import { calculateDistanceMeters } from './utils/geoUtils';
import { Express, Response } from 'express';
import { telegramAuthMiddleware, AuthenticatedRequest } from './middleware/telegramAuth';
import mongoose from 'mongoose';
import { Wish, WishGroup, IWishGroup } from './models/Wish';
import { EventTemplate } from './models/EventTemplate';
import { Event } from './models/Event';
import { Place } from './models/Place';
import { User } from './models/User';
import { escapeHtml, sendTelegramMessage } from './utils/telegramNotify';
import { formatWhen } from './eventNotify';
import { buildExtras } from './eventTemplates';
import { sendWithButtons, Btn, phraseFor, proposalSlots, endsToday, groupSize, buildPath, setAfterMatch } from './wishes';
import { isAdmin, adminIds } from './news';
import { PROPOSAL_FALLBACK_PLACES } from './data/wishProposals';
import { PROPOSAL_TEXTS as T, WISH_TEXTS as W, SUGGEST_TEXTS as SG } from './texts';
import { parsePlaceText, suggestPlace } from './placeSuggestions';

/**
 * «Хочу сходить» без организатора: когда в группе набирается PROPOSE_AT человек, бот сам предлагает
 * время и место. Как только CONFIRM_MIN нажмут «✅ Пойду», создаётся официальная сходка от ДА! МИНСК
 */

const HOUR = 60 * 60 * 1000;
const MINSK = 3 * HOUR;
const PROPOSE_AT = () => Math.max(2, Number(process.env.PROPOSE_AT) || 3);
const CONFIRM_MIN = () => Math.max(2, Number(process.env.CONFIRM_MIN) || 3);
// Не раньше чем через 20 часов (почти сутки), если только люди не хотели «сегодня» — тогда через 4 часа
const leadHoursFor = (g: IWishGroup) => (endsToday(g) ? 4 : 20);

// «Сб 31.10, 14:00» — коротко для кнопок
const shortWhen = (d: Date) => {
  const m = new Date(d.getTime() + MINSK);
  const days = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${days[m.getUTCDay()]} ${pad(m.getUTCDate())}.${pad(m.getUTCMonth() + 1)}, ${pad(m.getUTCHours())}:${pad(m.getUTCMinutes())}`;
};

const isDaytime = (now = new Date()) => {
  const h = new Date(now.getTime() + MINSK).getUTCHours();
  return h >= 10 && h < 22;
};

// Место, до которого всем участникам группы в сумме ближе всего (точки людей — точные, наружу не уходят).
// Одного человека с окраины это не перетянет. Нет точек — место с лучшим рейтингом
async function closestToGroup<T extends { location: { coordinates: number[] }; rating?: number | null }>(group: IWishGroup, places: T[]): Promise<T | null> {
  if (!places.length) return null;
  const ids = (await Wish.find({ groupId: group._id, status: { $in: ['matched', 'fulfilled'] } }, { telegramId: 1 }).lean()).map((w) => w.telegramId);
  const users = await User.find({ telegramId: { $in: ids } }, { locationExact: 1, locationFuzzy: 1 }).lean();
  const points = users
    .map((u) => u.locationExact?.coordinates || u.locationFuzzy?.coordinates)
    .filter((c): c is [number, number] => Array.isArray(c) && c.length === 2);
  if (!points.length) return [...places].sort((x, y) => (y.rating || 0) - (x.rating || 0))[0];
  const total = (pl: T) => points.reduce((sum, [lng, lat]) => sum + calculateDistanceMeters(lat, lng, pl.location.coordinates[1], pl.location.coordinates[0]), 0);
  return places.reduce((best, pl) => (total(pl) < total(best) ? pl : best));
}

// Где встречаться: место группы → место из «Мест» подходящего типа → точка встречи для этого вида
async function placeFor(group: IWishGroup) {
  if (group.placeId && mongoose.Types.ObjectId.isValid(group.placeId)) {
    const p = await Place.findById(group.placeId).lean();
    if (p) return { placeId: String(p._id), placeName: p.name, coords: [p.location.coordinates[1], p.location.coordinates[0]] as [number, number] };
  }
  const tpl = await EventTemplate.findOne({ key: group.kind }).lean();
  if (tpl?.placeTypes?.length) {
    const places = await Place.find({ category: { $in: tpl.placeTypes } }).lean();
    const p = await closestToGroup(group, places);
    if (p) return { placeId: String(p._id), placeName: p.name, coords: [p.location.coordinates[1], p.location.coordinates[0]] as [number, number] };
  }
  const fb = PROPOSAL_FALLBACK_PLACES[group.kind];
  return fb ? { placeName: fb.name, coords: fb.coords, note: fb.note } : null;
}

// Создать предложение для группы (force — по кнопке автора, даже если людей меньше порога)
type ProposalPlace = { placeId?: string; placeName: string; coords: [number, number]; note?: string };

export async function proposeForGroup(group: IWishGroup, force = false, override?: ProposalPlace): Promise<boolean> {
  if (group.status !== 'open' || group.proposal) return false;
  if (!force && (await groupSize(group._id)) < PROPOSE_AT()) return false;
  const times = proposalSlots(group, leadHoursFor(group), 3);
  if (!times.length) return false;
  const place = override || (await placeFor(group));
  if (!place) {
    // Нет подходящего места: спрашиваем группу — первая присланная ссылка станет местом сходки
    if (!group.askPlaceAt) {
      await WishGroup.updateOne({ _id: group._id }, { $set: { askPlaceAt: new Date() } });
      await Wish.updateMany({ groupId: group._id, status: 'matched' }, { $set: { pending: 'askplace' } });
    }
    if (!group.noPlaceNotifiedAt) {
      await WishGroup.updateOne({ _id: group._id }, { $set: { noPlaceNotifiedAt: new Date() } });
      const what = await phraseFor(group.kind, group.sport);
      for (const id of adminIds()) sendTelegramMessage(id, SG.adminAsked(escapeHtml(what), await groupSize(group._id)), 'Открыть ДА! МИНСК', '?tab=places');
    }
    return false;
  }
  await WishGroup.updateOne(
    { _id: group._id, proposal: { $exists: false } },
    { $set: { proposal: { options: times.map((at) => ({ at, yes: [] })), ...place, no: [], createdAt: new Date() } } }
  );
  await Wish.updateMany({ groupId: group._id, status: 'matched' }, { $set: { pending: 'proposal' } });
  return true;
}

// Текст предложения: место и варианты времени кнопками
async function offerMessage(group: IWishGroup) {
  const p = group.proposal!;
  const what = await phraseFor(group.kind, group.sport);
  return {
    html: T.offer(await groupSize(group._id), escapeHtml(what), escapeHtml(p.placeName), p.note, p.options.map((o) => formatWhen(o.at)), CONFIRM_MIN()),
    rows: [
      ...p.options.map((o, i) => [{ text: T.optionBtn(shortWhen(o.at)), data: `prp:yes:${group._id}:${i}` }]),
      [{ text: T.noBtn, data: `prp:no:${group._id}` }],
      [{ text: T.whoBtn, path: `?wishGroup=${group._id}` }]
    ] as Btn[][]
  };
}

// Набралось «Пойду» — создаём официальную сходку от ДА! МИНСК
async function createEventFromProposal(group: IWishGroup, optionIndex: number) {
  const p = group.proposal!;
  const option = p.options[optionIndex];
  const tpl = await EventTemplate.findOne({ key: group.kind }).lean();
  const admin = (await User.findOne({ telegramId: { $in: adminIds() } }).lean()) as any;
  const subField = (tpl?.fields || []).find((f: any) => f.type === 'select' && f.required);
  const extrasRaw = subField && group.sport ? { [subField.key]: group.sport } : {};
  const built = tpl ? buildExtras(tpl.fields || [], extrasRaw) : { extras: {}, badges: [] as string[] };
  // Название и описание из шаблона, {спорт} и т.п. — из вида спорта
  const fill = (text: string) =>
    text.replace(/\{([^}]+)\}/g, (_, token) => {
      const f = (tpl?.fields || []).find((x: any) => x.token === token);
      const opt = f?.options?.find((o: any) => o.value === (extrasRaw as any)[f.key] || o.value === f.default);
      return opt ? opt.say ?? opt.label : '';
    }).replace(/\s{2,}/g, ' ').trim();
  const hasAllTokens = !/\{[^}]+\}/.test(tpl?.title || '') || Boolean(group.sport);
  const title = (hasAllTokens ? fill(tpl?.title || '') : tpl?.fallbackTitle) || (await phraseFor(group.kind, group.sport));
  const description = [fill(tpl?.description || ''), p.note].filter(Boolean).join('\n\n') || 'Сходка из «Хочу сходить»';

  const yesUsers = await User.find({ telegramId: { $in: option.yes } }).lean();
  const event = await Event.create({
    title: title.slice(0, 100),
    description: description.slice(0, 600),
    category: tpl?.category || 'other',
    customCategory: tpl?.category ? '' : tpl?.name || '',
    tags: tpl?.tags || [],
    placeId: p.placeId,
    templateId: tpl?.key,
    durationMinutes: tpl?.durationMinutes || 0,
    extras: built.extras,
    badges: built.badges,
    isPaid: Boolean(tpl?.paid),
    locationName: p.placeName,
    location: { type: 'Point', coordinates: [p.coords[1], p.coords[0]] },
    dateTime: option.at,
    // Организатор — ДА! МИНСК (аккаунт автора), сам автор в участники не записывается
    creator: {
      telegramId: admin?.telegramId || adminIds()[0] || 0,
      name: admin?.firstName || 'ДА! МИНСК',
      username: admin?.username,
      avatarUrl: admin?.avatarUrl || 'https://yesminsk-app.vercel.app/favicon.svg'
    },
    participants: yesUsers.map((u) => ({ telegramId: u.telegramId, name: u.firstName, username: u.username, avatarUrl: u.avatarUrl || '', joinedAt: new Date() })),
    maxParticipants: Math.max(tpl?.seats || 0, (await groupSize(group._id)) + 2),
    isActive: true
  });

  const eventId = String(event._id);
  await WishGroup.updateOne({ _id: group._id }, { $set: { status: 'fulfilled', meetupId: eventId } });
  await Wish.updateMany({ groupId: group._id, telegramId: { $in: option.yes } }, { $set: { status: 'fulfilled', meetupId: eventId, pending: null } });
  // Остальным (не ответили или выбрали другое время) — «Сходку собрали», кроме «Не смогу ни в один»
  await Wish.updateMany({ groupId: group._id, telegramId: { $nin: [...option.yes, ...p.no] }, status: 'matched' }, { $set: { meetupId: eventId, pending: 'built' } });

  const when = formatWhen(event.dateTime);
  for (const id of option.yes) {
    await sendWithButtons(id, T.createdForYes(escapeHtml(event.title), when, escapeHtml(event.locationName)), [[{ text: T.openEvent, path: `?event=${eventId}` }]]);
  }
  for (const id of adminIds()) sendTelegramMessage(id, T.adminCreated(escapeHtml(event.title), when, option.yes.length), T.openEvent, `?event=${eventId}`);
}

/* ---------- Цикл: предложить, отправить днём ---------- */

let running = false;
export async function runProposals() {
  if (running) return;
  running = true;
  try {
    // 1. Группы, где набралось достаточно людей, а предложения ещё нет
    for (const g of await WishGroup.find({ status: 'open', proposal: { $exists: false }, windowEnd: { $gt: new Date() } })) await proposeForGroup(g);

    // Присоединились к группе уже после предложения — им тоже предложение, а не «соберите сами»
    const withProposal = await WishGroup.find({ status: 'open', proposal: { $exists: true } }, { _id: 1 }).lean();
    if (withProposal.length) {
      await Wish.updateMany({ groupId: { $in: withProposal.map((g) => g._id) }, status: 'matched', pending: { $in: ['match', 'askplace'] } }, { $set: { pending: 'proposal' } });
    }
    const asking = await WishGroup.find({ status: 'open', proposal: { $exists: false }, askPlaceAt: { $exists: true } }, { _id: 1 }).lean();
    if (asking.length) {
      await Wish.updateMany({ groupId: { $in: asking.map((g) => g._id) }, status: 'matched', pending: 'match' }, { $set: { pending: 'askplace' } });
    }

    // 2. Отправляем днём
    if (!process.env.TELEGRAM_BOT_TOKEN || !isDaytime()) return;
    // Места нет — просим группу прислать ссылку
    for (const w of await Wish.find({ pending: 'askplace', status: 'matched' })) {
      const g = await WishGroup.findById(w.groupId);
      w.pending = null;
      await w.save();
      if (!g || g.status !== 'open' || g.proposal) continue;
      await sendWithButtons(w.telegramId, SG.groupAsk(await groupSize(g._id), escapeHtml(await phraseFor(g.kind, g.sport))), [
        [{ text: SG.groupAskBtn, path: `?wishGroup=${g._id}&suggest=1` }],
        [{ text: T.whoBtn, path: `?wishGroup=${g._id}` }]
      ]);
      await new Promise((r) => setTimeout(r, 60));
    }

    for (const w of await Wish.find({ pending: 'proposal', status: 'matched' })) {
      const g = await WishGroup.findById(w.groupId);
      w.pending = null;
      await w.save();
      if (!g || g.status !== 'open' || !g.proposal || !g.proposal.options.some((o) => o.at.getTime() > Date.now())) continue;
      const msg = await offerMessage(g);
      await sendWithButtons(w.telegramId, msg.html, msg.rows);
      await new Promise((r) => setTimeout(r, 60));
    }
  } finally {
    running = false;
  }
}

export function startProposalLoop() {
  // Группа доросла до порога — сразу предложение, без промежуточного «соберите сами»
  setAfterMatch(async (groupId) => {
    const g = await WishGroup.findById(groupId);
    if (g && (await proposeForGroup(g))) runProposals().catch(() => {});
  });
  const run = () => runProposals().catch((err) => console.warn('⚠️ Предложения «Хочу сходить»:', err?.message || err));
  setTimeout(run, 4 * 60 * 1000);
  setInterval(run, 10 * 60 * 1000);
}

/* ---------- Кнопки ---------- */

export async function handleProposalCallback(query: any): Promise<boolean> {
  const data: string = query.data || '';
  if (!data.startsWith('prp:') && !data.startsWith('prpa:')) return false;
  const fromId: number = query.from?.id;
  const answer = (text = '') =>
    fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callback_query_id: query.id, text })
    }).catch(() => {});

  // Кнопки автора из /wishes: prpa:<группа>
  if (data.startsWith('prpa:')) {
    if (!isAdmin(fromId)) return answer(), true;
    const g = mongoose.Types.ObjectId.isValid(data.slice(5)) ? await WishGroup.findById(data.slice(5)) : null;
    const ok = g ? await proposeForGroup(g, true) : false;
    answer(ok ? T.proposedNow : T.cantPropose);
    if (ok) runProposals().catch(() => {});
    return true;
  }

  const [, action, id, idxRaw] = data.split(':');
  const g = mongoose.Types.ObjectId.isValid(id) ? await WishGroup.findById(id) : null;
  const inGroup = g ? await Wish.exists({ groupId: g._id, telegramId: fromId }) : null;
  if (!g || !g.proposal || !inGroup) return answer(T.gone), true;
  const idx = Number(idxRaw);
  const option = action === 'yes' ? g.proposal.options[idx] : null;
  if (action === 'yes' && !option) return answer(T.gone), true;

  // Сходку уже собрали: «Пойду» на то же время — записываем, на другое — подсказываем
  if (g.status === 'fulfilled' && g.meetupId && option) {
    const ev = mongoose.Types.ObjectId.isValid(g.meetupId) ? await Event.findById(g.meetupId) : null;
    if (!ev || !ev.isActive) return answer(T.gone), true;
    if (ev.dateTime.getTime() !== new Date(option.at).getTime()) return answer(T.otherTime(formatWhen(ev.dateTime))), true;
    if (!ev.participants.some((p) => p.telegramId === fromId)) {
      const u = await User.findOne({ telegramId: fromId }).lean();
      ev.participants.push({ telegramId: fromId, name: u?.firstName || query.from?.first_name || '', username: u?.username, avatarUrl: u?.avatarUrl || '', joinedAt: new Date() } as any);
      await ev.save();
      await Wish.updateMany({ groupId: g._id, telegramId: fromId }, { $set: { status: 'fulfilled', meetupId: g.meetupId, pending: null } });
    }
    answer(T.lateJoin);
    return true;
  }
  if (g.status !== 'open') return answer(T.gone), true;

  if (action === 'no') {
    // «Не смогу ни в один»: снимаем все мои «Пойду»
    const pulls = Object.fromEntries(g.proposal.options.map((_, i) => [`proposal.options.${i}.yes`, fromId]));
    await WishGroup.updateOne({ _id: g._id, status: 'open' }, { $addToSet: { 'proposal.no': fromId }, $pull: pulls });
    answer(T.noOk);
    return true;
  }

  const updated = await WishGroup.findOneAndUpdate(
    { _id: g._id, status: 'open' },
    { $addToSet: { [`proposal.options.${idx}.yes`]: fromId }, $pull: { 'proposal.no': fromId } },
    { new: true }
  );
  if (!updated?.proposal) return answer(T.gone), true;
  const yes = updated.proposal.options[idx].yes.length;
  answer(T.yesOk(yes, CONFIRM_MIN(), shortWhen(new Date(updated.proposal.options[idx].at))));
  if (yes >= CONFIRM_MIN()) {
    // Защита от двойного создания: забираем группу атомарно
    const claimed = await WishGroup.findOneAndUpdate({ _id: g._id, status: 'open' }, { $set: { status: 'fulfilled' } }, { new: true });
    if (claimed) await createEventFromProposal(claimed, idx);
  }
  return true;
}

/* ---------- /wishes — для автора ---------- */

export async function handleWishesCommand(message: any): Promise<boolean> {
  if (!/^\/wishes\b/i.test((message.text || '').trim()) || !isAdmin(message.from?.id)) return false;
  const groups = await WishGroup.find({ status: 'open', windowEnd: { $gt: new Date() } }).sort({ createdAt: 1 });
  if (!groups.length) {
    await sendWithButtons(message.chat.id, `${T.listTitle}\n\n${T.listEmpty}`, []);
    return true;
  }
  const lines = [T.listTitle, ''];
  const rows: Btn[][] = [];
  for (const g of groups) {
    const what = await phraseFor(g.kind, g.sport);
    const sample = await Wish.findOne({ groupId: g._id }).lean();
    const state = g.proposal
      ? T.stateProposed(g.proposal.options.map((o) => `${shortWhen(new Date(o.at))} ✅ ${o.yes.length}`).join(', '), g.proposal.no.length)
      : T.stateNone;
    lines.push(T.listLine(escapeHtml(what), W.when[sample?.timeWindow || 'week'], await groupSize(g._id), state));
    if (!g.proposal) rows.push([{ text: T.proposeBtn(what), data: `prpa:${g._id}` }]);
    rows.push([{ text: T.buildBtn(what), path: buildPath(g) }]);
  }
  await sendWithButtons(message.chat.id, lines.join('\n'), rows);
  return true;
}

/* ---------- Ответ группы: ссылка на место ---------- */

// Предложить место группе (ответом боту или из приложения). Возвращает текст ответа человеку
export async function suggestGroupPlace(group: IWishGroup, fromId: number, text: string): Promise<{ ok: boolean; message: string }> {
  if (group.proposal) return { ok: false, message: SG.groupAlready(group.proposal.placeName) };
  const parsed = await parsePlaceText(text);
  if (!parsed) return { ok: false, message: SG.notFound };
  const ok = await proposeForGroup(group, true, { placeName: parsed.name, coords: parsed.coords });
  const tpl = await EventTemplate.findOne({ key: group.kind }, { placeTypes: 1 }).lean();
  const what = await phraseFor(group.kind, group.sport);
  suggestPlace(fromId, parsed, tpl?.placeTypes?.[0] || '', SG.fromGroup(what)).catch(() => {});
  if (ok) runProposals().catch(() => {});
  return { ok, message: ok ? SG.groupThanks(parsed.name) : SG.thanks };
}

// Человек из группы, которую бот спросил про место, прислал ссылку или название — это и будет место сходки
export async function handleGroupPlaceReply(message: any): Promise<boolean> {
  const text: string = (message.text || '').trim();
  const fromId: number = message.from?.id;
  if (!text || text.startsWith('/') || !fromId) return false;
  const wishes = await Wish.find({ telegramId: fromId, status: 'matched', groupId: { $exists: true } }).lean();
  if (!wishes.length) return false;
  const groups = await WishGroup.find({ _id: { $in: wishes.map((w) => w.groupId) }, status: 'open', askPlaceAt: { $gte: new Date(Date.now() - 3 * 24 * HOUR) } });
  const group = groups[0];
  if (!group) return false;
  const res = await suggestGroupPlace(group, fromId, text);
  await sendWithButtons(message.chat.id, escapeHtml(res.message), []);
  return true;
}

// Из приложения: POST /api/wishes/groups/:id/place { text }
export function setupProposalRoutes(app: Express) {
  app.post('/api/wishes/groups/:id/place', telegramAuthMiddleware as any, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const id = String(req.params.id);
      const myId = req.telegramUser!.id;
      const group = mongoose.Types.ObjectId.isValid(id) ? await WishGroup.findById(id) : null;
      if (!group || group.status !== 'open' || !(await Wish.exists({ groupId: group._id, telegramId: myId }))) return res.status(404).json({ error: SG.notFound });
      const text = String(req.body?.text || '').slice(0, 500);
      if (!text.trim()) return res.status(400).json({ error: SG.needLink });
      const result = await suggestGroupPlace(group, myId, text);
      if (!result.ok && !group.proposal) return res.status(400).json({ error: result.message });
      res.json(result);
    } catch {
      res.status(500).json({ error: SG.notFound });
    }
  });
}
