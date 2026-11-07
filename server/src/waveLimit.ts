import mongoose from 'mongoose';
import { IUser, User } from './models/User';
import { Reaction } from './models/Reaction';

/**
 * Дневной лимит 👋 «Пообщаться».
 * Считаем 👋, отправленные за календарный день по Минску (сброс в 00:00 по Минску).
 * Не в счёт: ответ на чужой 👋 (сразу «На связи») и привет участникам после сходки — это и есть то, к чему ведём.
 * 15 в день; 25 — первые сутки после регистрации или если на ≥25% из ≥10 отправленных 👋 ответили взаимно.
 */

export const WAVE_LIMIT_BASE = 15;
export const WAVE_LIMIT_BOOSTED = 25;
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
  return [
    `⏳ Лимит 👋 (${WAVE_LIMIT_BASE}/${WAVE_LIMIT_BOOSTED} в день) включён с ${since}`,
    `Упёрлись в лимит 👋: сегодня ${today} чел., за 7 дней ${week} чел.`
  ];
}
