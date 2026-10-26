import { Express, Response } from 'express';
import { Schema, model } from 'mongoose';
import { telegramAuthMiddleware, AuthenticatedRequest } from './middleware/telegramAuth';
import { isAdmin } from './news';
import { sendWithButtons } from './wishes';
import { FUND_TEXTS as T } from './texts';

/**
 * Шкала донатов: сколько всего собрано и сколько из этого — в котёл для пользователей.
 * Автор пишет боту «/fund 95 48,45», приложение показывает шкалу в «Новостях» и в окне доната
 */
const Fund = model(
  'Fund',
  new Schema({ key: { type: String, unique: true }, total: Number, community: Number, updatedAt: Date })
);

const KEY = 'main';
const num = (s: string) => Number(String(s).replace(',', '.'));
export const formatRub = (n: number) => `${(Math.round(n * 100) / 100).toLocaleString('ru-RU', { maximumFractionDigits: 2 })} р.`;

export function setupFundRoutes(app: Express) {
  app.get('/api/fund', telegramAuthMiddleware as any, async (_req: AuthenticatedRequest, res: Response) => {
    const f = await Fund.findOne({ key: KEY }).lean().catch(() => null);
    res.json(f ? { total: f.total || 0, community: f.community || 0, updatedAt: f.updatedAt } : { total: 0, community: 0 });
  });
}

// /fund — показать; /fund 95 48,45 — всего собрано и сколько из этого в котёл для пользователей
export async function handleFundCommand(message: any): Promise<boolean> {
  const text: string = (message.text || '').trim();
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
