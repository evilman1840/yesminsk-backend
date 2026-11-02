import { Event } from './models/Event';
import { Reaction } from './models/Reaction';

/**
 * Настоящая статистика сходок для карточек «Хочу сходить»: сколько прошло, как оценивают, остаются ли на связи.
 * Каждое число отдаём, только когда данных достаточно — хвастаться выборкой из пяти человек не будем
 */

const HOUR = 60 * 60 * 1000;
const TTL = 6 * HOUR;          // считаем не чаще раза в 6 часов
const WINDOW_DAYS = 180;       // «на связи» — по сходкам за полгода
const MIN_MEETUPS = 10;        // «Уже прошло N сходок»
const MIN_REVIEWS = 20;        // «N из 10 ставят „Отлично“»
const MIN_PEOPLE = 30;         // «N из 10 остаются на связи»

export interface MeetupStats {
  meetups?: number;            // прошедших сходок, где было хотя бы двое
  people?: number;             // разных людей на них
  excellentOf10?: number;      // из 10 отзывов — сколько «😍 Отлично»
  keptInTouchOf10?: number;    // из 10 участников — сколько после сходки на связи с кем-то из компании
}

let cache: { at: number; stats: MeetupStats } | null = null;

export async function getMeetupStats(): Promise<MeetupStats> {
  if (cache && Date.now() - cache.at < TTL) return cache.stats;
  const stats = await compute().catch((err) => {
    console.warn('⚠️ Статистика сходок:', err?.message || err);
    return cache?.stats || {};
  });
  cache = { at: Date.now(), stats };
  return stats;
}

async function compute(): Promise<MeetupStats> {
  const now = new Date();
  const events = await Event.find(
    { dateTime: { $lt: now } },
    { dateTime: 1, 'participants.telegramId': 1, 'participants.noShowAt': 1, 'feedback.telegramId': 1, 'feedback.score': 1, 'feedback.wantsContact': 1 }
  ).lean();

  // Кто был: участники без отметки «Не пришёл(ла)»; сходка считается, если пришли хотя бы двое
  const held = events
    .map((e) => ({ e, ids: [...new Set((e.participants || []).filter((p) => !p.noShowAt).map((p) => p.telegramId))] }))
    .filter((x) => x.ids.length >= 2);
  const stats: MeetupStats = {};

  if (held.length >= MIN_MEETUPS) {
    stats.meetups = held.length;
    stats.people = new Set(held.flatMap((x) => x.ids)).size;
  }

  const reviews = events.flatMap((e) => e.feedback || []);
  if (reviews.length >= MIN_REVIEWS) {
    stats.excellentOf10 = Math.round((reviews.filter((f) => f.score === 3).length / reviews.length) * 10);
  }

  // На связи: после сходки взаимный 👋 с кем-то из той же компании или в отзыве «хочу контакт»
  const since = new Date(now.getTime() - WINDOW_DAYS * 24 * HOUR);
  const recent = held.filter((x) => x.e.dateTime >= since);
  const ids = [...new Set(recent.flatMap((x) => x.ids))];
  if (ids.length >= MIN_PEOPLE) {
    const likes = await Reaction.find({ type: 'like', fromTelegramId: { $in: ids }, toTelegramId: { $in: ids } }, { fromTelegramId: 1, toTelegramId: 1, updatedAt: 1 }).lean();
    const likedAt = new Map(likes.map((r) => [`${r.fromTelegramId}:${r.toTelegramId}`, new Date(r.updatedAt).getTime()]));
    let total = 0;
    let kept = 0;
    for (const { e, ids: group } of recent) {
      const after = new Date(e.dateTime).getTime();
      const wants = new Set((e.feedback || []).filter((f) => f.wantsContact).map((f) => f.telegramId));
      for (const me of group) {
        total++;
        const mutual = group.some((other) => {
          if (other === me) return false;
          const a = likedAt.get(`${me}:${other}`);
          const b = likedAt.get(`${other}:${me}`);
          return a !== undefined && b !== undefined && Math.max(a, b) >= after; // на связь вышли уже после сходки
        });
        if (mutual || wants.has(me)) kept++;
      }
    }
    const share = Math.round((kept / total) * 10);
    if (share > 0) stats.keptInTouchOf10 = share;
  }
  return stats;
}
