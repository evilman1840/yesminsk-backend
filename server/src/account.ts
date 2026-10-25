import { Express, Response } from 'express';
import { telegramAuthMiddleware, AuthenticatedRequest } from './middleware/telegramAuth';
import { User } from './models/User';
import { Event } from './models/Event';
import { Reaction } from './models/Reaction';
import { Wish } from './models/Wish';
import { PlaceTip } from './models/Place';
import { Report } from './moderation';
import { MeetupFormEvent } from './meetupMetrics';
import { NudgeLog } from './nudges';
import { sendTelegramMessage, escapeHtml } from './utils/telegramNotify';
import { formatWhen } from './eventNotify';
import { ACCOUNT_TEXTS as T } from './texts';
import { deleteAvatar } from './avatars';
import { PlaceSuggestion } from './placeSuggestions';

/**
 * Удалить себя из приложения: анкета, фото, желания, реакции, советы и жалобы удаляются;
 * свои сходки отменяются (участникам пишет бот), из чужих — выписываем.
 * Если открыть приложение снова — начнётся с чистого листа
 */
export function setupAccountRoutes(app: Express) {
  app.delete('/api/users/me', telegramAuthMiddleware as any, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const myId = req.telegramUser!.id;
      const me = await User.findOne({ telegramId: myId });
      if (!me) return res.sendStatus(204);
      // Заблокированный не должен обойти бан, удалив и создав аккаунт заново
      if (me.isBanned) return res.status(403).json({ error: T.bannedCantDelete });

      // Свои сходки: предстоящим участникам — «Сходка отменена»
      const mine = await Event.find({ 'creator.telegramId': myId });
      for (const ev of mine) {
        if (!ev.isActive || ev.dateTime.getTime() < Date.now()) continue;
        for (const p of ev.participants) {
          if (p.telegramId === myId) continue;
          sendTelegramMessage(p.telegramId, T.eventCancelled(escapeHtml(ev.title), formatWhen(ev.dateTime)), T.findOther, '?tab=events');
        }
      }
      await Event.deleteMany({ 'creator.telegramId': myId });
      // Из чужих сходок — выписываем (и убираем мои отзывы «Как прошло?»)
      await Event.updateMany({ 'participants.telegramId': myId }, { $pull: { participants: { telegramId: myId } } });
      await Event.updateMany({ 'feedback.telegramId': myId }, { $pull: { feedback: { telegramId: myId } } });

      await Promise.all([
        Reaction.deleteMany({ $or: [{ fromTelegramId: myId }, { toTelegramId: myId }] }),
        Wish.deleteMany({ telegramId: myId }),
        PlaceTip.deleteMany({ telegramId: myId }),
        Report.deleteMany({ $or: [{ fromTelegramId: myId }, { targetType: 'user', targetId: String(myId) }] }),
        MeetupFormEvent.deleteMany({ telegramId: myId }),
        NudgeLog.deleteMany({ telegramId: myId }),
        deleteAvatar(myId),
        PlaceSuggestion.deleteMany({ telegramId: myId, status: 'pending' })
      ]);
      await User.deleteOne({ telegramId: myId });
      console.log(`🗑 Аккаунт удалён по просьбе пользователя: ${myId}`);
      res.sendStatus(204);
    } catch (err: any) {
      console.warn('⚠️ Удаление аккаунта:', err?.message || err);
      res.status(500).json({ error: T.failed });
    }
  });
}
