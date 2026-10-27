import { calculateDistanceMeters } from './utils/geoUtils';

/**
 * Порядок сходок в ленте «Все»: баллы за то, насколько сходка подходит человеку.
 * Чистая функция — без базы, чтобы правила было легко проверить и поменять
 */

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

// Официальные сходки ближе этого срока — закреплены наверху, дальше — просто большой бонус
export const OFFICIAL_PIN_DAYS = 3;
export const OFFICIAL_PIN_SCORE = 1000;
export const OFFICIAL_BONUS = 40;

export interface RankInput {
  dateTime: Date;
  category: string;
  location: [number, number]; // [lng, lat]
  participantIds: number[];
  seatsTaken: number;
  maxParticipants: number; // 0 — без ограничений
  isOfficial: boolean;
}

export interface Viewer {
  goals: string[];
  home?: [number, number]; // [lng, lat], точное место из анкеты
  matchIds: Set<number>;  // кто у меня «На связи»
  now?: number;
}

// Скоро: сегодня-завтра — максимум, через неделю и дальше — ноль
function timeScore(start: number, now: number) {
  const until = start - now;
  if (until <= DAY) return 30;
  if (until <= 2 * DAY) return 22;
  if (until <= 3 * DAY) return 15;
  if (until <= 7 * DAY) return 8;
  return 0;
}

// Близко к дому: до 2 км — максимум, дальше 15 км — ноль
function distanceScore(meters: number | null) {
  if (meters === null) return 0;
  if (meters <= 2000) return 20;
  if (meters >= 15000) return 0;
  return Math.round((20 * (15000 - meters)) / 13000);
}

// Набирается народ: с ограничением мест — по заполненности (треть мест = максимум), без ограничения — по числу людей
function popularityScore(seats: number, max: number) {
  if (max > 0) return Math.min(10, Math.round((seats / max) * 30));
  return Math.min(10, Math.max(0, (seats - 1) * 2));
}

export function distanceTo(ev: Pick<RankInput, 'location'>, viewer: Pick<Viewer, 'home'>): number | null {
  if (!viewer.home || ev.location?.length !== 2) return null;
  return Math.round(calculateDistanceMeters(viewer.home[1], viewer.home[0], ev.location[1], ev.location[0]));
}

export function rankEvent(ev: RankInput, viewer: Viewer): number {
  const now = viewer.now ?? Date.now();
  const start = new Date(ev.dateTime).getTime();
  if (ev.isOfficial && start - now <= OFFICIAL_PIN_DAYS * DAY) return OFFICIAL_PIN_SCORE + timeScore(start, now);

  const friends = ev.participantIds.filter((id) => viewer.matchIds.has(id)).length;
  const isFull = ev.maxParticipants > 0 && ev.seatsTaken >= ev.maxParticipants;
  return (
    Math.min(30, friends * 15) +
    (viewer.goals.includes(ev.category) ? 25 : 0) +
    timeScore(start, now) +
    distanceScore(distanceTo(ev, viewer)) +
    popularityScore(ev.seatsTaken, ev.maxParticipants) +
    (ev.isOfficial ? OFFICIAL_BONUS : 0) +
    (isFull ? -50 : 0)
  );
}
