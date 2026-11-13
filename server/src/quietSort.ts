import mongoose from 'mongoose';
import { Reaction } from './models/Reaction';
import { User } from './models/User';
import { notifyAdmins, pastAccountLine } from './moderation';
import { DeletedAccount } from './deletedAccounts';
import { isAdmin } from './news';
import { escapeHtml, userMentionHtml } from './utils/telegramNotify';

/**
 * Тихая сортировка в ленте «Люди»: кто нажал 👋 30 раз и больше, а взаимных («На связи») меньше 10%,
 * показывается после всех остальных. Ничего не баним и никому не пишем; во «Хотят» такие люди остаются.
 * Список пересчитываем раз в час и держим в памяти.
 *
 * «Часто скрывают»: человек машет (от 20 👋), а его скрыли 10 раз и больше — это не меньше пятой части от его 👋
 * и вдвое больше, чем ответили взаимно. Такие тоже уходят в конец ленты, дневной лимит 👋 у них ниже (waveLimit.ts),
 * а модератору один раз приходит карточка: «Забанить» или «Всё в порядке» (тогда человека больше не трогаем).
 * Скрытия считаем по чёрным спискам (blockedUsers), а не по реакциям: реакции стираются вместе с аккаунтом,
 * а чёрные списки остаются — так видно и тех, кто удалил анкету и завёл новую.
 */

const MIN_SENT = 30;
const MAX_MUTUAL_SHARE = 0.1;
const HIDDEN_MIN_SENT = 20;
const HIDDEN_MIN = 10;
const HIDDEN_MIN_SHARE = 0.2;
const HIDDEN_PER_MUTUAL = 2;
const HIDDEN_ALERT_ACTIVE_DAYS = 14; // карточку шлём только про тех, кто заходил недавно
const HOUR = 60 * 60 * 1000;

let quiet = new Set<number>();
let oftenHidden = new Set<number>();

export const isQuiet = (telegramId: number) => quiet.has(telegramId) || oftenHidden.has(telegramId);
export const quietCount = () => quiet.size;
export const isOftenHidden = (telegramId: number) => oftenHidden.has(telegramId);
export const oftenHiddenCount = () => oftenHidden.size;

export interface HiddenStat {
  telegramId: number;
  sent: number;
  mutual: number;
  hiddenBy: number;  // у скольких человек он в чёрном списке
  hiddenNow: number; // из них скрыли нынешнюю анкету (есть реакция «Скрыть»)
  past?: { times: number; reports: number; reasons: string[] }; // удалял(а) аккаунт (deletedAccounts.ts)
}

// Решения модератора и отметки «карточка отправлена»
const alerts = () => mongoose.connection.db!.collection('hiddenalerts');

/** Считает обе группы. Ничего не пишет в базу — годится и для проверки на живых данных */
export async function computeQuietSort(): Promise<{ quiet: Set<number>; hidden: HiddenStat[] }> {
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
  // 👋 с прежних, удалённых анкет тоже в счёт: удаление аккаунта счётчик не обнуляет
  const pastOf = new Map<number, any>();
  for (const p of await DeletedAccount.find({}, { telegramId: 1, sent: 1, mutual: 1, times: 1, reports: 1, reasons: 1 }).lean()) {
    pastOf.set(p.telegramId, p);
    const s = stats.get(p.telegramId) || { sent: 0, mutual: 0 };
    stats.set(p.telegramId, { sent: s.sent + (p.sent || 0), mutual: s.mutual + (p.mutual || 0) });
  }
  const nextQuiet = new Set<number>();
  for (const [id, s] of stats) if (s.sent >= MIN_SENT && s.mutual / s.sent < MAX_MUTUAL_SHARE) nextQuiet.add(id);

  const [blocked, hides] = await Promise.all([
    User.aggregate([{ $unwind: '$blockedUsers' }, { $group: { _id: '$blockedUsers', n: { $sum: 1 } } }, { $match: { n: { $gte: HIDDEN_MIN } } }]),
    Reaction.aggregate([{ $match: { type: 'dislike' } }, { $group: { _id: '$toTelegramId', n: { $sum: 1 } } }])
  ]);
  const hiddenNow = new Map<number, number>(hides.map((h: any) => [h._id, h.n]));
  const hidden: HiddenStat[] = [];
  for (const b of blocked) {
    const s = stats.get(b._id);
    if (!s || s.sent < HIDDEN_MIN_SENT) continue;
    if (b.n / s.sent < HIDDEN_MIN_SHARE || b.n < HIDDEN_PER_MUTUAL * s.mutual) continue;
    hidden.push({ telegramId: b._id, sent: s.sent, mutual: s.mutual, hiddenBy: b.n, hiddenNow: hiddenNow.get(b._id) || 0, past: pastOf.get(b._id) });
  }
  return { quiet: nextQuiet, hidden };
}

export function hiddenCardHtml(u: { telegramId: number; firstName: string; username?: string; age?: number; createdAt?: Date }, s: HiddenStat): string {
  const since = u.createdAt ? new Date(u.createdAt).toLocaleDateString('ru-RU', { timeZone: 'Europe/Minsk', day: 'numeric', month: 'long' }) : '—';
  const before = s.hiddenBy - s.hiddenNow;
  return [
    '🙈 <b>Часто скрывают</b>',
    `${userMentionHtml(u)}${u.age ? `, ${u.age}` : ''} · в приложении с ${escapeHtml(since)}`,
    '',
    `Помахал(а): ${s.sent} · ответили взаимно: ${s.mutual} · скрыли: ${s.hiddenBy}`,
    ...(s.past?.times ? [pastAccountLine(s.past)] : before >= 5 ? [`⚠️ ${before} из них скрыли раньше, чем появилась эта анкета: похоже, аккаунт удаляли и завели заново.`] : []),
    '',
    'Уже в конце ленты, лимит 5 👋 в день. Человеку ничего не писали.'
  ].join('\n');
}

async function refreshQuietSort() {
  const { quiet: nextQuiet, hidden } = await computeQuietSort();
  const ids = hidden.map((h) => h.telegramId);
  const [users, marks] = await Promise.all([
    ids.length ? User.find({ telegramId: { $in: ids }, isBanned: { $ne: true } }, { telegramId: 1, firstName: 1, username: 1, age: 1, createdAt: 1, lastActiveAt: 1 }).lean() : [],
    ids.length ? alerts().find({ telegramId: { $in: ids } }).toArray() : []
  ]);
  const userOf = new Map<number, any>((users as any[]).map((u) => [u.telegramId, u]));
  const markOf = new Map<number, any>(marks.map((m: any) => [m.telegramId, m]));
  const nextHidden = new Set<number>();
  for (const h of hidden) {
    const u = userOf.get(h.telegramId);
    const mark = markOf.get(h.telegramId);
    if (!u || mark?.ok) continue; // забанен, удалён или модератор сказал «всё в порядке»
    nextHidden.add(h.telegramId);
    const active = u.lastActiveAt && Date.now() - new Date(u.lastActiveAt).getTime() < HIDDEN_ALERT_ACTIVE_DAYS * 24 * HOUR;
    if (mark || !active) continue;
    await alerts().updateOne({ telegramId: h.telegramId }, { $setOnInsert: { telegramId: h.telegramId, alertedAt: new Date() } }, { upsert: true });
    notifyAdmins(hiddenCardHtml(u, h), [
      { text: '🚫 Забанить', data: `ban:${h.telegramId}` },
      { text: '✅ Всё в порядке', data: `okhid:${h.telegramId}` }
    ]);
  }
  quiet = nextQuiet;
  oftenHidden = nextHidden;
}

/** Кнопка «Всё в порядке» под карточкой: человека больше не опускаем из-за скрытий и не режем ему лимит */
export async function handleHiddenCallback(query: any): Promise<boolean> {
  const [action, id] = String(query.data || '').split(':');
  if (action !== 'okhid') return false;
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const call = (method: string, body: any) =>
    fetch(`https://api.telegram.org/bot${token}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).catch(() => {});
  if (!isAdmin(query.from?.id)) {
    call('answerCallbackQuery', { callback_query_id: query.id, text: 'Только для администратора' });
    return true;
  }
  const telegramId = Number(id);
  await alerts().updateOne({ telegramId }, { $set: { ok: true, okAt: new Date() }, $setOnInsert: { telegramId } }, { upsert: true });
  oftenHidden.delete(telegramId);
  const result = '✅ Всё в порядке: лимит и место в ленте обычные';
  call('answerCallbackQuery', { callback_query_id: query.id, text: result });
  if (query.message) {
    call('editMessageText', { chat_id: query.message.chat.id, message_id: query.message.message_id, text: `${query.message.text}\n\n${result}` });
  }
  return true;
}

export function startQuietSortLoop() {
  const run = () => refreshQuietSort().catch((err) => console.warn('⚠️ Тихая сортировка:', err?.message || err));
  setTimeout(run, 30 * 1000);
  setInterval(run, HOUR);
}

/** Тех, кто в тихой сортировке, — в конец; внутри обеих групп порядок прежний */
export function quietLast<T>(list: T[], idOf: (x: T) => number): T[] {
  if (!quiet.size && !oftenHidden.size) return list;
  return [...list.filter((x) => !isQuiet(idOf(x))), ...list.filter((x) => isQuiet(idOf(x)))];
}
