import { Express, Response } from 'express';
import mongoose, { Schema, model, Types } from 'mongoose';
import { telegramAuthMiddleware, AuthenticatedRequest } from './middleware/telegramAuth';
import { Event, IEvent } from './models/Event';
import { WishGroup } from './models/Wish';
import { formatWhen, eventAppPath } from './eventNotify';
import { escapeHtml, sendTelegramMessage } from './utils/telegramNotify';
import { EVENT_LEAVE_TEXTS as T } from './texts';

/**
 * Организатор уходит со своей сходки.
 * — «Не смогу пойти, передать»: сходка остаётся, организатором становится первый записавшийся
 *   (у «По записи» — первый подтверждённый). Особенно для сходок из «Хочу сходить»: там организатором
 *   бот назначил первого «Пойду», и раньше единственный способ не пойти был удалить сходку для всех.
 * — Удаление (app.ts) и передача записываются в EventExit: кто, когда, сколько было людей, из «Хочу сходить» ли
 */

const DAY = 24 * 60 * 60 * 1000;

type ExitKind = 'deleted' | 'handover';

interface IEventExit {
  _id: Types.ObjectId;
  eventId: Types.ObjectId;
  kind: ExitKind;
  title: string;
  dateTime: Date;
  creatorId: number;
  byId: number;
  byModerator: boolean;
  others: number;    // сколько было записано кроме организатора
  fromWish: boolean; // сходку собрал бот из «Хочу сходить»
  beforeStart: boolean;
  createdAt: Date;
}

const EventExitSchema = new Schema<IEventExit>(
  {
    eventId: { type: Schema.Types.ObjectId, required: true },
    kind: { type: String, enum: ['deleted', 'handover'], required: true },
    title: { type: String, default: '' },
    dateTime: { type: Date },
    creatorId: { type: Number },
    byId: { type: Number },
    byModerator: { type: Boolean, default: false },
    others: { type: Number, default: 0 },
    fromWish: { type: Boolean, default: false },
    beforeStart: { type: Boolean, default: true }
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);
EventExitSchema.index({ createdAt: -1 });
EventExitSchema.index({ eventId: 1 });

export const EventExit = model<IEventExit>('EventExit', EventExitSchema);

const othersOf = (ev: IEvent) => ev.participants.filter((p) => p.telegramId !== ev.creator.telegramId);

// Кому передать: первый в списке (порядок записи, приложение показывает того же); у «По записи» — только подтверждённые
export function nextHost(ev: IEvent) {
  return othersOf(ev).find((p) => !ev.byRequest || p.approvedAt);
}

// Записать уход организатора (удаление или передачу). Ошибки не мешают самому действию
export async function logEventExit(ev: IEvent, kind: ExitKind, byId: number) {
  try {
    const fromWish = Boolean(await WishGroup.exists({ meetupId: String(ev._id) }));
    await EventExit.create({
      eventId: ev._id,
      kind,
      title: ev.title,
      dateTime: ev.dateTime,
      creatorId: ev.creator.telegramId,
      byId,
      byModerator: Number(byId) !== Number(ev.creator.telegramId),
      others: othersOf(ev).length,
      fromWish,
      beforeStart: ev.dateTime.getTime() > Date.now()
    });
  } catch (err: any) {
    console.warn('⚠️ Запись ухода организатора:', err?.message || err);
  }
}

type Formatter = (ev: IEvent, viewerId: number) => any;

export function setupEventLeaveRoutes(app: Express, formatEvent: Formatter) {
  // «Не смогу пойти, передать сходку»: организатор уходит, сходка остаётся следующему
  app.post('/api/events/:id/handover', telegramAuthMiddleware as any, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const myId = req.telegramUser!.id;
      const id = String(req.params.id || '');
      const ev = mongoose.Types.ObjectId.isValid(id) ? await Event.findById(id) : null;
      if (!ev || !ev.isActive) return res.status(404).json({ error: 'Сходка не найдена' });
      if (Number(ev.creator.telegramId) !== Number(myId)) return res.status(403).json({ error: T.notHost });
      if (ev.dateTime.getTime() <= Date.now()) return res.status(400).json({ error: T.started });
      const next = nextHost(ev);
      if (!next) return res.status(400).json({ error: T.nobody });

      await logEventExit(ev, 'handover', myId);
      const hostName = ev.creator.name;
      ev.creator = { telegramId: next.telegramId, name: next.name, username: next.username, avatarUrl: next.avatarUrl || '' } as any;
      ev.participants = ev.participants.filter((p) => p.telegramId !== myId) as any;
      await ev.save();

      const when = formatWhen(ev.dateTime);
      sendTelegramMessage(next.telegramId, T.newHost(escapeHtml(hostName), escapeHtml(ev.title), when, escapeHtml(ev.locationName)), T.openBtn, eventAppPath(ev));
      res.json({ success: true, newHost: next.name, event: formatEvent(ev, myId) });
    } catch (err: any) {
      console.warn('⚠️ /api/events/handover:', err?.message || err);
      res.status(500).json({ error: T.failed });
    }
  });
}

/* ---------- /stats ---------- */

export async function eventExitStatsLines(): Promise<string[]> {
  const since = new Date(Date.now() - 7 * DAY);
  const rows = await EventExit.find({ createdAt: { $gte: since }, byModerator: false, beforeStart: true }).lean();
  if (!rows.length) return [];
  const deleted = rows.filter((r) => r.kind === 'deleted');
  const handed = rows.filter((r) => r.kind === 'handover').length;
  return [
    T.stats(
      deleted.length,
      deleted.filter((r) => r.others > 0).length,
      deleted.filter((r) => r.fromWish).length,
      handed
    )
  ];
}
