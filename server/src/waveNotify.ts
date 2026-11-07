import { User } from './models/User';
import { sendTelegramMessage } from './utils/telegramNotify';
import { minskDayKey } from './waveLimit';

/**
 * Уведомления о входящих 👋 пачкой.
 * Первые 3 за день (по Минску) — сразу, по одному. С 4-го копим и в 20:00 по Минску шлём одно сообщение.
 * «Вы на связи» сюда не относится — оно всегда приходит сразу.
 * Сводку не шлём тем, кто не заходил 21 день, и тем, кто уже открыл приложение после последнего 👋 (сам всё видел).
 */

const INSTANT_PER_DAY = 3;
const DIGEST_HOUR = 20;
const INACTIVE_DAYS = 21;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const MINSK = 3 * HOUR;

/** Пришёл новый 👋 (не взаимный). true — написать человеку сразу, false — отложено до вечерней сводки */
export async function noteIncomingWave(telegramId: number): Promise<boolean> {
  const day = minskDayKey();
  try {
    // Сегодня уже было, но меньше 3 сообщений — пишем сразу
    const instant = await User.updateOne(
      { telegramId, 'waveNotify.day': day, 'waveNotify.sent': { $lt: INSTANT_PER_DAY } },
      { $inc: { 'waveNotify.sent': 1 } }
    );
    if (instant.modifiedCount) return true;
    // Сегодня уже 3 — копим
    const queued = await User.updateOne(
      { telegramId, 'waveNotify.day': day },
      { $inc: { 'waveNotify.pending': 1 }, $set: { 'waveNotify.lastQueuedAt': new Date() } }
    );
    if (queued.modifiedCount) return false;
    // Первый 👋 за день. Отложенные с прошлого вечера (пришли после 20:00) не теряем — уйдут в сегодняшнюю сводку
    await User.updateOne({ telegramId }, { $set: { 'waveNotify.day': day, 'waveNotify.sent': 1 } });
    return true;
  } catch (err: any) {
    console.warn('⚠️ Счётчик уведомлений 👋:', err?.message || err);
    return true;
  }
}

// «1 человек», «2 человека», «5 человек»
export function peopleWord(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  return mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14) ? 'человека' : 'человек';
}

export const waveDigestText = (n: number) =>
  `👋 <b>Сегодня с тобой хотят пообщаться ещё ${n} ${peopleWord(n)}</b>\n\nЗагляни, вдруг там кто-то с общими интересами.`;

let isRunning = false;

async function sendWaveDigests() {
  if (isRunning) return;
  const now = Date.now();
  if (new Date(now + MINSK).getUTCHours() < DIGEST_HOUR) return;
  isRunning = true;
  try {
    const day = minskDayKey(now);
    const due = await User.find(
      { 'waveNotify.pending': { $gt: 0 }, 'waveNotify.digestDay': { $ne: day } },
      { telegramId: 1, waveNotify: 1, lastActiveAt: 1, canMessage: 1, isBanned: 1 }
    ).lean();
    let sent = 0;
    for (const u of due) {
      const n = u.waveNotify?.pending || 0;
      // Сначала отмечаем — чтобы не отправить дважды
      await User.updateOne({ _id: u._id }, { $set: { 'waveNotify.pending': 0, 'waveNotify.digestDay': day } });
      const lastActive = u.lastActiveAt ? new Date(u.lastActiveAt).getTime() : 0;
      const lastQueued = u.waveNotify?.lastQueuedAt ? new Date(u.waveNotify.lastQueuedAt).getTime() : 0;
      if (u.isBanned || u.canMessage === false) continue;
      if (now - lastActive > INACTIVE_DAYS * DAY) continue; // давно не заходил — не пишем
      if (lastActive > lastQueued) continue; // уже заходил после последнего 👋 и всё видел
      if (await sendTelegramMessage(u.telegramId, waveDigestText(n), 'Посмотреть', '?tab=likes')) sent++;
      await new Promise((r) => setTimeout(r, 60)); // Telegram: не больше ~30 сообщений в секунду
    }
    if (due.length) console.log(`👋 Вечерняя сводка приветов: отправлено ${sent} из ${due.length}`);
  } finally {
    isRunning = false;
  }
}

export function startWaveDigestLoop() {
  const run = () => sendWaveDigests().catch((err) => console.warn('⚠️ Сводка приветов:', err?.message || err));
  setTimeout(run, 90 * 1000);
  setInterval(run, 10 * 60 * 1000);
}
