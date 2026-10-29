import { Schema, model } from 'mongoose';
import { User, IUser } from './models/User';
import { Event } from './models/Event';
import { Place } from './models/Place';
import { Wish } from './models/Wish';
import { escapeHtml } from './utils/telegramNotify';
import { formatWhen } from './eventNotify';
import { meetupCreatePath } from './eventTemplates';
import { sendWithButtons, Btn } from './wishes';
import { isAdmin } from './news';
import { NUDGE_TEXTS as T, PROFILE_NUDGE_TEXTS as P, USERNAME_TEXTS as U, peopleCount } from './texts';

/**
 * Приветственный толчок: новичку без активности бот пишет через сутки и (последний раз) через 4 дня.
 * Активность: записался на сходку, собрал сходку или отметил желание. «Не сейчас» — больше не пишем.
 * Время: будни 18:00, выходные 12:00 по Минску
 */

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const MINSK = 3 * HOUR;
const FIRST_AFTER = DAY;
const SECOND_AFTER = 4 * DAY;
const MAX_AGE = 6 * DAY; // старше — уже не новичок, не пишем

type Variant = 'A' | 'B' | 'C' | 'second';

// Журнал отправок: какой вариант работает лучше
export const NudgeLog = model(
  'NudgeLog',
  new Schema({
    telegramId: { type: Number, required: true, index: true },
    n: { type: Number, required: true }, // 1 или 2
    variant: { type: String, enum: ['A', 'B', 'C', 'second', 'profile'], required: true },
    sentAt: { type: Date, default: Date.now, index: true }
  })
);

// Будни 18:00–19:00, выходные 12:00–13:00
const isSendSlot = (now = new Date()) => {
  const m = new Date(now.getTime() + MINSK);
  const weekend = m.getUTCDay() === 0 || m.getUTCDay() === 6;
  return m.getUTCHours() === (weekend ? 12 : 18);
};

// Уже что-то сделал в приложении?
async function hasActivity(telegramId: number) {
  return Boolean(
    (await Event.exists({ 'participants.telegramId': telegramId })) || (await Event.exists({ 'creator.telegramId': telegramId })) || (await Wish.exists({ telegramId }))
  );
}

// Первое сообщение: А — ближайшие сходки, Б — сохранённое место, которое хотят и другие, В — простой шаг
async function firstMessage(user: IUser): Promise<{ variant: Variant; html: string; rows: Btn[][] }> {
  const off: Btn[] = [{ text: T.offBtn, data: 'ndg:off' }];
  const now = new Date();
  const soon = await Event.find({
    isActive: true,
    dateTime: { $gte: now, $lte: new Date(now.getTime() + 3 * DAY) },
    'creator.telegramId': { $ne: user.telegramId }
  })
    .sort({ dateTime: 1 })
    .limit(2);
  if (soon.length) {
    return {
      variant: 'A',
      html: [T.eventsTitle, ...soon.map((e) => T.eventLine(escapeHtml(e.title), formatWhen(e.dateTime))), '', T.eventsEnd].join('\n'),
      rows: [[{ text: T.eventsBtn, path: '?tab=events' }], off]
    };
  }

  const saved = (user.savedPlaces || []).filter(Boolean);
  if (saved.length) {
    // Самое популярное из сохранённых: сколько ещё людей его сохранили
    const counts = await User.aggregate([
      { $match: { savedPlaces: { $in: saved }, telegramId: { $ne: user.telegramId }, isBanned: { $ne: true } } },
      { $unwind: '$savedPlaces' },
      { $match: { savedPlaces: { $in: saved } } },
      { $group: { _id: '$savedPlaces', n: { $sum: 1 } } },
      { $sort: { n: -1 } },
      { $limit: 1 }
    ]);
    const top = counts[0];
    const place = top ? await Place.findById(top._id, { name: 1 }).lean() : null;
    if (top && place) {
      return {
        variant: 'B',
        html: T.place(escapeHtml(place.name), peopleCount(top.n)),
        rows: [
          [{ text: T.placeBuildBtn, path: meetupCreatePath({ placeId: String(top._id) }) }],
          [{ text: T.wishBtn, path: `?want=1&place=${top._id}` }],
          off
        ]
      };
    }
  }

  return {
    variant: 'C',
    html: T.simple,
    rows: [[{ text: T.wishBtn, path: '?want=1' }], [{ text: T.buildBtn, path: meetupCreatePath() }], off]
  };
}

const secondMessage = () => ({
  variant: 'second' as Variant,
  html: T.second,
  rows: [[{ text: T.wishBtn, path: '?want=1' }], [{ text: T.offBtn, data: 'ndg:off' }]] as Btn[][]
});

let running = false;
export async function runNudges(force = false) {
  if (running || !process.env.TELEGRAM_BOT_TOKEN || (!force && !isSendSlot())) return;
  running = true;
  try {
    const now = Date.now();
    const users = await User.find({
      hasAgreedToRules: true,
      isBanned: { $ne: true },
      nudgeOptedOut: { $ne: true },
      nudge2SentAt: { $exists: false },
      createdAt: { $gte: new Date(now - MAX_AGE), $lte: new Date(now - FIRST_AFTER) }
    });
    for (const user of users) {
      if (await hasActivity(user.telegramId)) continue;
      const age = now - new Date((user as any).createdAt).getTime();
      let msg: { variant: Variant; html: string; rows: Btn[][] } | null = null;
      let n = 0;
      if (!user.nudge1SentAt) {
        msg = await firstMessage(user);
        n = 1;
      } else if (age >= SECOND_AFTER && now - user.nudge1SentAt.getTime() >= 2 * DAY) {
        msg = secondMessage();
        n = 2;
      }
      if (!msg) continue;
      // Отмечаем до отправки — чтобы при сбое не написать дважды
      await User.updateOne({ _id: user._id }, { $set: n === 1 ? { nudge1SentAt: new Date() } : { nudge2SentAt: new Date() } });
      await sendWithButtons(user.telegramId, msg.html, msg.rows);
      await NudgeLog.create({ telegramId: user.telegramId, n, variant: msg.variant });
      await new Promise((r) => setTimeout(r, 60));
    }
    await runProfileNudges(now);
    await runUsernameNudges(now);
  } finally {
    running = false;
  }
}

/* ---------- Разовое напоминание «заполни анкету подробнее» ---------- */

// Что не заполнено: своё фото, о себе, интересы, «обычно хожу»
export const missingProfileParts = (u: IUser) => {
  const parts: string[] = [];
  if (!u.avatarUrl || u.avatarUrl.includes('images.unsplash.com')) parts.push(P.photo);
  if (!u.bio || u.bio.trim().length < 10) parts.push(P.bio);
  if (!u.goals?.length) parts.push(P.goals);
  if (!u.goesWith) parts.push(P.goesWith);
  return parts;
};
const PROFILE_PARTS = 5; // имя + 4 пункта выше

const profileMessage = (u: IUser | null) => {
  // null — пример для пустой анкеты (превью /nudge)
  const missing = u ? missingProfileParts(u) : [P.photo, P.bio, P.goals, P.goesWith];
  const percent = Math.round(((PROFILE_PARTS - missing.length) / PROFILE_PARTS) * 100);
  return { html: [P.intro(percent, missing.length), '', ...missing.map((m) => `• ${m}`), '', P.outro].join('\n'), rows: [[{ text: P.button, path: '?tab=profile' }]] as Btn[][] };
};

// Один раз: не раньше чем через 3 дня после регистрации и не в день приветственного сообщения.
// Пишем, если нет своего фото или «о себе»; в сообщении — всё, чего не хватает
async function runProfileNudges(now: number) {
  const users = await User.find({
    hasAgreedToRules: true,
    isBanned: { $ne: true },
    profileNudgeSentAt: { $exists: false },
    createdAt: { $lte: new Date(now - 3 * DAY) },
    $or: [{ avatarUrl: { $regex: 'images\\.unsplash\\.com' } }, { avatarUrl: { $in: ['', null] } }, { bio: { $in: ['', null] } }, { bio: { $regex: '^.{0,9}$', $options: 's' } }]
  });
  for (const user of users) {
    const lastNudge = Math.max(user.nudge1SentAt?.getTime() || 0, user.nudge2SentAt?.getTime() || 0);
    if (now - lastNudge < DAY) continue; // в один день с приветственным не пишем
    if (!missingProfileParts(user).length) continue;
    await User.updateOne({ _id: user._id }, { $set: { profileNudgeSentAt: new Date() } });
    const msg = profileMessage(user);
    await sendWithButtons(user.telegramId, msg.html, msg.rows);
    await NudgeLog.create({ telegramId: user.telegramId, n: 3, variant: 'profile' });
    await new Promise((r) => setTimeout(r, 60));
  }
}

/* ---------- Разовое напоминание «заведи @username» ---------- */

// Без @username человеку не могут написать первым ни «На связи», ни организатор сходки.
// Один раз, не раньше чем через сутки после регистрации и не в день другого напоминания
async function runUsernameNudges(now: number) {
  const users = await User.find({
    hasAgreedToRules: true,
    isBanned: { $ne: true },
    canMessage: { $ne: false },
    username: { $in: [null, ''] },
    usernameNudgeSentAt: { $exists: false },
    createdAt: { $lte: new Date(now - DAY) }
  });
  for (const user of users) {
    const lastNudge = Math.max(user.nudge1SentAt?.getTime() || 0, user.nudge2SentAt?.getTime() || 0, user.profileNudgeSentAt?.getTime() || 0);
    if (now - lastNudge < DAY) continue;
    await User.updateOne({ _id: user._id }, { $set: { usernameNudgeSentAt: new Date() } });
    await sendWithButtons(user.telegramId, U.nudge, [[{ text: U.nudgeBtn, path: '?tab=profile' }]]);
    await new Promise((r) => setTimeout(r, 60));
  }
}

export function startNudgeLoop() {
  const run = () => runNudges().catch((err) => console.warn('⚠️ Приветственный толчок:', err?.message || err));
  setTimeout(run, 3 * 60 * 1000);
  setInterval(run, 20 * 60 * 1000); // в нужный час проверка успеет пройти несколько раз, отправка — один
}

// «Не сейчас»
export async function handleNudgeCallback(query: any): Promise<boolean> {
  if (query.data !== 'ndg:off') return false;
  await User.updateOne({ telegramId: query.from?.id }, { $set: { nudgeOptedOut: true } });
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const call = (method: string, body: any) =>
    fetch(`https://api.telegram.org/bot${token}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).catch(() => {});
  call('answerCallbackQuery', { callback_query_id: query.id, text: T.offOk });
  call('editMessageReplyMarkup', { chat_id: query.message?.chat?.id, message_id: query.message?.message_id, reply_markup: { inline_keyboard: [] } });
  return true;
}

// /nudge — автор видит, как выглядят сообщения (без отметок и журнала)
export async function handleNudgeCommand(message: any): Promise<boolean> {
  if (!/^\/nudge\b/i.test((message.text || '').trim()) || !isAdmin(message.from?.id)) return false;
  const me = await User.findOne({ telegramId: message.from.id });
  if (!me) return false;
  const first = await firstMessage(me);
  const second = secondMessage();
  const isFull = !missingProfileParts(me).length;
  const profile = profileMessage(isFull ? null : me);
  await sendWithButtons(message.chat.id, T.previewNote, []);
  await sendWithButtons(message.chat.id, first.html, first.rows.map((r) => r.map((b) => (b.data ? { ...b, data: 'ndg:preview' } : b))));
  await sendWithButtons(message.chat.id, second.html, second.rows.map((r) => r.map((b) => (b.data ? { ...b, data: 'ndg:preview' } : b))));
  if (isFull) await sendWithButtons(message.chat.id, P.previewFull, []);
  await sendWithButtons(message.chat.id, profile.html, profile.rows);
  return true;
}

/* ---------- /stats ---------- */

export async function nudgeStatsLines(since: Date): Promise<string[]> {
  const all = await NudgeLog.find({ sentAt: { $gte: since } }).lean();
  const logs = all.filter((l) => l.variant !== 'profile');
  const profileLogs = all.filter((l) => l.variant === 'profile');
  const profileLines: string[] = [];
  if (profileLogs.length) {
    const ids = profileLogs.map((l) => l.telegramId);
    const filled = (await User.find({ telegramId: { $in: ids } })).filter((u) => !missingProfileParts(u).length).length;
    profileLines.push('', P.statsTitle, P.statsLine(profileLogs.length, filled, `${Math.round((filled / profileLogs.length) * 100)}%`));
  }
  if (!logs.length) return [T.statsTitle, T.statsSent(0, 0), ...profileLines];
  const now = Date.now();
  const lines = [T.statsTitle, T.statsSent(logs.filter((l) => l.n === 1).length, logs.filter((l) => l.n === 2).length)];
  for (const v of ['A', 'B', 'C', 'second']) {
    // Считаем только те, у которых уже прошло 48 часов
    const done = logs.filter((l) => l.variant === v && now - l.sentAt.getTime() >= 2 * DAY);
    const sent = logs.filter((l) => l.variant === v).length;
    if (!sent) continue;
    let acted = 0;
    for (const l of done) {
      const from = l.sentAt;
      const to = new Date(from.getTime() + 2 * DAY);
      const did =
        (await Wish.exists({ telegramId: l.telegramId, createdAt: { $gte: from, $lte: to } })) ||
        (await Event.exists({ 'creator.telegramId': l.telegramId, createdAt: { $gte: from, $lte: to } })) ||
        (await Event.exists({ participants: { $elemMatch: { telegramId: l.telegramId, joinedAt: { $gte: from, $lte: to } } } }));
      if (did) acted++;
    }
    lines.push(T.statsVariant(T.variantNames[v], sent, done.length, acted));
  }
  const nudged = new Set(logs.map((l) => l.telegramId));
  const off = await User.countDocuments({ telegramId: { $in: [...nudged] }, nudgeOptedOut: true });
  lines.push(T.statsOff(off, `${Math.round((off / nudged.size) * 100)}%`));
  return [...lines, ...profileLines];
}
