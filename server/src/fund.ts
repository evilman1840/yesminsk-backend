import { Express, Response } from 'express';
import { Schema, model } from 'mongoose';
import { telegramAuthMiddleware, AuthenticatedRequest } from './middleware/telegramAuth';
import { isAdmin } from './news';
import { sendWithButtons } from './wishes';
import { countCoffee } from './coffee';
import { escapeHtml } from './utils/telegramNotify';
import { FUND_TEXTS as T } from './texts';

/**
 * Шкала донатов: сколько всего собрано и сколько из этого — в котёл для пользователей.
 * Автор пишет боту «/fund 95 48,45», приложение показывает шкалу в «Новостях» и в окне доната.
 * Переводы приютам и волонтёрам — «/sent 15 Приют «Хвостики»», в окне доната видно последний и сумму
 */
const Fund = model(
  'Fund',
  new Schema({ key: { type: String, unique: true }, total: Number, community: Number, updatedAt: Date })
);

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
      Fund.findOne({ key: KEY }).lean().catch(() => null),
      Transfer.findOne().sort({ createdAt: -1 }).lean().catch(() => null),
      sentTotal().catch(() => 0),
      countCoffee().catch(() => 0)
    ]);
    res.json({
      total: f?.total || 0,
      community: f?.community || 0,
      updatedAt: f?.updatedAt,
      sent,
      coffee,
      lastTransfer: last ? { amount: last.amount, to: last.to, at: last.createdAt } : null
    });
  });
}

// /fund — показать; /fund 95 48,45 — всего собрано и сколько из этого в котёл для пользователей.
// /sent — переводы; /sent 15 Приют «Хвостики» — записать перевод; /delsent — удалить последний
export async function handleFundCommand(message: any): Promise<boolean> {
  const text: string = (message.text || '').trim();
  if (/^\/sent(@\w+)?(\s|$)/i.test(text)) return handleSent(message, text);
  if (/^\/delsent(@\w+)?$/i.test(text)) return handleDelSent(message);
  if (!/^\/fund\b/i.test(text)) return false;
  const chatId = message.chat.id;
  if (!isAdmin(message.from?.id)) return true;
  const args = text.split(/\s+/).slice(1);
  if (!args.length) {
    const f = await Fund.findOne({ key: KEY }).lean();
    await sendWithButtons(chatId, f ? T.current(formatRub(f.total || 0), formatRub(f.community || 0), formatRub((f.total || 0) - (f.community || 0))) + T.usage : T.usage, []);
    return true;
  }
  const total = num(args[0]);
  const community = num(args[1] ?? '0');
  if (!Number.isFinite(total) || !Number.isFinite(community) || total < 0 || community < 0 || community > total) {
    await sendWithButtons(chatId, T.bad + T.usage, []);
    return true;
  }
  await Fund.updateOne({ key: KEY }, { $set: { total, community, updatedAt: new Date() } }, { upsert: true });
  await sendWithButtons(chatId, T.saved(formatRub(total), formatRub(community), formatRub(total - community)), []);
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
