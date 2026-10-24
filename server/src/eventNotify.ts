import { Event, IEvent } from './models/Event';
import { priceLabel } from './texts';
import { sendTelegramMessage, escapeHtml } from './utils/telegramNotify';

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
    notifyParticipants(ev, `⏰ <b>Напоминаем о сходке</b>\n\n${eventSummaryHtml(ev)}\n\nПланы поменялись? Отмени участие в приложении, так организатор будет знать.`);
  }

  const hourEvents = await Event.find({
    isActive: true,
    reminderHourSentAt: { $exists: false },
    dateTime: { $gt: new Date(now), $lte: new Date(now + HOUR) }
  });
  for (const ev of hourEvents) {
    ev.reminderHourSentAt = new Date();
    await ev.save();
    notifyParticipants(ev, `🔔 <b>Скоро сходка: меньше чем через час!</b>\n\n${eventSummaryHtml(ev)}\n\nХорошей встречи 💛`);
  }
}

export function startReminderLoop() {
  const run = () => sendDueReminders().catch((err) => console.warn('⚠️ Ошибка напоминаний:', err?.message || err));
  setTimeout(run, 30 * 1000); // первый запуск — вскоре после старта сервера
  setInterval(run, 5 * 60 * 1000); // дальше каждые 5 минут
}
