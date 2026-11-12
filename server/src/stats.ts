import mongoose from 'mongoose';
import { User } from './models/User';
import { Event } from './models/Event';
import { Reaction } from './models/Reaction';
import { Donation } from './models/Donation';
import { News } from './models/News';
import { Place, PlaceTip } from './models/Place';
import { sendTelegramMessage } from './utils/telegramNotify';
import { isAdmin } from './news';
import { meetupStatsLines } from './meetupMetrics';
import { BOT_ACCESS_TEXTS, USERNAME_TEXTS } from './texts';
import { wishStatsLines } from './wishes';
import { nudgeStatsLines } from './nudges';
import { gameStatsLines } from './games';
import { seaStatsLines } from './sea';
import { tractorStatsLines } from './gameScores';
import { waveLimitStatsLines } from './waveLimit';
import { buddyStatsLines } from './buddyInvites';
import { eventExitStatsLines } from './eventLeave';
import { recruitStatsLines } from './recruitHelp';
import { serialStatsLines } from './serial';
import { helloStatsLines } from './hello';
import { fiveDuelCounts } from './games';
import { seaDuelCounts } from './sea';
import { DUEL_TEXTS, WAVE_GATE_TEXTS } from './texts';

// Партии из «На связи» за 7 дней: по строке на игру
async function duelStatsLines(): Promise<string[]> {
  const [five, sea] = await Promise.all([fiveDuelCounts(), seaDuelCounts()]);
  if (!five.sent && !sea.sent) return [];
  return [
    DUEL_TEXTS.statsTitle,
    DUEL_TEXTS.stats('Крестики-Нолики', five.sent, five.accepted, five.finished, five.wrote),
    DUEL_TEXTS.stats('Морской бой', sea.sent, sea.accepted, sea.finished, sea.wrote)
  ];
}

// Шторки пола и @username перед первым 👋 (за всё время: первый показ у каждого человека)
async function waveGateStatsLines(): Promise<string[]> {
  const [gShown, gDone, uShown, uDone, left] = await Promise.all([
    User.countDocuments({ 'waveGate.genderShownAt': { $exists: true } }),
    User.countDocuments({ 'waveGate.genderShownAt': { $exists: true }, genderConfirmed: true }),
    User.countDocuments({ 'waveGate.usernameShownAt': { $exists: true } }),
    User.countDocuments({ 'waveGate.usernameShownAt': { $exists: true }, username: { $nin: [null, ''] } }),
    User.countDocuments({ 'waveGate.leftAt': { $exists: true } })
  ]);
  if (!gShown && !uShown) return [];
  return [WAVE_GATE_TEXTS.statsTitle, WAVE_GATE_TEXTS.stats(gShown, gDone, uShown, uDone, left)];
}

/**
 * /stats — сводка по приложению для автора (только ADMIN_TELEGRAM_IDS)
 */

const DAY = 24 * 60 * 60 * 1000;
const MINSK_OFFSET = 3 * 60 * 60 * 1000; // Минск: UTC+3 круглый год

// Начало сегодняшнего дня по минскому времени
const startOfMinskDay = () => {
  const now = Date.now();
  return new Date(now - ((now + MINSK_OFFSET) % DAY));
};

const ago = (days: number) => new Date(Date.now() - days * DAY);

// «+3» / «0» — для приростов
const plus = (n: number) => (n > 0 ? `+${n}` : '0');

export async function handleStatsCommand(message: any): Promise<boolean> {
  const text: string = (message.text || '').trim();
  if (!/^\/stats\b/i.test(text)) return false;
  if (!isAdmin(message.from?.id)) return false;

  // Сборка идёт ~полминуты — сразу говорим, что считаем, чтобы не было тишины
  sendTelegramMessage(message.chat.id, '⏳ Считаю статистику, это до минуты…');
  try {
    // Telegram принимает до 4096 символов — длинную сводку режем по строкам (пустая строка = граница блока)
    const parts: string[] = [];
    let cur = '';
    for (const block of (await buildStats()).split('\n\n')) {
      if (cur && cur.length + block.length + 2 > 4000) {
        parts.push(cur);
        cur = '';
      }
      cur = cur ? `${cur}\n\n${block}` : block;
    }
    if (cur) parts.push(cur);
    for (const part of parts) await sendTelegramMessage(message.chat.id, part);
  } catch (err: any) {
    sendTelegramMessage(message.chat.id, `Не получилось собрать статистику: ${err?.message || err}`);
  }
  return true;
}

export async function buildStats(): Promise<string> {
  const today = startOfMinskDay();
  const real = { hasAgreedToRules: true }; // считаем только тех, кто прошёл приветствие

  const [
    usersTotal, usersToday, users7, users30,
    activeToday, active7,
    invisible, banned, hidden, guides, tourists, availableNow,
    men, women
  ] = await Promise.all([
    User.countDocuments(real),
    User.countDocuments({ ...real, createdAt: { $gte: today } }),
    User.countDocuments({ ...real, createdAt: { $gte: ago(7) } }),
    User.countDocuments({ ...real, createdAt: { $gte: ago(30) } }),
    User.countDocuments({ ...real, lastActiveAt: { $gte: today } }),
    User.countDocuments({ ...real, lastActiveAt: { $gte: ago(7) } }),
    User.countDocuments({ ...real, isProfileActive: false }),
    User.countDocuments({ isBanned: true }),
    User.countDocuments({ hiddenByReports: true }),
    User.countDocuments({ ...real, isGuide: true }),
    User.countDocuments({ ...real, isTourist: true }),
    User.countDocuments({ ...real, availableUntil: { $gt: new Date() } }),
    User.countDocuments({ ...real, gender: 'male' }),
    User.countDocuments({ ...real, gender: 'female' })
  ]);

  // 👋 и «на связи» (взаимные 👋)
  const likes = await Reaction.find({ type: 'like' }, { fromTelegramId: 1, toTelegramId: 1, createdAt: 1 }).lean();
  const likeKeys = new Set(likes.map((l) => `${l.fromTelegramId}:${l.toTelegramId}`));
  const matches = likes.filter((l) => likeKeys.has(`${l.toTelegramId}:${l.fromTelegramId}`)).length / 2;
  const likes7 = likes.filter((l) => l.createdAt && l.createdAt >= ago(7)).length;
  const hides = await Reaction.countDocuments({ type: 'dislike' });
  // «Пропустить» свайпом: сколько пропусков сейчас действует
  const skipsAgg = await User.aggregate([{ $match: { 'skipped.0': { $exists: true } } }, { $project: { n: { $size: { $filter: { input: '$skipped', cond: { $gt: ['$$this.until', new Date()] } } } } } }, { $group: { _id: null, n: { $sum: '$n' } } }]);
  const skipsNow = skipsAgg[0]?.n || 0;

  // Сходки
  const [eventsUpcoming, eventsCreated7, eventsTotal] = await Promise.all([
    Event.find({ isActive: true, dateTime: { $gte: new Date() } }, { participants: 1 }).lean(),
    Event.countDocuments({ createdAt: { $gte: ago(7) } }),
    Event.countDocuments({})
  ]);
  const goingUpcoming = eventsUpcoming.reduce((sum, e) => sum + (e.participants?.length || 0), 0);

  // Донаты звёздами
  const donations = await Donation.find({}, { stars: 1, createdAt: 1 }).lean();
  const starsTotal = donations.reduce((s, d) => s + d.stars, 0);
  const stars30 = donations.filter((d) => d.createdAt >= ago(30)).reduce((s, d) => s + d.stars, 0);

  // Жалобы и новости
  const Report = mongoose.models.Report;
  const openReports = Report ? await Report.countDocuments({ status: 'open' }) : 0;
  const newsCount = await News.countDocuments({ isPublished: true });
  const invitedJoined = await User.countDocuments({ ...real, invitedBy: { $exists: true } });
  const [placesCount, tipsCount] = await Promise.all([Place.countDocuments({}), PlaceTip.countDocuments({})]);

  const meetupLines = await meetupStatsLines(ago(30));
  // Скольким людям бот может писать (остальные открыли приложение по ссылке и не разрешили сообщения)
  const noUsername = await User.countDocuments({ ...real, username: { $in: [null, ''] } });
  // Напоминали завести @username — и сколько из них завели (username подхватывается при входе)
  const [usernameNudged, usernameFixed] = await Promise.all([
    User.countDocuments({ ...real, usernameNudgeSentAt: { $exists: true } }),
    User.countDocuments({ ...real, usernameNudgeSentAt: { $exists: true }, username: { $nin: [null, ''] } })
  ]);
  // «Не указали пол»: сами выбрали «не указывать» или ещё не ответили (не спрашивали / «Позже»)
  const genderSkipped = await User.countDocuments({ ...real, genderConfirmed: true, gender: { $nin: ['male', 'female'] } });
  const [canMessage, blocked] = await Promise.all([User.countDocuments({ ...real, canMessage: true }), User.countDocuments({ ...real, canMessage: false })]);
  // Из тех, кто заходил за неделю, бот не может писать: остановили бота или не разрешали. Им — плашка в приложении
  const [activeBlocked, activeNeverAllowed] = await Promise.all([
    User.countDocuments({ ...real, lastActiveAt: { $gte: ago(7) }, canMessage: false }),
    User.countDocuments({ ...real, lastActiveAt: { $gte: ago(7) }, canMessage: { $exists: false } })
  ]);
  const wishLines = await wishStatsLines(ago(30));
  const nudgeLines = await nudgeStatsLines(ago(30));
  const gameLines = [
    ...(await gameStatsLines().catch(() => [] as string[])),
    ...(await seaStatsLines().catch(() => [] as string[])),
    ...(await tractorStatsLines().catch(() => [] as string[]))
  ];

  const waveLimitLines = await waveLimitStatsLines().catch(() => [] as string[]);
  const buddyLines = await buddyStatsLines().catch(() => [] as string[]);
  const recruitLines = await recruitStatsLines().catch(() => [] as string[]);
  const exitLines = await eventExitStatsLines().catch(() => [] as string[]);
  const serialLines = await serialStatsLines().catch(() => [] as string[]);
  const helloLines = await helloStatsLines().catch(() => [] as string[]);
  const duelLines = await duelStatsLines().catch(() => [] as string[]);
  const gateLines = await waveGateStatsLines().catch(() => [] as string[]);

  const date = new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Minsk', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });

  return [
    `📊 <b>ГУЛЯЙ! статистика</b>`,
    `<i>${date}</i>`,
    ``,
    `👥 <b>Люди: ${usersTotal}</b>`,
    `Новые: сегодня ${plus(usersToday)} · за 7 дней ${plus(users7)} · за 30 дней ${plus(users30)}`,
    `Заходили: сегодня ${activeToday} · за 7 дней ${active7}`,
    `Мужчины ${men} · женщины ${women} · не указали ${usersTotal - men - women} (выбрали «не указывать» ${genderSkipped}, ещё не ответили ${usersTotal - men - women - genderSkipped})`,
    `🧭 Гиды ${guides} · 🧳 туристы ${tourists} · ⚡ «Хочу сейчас» ${availableNow}`,
    `🙈 В невидимке ${invisible} · 💌 пришли по приглашениям ${invitedJoined}`,
    BOT_ACCESS_TEXTS.statsLine(canMessage, usersTotal, blocked),
    BOT_ACCESS_TEXTS.statsActiveLine(activeBlocked, activeNeverAllowed, active7),
    USERNAME_TEXTS.statsLine(noUsername, usersTotal, usernameNudged, usernameFixed),
    ``,
    `👋 <b>Знакомства</b>`,
    `«Пообщаться» всего ${likes.length} (за 7 дней ${plus(likes7)})`,
    `🤝 На связи (взаимно): ${matches}`,
    `🙈 Скрыли навсегда (кнопкой): ${hides} · ⏭ пропусков сейчас: ${skipsNow}`,
    ...waveLimitLines,
    ...(gateLines.length ? [``, ...gateLines] : []),
    ...(helloLines.length ? [``, ...helloLines] : []),
    ...(duelLines.length ? [``, ...duelLines] : []),
    ``,
    `🗓 <b>Сходки</b>`,
    `Предстоящих ${eventsUpcoming.length}, на них идут ${goingUpcoming} чел.`,
    `Создано за 7 дней ${plus(eventsCreated7)} · всего ${eventsTotal}`,
    ...exitLines,
    ...(recruitLines.length ? [``, ...recruitLines] : []),
    ...(buddyLines.length ? [``, ...buddyLines] : []),
    ``,
    ...meetupLines,
    ``,
    ...wishLines,
    ``,
    ...(serialLines.length ? [...serialLines, ``] : []),
    ...nudgeLines,
    ``,
    ...gameLines,
    ``,
    `💛 <b>Донаты звёздами</b>: ${donations.length} шт., всего ⭐ ${starsTotal} (за 30 дней ⭐ ${stars30})`,
    ``,
    `🛡 Открытых жалоб: ${openReports}${openReports ? ' ⚠️' : ''} · скрыто после жалоб ${hidden} · забанено ${banned}`,
    `📰 Новостей опубликовано: ${newsCount}`,
    `📍 Мест: ${placesCount} · советов от людей: ${tipsCount}`
  ].join('\n');
}
