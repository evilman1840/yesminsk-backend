import { Reaction } from './models/Reaction';

/**
 * Тихая сортировка в ленте «Люди»: кто нажал 👋 30 раз и больше, а взаимных («На связи») меньше 10%,
 * показывается после всех остальных. Ничего не баним и никому не пишем; во «Хотят» такие люди остаются.
 * Список пересчитываем раз в час и держим в памяти.
 */

const MIN_SENT = 30;
const MAX_MUTUAL_SHARE = 0.1;
const HOUR = 60 * 60 * 1000;

let quiet = new Set<number>();

export const isQuiet = (telegramId: number) => quiet.has(telegramId);
export const quietCount = () => quiet.size;

async function refreshQuietSort() {
  // Все 👋: действующие и отменённые из «На связи» (они тоже были отправлены)
  const waves = await Reaction.find({ type: { $in: ['like', 'unmatch'] } }, { fromTelegramId: 1, toTelegramId: 1, type: 1 }).lean();
  const liked = new Set(waves.filter((w) => w.type === 'like').map((w) => `${w.fromTelegramId}:${w.toTelegramId}`));
  const stats = new Map<number, { sent: number; mutual: number }>();
  for (const w of waves) {
    const s = stats.get(w.fromTelegramId) || { sent: 0, mutual: 0 };
    s.sent++;
    if (liked.has(`${w.toTelegramId}:${w.fromTelegramId}`)) s.mutual++;
    stats.set(w.fromTelegramId, s);
  }
  const next = new Set<number>();
  for (const [id, s] of stats) if (s.sent >= MIN_SENT && s.mutual / s.sent < MAX_MUTUAL_SHARE) next.add(id);
  quiet = next;
}

export function startQuietSortLoop() {
  const run = () => refreshQuietSort().catch((err) => console.warn('⚠️ Тихая сортировка:', err?.message || err));
  setTimeout(run, 30 * 1000);
  setInterval(run, HOUR);
}

/** Тех, кто в тихой сортировке, — в конец; внутри обеих групп порядок прежний */
export function quietLast<T>(list: T[], idOf: (x: T) => number): T[] {
  if (!quiet.size) return list;
  return [...list.filter((x) => !quiet.has(idOf(x))), ...list.filter((x) => quiet.has(idOf(x)))];
}
