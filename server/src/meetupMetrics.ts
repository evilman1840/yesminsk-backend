import { Express, Response } from 'express';
import { Schema, model } from 'mongoose';
import { telegramAuthMiddleware, AuthenticatedRequest } from './middleware/telegramAuth';
import { Event } from './models/Event';
import { EventTemplate, CUSTOM_TEMPLATE_KEY } from './models/EventTemplate';
import { METRICS_TEXTS as T } from './texts';

/**
 * Воронка формы «Собрать сходку»: открыли → выбрали шаблон → опубликовали, и где бросили.
 * Приложение шлёт шаги, /stats считает за 30 дней
 */

export const FORM_STEPS = ['opened', 'template', 'published', 'closed', 'error'] as const;
// Что не заполнено и какая ошибка — чтобы понять, где бросают форму
export const FORM_FIELDS = ['title', 'description', 'place', 'time', 'templateField'] as const;
export const FORM_ERRORS = ['required', 'geocode', 'templateField', 'photoWait', 'customCategory', 'server'] as const;
export const FORM_SOURCES = ['feed', 'empty', 'place', 'link', 'map', 'people'] as const;
type FormStep = (typeof FORM_STEPS)[number];

interface IMeetupFormEvent {
  telegramId: number;
  sessionId: string;   // одно открытие формы
  step: FormStep;
  template?: string;   // выбранный шаблон (для template и published)
  source?: string;     // откуда открыли: лента, пустая лента, карточка места, ссылка
  closedAt?: 'pick' | 'form'; // где закрыли без публикации
  missing?: string[];  // какие поля были пустыми (при закрытии или ошибке)
  error?: string;      // какую ошибку увидели
  createdAt: Date;
}

const MeetupFormEventSchema = new Schema<IMeetupFormEvent>({
  telegramId: { type: Number, required: true },
  sessionId: { type: String, required: true, index: true },
  step: { type: String, enum: FORM_STEPS, required: true },
  template: { type: String },
  source: { type: String, enum: FORM_SOURCES },
  closedAt: { type: String, enum: ['pick', 'form'] },
  missing: { type: [String], default: undefined },
  error: { type: String, enum: FORM_ERRORS },
  createdAt: { type: Date, default: Date.now, expires: 180 * 24 * 60 * 60 } // храним полгода
});

export const MeetupFormEvent = model<IMeetupFormEvent>('MeetupFormEvent', MeetupFormEventSchema);

export function setupMeetupMetricsRoutes(app: Express) {
  app.post('/api/metrics/meetup-form', telegramAuthMiddleware as any, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { sessionId, step, template, source, closedAt, missing, error } = req.body || {};
      if (typeof sessionId !== 'string' || !/^[a-z0-9-]{6,40}$/i.test(sessionId) || !FORM_STEPS.includes(step)) return res.sendStatus(400);
      await MeetupFormEvent.create({
        telegramId: req.telegramUser!.id,
        sessionId,
        step,
        template: typeof template === 'string' ? template.slice(0, 30) : undefined,
        source: FORM_SOURCES.includes(source) ? source : undefined,
        closedAt: closedAt === 'pick' || closedAt === 'form' ? closedAt : undefined,
        missing: Array.isArray(missing) ? missing.filter((f: any) => FORM_FIELDS.includes(f)) : undefined,
        error: FORM_ERRORS.includes(error) ? error : undefined
      });
      res.sendStatus(204);
    } catch {
      res.sendStatus(500);
    }
  });
}

const pct = (part: number, total: number) => (total ? `${Math.round((part / total) * 100)}%` : '0%');

// Раздел для /stats: сходки по шаблонам и воронка формы за 30 дней
export async function meetupStatsLines(since: Date): Promise<string[]> {
  const [byTemplate, templates, steps] = await Promise.all([
    Event.aggregate([{ $match: { createdAt: { $gte: since } } }, { $group: { _id: '$templateId', n: { $sum: 1 } } }]),
    EventTemplate.find({}, { key: 1, emoji: 1, name: 1 }).lean(),
    MeetupFormEvent.aggregate([
      { $match: { createdAt: { $gte: since } } },
      { $group: { _id: { step: '$step', closedAt: '$closedAt', source: '$source' }, sessions: { $addToSet: '$sessionId' } } }
    ])
  ]);

  const name = new Map(templates.map((t) => [t.key, `${t.emoji} ${t.name}`]));
  const count = (key: string | null) => byTemplate.find((b) => (b._id ?? null) === key)?.n || 0;
  const custom = count(CUSTOM_TEMPLATE_KEY);
  const noTemplate = count(null);
  const top = byTemplate
    .filter((b) => b._id && b._id !== CUSTOM_TEMPLATE_KEY)
    .sort((a, b) => b.n - a.n);
  const viaTemplate = top.reduce((s, b) => s + b.n, 0);

  // Уникальные открытия формы на каждом шаге
  const sessions = (filter: (id: any) => boolean) => new Set(steps.filter((s) => filter(s._id)).flatMap((s) => s.sessions)).size;
  const opened = sessions((id) => id.step === 'opened');
  const picked = sessions((id) => id.step === 'template');
  const published = sessions((id) => id.step === 'published');
  const quitPick = sessions((id) => id.step === 'closed' && id.closedAt === 'pick');
  const quitForm = sessions((id) => id.step === 'closed' && id.closedAt === 'form');
  const bySource = FORM_SOURCES.map((src) => [src, sessions((id) => id.step === 'opened' && id.source === src)] as const).filter(([, n]) => n);

  const lines = [T.title, T.created(viaTemplate, custom, noTemplate)];
  if (top.length) lines.push(T.top(top.map((b) => `${name.get(b._id) || b._id} ${b.n}`).join(' · ')));
  lines.push(T.funnel(opened, picked, published, pct(published, opened)));
  lines.push(T.quit(quitPick, quitForm));
  if (bySource.length) lines.push(T.sources(bySource.map(([src, n]) => `${T.sourceNames[src]} ${n}`).join(' · ')));

  // Почему бросают заполненную форму: какие поля были пустыми и какие ошибки видели
  const quits = await MeetupFormEvent.find({ createdAt: { $gte: since }, step: 'closed', closedAt: 'form' }, { missing: 1 }).lean();
  const errs = await MeetupFormEvent.aggregate([{ $match: { createdAt: { $gte: since }, step: 'error' } }, { $group: { _id: '$error', n: { $sum: 1 } } }, { $sort: { n: -1 } }]);
  const missingCount = new Map<string, number>();
  quits.forEach((q) => (q.missing || []).forEach((f) => missingCount.set(f, (missingCount.get(f) || 0) + 1)));
  const missingList = [...missingCount.entries()].sort((a, b) => b[1] - a[1]).map(([f, n]) => `${T.fieldNames[f] || f} ${n}`);
  const filledQuits = quits.filter((q) => !q.missing?.length).length;
  if (missingList.length || filledQuits) lines.push(T.quitFields(missingList.join(' · '), filledQuits));
  if (errs.length) lines.push(T.errors(errs.map((e) => `${T.errorNames[e._id] || e._id} ${e.n}`).join(' · ')));
  return lines;
}
