import { Schema, model } from 'mongoose';
import { Event } from './models/Event';
import { isAdmin } from './news';
import { sendWithButtons } from './wishes';
import { escapeHtml } from './utils/telegramNotify';
import { COFFEE_TEXTS as T } from './texts';

/**
 * Кофе организаторам: раз в неделю разыгрываем кофе среди тех, кто провёл сходку.
 *
 * Боту (только автор):
 *   /coffee      — розыгрыш за прошлую неделю (пн–вс по Минску); если уже был — показать итог
 *   /coffee ещё  — ещё один победитель той же недели (кофе больше или победитель не ответил)
 *
 * Билетик — каждая прошедшая сходка, куда записались хотя бы 2 человека кроме организатора
 * (без отмеченных «Не пришёл»). Скрытые и удалённые сходки не считаются
 */

const MIN_GUESTS = 2;
const MINSK_OFFSET_MS = 3 * 60 * 60 * 1000; // Беларусь круглый год UTC+3

const CoffeeDraw = model(
  'CoffeeDraw',
  new Schema({
    weekStart: { type: Date, unique: true },
    winners: [{ telegramId: Number, name: String, username: String, tickets: Number, drawnAt: Date }]
  })
);

// Понедельник 00:00 по Минску прошлой недели и следующий понедельник
function lastWeek(now = new Date()) {
  const minsk = new Date(now.getTime() + MINSK_OFFSET_MS);
  const daysSinceMonday = (minsk.getUTCDay() + 6) % 7;
  const thisMonday = Date.UTC(minsk.getUTCFullYear(), minsk.getUTCMonth(), minsk.getUTCDate() - daysSinceMonday) - MINSK_OFFSET_MS;
  const start = new Date(thisMonday - 7 * 24 * 60 * 60 * 1000);
  return { start, end: new Date(thisMonday) };
}

const dayMonth = (d: Date) => d.toLocaleDateString('ru-RU', { timeZone: 'Europe/Minsk', day: 'numeric', month: 'long' });

interface Host {
  telegramId: number;
  name: string;
  username?: string;
  tickets: number;
}

async function hostsOfWeek(start: Date, end: Date): Promise<Host[]> {
  const events = await Event.find(
    { isActive: true, stopWordsHold: { $ne: true }, dateTime: { $gte: start, $lt: end } },
    { creator: 1, participants: 1 }
  ).lean();
  const hosts = new Map<number, Host>();
  for (const ev of events) {
    const guests = ev.participants.filter((p) => p.telegramId !== ev.creator.telegramId && !p.noShowAt);
    if (guests.length < MIN_GUESTS) continue;
    const h = hosts.get(ev.creator.telegramId) || { telegramId: ev.creator.telegramId, name: ev.creator.name, username: ev.creator.username, tickets: 0 };
    h.tickets += 1;
    hosts.set(h.telegramId, h);
  }
  return [...hosts.values()].sort((a, b) => b.tickets - a.tickets);
}

// Случайный победитель: чем больше билетиков, тем больше шансов
function pick(hosts: Host[]): Host {
  let r = Math.random() * hosts.reduce((s, h) => s + h.tickets, 0);
  for (const h of hosts) {
    r -= h.tickets;
    if (r < 0) return h;
  }
  return hosts[hosts.length - 1];
}

const who = (w: { telegramId: number; name: string; username?: string }) =>
  `<a href="tg://user?id=${w.telegramId}">${escapeHtml(w.name)}</a>${w.username ? ` @${escapeHtml(w.username)}` : ''}`;

function report(start: Date, end: Date, hosts: Host[], winners: any[]) {
  const period = `${dayMonth(start)} – ${dayMonth(new Date(end.getTime() - 1))}`;
  const list = hosts.map((h) => `• ${escapeHtml(h.name)}: ${h.tickets} 🎟`).join('\n');
  const won = winners.map((w, i) => `${i + 1}. ${who(w)} (${w.tickets} 🎟)`).join('\n');
  return T.report(period, hosts.length, list, won);
}

export async function handleCoffeeCommand(message: any): Promise<boolean> {
  const text: string = (message.text || '').trim();
  const m = text.match(/^\/coffee(@\w+)?(?:\s+(.*))?$/i);
  if (!m) return false;
  const chatId = message.chat.id;
  if (!isAdmin(message.from?.id)) return true;
  const more = /^(ещё|еще|more)$/i.test((m[2] || '').trim());

  const { start, end } = lastWeek();
  const hosts = await hostsOfWeek(start, end);
  const draw: any = await CoffeeDraw.findOne({ weekStart: start }).lean();
  const winners: any[] = draw?.winners || [];

  if (winners.length && !more) {
    sendWithButtons(chatId, T.already + report(start, end, hosts, winners) + T.usage, []);
    return true;
  }
  const left = hosts.filter((h) => !winners.some((w) => w.telegramId === h.telegramId));
  if (!left.length) {
    sendWithButtons(chatId, (hosts.length ? T.noneLeft : T.noHosts(MIN_GUESTS)) + T.usage, []);
    return true;
  }

  const winner = { ...pick(left), drawnAt: new Date() };
  await CoffeeDraw.updateOne({ weekStart: start }, { $push: { winners: winner } }, { upsert: true });
  sendWithButtons(chatId, T.drawn + report(start, end, hosts, [...winners, winner]) + T.usage, []);
  return true;
}
