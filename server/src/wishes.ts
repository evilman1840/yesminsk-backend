import { Express, Response } from 'express';
import mongoose from 'mongoose';
import { telegramAuthMiddleware, AuthenticatedRequest } from './middleware/telegramAuth';
import { Wish, WishGroup, IWish, IWishGroup, WISH_WINDOWS, WishWindow } from './models/Wish';
import { EventTemplate, IEventTemplate, CUSTOM_TEMPLATE_KEY } from './models/EventTemplate';
import { Event, IEvent } from './models/Event';
import { Place } from './models/Place';
import { User } from './models/User';
import { escapeHtml } from './utils/telegramNotify';
import { meetupCreatePath } from './eventTemplates';
import { formatWhen } from './eventNotify';
import { WISH_TEXTS as T } from './texts';

/**
 * «Хочу сходить»: желания без обязательств, группы совпадений и сообщения бота.
 * Совпадение: один вид (и вид спорта) + пересекающееся время + одно место или «где угодно».
 * Сообщения — только днём (10:00–22:00 по Минску), о совпадениях не чаще раза в день
 */

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const MINSK = 3 * HOUR; // Минск: UTC+3 круглый год
const MAX_ACTIVE = 3;
const REMIND_AFTER = DAY;
const matchThreshold = () => Math.max(2, Number(process.env.MATCH_THRESHOLD) || 2);

/* ---------- Время по Минску ---------- */

const minskMidnight = (now: Date, addDays = 0) => {
  const m = new Date(now.getTime() + MINSK);
  return Date.UTC(m.getUTCFullYear(), m.getUTCMonth(), m.getUTCDate() + addDays) - MINSK;
};
const minskDow = (now: Date) => new Date(now.getTime() + MINSK).getUTCDay(); // 0 — воскресенье
const minskHour = (now: Date) => new Date(now.getTime() + MINSK).getUTCHours();
const isDaytime = (now = new Date()) => minskHour(now) >= 10 && minskHour(now) < 22;

// Окно времени желания: сегодня, завтра, ближайшие выходные, ближайшие 7 дней
export function wishWindow(w: WishWindow, now = new Date()): [Date, Date] {
  const today = minskMidnight(now);
  if (w === 'today') return [now, new Date(today + DAY - 1)];
  if (w === 'tomorrow') return [new Date(today + DAY), new Date(today + 2 * DAY - 1)];
  if (w === 'weekend') {
    const dow = minskDow(now);
    if (dow === 6) return [now, new Date(today + 2 * DAY - 1)];
    if (dow === 0) return [now, new Date(today + DAY - 1)];
    const saturday = today + (6 - dow) * DAY;
    return [new Date(saturday), new Date(saturday + 2 * DAY - 1)];
  }
  return [now, new Date(now.getTime() + 7 * DAY)];
}

// Какое быстрое время подставить в форму «Соберу я»: первое, что попадает в общее окно группы
const QUICK_SLOTS: { id: 'today' | 'tomorrow' | 'saturday' | 'sunday'; at: (now: Date) => number }[] = [
  { id: 'today', at: (now) => minskMidnight(now) + 19 * HOUR },
  { id: 'tomorrow', at: (now) => minskMidnight(now, 1) + 19 * HOUR },
  { id: 'saturday', at: (now) => minskMidnight(now, (6 - minskDow(now) + 7) % 7) + 14 * HOUR },
  { id: 'sunday', at: (now) => minskMidnight(now, (7 - minskDow(now)) % 7) + 14 * HOUR }
];
const whenForGroup = (g: { windowStart: Date; windowEnd: Date }, now = new Date()) => slotForGroup(g, 1, now)?.id;

// Варианты времени для предложения бота: вечера ближайших дней и выходные днём,
// не раньше чем через leadHours и внутри общего окна группы. Не больше max вариантов
export const proposalSlots = (g: { windowStart: Date; windowEnd: Date }, leadHours: number, max = 3, now = new Date()) => {
  const dow = minskDow(now);
  const candidates = [
    ...[0, 1, 2, 3].map((d) => minskMidnight(now, d) + 19 * HOUR),
    minskMidnight(now, (6 - dow + 7) % 7) + 14 * HOUR,
    minskMidnight(now, (7 - dow) % 7) + 14 * HOUR,
    minskMidnight(now, ((6 - dow + 7) % 7) + 7) + 14 * HOUR
  ];
  return [...new Set(candidates)]
    .filter((t) => t > now.getTime() + leadHours * HOUR && t >= g.windowStart.getTime() && t <= g.windowEnd.getTime())
    .sort((a, b) => a - b)
    .slice(0, max)
    .map((t) => new Date(t));
};

// Окно группы заканчивается сегодня (кто-то хотел «сегодня») — тогда можно предлагать и сегодняшний вечер
export const endsToday = (g: { windowEnd: Date }, now = new Date()) => g.windowEnd.getTime() < minskMidnight(now, 1);

// Первое быстрое время в общем окне группы, не раньше чем через leadHours
export const slotForGroup = (g: { windowStart: Date; windowEnd: Date }, leadHours = 1, now = new Date()) => {
  const slot = QUICK_SLOTS.find((s) => {
    const t = s.at(now);
    return t > now.getTime() + leadHours * HOUR && t >= g.windowStart.getTime() && t <= g.windowEnd.getTime();
  });
  return slot ? { id: slot.id, date: new Date(slot.at(now)) } : null;
};

/* ---------- Виды желаний = шаблоны с фразой ---------- */

interface WishKind {
  tpl: IEventTemplate;
  subField?: { key: string; token?: string; options: { value: string; label: string }[] }; // вид спорта
}

async function loadKind(kind: string): Promise<WishKind | null> {
  if (!/^[a-z0-9_]{1,30}$/.test(kind) || kind === CUSTOM_TEMPLATE_KEY) return null;
  const tpl = await EventTemplate.findOne({ key: kind, active: true, wishPhrase: { $nin: ['', null] } });
  if (!tpl) return null;
  const f = (tpl.fields || []).find((x) => x.type === 'select' && x.required);
  return { tpl, subField: f ? { key: f.key, token: f.token, options: (f.options || []).filter((o) => o.value !== 'other') } : undefined };
}

// «в кино», «поиграть в настольный теннис»
const phraseOf = (k: WishKind, sport?: string) => {
  let phrase = k.tpl.wishPhrase;
  const opt = k.subField?.options.find((o) => o.value === sport);
  if (k.subField?.token) phrase = phrase.replace(`{${k.subField.token}}`, opt ? opt.label.toLowerCase() : '').trim();
  return phrase;
};

export async function phraseFor(kind: string, sport?: string) {
  const k = await loadKind(kind);
  return k ? phraseOf(k, sport) : kind;
}

/* ---------- Совпадения ---------- */

const overlaps = (a: { windowStart: Date; windowEnd: Date }, b: { windowStart: Date; windowEnd: Date }) =>
  a.windowStart < b.windowEnd && b.windowStart < a.windowEnd;
const placeOk = (a?: string | null, b?: string | null) => !a || !b || a === b;

// Новое (или ещё не совпавшее) желание: в открытую группу или в новую, если набрался порог
export async function tryMatch(wish: IWish): Promise<boolean> {
  if (wish.status !== 'active') return false;
  const sport = wish.sport || null;

  const groups = await WishGroup.find({ status: 'open', kind: wish.kind, sport, windowEnd: { $gt: new Date() } }).sort({ createdAt: 1 });
  for (const g of groups) {
    if (!overlaps(g, wish) || !placeOk(g.placeId, wish.placeId)) continue;
    if (await Wish.exists({ groupId: g._id, telegramId: wish.telegramId, status: { $in: ['matched', 'fulfilled'] } })) continue;
    await joinGroup(g, [wish]);
    return true;
  }

  const cands = await Wish.find({
    status: 'active',
    kind: wish.kind,
    sport,
    telegramId: { $ne: wish.telegramId },
    windowStart: { $lt: wish.windowEnd },
    windowEnd: { $gt: wish.windowStart }
  }).sort({ createdAt: 1 });

  // Место: у нового указано — только с ним или «где угодно»; не указано — самое частое место среди остальных
  let place = wish.placeId || null;
  if (!place) {
    const counts = new Map<string, number>();
    cands.forEach((c) => c.placeId && counts.set(c.placeId, (counts.get(c.placeId) || 0) + 1));
    place = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null;
  }

  const members: IWish[] = [wish];
  const users = new Set([wish.telegramId]);
  let start = wish.windowStart;
  let end = wish.windowEnd;
  for (const c of cands) {
    if (users.has(c.telegramId) || !placeOk(place, c.placeId)) continue;
    if (!(c.windowStart < end && start < c.windowEnd)) continue;
    members.push(c);
    users.add(c.telegramId);
    start = new Date(Math.max(start.getTime(), c.windowStart.getTime()));
    end = new Date(Math.min(end.getTime(), c.windowEnd.getTime()));
  }
  if (users.size < matchThreshold()) return false;

  const group = await WishGroup.create({ kind: wish.kind, sport: wish.sport, placeId: members.find((m) => m.placeId)?.placeId, windowStart: start, windowEnd: end });
  await joinGroup(group, members);
  return true;
}

async function joinGroup(g: IWishGroup, members: IWish[]) {
  for (const w of members) {
    g.windowStart = new Date(Math.max(g.windowStart.getTime(), w.windowStart.getTime()));
    g.windowEnd = new Date(Math.min(g.windowEnd.getTime(), w.windowEnd.getTime()));
    if (w.placeId && !g.placeId) g.placeId = w.placeId;
  }
  await g.save();
  await Wish.updateMany(
    { _id: { $in: members.map((m) => m._id) } },
    { $set: { groupId: g._id, status: 'matched', matchedAt: new Date(), pending: 'match' } }
  );
}

export const groupSize = (groupId: unknown) => Wish.countDocuments({ groupId, status: { $in: ['matched', 'fulfilled'] } });

/* ---------- Создание и отмена ---------- */

// После совпадения: модуль предложений проверяет, не пора ли сразу предложить время и место
// (подключается из proposals.ts, чтобы не было круговых импортов)
let afterMatch: ((groupId: unknown) => Promise<void>) | null = null;
export const setAfterMatch = (fn: (groupId: unknown) => Promise<void>) => {
  afterMatch = fn;
};

export async function createWish(
  telegramId: number,
  input: { kind?: unknown; sport?: unknown; timeWindow?: unknown; placeId?: unknown },
  source: 'app' | 'link'
): Promise<{ wish?: IWish; sameCount?: number; error?: string }> {
  const k = await loadKind(String(input.kind || ''));
  if (!k) return { error: T.badKind };
  const timeWindow = String(input.timeWindow || '') as WishWindow;
  if (!WISH_WINDOWS.includes(timeWindow)) return { error: T.badKind };
  let sport: string | undefined;
  if (k.subField) {
    sport = String(input.sport || '');
    if (!k.subField.options.some((o) => o.value === sport)) return { error: T.badKind };
  }
  let placeId: string | undefined;
  if (input.placeId && mongoose.Types.ObjectId.isValid(String(input.placeId)) && (await Place.exists({ _id: String(input.placeId) }))) placeId = String(input.placeId);

  const now = new Date();
  const live = { telegramId, status: { $in: ['active', 'matched'] }, windowEnd: { $gt: now } };
  if (await Wish.exists({ ...live, kind: k.tpl.key, sport: sport || null, timeWindow, placeId: placeId || null })) return { error: T.duplicate };
  if ((await Wish.countDocuments(live)) >= MAX_ACTIVE) return { error: T.tooMany(MAX_ACTIVE) };

  const [windowStart, windowEnd] = wishWindow(timeWindow, now);
  const wish = await Wish.create({ telegramId, kind: k.tpl.key, sport, timeWindow, windowStart, windowEnd, placeId, source });

  // Сколько ещё людей хотят того же (для подтверждения в приложении)
  const others = await Wish.find({
    telegramId: { $ne: telegramId },
    kind: wish.kind,
    sport: sport || null,
    status: { $in: ['active', 'matched'] },
    windowStart: { $lt: windowEnd },
    windowEnd: { $gt: windowStart }
  }).lean();
  const sameCount = new Set(others.filter((o) => placeOk(o.placeId, placeId)).map((o) => o.telegramId)).size;

  if (await tryMatch(wish)) {
    const matched = await Wish.findById(wish._id);
    if (matched?.groupId && afterMatch) await afterMatch(matched.groupId).catch(() => {});
    sendPending().catch(() => {});
  }
  return { wish: (await Wish.findById(wish._id)) || wish, sameCount };
}

// Кто-то собрал сходку по ссылке «Соберу я»: группа исполнена, остальным — «Сходку собрали»
export async function onMeetupFromWish(groupId: unknown, event: IEvent, creatorId: number) {
  if (!groupId || !mongoose.Types.ObjectId.isValid(String(groupId))) return;
  const group = await WishGroup.findOneAndUpdate({ _id: String(groupId), status: 'open' }, { $set: { status: 'fulfilled', meetupId: String(event._id) } });
  if (!group) return;
  const meetupId = String(event._id);
  await Wish.updateMany({ groupId: group._id, telegramId: creatorId, status: 'matched' }, { $set: { status: 'fulfilled', meetupId, pending: null } });
  await Wish.updateMany({ groupId: group._id, telegramId: { $ne: creatorId }, status: 'matched' }, { $set: { meetupId, pending: 'built' } });
  sendPending().catch(() => {});
}

/* ---------- Сообщения бота ---------- */

export type Btn = { text: string; path?: string; data?: string; url?: string };

export async function sendWithButtons(chatId: number, html: string, rows: Btn[][]) {
  const appUrl = (process.env.MINI_APP_URL || '').replace(/\/+$/, '');
  const keyboard = rows
    .map((row) =>
      row
        .filter((b) => b.data || b.url || appUrl)
        .map((b) => (b.data ? { text: b.text, callback_data: b.data } : b.url ? { text: b.text, url: b.url } : { text: b.text, web_app: { url: `${appUrl}/${b.path || ''}` } }))
    )
    .filter((row) => row.length);
  const res = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: html, parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: { inline_keyboard: keyboard } })
  }).catch(() => null);
  return Boolean(res?.ok);
}

// «Соберу я»: форма с шаблоном, временем, местом и видом спорта; wish — чтобы после публикации написать остальным
export const buildPath = (g: IWishGroup) => {
  const base = meetupCreatePath({ template: g.kind, when: whenForGroup(g), placeId: g.placeId });
  return `${base}&wish=${g._id}${g.sport ? `&opt=${encodeURIComponent(g.sport)}` : ''}`;
};

const callAnswer = (id: string, text = '') =>
  fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callback_query_id: id, text })
  }).catch(() => {});

let sending = false;
export async function sendPending() {
  if (sending || !process.env.TELEGRAM_BOT_TOKEN || !isDaytime()) return;
  sending = true;
  try {
    const now = new Date();
    const today = new Date(minskMidnight(now));

    // 1. Совпадения: одно сообщение на человека в день, несколько желаний — вместе
    const pendingMatch = await Wish.find({ pending: 'match', status: 'matched' });
    const byUser = new Map<number, IWish[]>();
    pendingMatch.forEach((w) => byUser.set(w.telegramId, [...(byUser.get(w.telegramId) || []), w]));
    for (const [telegramId, wishes] of byUser) {
      if (await Wish.exists({ telegramId, notifiedAt: { $gte: today } })) continue; // уже писали сегодня — завтра утром
      const items = [];
      for (const w of wishes) {
        const g = await WishGroup.findById(w.groupId);
        if (g?.status === 'open' && (g.proposal || g.askPlaceAt)) {
          // У группы уже есть предложение бота (или бот спрашивает место) — пришлём его, а не «соберите сами»
          const next = g.proposal ? 'proposal' : 'askplace';
          await Wish.updateOne({ _id: w._id }, { $set: { pending: next } });
          w.pending = next;
          continue;
        }
        if (!g || g.status !== 'open') continue;
        items.push({ w, g, n: await groupSize(g._id), what: await phraseFor(w.kind, w.sport), when: T.when[w.timeWindow] });
      }
      if (!items.length) {
        await Wish.updateMany({ _id: { $in: wishes.filter((w) => w.pending === 'match').map((w) => w._id) } }, { $set: { pending: null } });
        continue;
      }
      const html =
        items.length === 1
          ? T.matchOne(items[0].n, items[0].what, items[0].when)
          : [T.matchManyTitle, '', ...items.map((i) => T.matchManyLine(i.n, i.what, i.when)), '', T.matchManyEnd].join('\n');
      // Каждая кнопка на своей строке, чтобы текст не обрезался
      const rows: Btn[][] = items.flatMap((i) => [
        [{ text: items.length === 1 ? T.buildBtn : T.buildBtnFor(i.what), path: buildPath(i.g) }],
        [{ text: items.length === 1 ? T.whoBtn : T.whoBtnFor(i.what), path: `?wishGroup=${i.g._id}` }],
        [{ text: T.waitBtn, data: `wsh:wait:${i.w._id}` }],
        [{ text: T.cancelBtn, data: `wsh:cancel:${i.w._id}` }]
      ]);
      await sendWithButtons(telegramId, html, rows);
      await Wish.updateMany({ _id: { $in: wishes.filter((w) => w.pending === 'match').map((w) => w._id) } }, { $set: { pending: null, notifiedAt: now } });
    }

    // 2. «Сходку собрали»
    for (const w of await Wish.find({ pending: 'built' })) {
      const ev = w.meetupId && mongoose.Types.ObjectId.isValid(w.meetupId) ? await Event.findById(w.meetupId) : null;
      if (ev && ev.isActive) {
        await sendWithButtons(w.telegramId, T.built(escapeHtml(ev.title), formatWhen(ev.dateTime), escapeHtml(ev.locationName)), [
          [{ text: T.builtBtn, path: `?event=${ev._id}` }]
        ]);
      }
      w.pending = null;
      await w.save();
    }

    // 3. Через сутки никто не собрал, а время ещё есть — одно напоминание
    const stale = await WishGroup.find({ status: 'open', proposal: { $exists: false }, askPlaceAt: { $exists: false }, reminderSentAt: { $exists: false }, createdAt: { $lte: new Date(now.getTime() - REMIND_AFTER) }, windowEnd: { $gt: now } });
    for (const g of stale) {
      g.reminderSentAt = now;
      await g.save();
      for (const w of await Wish.find({ groupId: g._id, status: 'matched' })) {
        await sendWithButtons(w.telegramId, T.reminder(await phraseFor(w.kind, w.sport), T.when[w.timeWindow]), [
          [{ text: T.buildBtn, path: buildPath(g) }],
          [{ text: T.whoBtn, path: `?wishGroup=${g._id}` }]
        ]);
      }
    }
  } finally {
    sending = false;
  }
}

// Прошло время — желания и группы сами исчезают; ещё не совпавшие пробуем свести снова
async function housekeeping() {
  const now = new Date();
  await Wish.updateMany({ status: { $in: ['active', 'matched'] }, windowEnd: { $lte: now } }, { $set: { status: 'expired', pending: null } });
  await WishGroup.updateMany({ status: 'open', windowEnd: { $lte: now } }, { $set: { status: 'expired' } });
  for (const w of await Wish.find({ status: 'active' }).sort({ createdAt: 1 })) await tryMatch(w);
}

export function startWishLoop() {
  const tick = () => sendPending().catch((err) => console.warn('⚠️ «Хочу сходить», отправка:', err?.message || err));
  const hourly = () => housekeeping().then(tick).catch((err) => console.warn('⚠️ «Хочу сходить», проверка:', err?.message || err));
  setTimeout(hourly, 2 * 60 * 1000);
  setInterval(tick, 5 * 60 * 1000);
  setInterval(hourly, HOUR);
}

/* ---------- Кнопки и ссылка из поста ---------- */

export async function handleWishCallback(query: any): Promise<boolean> {
  const data: string = query.data || '';
  if (!data.startsWith('wsh:') && !data.startsWith('wshc:')) return false;
  const fromId: number = query.from?.id;

  if (data.startsWith('wshc:')) {
    // ✅ Хочу! — из ссылки wish_…
    const [, kind, sport, timeWindow] = data.split(':');
    const res = await createWish(fromId, { kind, sport: sport === '-' ? undefined : sport, timeWindow }, 'link');
    callAnswer(query.id, res.error || '');
    if (res.wish) {
      const lines = [T.created];
      if (res.sameCount) lines.push('', T.sameCount(res.sameCount));
      await sendWithButtons(query.message.chat.id, lines.join('\n'), [[{ text: T.openApp, path: '?tab=events' }]]);
    }
    return true;
  }

  const [, action, id] = data.split(':');
  const wish = mongoose.Types.ObjectId.isValid(id) ? await Wish.findOne({ _id: id, telegramId: fromId }) : null;
  if (!wish) return callAnswer(query.id), true;
  if (action === 'cancel') {
    wish.status = 'cancelled';
    wish.pending = null;
    await wish.save();
    callAnswer(query.id, T.cancelOk);
  } else callAnswer(query.id, T.waitOk);
  return true;
}

// /start wish_cinema_weekend или wish_sport_tabletennis_weekend
export async function handleWishStart(chatId: number, param: string) {
  const parts = param.split('_');
  const timeWindow = parts.pop() as WishWindow;
  const [kind, sport] = parts;
  const k = kind ? await loadKind(kind) : null;
  const sportOk = !k?.subField || k.subField.options.some((o) => o.value === sport);
  if (!k || !WISH_WINDOWS.includes(timeWindow) || !sportOk) {
    await sendWithButtons(chatId, T.linkBad, [[{ text: T.openApp, path: '?tab=events' }]]);
    return;
  }
  await sendWithButtons(chatId, T.linkAsk(phraseOf(k, sport), T.when[timeWindow]), [[{ text: T.linkBtn, data: `wshc:${kind}:${sport || '-'}:${timeWindow}` }]]);
}

/* ---------- Для приложения ---------- */

const formatWish = async (w: IWish) => ({
  id: String(w._id),
  kind: w.kind,
  sport: w.sport || null,
  timeWindow: w.timeWindow,
  placeId: w.placeId || null,
  status: w.status,
  what: await phraseFor(w.kind, w.sport),
  when: T.when[w.timeWindow],
  groupSize: w.groupId ? await groupSize(w.groupId) : 0
});

// Сколько людей чего хотят: вид + вид спорта + когда + место
async function wishSummary() {
  const rows = await Wish.aggregate([
    { $match: { status: { $in: ['active', 'matched'] }, windowEnd: { $gt: new Date() } } },
    { $group: { _id: { kind: '$kind', sport: '$sport', timeWindow: '$timeWindow', placeId: '$placeId' }, users: { $addToSet: '$telegramId' } } }
  ]);
  return Promise.all(
    rows.map(async (r) => ({
      kind: r._id.kind,
      sport: r._id.sport || null,
      timeWindow: r._id.timeWindow,
      placeId: r._id.placeId || null,
      count: r.users.length,
      userIds: r.users as number[],
      what: await phraseFor(r._id.kind, r._id.sport),
      when: T.when[r._id.timeWindow]
    }))
  );
}

export function setupWishRoutes(app: Express) {
  app.get('/api/wishes', telegramAuthMiddleware as any, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const me = req.telegramUser!.id;
      const mine = await Wish.find({ telegramId: me, status: { $in: ['active', 'matched'] }, windowEnd: { $gt: new Date() } }).sort({ createdAt: -1 });
      const summary = await wishSummary();
      res.json({
        mine: await Promise.all(mine.map(formatWish)),
        // Без списка людей: только сколько и есть ли среди них я
        summary: summary.map(({ userIds, ...s }) => ({ ...s, includesMe: userIds.includes(me) })),
        maxActive: MAX_ACTIVE
      });
    } catch {
      res.status(500).json({ error: 'Не удалось загрузить желания' });
    }
  });

  app.post('/api/wishes', telegramAuthMiddleware as any, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const result = await createWish(req.telegramUser!.id, req.body || {}, 'app');
      if (result.error) return res.status(400).json({ error: result.error });
      res.status(201).json({ wish: await formatWish(result.wish!), sameCount: result.sameCount || 0 });
    } catch {
      res.status(500).json({ error: 'Не удалось сохранить желание' });
    }
  });

  app.delete('/api/wishes/:id', telegramAuthMiddleware as any, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const id = String(req.params.id);
      if (!mongoose.Types.ObjectId.isValid(id)) return res.sendStatus(404);
      await Wish.updateOne({ _id: id, telegramId: req.telegramUser!.id }, { $set: { status: 'cancelled', pending: null } });
      res.sendStatus(204);
    } catch {
      res.sendStatus(500);
    }
  });
}

/* ---------- /stats ---------- */

export async function wishStatsLines(since: Date): Promise<string[]> {
  const [created, byKind, groups, built, linkUsers, active] = await Promise.all([
    Wish.countDocuments({ createdAt: { $gte: since } }),
    Wish.aggregate([{ $match: { createdAt: { $gte: since } } }, { $group: { _id: '$kind', n: { $sum: 1 } } }, { $sort: { n: -1 } }]),
    WishGroup.countDocuments({ createdAt: { $gte: since } }),
    WishGroup.countDocuments({ createdAt: { $gte: since }, status: 'fulfilled' }),
    Wish.distinct('telegramId', { source: 'link', createdAt: { $gte: since } }),
    Wish.countDocuments({ status: { $in: ['active', 'matched'] }, windowEnd: { $gt: new Date() } })
  ]);
  const names = new Map((await EventTemplate.find({}, { key: 1, emoji: 1 }).lean()).map((t) => [t.key, t.emoji]));
  const withProfile = linkUsers.length ? await User.countDocuments({ telegramId: { $in: linkUsers }, hasAgreedToRules: true }) : 0;
  const rate = groups ? `${Math.round((built / groups) * 100)}%` : '0%';
  return [
    T.statsTitle,
    T.statsCreated(created, byKind.map((k) => `${names.get(k._id) || k._id} ${k.n}`).join(' · ')),
    T.statsGroups(groups, built, rate),
    T.statsLinks(linkUsers.length, withProfile),
    T.statsActive(active)
  ];
}
