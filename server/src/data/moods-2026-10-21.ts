import { PlaceMood } from '../models/Place';

/**
 * Настроения мест из таблицы «10 мест» от автора (21.10.2026). Заменяют предложенные при импорте
 */
export const PLACE_MOODS_2026_10_21: { place: string; moods: PlaceMood[] }[] = [
  { place: 'Парк Горького', moods: ['wow', 'party', 'tosku'] },
  { place: 'Парк Челюскинцев', moods: ['wow', 'escape', 'party'] },
  { place: 'Парк Победы', moods: ['escape', 'love', 'wow'] },
  { place: 'Лошицкий парк', moods: ['love', 'escape', 'party'] },
  { place: 'Большой театр оперы и балета', moods: ['wow', 'love', 'solo'] },
  { place: 'Музей истории Великой Отечественной войны', moods: ['love', 'solo'] },
  { place: 'Парк Михаила Павлова', moods: ['escape', 'tosku', 'solo'] },
  { place: 'Парк 50-летия Октября', moods: ['escape', 'solo', 'party'] },
  { place: 'Парк Курасовщина', moods: ['party', 'escape', 'wow'] },
  { place: 'Парк Дружбы народов', moods: ['escape', 'solo', 'tosku'] },
  { place: 'Севастопольский парк', moods: ['escape', 'solo', 'tosku'] }
];
