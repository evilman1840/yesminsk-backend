import { Express, Response } from 'express';
import mongoose, { Schema, model, Types } from 'mongoose';
import { telegramAuthMiddleware, AuthenticatedRequest } from './middleware/telegramAuth';
import { Event, IEvent } from './models/Event';
import { User, IUser } from './models/User';
import { Reaction } from './models/Reaction';
import { Wish } from './models/Wish';
import { CUSTOM_TEMPLATE_KEY } from './models/EventTemplate';
import { joinEvent, joinBlockReason, freeSeats, isEventCreator } from './eventJoin';
import { seatsTaken, formatWhen, eventAppPath } from './eventNotify';
import { likes } from './eventRanking';
import { phraseFor, sendWithButtons } from './wishes';
import { avatarFor } from './avatars';
import { escapeHtml, sendTelegramMessage } from './utils/telegramNotify';
import { BUDDY_TEXTS as T, WISH_TEXTS } from './texts';

/**
 * «👯 Пойдём на сходку вместе»: позвать знакомого из «На связи» на сходку компанией.
 * Только на сходки больше чем на двоих; знакомому сходка должна подходить по условиям организатора.
 * Не больше 5 приглашений в день, одного человека на одну сходку — один раз.
 * Без ответа сутки (или если до сходки меньше 3 часов) приглашение тихо истекает
 */

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const MINSK = 3 * HOUR; // Минск: UTC+3 круглый год
export const BUDDY_DAILY_LIMIT = 5;
const ANSWER_HOURS = 24;
const CUTOFF_HOURS = 3; // ближе к началу не зовём, и приглашение истекает
const OPTIONS_MAX = 5;
const LOOKAHEAD_DAYS = 30;

type BuddyStatus = 'pending' | 'accepted' | 'declined' | 'expired' | 'undelivered';
type BuddySource = 'people' | 'event' | 'create' | 'match';

interface IBuddyInvite {
  _id: Types.ObjectId;
  eventId: Types.ObjectId;
  fromId: number;
  toId: number;
  source: BuddySource;
  status: BuddyStatus;
  expiresAt: Date;
  respondedAt?: Date;
  messageId?: number; // сообщение бота с кнопками — убрать кнопки, когда истечёт
  createdAt: Date;
}

const BuddyInviteSchema = new Schema<IBuddyInvite>(
  {
    eventId: { type: Schema.Types.ObjectId, required: true, index: true },
    fromId: { type: Number, required: true },
    toId: { type: Number, required: true, index: true },
    source: { type: String, enum: ['people', 'event', 'create', 'match'], default: 'people' }, // match — шторка из сообщения «Вы на связи»
    status: { type: String, enum: ['pending', 'accepted', 'declined', 'expired', 'undelivered'], default: 'pending', index: true },
    expiresAt: { type: Date, required: true, index: true },
    respondedAt: { type: Date },
    messageId: { type: Number }
  },
  { timestamps: true }
);
// Одного человека на одну сходку — один раз
BuddyInviteSchema.index({ eventId: 1, fromId: 1, toId: 1 }, { unique: true });
BuddyInviteSchema.index({ fromId: 1, createdAt: -1 });
BuddyInviteSchema.index({ createdAt: -1 });

export const BuddyInvite = model<IBuddyInvite>('BuddyInvite', BuddyInviteSchema);

class BuddyError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/* ---------- Правила ---------- */

const minskDayStart = (now = Date.now()) => new Date(now - ((now + MINSK) % DAY));

// Сколько приглашений осталось сегодня (не дошедшие не считаем: человек в них не виноват)
export async function invitesLeft(fromId: number) {
  const used = await BuddyInvite.countDocuments({ fromId, createdAt: { $gte: minskDayStart() }, status: { $ne: 'undelivered' } });
  return Math.max(0, BUDDY_DAILY_LIMIT - used);
}

// «На связи»: оба нажали 👋
export async function matchIdsOf(myId: number): Promise<number[]> {
  const [mine, toMe] = await Promise.all([
    Reaction.distinct('toTelegramId', { fromTelegramId: myId, type: 'like' }),
    Reaction.distinct('fromTelegramId', { toTelegramId: myId, type: 'like' })
  ]);
  const back = new Set(toMe.map(Number));
  return mine.map(Number).filter((id) => back.has(id));
}
async function isMatch(a: number, b: number) {
  const n = await Reaction.countDocuments({
    type: 'like',
    $or: [
      { fromTelegramId: a, toTelegramId: b },
      { fromTelegramId: b, toTelegramId: a }
    ]
  });
  return n === 2;
}

// Сходка, куда можно звать: впереди больше 3 часов, не «на двоих» (лимит 0 — без ограничений)
const openForBuddies = (ev: IEvent, now = Date.now()) =>
  ev.isActive && ev.dateTime.getTime() > now + CUTOFF_HOURS * HOUR && (!ev.maxParticipants || ev.maxParticipants > 2);
const openQuery = (now = Date.now()) => ({
  isActive: true,
  dateTime: { $gt: new Date(now + CUTOFF_HOURS * HOUR), $lte: new Date(now + LOOKAHEAD_DAYS * DAY) },
  $or: [{ maxParticipants: { $in: [0, null] } }, { maxParticipants: { $gt: 2 } }]
});

const isGoing = (ev: IEvent, id: number) => ev.participants.some((p) => p.telegramId === id);
// Хватает мест на обоих: отправителю (если ещё не записан) и знакомому
const seatsNeeded = (ev: IEvent, senderId: number) => (isGoing(ev, senderId) ? 1 : 2);

const goalsOf = (u: any): string[] => (u?.goals?.length ? u.goals : u?.goal ? [u.goal] : []);

// Почему сюда нельзя позвать этого человека; null — можно
function inviteBlock(ev: IEvent, sender: IUser, friend: IUser | null): string | null {
  if (!openForBuddies(ev)) return T.notOpen;
  if (!friend || friend.isBanned) return T.notMatch;
  if (isGoing(ev, friend.telegramId) || isEventCreator(ev, friend.telegramId)) return T.alreadyGoing;
  if (joinBlockReason(ev, friend, friend.telegramId)) return T.notFit;
  const mine = joinBlockReason(ev, sender, sender.telegramId);
  if (mine) return mine;
  if (freeSeats(ev) < seatsNeeded(ev, sender.telegramId)) return T.noSeats;
  return null;
}

const blockedEither = (a: IUser, b: IUser) => (a.blockedUsers || []).includes(b.telegramId) || (b.blockedUsers || []).includes(a.telegramId);

/* ---------- Отправка ---------- */

// Сколько ещё человек будет, кроме отправителя (с организатором). 0 — идут только организатор и отправитель
function othersCount(ev: IEvent, senderId: number) {
  const seatsOf = (id: number) => {
    const p = ev.participants.find((x) => x.telegramId === id);
    return p ? 1 + (p.guests || 0) : 0;
  };
  const total = seatsTaken(ev) - seatsOf(senderId);
  const besidesHost = total - (isEventCreator(ev, senderId) ? 0 : seatsOf(ev.creator.telegramId));
  return besidesHost > 0 ? total : 0;
}

async function deliver(invite: IBuddyInvite, ev: IEvent, sender: IUser): Promise<boolean> {
  const appUrl = (process.env.MINI_APP_URL || '').replace(/\/+$/, '');
  const html = T.invite(escapeHtml(sender.firstName), escapeHtml(ev.title), formatWhen(ev.dateTime), escapeHtml(ev.locationName), othersCount(ev, sender.telegramId));
  const keyboard = [
    [
      { text: T.yesBtn, callback_data: `bdy:y:${invite._id}` },
      { text: T.noBtn, callback_data: `bdy:n:${invite._id}` }
    ],
    ...(appUrl ? [[{ text: T.openBtn, web_app: { url: `${appUrl}/${eventAppPath(ev)}` } }]] : [])
  ];
  const res = await tg('sendMessage', { chat_id: invite.toId, text: html, parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: { inline_keyboard: keyboard } });
  if (res?.ok && res.result?.message_id) {
    await BuddyInvite.updateOne({ _id: invite._id }, { $set: { messageId: res.result.message_id } });
    return true;
  }
  if (res?.error_code === 403) User.updateOne({ telegramId: invite.toId }, { $set: { canMessage: false, botBlockedAt: new Date() } }).catch(() => {});
  return false;
}

/**
 * Позвать знакомого на сходку. Отправитель записывается сам, если ещё не записан
 * («По записи» — обычная заявка организатору). Бросает BuddyError с текстом для человека
 */
async function sendBuddyInvite(ev: IEvent, sender: IUser, toId: number, source: BuddySource) {
  const friend = toId && toId !== sender.telegramId ? await User.findOne({ telegramId: toId }) : null;
  if (!friend || blockedEither(sender, friend) || !(await isMatch(sender.telegramId, toId))) throw new BuddyError(403, T.notMatch);
  const block = inviteBlock(ev, sender, friend);
  if (block) throw new BuddyError(400, block);
  if (await BuddyInvite.exists({ eventId: ev._id, fromId: sender.telegramId, toId })) throw new BuddyError(409, T.alreadyInvited);
  if ((await invitesLeft(sender.telegramId)) <= 0) throw new BuddyError(429, T.limit(BUDDY_DAILY_LIMIT));

  if (!isGoing(ev, sender.telegramId)) {
    const joined = await joinEvent(ev, sender, { id: sender.telegramId, first_name: sender.firstName }, { guests: 0, withKids: false });
    if (!joined.ok) throw new BuddyError(joined.status, joined.error);
  }

  const expiresAt = new Date(Math.min(Date.now() + ANSWER_HOURS * HOUR, ev.dateTime.getTime() - CUTOFF_HOURS * HOUR));
  let invite: IBuddyInvite;
  try {
    invite = (await BuddyInvite.create({ eventId: ev._id, fromId: sender.telegramId, toId, source, expiresAt })).toObject();
  } catch (err: any) {
    if (err?.code === 11000) throw new BuddyError(409, T.alreadyInvited);
    throw err;
  }
  const delivered = await deliver(invite, ev, sender);
  if (!delivered) await BuddyInvite.updateOne({ _id: invite._id }, { $set: { status: 'undelivered' } });
  return { delivered };
}

// Сходку собрали из «Собери свою сходку» в «Пойдём вместе»: сразу зовём того, с кем собирались.
// Сходка «на двоих» или не подходит знакомому — тихо пропускаем
export async function inviteBuddyToNewEvent(ev: IEvent, sender: IUser, toId: number) {
  if (!Number.isSafeInteger(toId)) return;
  try {
    await sendBuddyInvite(ev, sender, toId, 'create');
  } catch (err) {
    if (!(err instanceof BuddyError)) throw err;
  }
}

/* ---------- Ответ приглашённого (кнопки в боте) ---------- */

const tg = async (method: string, body: any): Promise<any> => {
  const res = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }).catch(() => null);
  return res ? res.json().catch(() => null) : null;
};
const answer = (id: string, text = '', alert = false) => tg('answerCallbackQuery', { callback_query_id: id, text, show_alert: alert });
// Кнопки ответа больше не нужны: оставляем только «Посмотреть сходку»
const clearButtons = (chatId: number, messageId: number | undefined, ev?: IEvent | null) => {
  if (!messageId) return;
  const appUrl = (process.env.MINI_APP_URL || '').replace(/\/+$/, '');
  const rows = ev && appUrl ? [[{ text: T.openBtn, web_app: { url: `${appUrl}/${eventAppPath(ev)}` } }]] : [];
  return tg('editMessageReplyMarkup', { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: rows } });
};

export async function handleBuddyCallback(query: any): Promise<boolean> {
  const data: string = query.data || '';
  if (!data.startsWith('bdy:')) return false;
  const [, action, id] = data.split(':');
  const fromId: number = query.from?.id;
  const messageId: number | undefined = query.message?.message_id;
  const invite = mongoose.Types.ObjectId.isValid(id) ? await BuddyInvite.findOne({ _id: id, toId: fromId }) : null;
  const ev = invite ? await Event.findById(invite.eventId) : null;

  // Уже ответили, истекло или сходки больше нет
  const stale = !invite || invite.status !== 'pending' || !ev || !ev.isActive || invite.expiresAt.getTime() <= Date.now();
  if (stale) {
    if (invite?.status === 'pending') await BuddyInvite.updateOne({ _id: invite._id, status: 'pending' }, { $set: { status: 'expired' } });
    await answer(query.id, T.stale);
    await clearButtons(fromId, messageId, ev?.isActive ? ev : null);
    return true;
  }
  if (action === 'n') {
    const done = await BuddyInvite.updateOne({ _id: invite._id, status: 'pending' }, { $set: { status: 'declined', respondedAt: new Date() } });
    await answer(query.id, T.declinedOk);
    await clearButtons(fromId, messageId, ev);
    if (done.modifiedCount) {
      const me = await User.findOne({ telegramId: fromId }, { firstName: 1 }).lean();
      await sendWithButtons(invite.fromId, T.declined(escapeHtml(me?.firstName || query.from?.first_name || 'Знакомый')), [
        [{ text: T.moreBtn, path: `${eventAppPath(ev)}&buddy=1` }]
      ]);
    }
    return true;
  }

  if (action !== 'y') return answer(query.id), true;
  const me = await User.findOne({ telegramId: fromId });
  const joined = await joinEvent(ev, me, { id: fromId, first_name: query.from?.first_name, username: query.from?.username }, { guests: 0, withKids: false, buddyOf: invite.fromId });
  if (!joined.ok) {
    // Например, места закончились: приглашение остаётся, пусть истечёт само
    await answer(query.id, joined.error, true);
    return true;
  }
  const done = await BuddyInvite.updateOne({ _id: invite._id, status: 'pending' }, { $set: { status: 'accepted', respondedAt: new Date() } });
  await answer(query.id);
  await clearButtons(fromId, messageId, ev);
  if (!done.modifiedCount) return true;
  sendTelegramMessage(fromId, ev.byRequest ? T.requested : T.joined, 'Открыть сходку', eventAppPath(ev));
  sendTelegramMessage(invite.fromId, T.accepted(escapeHtml(me?.firstName || query.from?.first_name || 'Знакомый'), escapeHtml(ev.title)), 'Открыть сходку', eventAppPath(ev));
  return true;
}

/* ---------- Истечение ---------- */

// Без ответа сутки или до сходки меньше 3 часов: тихо истекает (никому не пишем, только убираем кнопки)
async function expireInvites() {
  const due = await BuddyInvite.find({ status: 'pending', expiresAt: { $lte: new Date() } }).limit(200).lean();
  for (const inv of due) {
    const res = await BuddyInvite.updateOne({ _id: inv._id, status: 'pending' }, { $set: { status: 'expired' } });
    if (!res.modifiedCount) continue;
    const ev = await Event.findById(inv.eventId);
    await clearButtons(inv.toId, inv.messageId, ev?.isActive ? ev : null);
    await new Promise((r) => setTimeout(r, 60));
  }
}

export function startBuddyLoop() {
  const run = () => expireInvites().catch((err) => console.warn('⚠️ «Пойдём вместе», истечение:', err?.message || err));
  setTimeout(run, 60 * 1000);
  setInterval(run, 10 * 60 * 1000);
}

/* ---------- Для карточки сходки и напоминаний ---------- */

// Кто «👯 идут вместе» (оба ещё в списке) и сколько таких пар
export function buddyPairIds(ev: IEvent): { ids: Set<number>; pairs: number } {
  const going = new Set(ev.participants.map((p) => p.telegramId));
  const ids = new Set<number>();
  let pairs = 0;
  for (const p of ev.participants) {
    if (!p.buddyOf || !going.has(p.buddyOf)) continue;
    ids.add(p.telegramId);
    ids.add(p.buddyOf);
    pairs++;
  }
  return { ids, pairs };
}

/* ---------- Для приложения ---------- */

type Formatter = (ev: IEvent, viewerId: number) => any;

const personOut = (u: any) => ({
  telegramId: u.telegramId,
  firstName: u.firstName,
  age: u.ageConfirmed === false ? undefined : u.age,
  areaName: u.isTourist ? 'В Минске проездом' : u.areaName || 'Минск',
  avatarUrl: u.photosHidden ? '' : avatarFor(u.telegramId, u.avatarUrl)
});

// Общие «Хочу сходить»: один вид (вид спорта может отличаться — это «похожее»)
async function sharedWishes(myId: number, friendId: number) {
  const live = { status: { $in: ['active', 'matched'] }, windowEnd: { $gt: new Date() } };
  const [mine, theirs] = await Promise.all([Wish.find({ telegramId: myId, ...live }).lean(), Wish.find({ telegramId: friendId, ...live }).lean()]);
  const out: { kind: string; sport: string | null; what: string; when: string; timeWindow: string }[] = [];
  for (const w of mine) {
    const same = theirs.find((t) => t.kind === w.kind && (t.sport || null) === (w.sport || null)) || theirs.find((t) => t.kind === w.kind);
    if (!same || out.some((o) => o.kind === w.kind && o.sport === (w.sport || null))) continue;
    out.push({ kind: w.kind, sport: w.sport || null, what: await phraseFor(w.kind, w.sport), when: WISH_TEXTS.when[w.timeWindow], timeWindow: w.timeWindow });
  }
  return out.slice(0, 3);
}

// Куда можно позвать знакомого: до 5 сходок, сначала те, что интересны обоим, потом ближайшие
async function fitEventsFor(me: IUser, friend: IUser, limit = OPTIONS_MAX): Promise<{ ev: IEvent; bothLike: boolean }[]> {
  const myId = me.telegramId;
  const friendId = friend.telegramId;
  const hidden = (me.hiddenEvents || []).filter((id) => mongoose.Types.ObjectId.isValid(id));
  const [events, invited] = await Promise.all([
    Event.find({ ...openQuery(), 'participants.telegramId': { $ne: friendId }, ...(hidden.length ? { _id: { $nin: hidden } } : {}) })
      .sort({ dateTime: 1 })
      .limit(300),
    BuddyInvite.distinct('eventId', { fromId: myId, toId: friendId })
  ]);
  const invitedSet = new Set(invited.map(String));
  const both = (ev: IEvent) => likes(goalsOf(me), ev.category) && likes(goalsOf(friend), ev.category);
  return events
    .filter((ev) => !invitedSet.has(String(ev._id)) && !inviteBlock(ev, me, friend))
    .map((ev) => ({ ev, bothLike: both(ev) }))
    .sort((a, b) => Number(b.bothLike) - Number(a.bothLike) || a.ev.dateTime.getTime() - b.ev.dateTime.getTime())
    .slice(0, limit);
}

/**
 * Мостик «На связи → сходка» для сообщения «Вы на связи!»: строка про общее «Хочу сходить»
 * или про сходку, интересную обоим. null — сказать нечего, пишем только общую подсказку
 */
export async function matchBridgeLine(me: IUser, friend: IUser): Promise<string | null> {
  const wishes = await sharedWishes(me.telegramId, friend.telegramId);
  if (wishes.length) return T.bridgeWish(wishes[0].what, wishes[0].when);
  // Только сходки по шаблонам: у «Своей идеи» категорию выбирает организатор, и она часто случайная
  const pick = (await fitEventsFor(me, friend, 50)).find(({ ev, bothLike }) => bothLike && ev.templateId && ev.templateId !== CUSTOM_TEMPLATE_KEY);
  if (pick) return T.bridgeEvent(escapeHtml(pick.ev.title), formatWhen(pick.ev.dateTime));
  return null;
}

export function setupBuddyRoutes(app: Express, formatEvent: Formatter) {
  // Из «На связи»: куда позвать этого человека — до 5 сходок, общие желания
  app.get('/api/buddies/:friendId/options', telegramAuthMiddleware as any, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const myId = req.telegramUser!.id;
      const friendId = Number(req.params.friendId);
      const [me, friend] = await Promise.all([User.findOne({ telegramId: myId }), Number.isSafeInteger(friendId) ? User.findOne({ telegramId: friendId }) : null]);
      if (!me || !friend || blockedEither(me, friend) || !(await isMatch(myId, friendId))) return res.status(403).json({ error: T.notMatch });

      const fit = await fitEventsFor(me, friend);

      res.json({
        friend: personOut(friend),
        events: fit.map(({ ev, bothLike }) => ({ ...formatEvent(ev, myId), bothLike })),
        wishes: await sharedWishes(myId, friendId),
        left: await invitesLeft(myId),
        limit: BUDDY_DAILY_LIMIT
      });
    } catch (err: any) {
      console.warn('⚠️ /api/buddies/options:', err?.message || err);
      res.status(500).json({ error: 'Не удалось загрузить сходки' });
    }
  });

  // Из карточки сходки: кого из «На связи» можно позвать с собой
  app.get('/api/events/:id/buddies', telegramAuthMiddleware as any, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const myId = req.telegramUser!.id;
      const id = String(req.params.id);
      const [me, ev] = await Promise.all([User.findOne({ telegramId: myId }), mongoose.Types.ObjectId.isValid(id) ? Event.findById(id) : null]);
      if (!me || !ev) return res.status(404).json({ error: 'Сходка не найдена' });
      if (!openForBuddies(ev)) return res.json({ people: [], left: await invitesLeft(myId), limit: BUDDY_DAILY_LIMIT, closed: T.notOpen });

      const ids = (await matchIdsOf(myId)).filter((x) => !(me.blockedUsers || []).includes(x));
      const [friends, invites] = await Promise.all([
        User.find({ telegramId: { $in: ids }, isBanned: { $ne: true }, blockedUsers: { $ne: myId } }),
        BuddyInvite.find({ eventId: ev._id, fromId: myId }, { toId: 1, status: 1 }).lean()
      ]);
      const invitedStatus = new Map(invites.map((i) => [i.toId, i.status]));
      const mySelf = joinBlockReason(ev, me, myId);
      const people = friends
        // Не подходит по условиям организатора или уже идёт — не показываем вовсе
        .filter((u) => !isGoing(ev, u.telegramId) && !isEventCreator(ev, u.telegramId) && !joinBlockReason(ev, u, u.telegramId))
        .map((u) => ({ ...personOut(u), invited: invitedStatus.get(u.telegramId) || null }))
        .sort((a, b) => Number(Boolean(a.invited)) - Number(Boolean(b.invited)) || a.firstName.localeCompare(b.firstName, 'ru'));
      res.json({
        people,
        left: await invitesLeft(myId),
        limit: BUDDY_DAILY_LIMIT,
        closed: mySelf || (freeSeats(ev) < seatsNeeded(ev, myId) ? T.noSeats : null)
      });
    } catch (err: any) {
      console.warn('⚠️ /api/events/:id/buddies:', err?.message || err);
      res.status(500).json({ error: 'Не удалось загрузить список' });
    }
  });

  // Отправить приглашение
  app.post('/api/buddies/invite', telegramAuthMiddleware as any, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const myId = req.telegramUser!.id;
      const eventId = String(req.body?.eventId || '');
      const toId = Number(req.body?.toId);
      const source: BuddySource = req.body?.source === 'event' ? 'event' : req.body?.source === 'match' ? 'match' : 'people';
      const [me, ev] = await Promise.all([User.findOne({ telegramId: myId }), mongoose.Types.ObjectId.isValid(eventId) ? Event.findById(eventId) : null]);
      if (!me || !ev) return res.status(404).json({ error: 'Сходка не найдена' });
      const { delivered } = await sendBuddyInvite(ev, me, toId, source);
      res.json({ delivered, ...(delivered ? {} : { warning: T.undelivered }), event: formatEvent(ev, myId), left: await invitesLeft(myId) });
    } catch (err: any) {
      if (err instanceof BuddyError) return res.status(err.status).json({ error: err.message });
      console.warn('⚠️ /api/buddies/invite:', err?.message || err);
      res.status(500).json({ error: 'Не получилось отправить приглашение, попробуй ещё раз' });
    }
  });
}

/* ---------- /stats ---------- */

export async function buddyStatsLines(): Promise<string[]> {
  const now = Date.now();
  const week = new Date(now - 7 * DAY);
  const rows = await BuddyInvite.aggregate([{ $match: { createdAt: { $gte: week } } }, { $group: { _id: '$status', n: { $sum: 1 } } }]);
  const by = (s: BuddyStatus) => rows.find((r) => r._id === s)?.n || 0;
  const sent = rows.reduce((sum, r) => sum + r.n, 0);
  if (!sent && !(await BuddyInvite.exists({}))) return [];

  // Пришедшие по приглашению: прошедшие сходки за 30 дней, человек в списке и не отмечен «Не пришёл(ла)»
  const past = await Event.find(
    { dateTime: { $gte: new Date(now - 30 * DAY), $lt: new Date(now) }, 'participants.buddyOf': { $exists: true } },
    { participants: 1, feedback: 1, dateTime: 1, creator: 1 }
  ).lean();
  const came: { id: number; at: Date; score?: number }[] = [];
  for (const ev of past) {
    for (const p of ev.participants) {
      if (!p.buddyOf || p.noShowAt) continue;
      came.push({ id: p.telegramId, at: ev.dateTime, score: (ev.feedback || []).find((f) => f.telegramId === p.telegramId)?.score });
    }
  }
  // Впервые: раньше не было ни одной сходки, где человек был в списке
  let first = 0;
  for (const c of came) {
    if (!(await Event.exists({ dateTime: { $lt: c.at }, 'participants.telegramId': c.id }))) first++;
  }
  const scores = came.map((c) => c.score).filter((s): s is number => typeof s === 'number');
  const avg = scores.length ? (scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(1).replace('.', ',') : '';

  // Сколько отправили из шторки, открытой по кнопке в сообщении «Вы на связи»
  const fromMatch = await BuddyInvite.aggregate([
    { $match: { createdAt: { $gte: week }, source: 'match' } },
    { $group: { _id: null, n: { $sum: 1 }, accepted: { $sum: { $cond: [{ $eq: ['$status', 'accepted'] }, 1, 0] } } } }
  ]);

  return [
    T.statsTitle,
    T.statsSent(sent, by('accepted'), by('declined'), by('expired'), by('pending'), by('undelivered')),
    ...(fromMatch[0]?.n ? [T.statsFromMatch(fromMatch[0].n, fromMatch[0].accepted)] : []),
    T.statsCame(came.length, first),
    ...(scores.length ? [T.statsScore(avg, scores.length)] : [])
  ];
}
