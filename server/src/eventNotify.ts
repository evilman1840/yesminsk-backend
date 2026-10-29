import { Event, IEvent } from './models/Event';
import { priceLabel } from './texts';
import { sendTelegramMessage, escapeHtml, markCannotMessage } from './utils/telegramNotify';

/**
 * Уведомления о сходках через бота: напоминания, изменения, отмена, новые участники
 */

const CATEGORY_EMOJI: Record<string, string> = {
  walk: '🚶',
  cafe_bar: '☕️',
  expo_cinema: '🎨',
  trip_outdoors: '🌲',
  boardgames: '🎲',
  sport: '🚴',
  talk: '🤗',
  support: '🫂',
  other: '✨'
};

// «суббота, 25 октября, 18:00» — всегда по минскому времени, где бы ни стоял сервер
export const formatWhen = (date: Date) =>
  new Date(date).toLocaleString('ru-RU', {
    timeZone: 'Europe/Minsk',
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit'
  });

// Сколько мест занято: каждый участник плюс его гости
export const seatsTaken = (event: IEvent) => event.participants.reduce((sum, p) => sum + 1 + (p.guests || 0), 0);

// «+1, с детьми» — как человек идёт (для сообщений организатору)
export const companyNote = (guests = 0, withKids = false) =>
  [guests > 0 ? `+${guests}` : '', withKids ? 'с детьми 👶' : ''].filter(Boolean).join(', ');

// Карточка сходки для сообщения бота
export const eventSummaryHtml = (event: IEvent) =>
  `${CATEGORY_EMOJI[event.category] || '📍'} <b>${escapeHtml(event.title)}</b>\n` +
  `🕒 ${formatWhen(event.dateTime)}\n` +
  `📍 ${escapeHtml(event.locationName)}\n` +
  `${priceLabel(event)}\n` +
  `👥 Идут: ${seatsTaken(event)}`;

export const eventAppPath = (event: IEvent) => `?event=${event._id.toString()}`;

// Кнопки «✅ Точно приду» / «❌ Отменить»: открывают сходку в приложении, оно само отмечает ответ (rsvp=yes|no)
export type EventBtn = { text: string; path?: string; url?: string };
export const rsvpButtons = (event: IEvent): EventBtn[] => [
  { text: '✅ Точно приду', path: `${eventAppPath(event)}&rsvp=yes` },
  { text: '❌ Отменить', path: `${eventAppPath(event)}&rsvp=no` }
];

export async function sendEventButtons(chatId: number, html: string, rows: EventBtn[][]) {
  const appUrl = (process.env.MINI_APP_URL || '').replace(/\/+$/, '');
  const keyboard = rows
    .map((row) => row.filter((b) => b.url || appUrl).map((b) => (b.url ? { text: b.text, url: b.url } : { text: b.text, web_app: { url: `${appUrl}/${b.path || ''}` } })))
    .filter((row) => row.length);
  const res = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: html, parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: { inline_keyboard: keyboard } })
  }).catch(() => null);
  if (res?.status === 403) markCannotMessage(chatId);
  return Boolean(res?.ok);
}

// Напоминание: участникам — «Точно приду / Отменить», организатору — просто открыть сходку
const remindParticipants = (event: IEvent, html: string) => {
  for (const p of event.participants) {
    const isHost = p.telegramId === event.creator.telegramId;
    const rows: EventBtn[][] = [...(isHost ? [] : [rsvpButtons(event)]), [{ text: 'Открыть сходку', path: eventAppPath(event) }]];
    sendEventButtons(p.telegramId, html, rows);
  }
};

// Сообщение всем участникам (кроме exceptId — обычно того, кто сам что-то поменял)
export const notifyParticipants = (event: IEvent, html: string, exceptId?: number, buttonText = 'Открыть сходку') => {
  for (const p of event.participants) {
    if (p.telegramId === exceptId) continue;
    sendTelegramMessage(p.telegramId, html, buttonText, eventAppPath(event));
  }
};

const HOUR = 60 * 60 * 1000;

/**
 * Проверка напоминаний: за сутки и за час до сходки.
 * Флаги в базе гарантируют, что каждое напоминание уйдёт один раз, даже после перезапуска сервера
 */
export async function sendDueReminders() {
  const now = Date.now();

  // За сутки — только если сходку создали заранее (иначе напоминание придёт сразу после создания)
  const dayEvents = await Event.find({
    isActive: true,
    reminderDaySentAt: { $exists: false },
    dateTime: { $gt: new Date(now + 2 * HOUR), $lte: new Date(now + 24 * HOUR) }
  });
  for (const ev of dayEvents) {
    ev.reminderDaySentAt = new Date();
    await ev.save();
    if (ev.dateTime.getTime() - ev.createdAt.getTime() < 24 * HOUR) continue;
    remindParticipants(ev, `⏰ <b>Напоминаем о сходке</b>\n\n${eventSummaryHtml(ev)}\n\nПридёшь? Нажми «Точно приду». Планы поменялись — «Отменить», так организатор будет знать.`);
  }

  const hourEvents = await Event.find({
    isActive: true,
    reminderHourSentAt: { $exists: false },
    dateTime: { $gt: new Date(now), $lte: new Date(now + HOUR) }
  });
  for (const ev of hourEvents) {
    ev.reminderHourSentAt = new Date();
    await ev.save();
    remindParticipants(ev, `🔔 <b>Скоро сходка: меньше чем через час!</b>\n\n${eventSummaryHtml(ev)}\n\nХорошей встречи 💛`);
  }
}

export function startReminderLoop() {
  const run = () => sendDueReminders().catch((err) => console.warn('⚠️ Ошибка напоминаний:', err?.message || err));
  setTimeout(run, 30 * 1000); // первый запуск — вскоре после старта сервера
  setInterval(run, 5 * 60 * 1000); // дальше каждые 5 минут
}
