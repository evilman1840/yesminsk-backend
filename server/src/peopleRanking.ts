import { Wish } from './models/Wish';
import { Event } from './models/Event';
import { Reaction } from './models/Reaction';
import { EventTemplate } from './models/EventTemplate';
import { calculateDistanceMeters } from './utils/geoUtils';
import { PEOPLE_TEXTS as T } from './texts';

/**
 * Порядок во вкладке «Люди» и на карте: по тому, что сближает (общие интересы и планы, близость, как человек ходит),
 * а не по внешности. Новичкам и тем, кого мало замечают, — небольшой плюс, чтобы каждого кто-то увидел.
 * Похожие по очкам анкеты каждый день немного перемешиваются, у каждого зрителя по-своему
 */

const DAY = 24 * 60 * 60 * 1000;

export interface RankContext {
  viewerId: number;
  myGoals: Set<string>;
  myCoords: [number, number] | null; // [lng, lat]
  myGoesWith?: string;
  myAge?: number;
  sharedPlans: Map<number, { kind: string; name: string }[]>; // человек → общие «Хочу сходить»
  sameEvent: Set<number>;             // идём на одну сходку
  likesIn: Map<number, number>;       // сколько «Пообщаться» получил человек
  dayKey: string;
}

// Устойчивое «случайное» число 0..1 на зрителя, человека и день
const jitter = (viewerId: number, id: number, day: string) => {
  let h = 2166136261;
  for (const ch of `${viewerId}:${id}:${day}`) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return ((h >>> 0) % 1000) / 1000;
};

const hasOwnPhoto = (u: any) => Boolean(u.avatarUrl) && !String(u.avatarUrl).includes('images.unsplash.com');

export function scoreUser(u: any, ctx: RankContext, flags?: { iLiked: boolean; likedMe: boolean }, now = Date.now()) {
  let s = 0;
  const goals: string[] = u.goals?.length ? u.goals : u.goal ? [u.goal] : [];
  const common = goals.filter((g) => g !== 'other' && ctx.myGoals.has(g)).length;
  s += Math.min(common, 4) * 3;

  const plans = ctx.sharedPlans.get(u.telegramId) || [];
  if (plans.length) s += 8 + (plans.length - 1) * 2;
  if (ctx.sameEvent.has(u.telegramId)) s += 5;

  const their = u.locationFuzzy?.coordinates || u.locationExact?.coordinates;
  if (ctx.myCoords && their?.length === 2) {
    const km = calculateDistanceMeters(ctx.myCoords[1], ctx.myCoords[0], their[1], their[0]) / 1000;
    s += 6 * Math.exp(-km / 4); // рядом ~6, 3 км ~3, 10 км ~0,5
  }

  if (ctx.myGoesWith && u.goesWith === ctx.myGoesWith) s += ctx.myGoesWith === 'kids' ? 3 : 2;
  if (ctx.myAge && u.age) {
    const d = Math.abs(Number(u.age) - ctx.myAge);
    s += d <= 5 ? 1.5 : d <= 10 ? 0.5 : 0;
  }

  const seen = u.lastActiveAt ? now - new Date(u.lastActiveAt).getTime() : Infinity;
  s += seen < DAY ? 3 : seen < 3 * DAY ? 2 : seen < 7 * DAY ? 1 : 0;

  if (hasOwnPhoto(u)) s += 2;
  if (u.bio && String(u.bio).trim().length >= 10) s += 1;
  if (u.availableUntil && new Date(u.availableUntil).getTime() > now) s += 8;

  // Равные шансы: кого и так много зовут — чуть ниже, новичкам первых дней — чуть выше
  s -= Math.min(3, (ctx.likesIn.get(u.telegramId) || 0) / 10);
  const created = u.createdAt ? new Date(u.createdAt).getTime() : 0;
  if (created && now - created < 3 * DAY) s += 2;

  if (flags?.likedMe) s += 2;
  if (flags?.iLiked) s -= 10; // уже позвал(а) — ждёт ответа, вниз

  return s + jitter(ctx.viewerId, u.telegramId, ctx.dayKey) * 2;
}

// «Почему показан»: общие планы и сходки (общие интересы карточка подсвечивает сама)
export const whyShown = (id: number, ctx: RankContext): string[] => {
  const out: string[] = [];
  if (ctx.sameEvent.has(id)) out.push(T.sameEvent);
  const plans = ctx.sharedPlans.get(id) || [];
  if (plans.length) out.push(T.samePlans(plans.slice(0, 2).map((p) => p.name).join(', ')));
  return out;
};

// Общие «Хочу сходить» ключами — нажать на строку «Тоже хочет» и увидеть, кто ещё хочет того же
export const sharedKinds = (id: number, ctx: RankContext) => ctx.sharedPlans.get(id) || [];

/**
 * Данные для очков одним заходом: мои планы и сходки, планы и сходки кандидатов, сколько их зовут
 */
export async function buildRankContext(me: any, candidateIds: number[]): Promise<RankContext> {
  const viewerId = me.telegramId;
  const myWishes = await Wish.find({ telegramId: viewerId, status: { $in: ['active', 'matched'] } }, { kind: 1 }).lean();
  const myKinds = [...new Set(myWishes.map((w) => w.kind))];

  const sharedPlans = new Map<number, { kind: string; name: string }[]>();
  if (myKinds.length) {
    const templates = await EventTemplate.find({ key: { $in: myKinds } }, { key: 1, name: 1 }).lean();
    const nameOf = new Map(templates.map((t: any) => [t.key, t.name]));
    const theirs = await Wish.find({ kind: { $in: myKinds }, status: { $in: ['active', 'matched'] }, telegramId: { $in: candidateIds } }, { telegramId: 1, kind: 1 }).lean();
    for (const w of theirs) {
      const list = sharedPlans.get(w.telegramId) || [];
      if (!list.some((p) => p.kind === w.kind)) sharedPlans.set(w.telegramId, [...list, { kind: w.kind, name: nameOf.get(w.kind) || w.kind }]);
    }
  }

  const sameEvent = new Set<number>();
  const myEvents = await Event.find({ isActive: true, dateTime: { $gt: new Date() }, 'participants.telegramId': viewerId }, { participants: 1 }).lean();
  for (const ev of myEvents) for (const p of ev.participants) if (p.telegramId !== viewerId) sameEvent.add(p.telegramId);

  const likesIn = new Map<number, number>();
  const counts = await Reaction.aggregate([{ $match: { type: 'like', toTelegramId: { $in: candidateIds } } }, { $group: { _id: '$toTelegramId', n: { $sum: 1 } } }]);
  for (const c of counts) likesIn.set(c._id, c.n);

  const coords = me.locationExact?.coordinates || me.locationFuzzy?.coordinates;
  const myGoals = new Set<string>((me.goals?.length ? me.goals : me.goal ? [me.goal] : []).filter((g: string) => g !== 'other'));
  const dayKey = new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString().slice(0, 10); // день по Минску

  return {
    viewerId,
    myGoals,
    myCoords: coords?.length === 2 ? [coords[0], coords[1]] : null,
    myGoesWith: me.goesWith,
    myAge: Number(me.age) || undefined,
    sharedPlans,
    sameEvent,
    likesIn,
    dayKey
  };
}
