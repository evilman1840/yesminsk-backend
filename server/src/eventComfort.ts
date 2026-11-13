import { Event, IEvent } from './models/Event';
import { User } from './models/User';
import { halfHourOk } from './nearbyInvite';
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
