import { Event, IEvent } from './models/Event';
import { User } from './models/User';
import { halfHourOk, NearbyPing } from './nearbyInvite';
import { isKnownArea } from './utils/userLocation';
import { COMFORT_TEXTS as T } from './texts';

/**
 * «Стесняешься идти?» — строки на карточке сходки для тех, кто ещё не был ни на одной сходке.
 * По опросу 13.11.2026 половину останавливает стеснение, и останавливает ещё при просмотре, до записи. Поэтому на карточке:
 * — «каждый второй у нас стесняется» (ты такой не один);
 * — сколько из идущих тоже идут впервые (там не «все свои»);
 * — что общего с идущими: район, интересы (это уже не совсем незнакомые);
 * — «можно зайти на полчаса» (не обязательно сидеть до конца) — где это правда.
 * Имён не называем, только числа. Модератор видит блок всегда — чтобы проверить, как он выглядит
 */

export type Comfort = { short: string; lines: string[] };

type Me = { areaName?: string | null; goals?: string[]; goal?: string } | null;

export async function comfortFor(events: IEvent[], me: Me, viewerId: number, opts: { now?: number; force?: boolean } = {}): Promise<Map<string, Comfort>> {
  const now = opts.now ?? Date.now();
  const out = new Map<string, Comfort>();
  // Только сходки, куда ещё можно решиться: впереди, не моя и я не записан
  const open = events.filter((ev) => ev.dateTime.getTime() > now && ev.creator.telegramId !== viewerId && !ev.participants.some((p) => p.telegramId === viewerId));
  if (!open.length) return out;

  const ids = [...new Set([viewerId, ...open.flatMap((ev) => ev.participants.map((p) => p.telegramId))])];
  // Уже был на сходке: записан на прошедшую, где был кто-то ещё
  const been = new Set(
    (await Event.distinct('participants.telegramId', { isActive: true, dateTime: { $lt: new Date(now) }, 'participants.1': { $exists: true }, 'participants.telegramId': { $in: ids } })).map(Number)
  );
  if (been.has(viewerId) && !opts.force) return out;

  const people = await User.find({ telegramId: { $in: ids } }, { telegramId: 1, areaName: 1, goals: 1, goal: 1 }).lean();
  const byId = new Map(people.map((u) => [u.telegramId, u]));
  const goalsOf = (u: any): string[] => (u?.goals?.length ? u.goals : u?.goal ? [u.goal] : []).filter((g: string) => g !== 'other');
  const myGoals = goalsOf(me);
  const myArea = isKnownArea(me?.areaName) ? me!.areaName : null;

  for (const ev of open) {
    const others = ev.participants.map((p) => p.telegramId);
    const firstTimers = others.filter((id) => !been.has(id)).length;
    const sameArea = myArea ? others.filter((id) => byId.get(id)?.areaName === myArea).length : 0;
    // Интерес, который разделяет больше всего идущих
    const goal = myGoals
      .map((g) => ({ g, n: others.filter((id) => goalsOf(byId.get(id)).includes(g)).length }))
      .sort((a, b) => b.n - a.n)[0];
    const half = halfHourOk(ev);

    const showFirst = firstTimers >= 1 && others.length >= 2;
    const lines = [
      T.notAlone,
      showFirst ? T.firstTimers(firstTimers, others.length) : '',
      sameArea ? T.sameArea(sameArea) : '',
      goal?.n ? T.sameGoal(goal.n, goal.g) : '',
      half ? T.halfHour : ''
    ].filter(Boolean);
    const short = [showFirst ? T.firstTimersShort(firstTimers, others.length) : sameArea ? T.sameArea(sameArea) : T.notAloneShort, half ? T.halfHourShort : ''].filter(Boolean).join(' · ');
    out.set(String(ev._id), { short, lines });
  }
  return out;
}

/* ---------- /stats ---------- */

const DAY = 24 * 60 * 60 * 1000;
const MINSK = 3 * 60 * 60 * 1000;
// Блок выложен вечером 13.11.2026. День запуска не берём ни в «до», ни в «после»
const LAUNCH = Date.UTC(2026, 10, 13) - MINSK;
const BEFORE_DAYS = 14;
const dm = (t: number) => new Date(t + MINSK).toISOString().slice(5, 10).split('-').reverse().join('.');

/**
 * Работает ли блок: сколько людей впервые в жизни записались на чужую сходку за две недели до него и после.
 * В тот же день заработали «Сходки рядом», поэтому отдельно — сколько первых записей пришло по приглашению бота.
 * Удалённые сходки в счёт не попадают (их нет в базе)
 */
export async function comfortStatsLines(): Promise<string[]> {
  const now = Date.now();
  const before = { from: LAUNCH - BEFORE_DAYS * DAY, to: LAUNCH };
  const after = { from: LAUNCH + DAY, to: now };

  // Первая запись каждого человека: и те, кто идёт, и те, кто потом отменил
  const events = await Event.find({}, { 'creator.telegramId': 1, 'participants.telegramId': 1, 'participants.joinedAt': 1, 'cancellations.telegramId': 1, 'cancellations.joinedAt': 1 }).lean();
  const first = new Map<number, { at: number; eventId: string }>();
  for (const ev of events) {
    for (const p of [...(ev.participants || []), ...(ev.cancellations || [])]) {
      if (!p.joinedAt || p.telegramId === ev.creator?.telegramId) continue;
      const at = new Date(p.joinedAt).getTime();
      if (at < (first.get(p.telegramId)?.at ?? Infinity)) first.set(p.telegramId, { at, eventId: String(ev._id) });
    }
  }
  const inWindow = (w: { from: number; to: number }) => [...first.entries()].filter(([, f]) => f.at >= w.from && f.at < w.to);
  const firstBefore = inWindow(before);
  const firstAfter = inWindow(after);

  const newUsers = (w: { from: number; to: number }) => User.countDocuments({ hasAgreedToRules: true, createdAt: { $gte: new Date(w.from), $lt: new Date(w.to) } });
  const [usersBefore, usersAfter, pings] = await Promise.all([
    newUsers(before),
    newUsers(after),
    NearbyPing.find({ toId: { $in: firstAfter.map(([id]) => id) }, status: { $ne: 'undelivered' } }, { toId: 1, eventId: 1, createdAt: 1 }).lean()
  ]);
  // Первая запись — на ту самую сходку, куда позвал бот, и уже после приглашения
  const viaNearby = firstAfter.filter(([id, f]) => pings.some((p) => p.toId === id && String(p.eventId) === f.eventId && new Date(p.createdAt).getTime() <= f.at)).length;

  const afterDays = (after.to - after.from) / DAY;
  const perDay = (n: number, days: number) => (n / days).toFixed(1).replace('.', ',');
  return [
    T.statsTitle,
    T.statsRow(`До (${dm(before.from)}–${dm(before.to - DAY)})`, firstBefore.length, perDay(firstBefore.length, BEFORE_DAYS), usersBefore),
    afterDays >= 1 ? T.statsRow(`После (с ${dm(after.from)})`, firstAfter.length, perDay(firstAfter.length, afterDays), usersAfter, viaNearby) : T.statsEarly
  ];
}
