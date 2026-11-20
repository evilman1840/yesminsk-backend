import type { IEvent } from './models/Event';
import type { Questionnaire } from './profile/questionnaire';

type MatchEvent = Pick<IEvent, 'category' | 'dateTime' | 'isPaid' | 'price' | 'donation'>;
type MatchUser = { questionnaire?: Questionnaire; goals?: string[]; goal?: string };

// Only explicit activity choices, never guesses from private answers or free text.
const ACTIVITIES: Record<string, string[]> = {
  walk: ['Прогулки по городу', 'Прогулки с собаками'],
  cafe: ['Кофе и разговоры', 'Кафе и рестораны'], restaurant: ['Кафе и рестораны'], bar: ['Бары'],
  cafe_bar: ['Кофе и разговоры', 'Кафе и рестораны', 'Бары'],
  boardgames: ['Настольные игры'], cinema: ['Кино'],
  exhibition: ['Выставки и музеи'], museum: ['Выставки и музеи'], expo_cinema: ['Кино', 'Выставки и музеи'],
  sport: ['Спорт и тренировки', 'Велосипед'],
  trip_outdoors: ['Походы и прогулки на природе', 'Поездки за город'],
  talk: ['Кофе и разговоры']
};
const LEGACY: Record<string, string> = {
  walk: 'walk', cafe: 'cafe_bar', restaurant: 'cafe_bar', bar: 'cafe_bar', cafe_bar: 'cafe_bar',
  cinema: 'expo_cinema', exhibition: 'expo_cinema', museum: 'expo_cinema', expo_cinema: 'expo_cinema',
  boardgames: 'boardgames', sport: 'sport', trip_outdoors: 'trip_outdoors'
};

/** Soft priorities only: wishes > favourite activity > activity > unknown > another interest.
 * Schedule, budget and meeting area break ties; distance breaks the remaining ties.
 */
export function nearbyMatchScore(ev: MatchEvent, u: MatchUser, area: string | null, hasWish = false): number {
  const q = u.questionnaire;
  const options = ACTIVITIES[ev.category];
  let interest = 1;
  if (options && q?.activities?.length) {
    interest = q.activities.some(a => options.includes(a)) ? 2 : 0;
    if (q.favouriteActivity && q.activities.includes(q.favouriteActivity) && options.includes(q.favouriteActivity)) interest = 3;
  } else if (LEGACY[ev.category]) {
    const goals = u.goals?.length ? u.goals : u.goal ? [u.goal] : [];
    if (goals.some(g => g !== 'other')) interest = goals.includes(LEGACY[ev.category]) ? 2 : 0;
  }
  if (hasWish) interest = 4;
  let context = 0;
  const date = new Date(new Date(ev.dateTime).getTime() + 3 * 3600000);
  const hour = date.getUTCHours();
  const weekend = [0, 6].includes(date.getUTCDay());
  const slot = hour >= 22 || hour < 6 ? 'Поздним вечером и ночью'
    : weekend ? (hour < 17 ? 'В выходные днём' : 'В выходные вечером')
      : hour < 12 ? 'В будни утром' : hour < 17 ? 'В будни днём' : 'В будни вечером';
  if (q?.availability?.length && !q.availability.includes('У меня плавающий график')) context += q.availability.includes(slot) ? 2 : -2;
  // Unknown prices and voluntary donations must not be treated as a known fixed expense.
  if (!ev.donation && ev.isPaid && typeof ev.price === 'number' && ev.price > 0) {
    const budget = q?.budget?.[0];
    const cap = budget === 'Предпочитаю бесплатные встречи' ? 0 : budget === 'До 15 BYN' ? 15
      : budget === 'Больше 15, но не больше 35 BYN' ? 35 : null;
    if (cap !== null) context += ev.price <= cap ? 1 : -2;
  }
  if (area && q?.meetingAreas?.includes(area)) context += 1;
  return interest * 100 + context;
}

/** Public event text only. Keep enough room for the existing summary and buttons. */
export function nearbyDescription(text: string): string {
  const plain = String(text || '').replace(/\s+/g, ' ').trim();
  const chars = Array.from(plain);
  return chars.length <= 240 ? plain : chars.slice(0, 239).join('').trimEnd() + '…';
}
