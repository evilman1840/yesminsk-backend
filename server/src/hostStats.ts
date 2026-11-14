import { Express, Response } from 'express';
import { telegramAuthMiddleware, AuthenticatedRequest } from './middleware/telegramAuth';
import { Event } from './models/Event';
import { User } from './models/User';
import { avatarFor } from './avatars';
import { isAdmin } from './news';
import { sendTelegramMessage, escapeHtml } from './utils/telegramNotify';

/**
 * Организаторы: сколько сходок человек провёл, значки «🌱 Организатор» (held ≥ 1, рисует приложение) и «🔥 Активный организатор»,
 * список «Организаторы месяца».
 * Считаем только состоявшиеся сходки — где было хотя бы двое (без отмеченных «Не пришёл(ла)»),
 * чтобы значок нельзя было набрать пустыми сходками
 */

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;
const TTL = 15 * MINUTE;       // пересчитываем не чаще раза в 15 минут
const ACTIVE_DAYS = 60;        // «🔥»: за последние два месяца…
const ACTIVE_MIN = 3;          // …проведено хотя бы три сходки
const MONTH_DAYS = 30;         // «Организаторы месяца»: за последние 30 дней…
const MONTH_MIN = 1;           // …хотя бы одна сходка: благодарим и тех, кто собрал первую
const MONTH_TOP = 40;          // в шторке 🏆 — все (с разумным потолком); карточка в ленте берёт первых шестерых
const MONTH_MIN_HOSTS = 2;     // один человек — ещё не список

export interface HostInfo {
  held: number;        // всего проведено сходок
  active?: boolean;    // «🔥 Активный организатор»
  supporter?: boolean; // «🍩 Кормит ГУЛЯЙ-Печку»
}

export interface MonthHost extends HostInfo {
  telegramId: number;
  name: string;
  avatarUrl: string;
}

let cache: { at: number; info: Map<number, HostInfo>; month: MonthHost[] } | null = null;
let running: Promise<void> | null = null;

async function compute() {
  const now = Date.now();
  const events = await Event.find(
    { dateTime: { $lt: new Date(now) }, isActive: { $ne: false } },
    { dateTime: 1, 'creator.telegramId': 1, 'participants.telegramId': 1, 'participants.noShowAt': 1 }
  ).lean();

  const byHost = new Map<number, { held: number; recent: number; month: number; monthPeople: number }>();
  for (const e of events) {
    const came = new Set((e.participants || []).filter((p) => !p.noShowAt).map((p) => p.telegramId));
    const hostId = Number(e.creator?.telegramId);
    if (came.size < 2 || !hostId) continue;
    const h = byHost.get(hostId) || { held: 0, recent: 0, month: 0, monthPeople: 0 };
    const age = now - new Date(e.dateTime).getTime();
    h.held++;
    if (age <= ACTIVE_DAYS * DAY) h.recent++;
    if (age <= MONTH_DAYS * DAY) {
      h.month++;
      h.monthPeople += came.size;
    }
    byHost.set(hostId, h);
  }

  const supporters = new Set((await User.distinct('telegramId', { isSupporter: true })).map(Number));
  const info = new Map<number, HostInfo>();
  byHost.forEach((h, id) => info.set(id, { held: h.held, ...(h.recent >= ACTIVE_MIN ? { active: true } : {}), ...(supporters.has(id) ? { supporter: true } : {}) }));
  supporters.forEach((id) => {
    if (!info.has(id)) info.set(id, { held: 0, supporter: true });
  });

  // Месяц: больше сходок — раньше, при равенстве — у кого было больше людей. Автор проекта тоже в списке
  const top = [...byHost.entries()]
    .filter(([, h]) => h.month >= MONTH_MIN)
    .sort((a, b) => b[1].month - a[1].month || b[1].monthPeople - a[1].monthPeople)
    .slice(0, MONTH_TOP * 2); // с запасом: часть анкет может быть скрыта или удалена
  const users = await User.find(
    { telegramId: { $in: top.map(([id]) => id) }, isBanned: { $ne: true }, hiddenByReports: { $ne: true }, isProfileActive: { $ne: false } },
    { telegramId: 1, firstName: 1, avatarUrl: 1, photosHidden: 1 }
  ).lean();
  const userById = new Map(users.map((u) => [u.telegramId, u]));
  const month: MonthHost[] = [];
  for (const [id] of top) {
    const u = userById.get(id);
    if (!u || month.length >= MONTH_TOP) continue;
    month.push({ telegramId: id, name: u.firstName, avatarUrl: u.photosHidden ? '' : avatarFor(id, u.avatarUrl), ...info.get(id)! });
  }

  cache = { at: now, info, month: month.length >= MONTH_MIN_HOSTS ? month : [] };
}

/**
 * Посчитать, если ещё не считали. Устаревшие числа отдаём сразу и обновляем в фоне: лента сходок важнее свежего счётчика
 */
export async function ensureHostStats(): Promise<void> {
  if (cache && Date.now() - cache.at < TTL) return;
  if (!running) {
    running = compute()
      .catch((err) => console.warn('⚠️ Статистика организаторов:', err?.message || err))
      .finally(() => {
        running = null;
      });
  }
  if (!cache) await running;
}

// Для карточки сходки и анкеты: ничего не провёл и Печку не кормит — поля нет
export const hostInfo = (telegramId: number): HostInfo | undefined => cache?.info.get(Number(telegramId));

/**
 * «/pechka @ник» — автор проекта сам ставит отметку «🍩 Кормит ГУЛЯЙ-Печку» тому, кто задонатил, но не отметился.
 * «/pechka @ник off» — снять. Вместо ника можно номер аккаунта. Человеку бот ничего не пишет
 */
export async function handlePechkaCommand(message: any): Promise<boolean> {
  const text: string = (message.text || '').trim();
  if (!/^\/pechka(@\w+)?(\s|$)/i.test(text)) return false;
  if (!isAdmin(message.from?.id)) return true;
  const chatId = message.chat.id;
  const [who, flag] = text.split(/\s+/).slice(1);
  const name = (who || '').replace(/^@/, '');
  if (!/^\w{2,40}$/.test(name)) {
    sendTelegramMessage(chatId, '🍩 Отметка Печки вручную:\n<code>/pechka @ник</code> — поставить\n<code>/pechka @ник off</code> — снять\nВместо ника можно номер аккаунта.');
    return true;
  }
  const query = /^\d+$/.test(name) ? { telegramId: Number(name) } : { username: new RegExp(`^${name}$`, 'i') };
  const users = await User.find(query, { telegramId: 1, firstName: 1, username: 1, isSupporter: 1 }).limit(3).lean();
  if (!users.length) {
    sendTelegramMessage(chatId, `Не нашёл в приложении никого с «${escapeHtml(who)}». Проверь ник: человек мог его сменить или ещё не заходил в приложение.`);
    return true;
  }
  if (users.length > 1) {
    sendTelegramMessage(chatId, `С таким ником несколько анкет, укажи номер аккаунта:\n${users.map((u) => `${escapeHtml(u.firstName)}: <code>/pechka ${u.telegramId}</code>`).join('\n')}`);
    return true;
  }
  const u = users[0];
  const on = !/^(off|нет|снять|-)$/i.test(flag || '');
  await User.updateOne({ telegramId: u.telegramId }, on ? { $set: { isSupporter: true } } : { $unset: { isSupporter: 1 } });
  if (cache) cache.at = 0; // значок на карточках сходок — со следующей загрузки ленты
  const label = `${escapeHtml(u.firstName)}${u.username ? ` (@${escapeHtml(u.username)})` : ''}`;
  sendTelegramMessage(chatId, on ? `🍩 Готово: ${label} теперь с отметкой «Кормит ГУЛЯЙ-Печку».${u.isSupporter ? ' Она уже стояла.' : ''}` : `Отметку Печки у ${label} снял.`);
  return true;
}

export function setupHostRoutes(app: Express) {
  // «Организаторы месяца» — без тех, кого я заблокировал и кто заблокировал меня
  app.get('/api/hosts/month', telegramAuthMiddleware as any, async (req: AuthenticatedRequest, res: Response) => {
    try {
      await ensureHostStats();
      const hosts = cache?.month || [];
      if (!hosts.length) return res.json({ hosts: [] });
      const myId = req.telegramUser!.id;
      const [me, blockedMe] = await Promise.all([
        User.findOne({ telegramId: myId }, { blockedUsers: 1 }).lean(),
        User.distinct('telegramId', { telegramId: { $in: hosts.map((h) => h.telegramId) }, blockedUsers: myId })
      ]);
      const hidden = new Set([...(me?.blockedUsers || []), ...blockedMe].map(Number));
      res.json({ hosts: hosts.filter((h) => !hidden.has(h.telegramId)) });
    } catch (err: any) {
      console.warn('⚠️ /api/hosts/month:', err?.message || err);
      res.status(500).json({ error: 'Не удалось загрузить организаторов' });
    }
  });
}
