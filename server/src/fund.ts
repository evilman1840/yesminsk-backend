import { Express, Response } from 'express';
import { Schema, model } from 'mongoose';
import { telegramAuthMiddleware, AuthenticatedRequest } from './middleware/telegramAuth';
import { isAdmin } from './news';
import { sendWithButtons } from './wishes';
import { countCoffee } from './coffee';
import { escapeHtml } from './utils/telegramNotify';
import { FUND_TEXTS as T } from './texts';
import { User } from './models/User';

/**
 * Шкала донатов: сколько всего собрано и сколько из этого — в котёл для пользователей.
 * Автор пишет боту «/fund 95 48,45», приложение показывает шкалу в «Новостях» и в окне доната.
 * Переводы приютам и волонтёрам — «/sent 15 Приют «Хвостики»», в окне доната видно последний и сумму
 */
const Fund = model(
  'Fund',
  new Schema({
    key: { type: String, unique: true },
    total: Number,
    community: Number,
    people: Number,     // сколько человек уже поддержали (третье число в /fund)
    goal: Number,       // цель месяца (/goal), по умолчанию DEFAULT_GOAL
    monthKey: String,   // «2026-11»: за какой месяц запомнен итог на 1-е число
    monthBase: Number,  // итог на 1-е число этого месяца; собрано за месяц = total − monthBase
    updatedAt: Date
  })
);

const DEFAULT_GOAL = 500;
const DEFAULT_PEOPLE = 51; // столько поддержали до появления счётчика в /fund
const MONTHS = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];

// Месяц по Минску: «2026-11»
function minskMonth(): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Minsk', year: 'numeric', month: '2-digit' }).formatToParts(new Date());
  return `${parts.find((p) => p.type === 'year')!.value}-${parts.find((p) => p.type === 'month')!.value}`;
}

// Начался новый месяц — запоминаем итог как «на 1-е число» (до обновления /fund)
async function fundDoc() {
  const key = minskMonth();
  let f: any = await Fund.findOne({ key: KEY }).lean();
  if (!f || f.monthKey !== key) {
    f = await Fund.findOneAndUpdate(
      { key: KEY },
      { $set: { monthKey: key, monthBase: f?.total || 0 } },
      { upsert: true, new: true }
    ).lean();
  }
  return f;
}

function monthInfo(f: any) {
  const goal = f?.goal || DEFAULT_GOAL;
  const raised = Math.max(0, (f?.total || 0) - (f?.monthBase || 0));
  const name = MONTHS[Number(String(f?.monthKey || minskMonth()).slice(5)) - 1];
  return { name, raised, goal };
}

const Transfer = model('Transfer', new Schema({ amount: Number, to: String, createdAt: { type: Date, default: Date.now } }));

const KEY = 'main';
const num = (s: string) => Number(String(s).replace(',', '.'));
export const formatRub = (n: number) => `${(Math.round(n * 100) / 100).toLocaleString('ru-RU', { maximumFractionDigits: 2 })} р.`;

async function sentTotal(): Promise<number> {
  const [r] = await Transfer.aggregate([{ $group: { _id: null, sum: { $sum: '$amount' } } }]);
  return r?.sum || 0;
}

export function setupFundRoutes(app: Express) {
  app.get('/api/fund', telegramAuthMiddleware as any, async (_req: AuthenticatedRequest, res: Response) => {
    const [f, last, sent, coffee] = await Promise.all([
      fundDoc().catch(() => null),
      Transfer.findOne().sort({ createdAt: -1 }).lean().catch(() => null),
      sentTotal().catch(() => 0),
      countCoffee().catch(() => 0)
    ]);
    res.json({
      total: f?.total || 0,
      community: f?.community || 0,
      updatedAt: f?.updatedAt,
      month: monthInfo(f),
      people: f?.people ?? DEFAULT_PEOPLE,
      sent,
      coffee,
      lastTransfer: last ? { amount: last.amount, to: last.to, at: last.createdAt } : null
    });
  });

  // «Готово, перевод сделан ✓» → экран «Спасибо»: две галочки. Проверки перевода нет, всё на честном слове.
  // Суммы и счётчик людей не трогаем. Снятая галочка ничего не меняет
  app.post('/api/fund/thanks', telegramAuthMiddleware as any, async (req: AuthenticatedRequest, res: Response) => {
    const tg = req.telegramUser;
    if (!tg?.id) return res.status(401).json({ error: 'Нет авторизации' });
    const set: Record<string, any> = {};
    if (req.body?.badge) set.isSupporter = true;
    if (req.body?.thanks) {
      set.thanksOk = true;
      set.thanksAt = new Date();
      if (tg.username) set.username = tg.username;
    }
    if (Object.keys(set).length) await User.updateOne({ telegramId: tg.id }, { $set: set });
    res.json({ success: true, isSupporter: Boolean(set.isSupporter) || undefined });
  });
}

// /fund — показать; /fund 95 48,45 51 — всего собрано, сколько из этого в котёл, сколько человек поддержали
// (не указанные числа остаются прежними); /fund месяц 120 — поправить итог на 1-е число.
// /goal 500 — цель месяца. /thanks — кому можно сказать спасибо по имени.
// /sent — переводы; /sent 15 Приют «Хвостики» — записать перевод; /delsent — удалить последний
export async function handleFundCommand(message: any): Promise<boolean> {
  const text: string = (message.text || '').trim();
  if (/^\/sent(@\w+)?(\s|$)/i.test(text)) return handleSent(message, text);
  if (/^\/delsent(@\w+)?$/i.test(text)) return handleDelSent(message);
  if (/^\/goal(@\w+)?(\s|$)/i.test(text)) return handleGoal(message, text);
  if (/^\/thanks(@\w+)?$/i.test(text)) return handleThanks(message);
  if (!/^\/fund\b/i.test(text)) return false;
  const chatId = message.chat.id;
  if (!isAdmin(message.from?.id)) return true;
  const args = text.split(/\s+/).slice(1);
  const f: any = await fundDoc();
  const status = (d: any) => {
    const m = monthInfo(d);
    return T.current(formatRub(d.total || 0), formatRub(d.community || 0), formatRub((d.total || 0) - (d.community || 0)), d.people ?? DEFAULT_PEOPLE) +
      T.month(m.name, formatRub(m.raised), formatRub(m.goal), formatRub(d.monthBase || 0));
  };
  if (!args.length) {
    await sendWithButtons(chatId, status(f) + T.usage, []);
    return true;
  }
  if (/^месяц$/i.test(args[0])) {
    const base = num(args[1] ?? '');
    if (!Number.isFinite(base) || base < 0) {
      await sendWithButtons(chatId, T.bad + T.usage, []);
      return true;
    }
    const d = await Fund.findOneAndUpdate({ key: KEY }, { $set: { monthBase: base } }, { new: true }).lean();
    await sendWithButtons(chatId, '✅ Поправил итог на 1-е число.\n\n' + status(d), []);
    return true;
  }
  const total = num(args[0]);
  const community = args[1] !== undefined ? num(args[1]) : f.community || 0;
  const people = args[2] !== undefined ? num(args[2]) : f.people ?? DEFAULT_PEOPLE;
  if (
    !Number.isFinite(total) || !Number.isFinite(community) || !Number.isInteger(people) ||
    total < 0 || community < 0 || people < 0 || community > total
  ) {
    await sendWithButtons(chatId, T.bad + T.usage, []);
    return true;
  }
  const d = await Fund.findOneAndUpdate({ key: KEY }, { $set: { total, community, people, updatedAt: new Date() } }, { new: true }).lean();
  await sendWithButtons(chatId, '✅ Обновил.\n\n' + status(d) + T.savedTail, []);
  return true;
}

// /goal — показать цель месяца; /goal 500 — поменять
async function handleGoal(message: any, text: string): Promise<boolean> {
  const chatId = message.chat.id;
  if (!isAdmin(message.from?.id)) return true;
  const arg = text.split(/\s+/)[1];
  if (arg === undefined) {
    const m = monthInfo(await fundDoc());
    await sendWithButtons(chatId, T.goalCurrent(m.name, formatRub(m.raised), formatRub(m.goal)) + T.goalUsage, []);
    return true;
  }
  const goal = num(arg);
  if (!Number.isFinite(goal) || goal <= 0) {
    await sendWithButtons(chatId, T.goalBad + T.goalUsage, []);
    return true;
  }
  await fundDoc();
  await Fund.updateOne({ key: KEY }, { $set: { goal } });
  await sendWithButtons(chatId, T.goalSaved(formatRub(goal)), []);
  return true;
}

// /thanks — кто разрешил сказать спасибо по имени (новые сверху)
async function handleThanks(message: any): Promise<boolean> {
  const chatId = message.chat.id;
  if (!isAdmin(message.from?.id)) return true;
  const list = await User.find({ thanksOk: true }, { firstName: 1, lastName: 1, username: 1, thanksAt: 1 })
    .sort({ thanksAt: -1 })
    .limit(200)
    .lean();
  if (!list.length) {
    await sendWithButtons(chatId, T.thanksNone, []);
    return true;
  }
  const lines = list.map((u: any) => {
    const name = escapeHtml([u.firstName, u.lastName].filter(Boolean).join(' ') || 'Без имени');
    const date = u.thanksAt ? new Date(u.thanksAt).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', timeZone: 'Europe/Minsk' }) : '';
    return `• ${name}${u.username ? ` @${escapeHtml(u.username)}` : ''}${date ? ` · ${date}` : ''}`;
  });
  await sendWithButtons(chatId, T.thanksList(list.length, lines.join('\n')), []);
  return true;
}

async function handleSent(message: any, text: string): Promise<boolean> {
  const chatId = message.chat.id;
  if (!isAdmin(message.from?.id)) return true;
  const m = text.match(/^\/sent(?:@\w+)?\s+(\d+(?:[.,]\d+)?)\s+(.+)$/is);
  if (!m) {
    if (text.split(/\s+/).length > 1) {
      await sendWithButtons(chatId, T.sentBad + T.sentUsage, []);
      return true;
    }
    const last = await Transfer.find().sort({ createdAt: -1 }).limit(5).lean();
    const list = last.map((t) => `• ${formatRub(t.amount || 0)} → ${escapeHtml(t.to || '')}`).join('\n');
    await sendWithButtons(chatId, (last.length ? T.sentList(formatRub(await sentTotal()), list) : T.sentNone) + T.sentUsage, []);
    return true;
  }
  const amount = num(m[1]);
  const to = m[2].trim().slice(0, 80);
  if (!Number.isFinite(amount) || amount <= 0) {
    await sendWithButtons(chatId, T.sentBad + T.sentUsage, []);
    return true;
  }
  await Transfer.create({ amount, to });
  await sendWithButtons(chatId, T.sentSaved(formatRub(amount), escapeHtml(to), formatRub(await sentTotal())), []);
  return true;
}

async function handleDelSent(message: any): Promise<boolean> {
  const chatId = message.chat.id;
  if (!isAdmin(message.from?.id)) return true;
  const last = await Transfer.findOneAndDelete({}, { sort: { createdAt: -1 } }).lean();
  if (!last) {
    await sendWithButtons(chatId, T.sentNone, []);
    return true;
  }
  await sendWithButtons(chatId, T.sentDeleted(formatRub(last.amount || 0), escapeHtml(last.to || ''), formatRub(await sentTotal())), []);
  return true;
}
