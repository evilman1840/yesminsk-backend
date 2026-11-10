import { Express, Response } from 'express';
import { Schema, model } from 'mongoose';
import { telegramAuthMiddleware, AuthenticatedRequest } from './middleware/telegramAuth';
import { isAdmin } from './news';

/**
 * Мини-сериал «Не Одна Дома»: сами серии живут в приложении (картинки и тексты),
 * здесь — кто что посмотрел, до какой карточки дошёл, сердечки и «Попробовать».
 * Одна запись на человека и серию
 */

const SOURCES = ['intro', 'joy', 'strip', 'shelf', 'tv', 'next', 'link', 'notice'] as const;

const SerialView = model(
  'SerialView',
  new Schema(
    {
      telegramId: { type: Number, required: true },
      ep: { type: Number, required: true },
      maxFrame: { type: Number, default: 0 }, // 0 — обложка; дальше — номер карточки
      frames: { type: Number, default: 0 },   // сколько карточек в серии
      liked: { type: Boolean, default: false },
      tried: { type: Number, default: 0 },    // нажатия «Попробовать»
      source: { type: String, enum: SOURCES, default: 'shelf' } // откуда открыли впервые
    },
    { timestamps: true }
  ).index({ telegramId: 1, ep: 1 }, { unique: true })
);

const MAX_EP = 60;
const epOf = (v: any) => {
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= MAX_EP ? n : null;
};

const heartsByEp = async (): Promise<Record<number, number>> => {
  const rows = await SerialView.aggregate([{ $match: { liked: true } }, { $group: { _id: '$ep', n: { $sum: 1 } } }]);
  return Object.fromEntries(rows.map((r) => [r._id, r.n]));
};

export function setupSerialRoutes(app: Express) {
  // Что я уже посмотрел и сколько сердечек у каждой серии
  app.get('/api/serial', telegramAuthMiddleware as any, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const mine = await SerialView.find({ telegramId: req.telegramUser!.id }, { ep: 1, maxFrame: 1, frames: 1, liked: 1 }).lean();
      const seen: Record<number, { maxFrame: number; frames: number; liked: boolean }> = {};
      for (const v of mine) seen[v.ep] = { maxFrame: v.maxFrame, frames: v.frames, liked: v.liked };
      res.json({ seen, hearts: await heartsByEp() });
    } catch {
      res.status(500).json({ error: 'Не получилось загрузить серии' });
    }
  });

  // Дошёл до карточки frame (из frames). Первый раз запоминаем, откуда открыли
  app.post('/api/serial/:ep/view', telegramAuthMiddleware as any, async (req: AuthenticatedRequest, res: Response) => {
    const ep = epOf(req.params.ep);
    const frame = Math.max(0, Math.min(30, Math.floor(Number(req.body?.frame) || 0)));
    const frames = Math.max(0, Math.min(30, Math.floor(Number(req.body?.frames) || 0)));
    const source = SOURCES.includes(req.body?.source) ? req.body.source : 'shelf';
    if (!ep) return res.status(400).json({ error: 'Нет такой серии' });
    try {
      await SerialView.updateOne(
        { telegramId: req.telegramUser!.id, ep },
        { $max: { maxFrame: frame }, $set: { frames }, $setOnInsert: { source } },
        { upsert: true }
      );
      res.json({ ok: true });
    } catch {
      res.json({ ok: false });
    }
  });

  app.post('/api/serial/:ep/like', telegramAuthMiddleware as any, async (req: AuthenticatedRequest, res: Response) => {
    const ep = epOf(req.params.ep);
    if (!ep) return res.status(400).json({ error: 'Нет такой серии' });
    try {
      await SerialView.updateOne({ telegramId: req.telegramUser!.id, ep }, { $set: { liked: !!req.body?.liked } }, { upsert: true });
      res.json({ hearts: await SerialView.countDocuments({ ep, liked: true }) });
    } catch {
      res.status(500).json({ error: 'Не получилось' });
    }
  });

  app.post('/api/serial/:ep/try', telegramAuthMiddleware as any, async (req: AuthenticatedRequest, res: Response) => {
    const ep = epOf(req.params.ep);
    if (!ep) return res.status(400).json({ error: 'Нет такой серии' });
    await SerialView.updateOne({ telegramId: req.telegramUser!.id, ep }, { $inc: { tried: 1 } }, { upsert: true }).catch(() => {});
    res.json({ ok: true });
  });
}

const pct = (a: number, b: number) => (b ? Math.round((a / b) * 100) : 0);

// Строки для /stats: по каждой серии — смотрели, досмотрели, ❤️, «Попробовать», перешли на следующую, воронка по карточкам
export async function serialStatsLines(): Promise<string[]> {
  // Админы тестируют серии до выхода — в статистику их не берём
  const views = (await SerialView.find({}, { telegramId: 1, ep: 1, maxFrame: 1, frames: 1, liked: 1, tried: 1, source: 1 }).lean()).filter(
    (v) => !isAdmin(v.telegramId)
  );
  if (!views.length) return [];
  const byEp = new Map<number, typeof views>();
  for (const v of views) byEp.set(v.ep, [...(byEp.get(v.ep) || []), v]);
  const eps = [...byEp.keys()].sort((a, b) => a - b);
  const lines = [`📺 <b>«Не Одна Дома»</b>`];
  for (const ep of eps) {
    const list = byEp.get(ep)!;
    const frames = Math.max(...list.map((v) => v.frames || 0));
    const watched = list.length;
    const done = frames ? list.filter((v) => v.maxFrame >= frames - 1).length : 0;
    const hearts = list.filter((v) => v.liked).length;
    const triedPeople = list.filter((v) => v.tried > 0).length;
    const next = byEp.get(ep + 1);
    const nextIds = new Set((next || []).map((v) => v.telegramId));
    const wentNext = next ? list.filter((v) => nextIds.has(v.telegramId)).length : 0;
    const from = SOURCES.map((s) => [s, list.filter((v) => v.source === s).length] as const).filter(([, n]) => n);
    lines.push(
      `С${ep}: смотрели ${watched} · досмотрели ${done} (${pct(done, watched)}%) · ❤️ ${hearts} · «Попробовать» ${triedPeople}` +
        (next ? ` · открыли С${ep + 1}: ${wentNext} (${pct(wentNext, watched)}%)` : '')
    );
    if (frames > 1) {
      const funnel = Array.from({ length: frames }, (_, i) => list.filter((v) => v.maxFrame >= i).length);
      lines.push(`   карточки: ${funnel.join(' → ')}`);
    }
    if (from.length) {
      const names: Record<string, string> = { intro: 'приветствие Миши', joy: 'сама после радости', strip: 'плашка', shelf: 'список серий', tv: 'телевизор', next: 'из прошлой серии', link: 'ссылка', notice: 'строка подсказок' };
      lines.push(`   откуда: ${from.map(([s, n]) => `${names[s] || s} ${n}`).join(' · ')}`);
    }
  }
  return lines;
}
