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

  try {
    sendTelegramMessage(message.chat.id, await buildStats());
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

  const date = new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Minsk', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });

  return [
    `📊 <b>ДА! МИНСК: статистика</b>`,
    `<i>${date}</i>`,
    ``,
    `👥 <b>Люди: ${usersTotal}</b>`,
    `Новые: сегодня ${plus(usersToday)} · за 7 дней ${plus(users7)} · за 30 дней ${plus(users30)}`,
    `Заходили: сегодня ${activeToday} · за 7 дней ${active7}`,
    `Мужчины ${men} · женщины ${women} · не указали ${usersTotal - men - women}`,
    `🧭 Гиды ${guides} · 🧳 туристы ${tourists} · ⚡ «Хочу сейчас» ${availableNow}`,
    `🙈 В невидимке ${invisible} · 💌 пришли по приглашениям ${invitedJoined}`,
    ``,
    `👋 <b>Знакомства</b>`,
    `«Пообщаться» всего ${likes.length} (за 7 дней ${plus(likes7)})`,
    `🤝 На связи (взаимно): ${matches}`,
    `🙈 Скрыли кого-то: ${hides}`,
    ``,
    `🗓 <b>Сходки</b>`,
    `Предстоящих ${eventsUpcoming.length}, на них идут ${goingUpcoming} чел.`,
    `Создано за 7 дней ${plus(eventsCreated7)} · всего ${eventsTotal}`,
    ``,
    ...meetupLines,
    ``,
    `💛 <b>Донаты звёздами</b>: ${donations.length} шт., всего ⭐ ${starsTotal} (за 30 дней ⭐ ${stars30})`,
    ``,
    `🛡 Открытых жалоб: ${openReports}${openReports ? ' ⚠️' : ''} · скрыто после жалоб ${hidden} · забанено ${banned}`,
    `📰 Новостей опубликовано: ${newsCount}`,
    `📍 Мест: ${placesCount} · советов от людей: ${tipsCount}`
  ].join('\n');
}
