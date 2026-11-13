import mongoose from 'mongoose';
import { IUser, User } from './models/User';
import { Reaction } from './models/Reaction';
import { quietCount, isOftenHidden, oftenHiddenCount } from './quietSort';

/**
 * Дневной лимит 👋 «Пообщаться».
 * Считаем 👋, отправленные за календарный день по Минску (сброс в 00:00 по Минску).
 * Не в счёт: ответ на чужой 👋 (сразу «На связи») и привет участникам после сходки — это и есть то, к чему ведём.
 * 15 в день; 25 — первые сутки после регистрации или если на ≥25% из ≥10 отправленных 👋 ответили взаимно.
 * 5 — тем, кого часто скрывают (quietSort.ts): правило важнее остальных, в том числе для новой анкеты.
 */

export const WAVE_LIMIT_BASE = 15;
export const WAVE_LIMIT_BOOSTED = 25;
export const WAVE_LIMIT_LOW = 5;
const BOOST_MIN_SENT = 10;
const BOOST_MIN_SHARE = 0.25;

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const MINSK = 3 * HOUR; // Минск: UTC+3 круглый год

export const minskDayStart = (now = Date.now()) => new Date(now - ((now + MINSK) % DAY));
export const minskDayKey = (now = Date.now()) => new Date(now + MINSK).toISOString().slice(0, 10);

export interface WaveQuota {
  limit: number;
  left: number;
  resetAt: string; // следующая полночь по Минску (ISO)
}

export class WaveLimitError extends Error {
  constructor(public quota: WaveQuota) {
    super('DAILY_WAVE_LIMIT');
  }
}

// Сколько 👋 в счёт лимита отправлено сегодня
async function usedToday(telegramId: number): Promise<number> {
  const start = minskDayStart();
  return Reaction.countDocuments({
    fromTelegramId: telegramId,
    likeFree: { $ne: true },
    $or: [
      { likedAt: { $gte: start } },
      // 👋, нажатые в день запуска до появления likedAt
      { likedAt: { $exists: false }, type: { $in: ['like', 'unmatch'] }, createdAt: { $gte: start } }
    ]
  });
}

// Повышенный лимит: новичок (меньше суток) или на его 👋 часто отвечают взаимно
async function dailyLimit(me: IUser): Promise<number> {
  if (isOftenHidden(me.telegramId)) return WAVE_LIMIT_LOW;
  const created = (me as any).createdAt ? new Date((me as any).createdAt).getTime() : 0;
  if (created && Date.now() - created < DAY) return WAVE_LIMIT_BOOSTED;
  const sent = await Reaction.find({ fromTelegramId: me.telegramId, type: { $in: ['like', 'unmatch'] } }, { toTelegramId: 1 }).lean();
  if (sent.length < BOOST_MIN_SENT) return WAVE_LIMIT_BASE;
  const mutual = await Reaction.countDocuments({ fromTelegramId: { $in: sent.map((r) => r.toTelegramId) }, toTelegramId: me.telegramId, type: 'like' });
  return mutual / sent.length >= BOOST_MIN_SHARE ? WAVE_LIMIT_BOOSTED : WAVE_LIMIT_BASE;
}

export async function waveQuota(me: IUser): Promise<WaveQuota> {
  const [limit, used] = await Promise.all([dailyLimit(me), usedToday(me.telegramId)]);
  return { limit, left: Math.max(0, limit - used), resetAt: new Date(minskDayStart().getTime() + DAY).toISOString() };
}

// Упёрся в лимит сегодня — запоминаем день (храним последние 14) для /stats
export async function markWaveLimitHit(telegramId: number): Promise<void> {
  const day = minskDayKey();
  await User.updateOne({ telegramId, waveLimitDays: { $ne: day } }, { $push: { waveLimitDays: { $each: [day], $slice: -14 } } }).catch(() => {});
}

/* ---------- запуск и /stats ---------- */

const LAUNCH_KEY = 'wave-limit-launch';

// При старте сервера: запоминаем дату включения лимита (один раз)
export async function rememberWaveLimitLaunch(): Promise<void> {
  try {
    await mongoose.connection.db!.collection('migrations').updateOne({ key: LAUNCH_KEY }, { $setOnInsert: { key: LAUNCH_KEY, at: new Date() } }, { upsert: true });
  } catch (err: any) {
    console.warn('⚠️ Дата запуска лимита 👋:', err?.message || err);
  }
}

export async function waveLimitStatsLines(): Promise<string[]> {
  const launch = await mongoose.connection.db!.collection('migrations').findOne({ key: LAUNCH_KEY });
  const days = Array.from({ length: 7 }, (_, i) => minskDayKey(Date.now() - i * DAY));
  const [today, week] = await Promise.all([
    User.countDocuments({ waveLimitDays: days[0] }),
    User.countDocuments({ waveLimitDays: { $in: days } })
  ]);
  const since = launch?.at ? new Date(launch.at).toLocaleDateString('ru-RU', { timeZone: 'Europe/Minsk', day: 'numeric', month: 'long' }) : '—';
  const weekAgo = new Date(Date.now() - 7 * DAY);
  const [reciprocity, hides7] = await Promise.all([
    reciprocityLine(weekAgo),
    Reaction.countDocuments({ type: 'dislike', updatedAt: { $gte: weekAgo } })
  ]);
  return [
    `⏳ Лимит 👋 (${WAVE_LIMIT_BASE}/${WAVE_LIMIT_BOOSTED} в день) включён с ${since}`,
    `Упёрлись в лимит 👋: сегодня ${today} чел., за 7 дней ${week} чел.`,
    reciprocity,
    `🙈 «Скрыть навсегда» за 7 дней: ${hides7}`,
    `🔇 В тихой сортировке: ${quietCount()} чел.`,
    `🙈 Часто скрывают (конец ленты, лимит ${WAVE_LIMIT_LOW} 👋): ${oftenHiddenCount()} чел.`
  ];
}

// Доля взаимных ответов на 👋, нажатые за 7 дней, по направлениям (М → Ж и т. д.)
async function reciprocityLine(since: Date): Promise<string> {
  const waves = await Reaction.find(
    { type: 'like', $or: [{ likedAt: { $gte: since } }, { likedAt: { $exists: false }, createdAt: { $gte: since } }] },
    { fromTelegramId: 1, toTelegramId: 1 }
  ).lean();
  if (!waves.length) return '↩️ Взаимность 👋 за 7 дней: пока нет данных';
  const ids = [...new Set(waves.flatMap((w) => [w.fromTelegramId, w.toTelegramId]))];
  const [users, answers] = await Promise.all([
    User.find({ telegramId: { $in: ids } }, { telegramId: 1, gender: 1 }).lean(),
    Reaction.find({ type: 'like', fromTelegramId: { $in: waves.map((w) => w.toTelegramId) }, toTelegramId: { $in: waves.map((w) => w.fromTelegramId) } }, { fromTelegramId: 1, toTelegramId: 1 }).lean()
  ]);
  const gender = new Map(users.map((u) => [u.telegramId, u.gender]));
  const answered = new Set(answers.map((a) => `${a.fromTelegramId}:${a.toTelegramId}`));
  const sign: Record<string, string> = { male: 'М', female: 'Ж' };
  const dirs: Record<string, [number, number]> = { 'М→Ж': [0, 0], 'Ж→М': [0, 0], 'Ж→Ж': [0, 0], 'М→М': [0, 0] };
  for (const w of waves) {
    const key = `${sign[gender.get(w.fromTelegramId) as string] || '?'}→${sign[gender.get(w.toTelegramId) as string] || '?'}`;
    if (!dirs[key]) continue; // пол не указан
    dirs[key][0]++;
    if (answered.has(`${w.toTelegramId}:${w.fromTelegramId}`)) dirs[key][1]++;
  }
  const part = (k: string) => {
    const [n, m] = dirs[k];
    return `${k} ${n ? Math.round((m / n) * 100) : 0}% (${m}/${n})`;
  };
  return `↩️ Взаимность 👋 за 7 дней: ${Object.keys(dirs).map(part).join(' · ')}`;
}
