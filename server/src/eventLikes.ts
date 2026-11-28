import { Express, Response } from 'express';
import mongoose from 'mongoose';
import { telegramAuthMiddleware, AuthenticatedRequest } from './middleware/telegramAuth';
import { Event, IEvent } from './models/Event';
import { User } from './models/User';
import { audienceFeedQuery } from './eventAudience';

export function setupEventLikeRoutes(app: Express, formatEvent: (event: IEvent, viewerId: number) => unknown, isAdmin: (viewerId: number) => boolean) {
  // Сохранённые лайком сходки, включая прошедшие. Имена поставивших лайк не раскрываем.
  app.get('/api/events/liked', telegramAuthMiddleware as any, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const viewerId = req.telegramUser!.id;
      const me = await User.findOne({ telegramId: viewerId }).lean();
      if (!me || me.isBanned) return res.status(403).json({ error: 'Сходки сейчас недоступны' });
      const events = await Event.find({
        likedBy: viewerId, isActive: true, stopWordsHold: { $ne: true },
        ...(isAdmin(viewerId) ? {} : { $or: [
          { 'creator.telegramId': viewerId }, { 'participants.telegramId': viewerId },
          { $and: [...audienceFeedQuery(me), ...(me.isEmpath ? [] : [{ tags: { $ne: 'empaths' } }])] }
        ] })
      }).sort({ dateTime: -1 });
      res.json(events.map((event) => formatEvent(event, viewerId)));
    } catch {
      res.status(500).json({ error: 'Не удалось загрузить понравившиеся сходки' });
    }
  });

  app.post('/api/events/:id/like', telegramAuthMiddleware as any, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const id = String(req.params.id);
      if (!mongoose.Types.ObjectId.isValid(id)) return res.status(404).json({ error: 'Сходка не найдена' });
      if (typeof req.body?.liked !== 'boolean') return res.status(400).json({ error: 'Укажи, поставить или убрать лайк' });
      const viewerId = req.telegramUser!.id;
      const me = await User.findOne({ telegramId: viewerId }).lean();
      if (!me || me.isBanned) return res.status(403).json({ error: 'Не удалось сохранить лайк' });
      const event = await Event.findOneAndUpdate({
        _id: id, isActive: true, stopWordsHold: { $ne: true },
        ...(isAdmin(viewerId) || !req.body.liked ? {} : { $or: [
          { 'creator.telegramId': viewerId }, { 'participants.telegramId': viewerId },
          { $and: [...audienceFeedQuery(me), ...(me.isEmpath ? [] : [{ tags: { $ne: 'empaths' } }])] }
        ] })
      }, req.body.liked ? { $addToSet: { likedBy: viewerId } } : { $pull: { likedBy: viewerId } }, { new: true });
      if (!event) return res.status(404).json({ error: 'Сходка больше недоступна' });
      res.json({ isLiked: Boolean(event.likedBy?.includes(viewerId)), likesCount: event.likedBy?.length || 0 });
    } catch {
      res.status(500).json({ error: 'Не удалось сохранить лайк. Попробуй ещё раз' });
    }
  });

}
