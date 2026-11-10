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
      answer: { type: String },               // вопрос в конце серии: какой вариант выбрал (один раз)
      wished: { type: Boolean, default: false }, // вопрос «А ты?»: отметил «Хочу сходить» прямо из серии
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

// Ответы на вопрос в конце серии: серия → вариант → сколько выбрали
const answersByEp = async (): Promise<Record<number, Record<string, number>>> => {
  const rows = await SerialView.aggregate([
    { $match: { answer: { $exists: true, $ne: null } } },
    { $group: { _id: { ep: '$ep', a: '$answer' }, n: { $sum: 1 } } }
  ]);
  const out: Record<number, Record<string, number>> = {};
  for (const r of rows) (out[r._id.ep] ||= {})[r._id.a] = r.n;
  return out;
};
const OPTION_RE = /^[a-z0-9_-]{1,24}$/;

const heartsByEp = async (): Promise<Record<number, number>> => {
  const rows = await SerialView.aggregate([{ $match: { liked: true } }, { $group: { _id: '$ep', n: { $sum: 1 } } }]);
  return Object.fromEntries(rows.map((r) => [r._id, r.n]));
};

export function setupSerialRoutes(app: Express) {
  // Что я уже посмотрел и сколько сердечек у каждой серии
  app.get('/api/serial', telegramAuthMiddleware as any, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const mine = await SerialView.find({ telegramId: req.telegramUser!.id }, { ep: 1, maxFrame: 1, frames: 1, liked: 1, answer: 1, wished: 1 }).lean();
      const seen: Record<number, { maxFrame: number; frames: number; liked: boolean; answer?: string; wished?: boolean }> = {};
      for (const v of mine) seen[v.ep] = { maxFrame: v.maxFrame, frames: v.frames, liked: v.liked, ...(v.answer ? { answer: v.answer } : {}), ...(v.wished ? { wished: true } : {}) };
      const [hearts, answers] = await Promise.all([heartsByEp(), answersByEp()]);
      res.json({ seen, hearts, answers });
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

  // Вопрос в конце серии: ответ один раз, в ответ — как ответили все
  app.post('/api/serial/:ep/answer', telegramAuthMiddleware as any, async (req: AuthenticatedRequest, res: Response) => {
    const ep = epOf(req.params.ep);
    const option = String(req.body?.option || '');
    if (!ep || !OPTION_RE.test(option)) return res.status(400).json({ error: 'Нет такого ответа' });
    try {
      const me = req.telegramUser!.id;
      await SerialView.updateOne({ telegramId: me, ep, answer: { $exists: false } }, { $set: { answer: option } }).catch(() => {});
      const mine = await SerialView.findOne({ telegramId: me, ep }, { answer: 1 }).lean();
      if (!mine?.answer) await SerialView.updateOne({ telegramId: me, ep }, { $set: { answer: option } }, { upsert: true });
      res.json({ answer: mine?.answer || option, answers: (await answersByEp())[ep] || {} });
    } catch {
      res.status(500).json({ error: 'Не получилось сохранить ответ' });
    }
  });

  // «А ты?»: отметил желание прямо из серии (само желание создаёт /api/wishes)
  app.post('/api/serial/:ep/wished', telegramAuthMiddleware as any, async (req: AuthenticatedRequest, res: Response) => {
    const ep = epOf(req.params.ep);
    if (!ep) return res.status(400).json({ error: 'Нет такой серии' });
    await SerialView.updateOne({ telegramId: req.telegramUser!.id, ep }, { $set: { wished: true } }, { upsert: true }).catch(() => {});
    res.json({ ok: true });
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
  const views = (await SerialView.find({}, { telegramId: 1, ep: 1, maxFrame: 1, frames: 1, liked: 1, tried: 1, source: 1, answer: 1, wished: 1 }).lean()).filter(
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
    // Вопрос в конце: сколько ответили и что выбрали; вернулись ли ответившие на следующую серию
    const answered = list.filter((v) => v.answer);
    if (answered.length) {
      const counts = new Map<string, number>();
      for (const v of answered) counts.set(v.answer!, (counts.get(v.answer!) || 0) + 1);
      const wished = list.filter((v) => v.wished).length;
      const back = next ? ` · открыли С${ep + 1}: ответившие ${pct(answered.filter((v) => nextIds.has(v.telegramId)).length, answered.length)}%, остальные досмотревшие ${pct(
        list.filter((v) => !v.answer && v.maxFrame >= frames - 1 && nextIds.has(v.telegramId)).length,
        list.filter((v) => !v.answer && v.maxFrame >= frames - 1).length
      )}%` : '';
      lines.push(
        `   вопрос: ответили ${answered.length} (${pct(answered.length, done)}% досмотревших) · ${[...counts].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(' · ')}` +
          (wished ? ` · отметили «Хочу сходить» ${wished}` : '') + back
      );
    }
    if (from.length) {
      const names: Record<string, string> = { intro: 'приветствие Миши', joy: 'сама после радости', strip: 'плашка', shelf: 'список серий', tv: 'телевизор', next: 'из прошлой серии', link: 'ссылка', notice: 'строка подсказок' };
      lines.push(`   откуда: ${from.map(([s, n]) => `${names[s] || s} ${n}`).join(' · ')}`);
    }
  }
  return lines;
}
