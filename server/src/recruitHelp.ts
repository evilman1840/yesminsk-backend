import mongoose, { Schema, model, Types } from 'mongoose';
import { Event, IEvent } from './models/Event';
import { User } from './models/User';
import { Wish } from './models/Wish';
import { CUSTOM_TEMPLATE_KEY } from './models/EventTemplate';
import { joinEvent, joinBlockReason, freeSeats } from './eventJoin';
import { seatsTaken, formatWhen, eventAppPath } from './eventNotify';
import { audienceUsersQuery } from './eventAudience';
import { theirPreferencesAllow } from './preferences';
import { phraseFor, sendWithButtons } from './wishes';
import { matchIdsOf } from './buddyInvites';
import { nearestArea } from './utils/userLocation';
import { escapeHtml, sendTelegramMessage } from './utils/telegramNotify';
import { RECRUIT_TEXTS as T } from './texts';

/**
 * «Помощь в наборе»: до начала меньше 48 часов, а идут (с организатором и гостями) меньше трёх.
 * Сходка состоится при любом числе людей: ничего не отменяем и не предлагаем отменить. Только помогаем:
 * — сходка выше в ленте и в «💡 Подсказках» (флаг recruiting в formatEvent, бонус в eventRanking.ts);
 * — тем, у кого желание «🙋 Хочу сходить» того же вида на эти дни, бот пишет один раз
 *   (не больше одного такого сообщения в день на человека, с учётом условий сходки, заходил за 21 день);
 * — организатору один раз подсказка позвать кого-то из «На связи»
 */

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const MINSK = 3 * HOUR; // Минск: UTC+3 круглый год
export const RECRUIT_HOURS = 48;
export const RECRUIT_MIN = 3;
const ACTIVE_DAYS = 21;
const PER_EVENT_MAX = 15;  // больше этого на одну сходку не пишем: «не хватает пары человек»
const BUDDY_CUTOFF = 3;    // «Позвать с собой» закрывается за 3 часа до начала (buddyInvites.ts)

const minskDayStart = (now = Date.now()) => new Date(now - ((now + MINSK) % DAY));
const isDaytime = (now = Date.now()) => {
  const h = new Date(now + MINSK).getUTCHours();
  return h >= 10 && h < 22;
};

// Сходке нужна помощь: впереди, начнётся меньше чем через 48 часов, идут меньше трёх и есть места
export function needsRecruitHelp(ev: IEvent, now = Date.now()) {
  const t = new Date(ev.dateTime).getTime();
  return Boolean(ev.isActive) && t > now && t - now <= RECRUIT_HOURS * HOUR && seatsTaken(ev) < RECRUIT_MIN && freeSeats(ev) > 0;
}

/* ---------- Кому уже писали ---------- */

type PingStatus = 'sent' | 'joined' | 'declined' | 'undelivered';

interface IRecruitPing {
  _id: Types.ObjectId;
  eventId: Types.ObjectId;
  toId: number;
  status: PingStatus;
  messageId?: number;
  createdAt: Date;
}

const RecruitPingSchema = new Schema<IRecruitPing>(
  {
    eventId: { type: Schema.Types.ObjectId, required: true },
    toId: { type: Number, required: true },
    status: { type: String, enum: ['sent', 'joined', 'declined', 'undelivered'], default: 'sent', index: true },
    messageId: { type: Number }
  },
  { timestamps: true }
);
// Одному человеку про одну сходку — один раз
RecruitPingSchema.index({ eventId: 1, toId: 1 }, { unique: true });
RecruitPingSchema.index({ toId: 1, createdAt: -1 });
RecruitPingSchema.index({ createdAt: -1 });

export const RecruitPing = model<IRecruitPing>('RecruitPing', RecruitPingSchema);

/* ---------- Отправка ---------- */

const tg = async (method: string, body: any): Promise<any> => {
  const res = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }).catch(() => null);
  return res ? res.json().catch(() => null) : null;
};

// Организатору — один раз: позови кого-то из «На связи». Только если есть кого и сюда можно звать
async function tipHost(ev: IEvent, now: number) {
  if (ev.recruitHostTipAt) return;
  if (ev.maxParticipants === 2 || ev.dateTime.getTime() <= now + BUDDY_CUTOFF * HOUR) return;
  const hostId = ev.creator.telegramId;
  if (!(await matchIdsOf(hostId)).length) return;
  const done = await Event.updateOne({ _id: ev._id, recruitHostTipAt: { $exists: false } }, { $set: { recruitHostTipAt: new Date() } });
  if (!done.modifiedCount) return;
  const others = seatsTaken(ev) - 1 - (ev.participants.find((p) => p.telegramId === hostId)?.guests || 0);
  await sendWithButtons(hostId, T.hostTip(escapeHtml(ev.title), Math.max(0, others)), [[{ text: T.hostBtn, path: `${eventAppPath(ev)}&buddy=1` }]]);
}

// Вид спорта (или другой выбор шаблона) в желании должен совпасть с тем, что выбрал организатор
const optionFits = (ev: IEvent, sport?: string | null) => {
  if (!sport) return true;
  const values = Object.values(ev.extras || {});
  return !values.length || values.includes(sport);
};

// Тем, кто сам отметил желание того же вида на эти дни
async function pingWishers(ev: IEvent, now: number) {
  if (!ev.templateId || ev.templateId === CUSTOM_TEMPLATE_KEY) return;
  const already = await RecruitPing.find({ eventId: ev._id }, { toId: 1 }).lean();
  const left = PER_EVENT_MAX - already.length;
  if (left <= 0) return;

  const hostId = ev.creator.telegramId;
  const skip = new Set<number>([hostId, ...ev.participants.map((p) => p.telegramId), ...(ev.cancellations || []).map((c) => c.telegramId), ...already.map((p) => p.toId)]);
  const wishes = (
    await Wish.find({
      kind: ev.templateId,
      status: { $in: ['active', 'matched'] },
      windowStart: { $lte: ev.dateTime },
      windowEnd: { $gte: ev.dateTime }
    }).lean()
  ).filter((w) => !skip.has(w.telegramId) && optionFits(ev, w.sport));
  if (!wishes.length) return;

  // Сегодня уже получил такое сообщение (про другую сходку) — не пишем
  const today = new Set((await RecruitPing.distinct('toId', { toId: { $in: wishes.map((w) => w.telegramId) }, createdAt: { $gte: minskDayStart(now) } })).map(Number));
  const host = await User.findOne({ telegramId: hostId }, { gender: 1, age: 1, blockedUsers: 1 }).lean();
  const users = await User.find(
    {
      telegramId: { $in: [...new Set(wishes.map((w) => w.telegramId))].filter((id) => !today.has(id)), $nin: host?.blockedUsers || [] },
      hasAgreedToRules: true,
      isBanned: { $ne: true },
      canMessage: { $ne: false },
      lastActiveAt: { $gte: new Date(now - ACTIVE_DAYS * DAY) },
      blockedUsers: { $ne: hostId },
      hiddenEvents: { $ne: String(ev._id) },
      ...audienceUsersQuery(ev), // пол и возраст
      $and: theirPreferencesAllow(host) // не пишем тем, кто не хочет общаться с полом или возрастом организатора
    },
    { telegramId: 1, gender: 1, age: 1, isEmpath: 1 }
  )
    .sort({ lastActiveAt: -1 })
    .lean();
  // «Только эмпаты», отказ организатора — как при записи
  const fit = users.filter((u) => !joinBlockReason(ev, u as any, u.telegramId)).slice(0, left);
  if (!fit.length) return;

  const where = escapeHtml(nearestArea(ev.location?.coordinates) || ev.locationName);
  const when = formatWhen(ev.dateTime);
  const title = escapeHtml(ev.title);
  for (const u of fit) {
    const wish = wishes.find((w) => w.telegramId === u.telegramId)!;
    let ping: IRecruitPing;
    try {
      ping = (await RecruitPing.create({ eventId: ev._id, toId: u.telegramId })).toObject();
    } catch (err: any) {
      if (err?.code === 11000) continue;
      throw err;
    }
    const html = T.wish(escapeHtml(await phraseFor(wish.kind, wish.sport)), title, when, where);
    const res = await tg('sendMessage', {
      chat_id: u.telegramId,
      text: html,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      reply_markup: {
        inline_keyboard: [
          [
            { text: T.goBtn, callback_data: `rcr:y:${ping._id}` },
            { text: T.skipBtn, callback_data: `rcr:n:${ping._id}` }
          ]
        ]
      }
    });
    if (res?.ok && res.result?.message_id) await RecruitPing.updateOne({ _id: ping._id }, { $set: { messageId: res.result.message_id } });
    else {
      await RecruitPing.updateOne({ _id: ping._id }, { $set: { status: 'undelivered' } });
      if (res?.error_code === 403) User.updateOne({ telegramId: u.telegramId }, { $set: { canMessage: false, botBlockedAt: new Date() } }).catch(() => {});
    }
    await new Promise((r) => setTimeout(r, 60));
  }
}

let running = false;
async function runRecruit() {
  if (running) return;
  running = true;
  try {
    const now = Date.now();
    const events = await Event.find({ isActive: true, dateTime: { $gt: new Date(now), $lte: new Date(now + RECRUIT_HOURS * HOUR) } });
    for (const ev of events) {
      if (!needsRecruitHelp(ev, now)) continue;
      // Отметку ставим и ночью — для /stats; писать — только днём
      if (!ev.recruitHelpAt) await Event.updateOne({ _id: ev._id, recruitHelpAt: { $exists: false } }, { $set: { recruitHelpAt: new Date() } });
      if (!isDaytime(now) || !process.env.TELEGRAM_BOT_TOKEN) continue;
      await tipHost(ev, now);
      await pingWishers(ev, now);
    }
  } finally {
    running = false;
  }
}

export function startRecruitLoop() {
  const run = () => runRecruit().catch((err) => console.warn('⚠️ «Помощь в наборе»:', err?.message || err));
  setTimeout(run, 3 * 60 * 1000);
  setInterval(run, 10 * 60 * 1000);
}

/* ---------- Кнопки «Пойду» / «Не подходит» ---------- */

export async function handleRecruitCallback(query: any): Promise<boolean> {
  const data: string = query.data || '';
  if (!data.startsWith('rcr:')) return false;
  const [, action, id] = data.split(':');
  const fromId: number = query.from?.id;
  const chatId: number = query.message?.chat?.id;
  const messageId: number | undefined = query.message?.message_id;
  const answer = (text = '', alert = false) => tg('answerCallbackQuery', { callback_query_id: query.id, text, show_alert: alert });

  const ping = mongoose.Types.ObjectId.isValid(id) ? await RecruitPing.findOne({ _id: id, toId: fromId }) : null;
  if (!ping) return answer(), true;

  // «Не подходит» — просто закрываем сообщение
  if (action === 'n') {
    if (ping.status === 'sent') await RecruitPing.updateOne({ _id: ping._id }, { $set: { status: 'declined' } });
    await answer();
    if (messageId) {
      const del = await tg('deleteMessage', { chat_id: chatId, message_id: messageId });
      if (!del?.ok) await tg('editMessageReplyMarkup', { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } });
    }
    return true;
  }
  if (action !== 'y') return answer(), true;

  const ev = await Event.findById(ping.eventId);
  const appUrl = (process.env.MINI_APP_URL || '').replace(/\/+$/, '');
  const openRow = ev && appUrl ? [[{ text: T.openBtn, web_app: { url: `${appUrl}/${eventAppPath(ev)}` } }]] : [];
  if (!ev || !ev.isActive || ev.dateTime.getTime() <= Date.now()) {
    await answer(T.stale);
    if (messageId) await tg('editMessageReplyMarkup', { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } });
    return true;
  }
  const me = await User.findOne({ telegramId: fromId });
  const joined = await joinEvent(ev, me, { id: fromId, first_name: query.from?.first_name, username: query.from?.username }, { guests: 0, withKids: false, viaRecruit: true });
  if (!joined.ok) {
    await answer(joined.error, true);
    return true;
  }
  await RecruitPing.updateOne({ _id: ping._id }, { $set: { status: 'joined' } });
  await answer();
  if (messageId) await tg('editMessageReplyMarkup', { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: openRow } });
  sendTelegramMessage(fromId, ev.byRequest ? T.requested : T.joined, T.openBtn, eventAppPath(ev));
  return true;
}

/* ---------- /stats ---------- */

const pct = (part: number, total: number) => (total ? `${Math.round((part / total) * 100)}%` : '0%');

export async function recruitStatsLines(): Promise<string[]> {
  const now = Date.now();
  const since = new Date(now - 7 * DAY);

  // Попали в помощь за 7 дней и сколько из прошедших набрали 3+ (пришедшие с организатором и гостями)
  const helped = await Event.find({ recruitHelpAt: { $gte: since } }, { dateTime: 1, isActive: 1, participants: 1 }).lean();
  const cameSeats = (e: any) => (e.participants || []).filter((p: any) => !p.noShowAt).reduce((s: number, p: any) => s + 1 + (p.guests || 0), 0);
  const done = helped.filter((e) => e.isActive && new Date(e.dateTime).getTime() <= now);
  const gathered = done.filter((e) => cameSeats(e) >= RECRUIT_MIN).length;
  const upcoming = helped.filter((e) => e.isActive && new Date(e.dateTime).getTime() > now).length;

  // Сообщения «Компания собирается»
  const rows = await RecruitPing.aggregate([{ $match: { createdAt: { $gte: since } } }, { $group: { _id: '$status', n: { $sum: 1 } } }]);
  const by = (s: PingStatus) => rows.find((r) => r._id === s)?.n || 0;
  const sent = rows.reduce((s, r) => s + r.n, 0) - by('undelivered');

  // Сходки, про которые писали, но их уже удалили: из Event они пропали, и в «Попали в помощь» их не видно
  const pingedIds: Types.ObjectId[] = await RecruitPing.distinct('eventId', { createdAt: { $gte: since } });
  const aliveIds = new Set((await Event.find({ _id: { $in: pingedIds } }, { _id: 1 }).lean()).map((e) => String(e._id)));
  const deleted = pingedIds.filter((id) => !aliveIds.has(String(id))).length;

  // Явка — только там, где организатор ответил «Все пришли?». Гостей не считаем: их не отметить
  const past = await Event.find(
    { isActive: true, dateTime: { $gte: since, $lte: new Date(now) } },
    { participants: 1, creator: 1, feedbackHostAskedAt: 1, attendanceAnsweredAt: 1 }
  ).lean();
  // Бот спрашивает организатора, только если записался кто-то, кроме него
  const asked = past.filter((e) => e.feedbackHostAskedAt && (e.participants || []).some((p) => p.telegramId !== e.creator.telegramId));
  const answered = asked.filter((e) => e.attendanceAnsweredAt);
  let signed = 0;
  let came = 0;
  for (const e of answered) {
    const list = (e.participants || []).filter((p) => p.telegramId !== e.creator.telegramId);
    signed += list.length;
    came += list.filter((p) => !p.noShowAt).length;
  }

  // Вдвоём: пришли только организатор и один участник, без гостей
  const held = past.filter((e) => new Set((e.participants || []).filter((p) => !p.noShowAt).map((p) => p.telegramId)).size >= 2);
  const pairs = held.filter((e) => {
    const cameList = (e.participants || []).filter((p) => !p.noShowAt);
    return cameList.length === 2 && cameList.some((p) => p.telegramId === e.creator.telegramId) && cameList.every((p) => !p.guests);
  }).length;

  return [
    T.statsTitle,
    T.statsHelp(helped.length + deleted, gathered, done.length, upcoming, deleted),
    T.statsPings(sent, by('joined'), by('declined')),
    answered.length ? T.statsAttendance(pct(came, signed), came, signed, answered.length, asked.length) : T.statsAttendanceNone(asked.length),
    T.statsPairs(pairs, held.length)
  ];
}
