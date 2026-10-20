import { Express, Request, Response, NextFunction } from 'express';
import { Schema, model, Document } from 'mongoose';
import mongoose from 'mongoose';
import { telegramAuthMiddleware, AuthenticatedRequest } from './middleware/telegramAuth';
import { User } from './models/User';
import { Event } from './models/Event';
import { escapeHtml, sendTelegramMessage } from './utils/telegramNotify';
import { isAdmin } from './news';
import { formatWhen } from './eventNotify';

/**
 * Модерация: жалобы на анкеты и сходки, автоскрытие после 3 жалоб, бан через кнопки в боте.
 * Жалобы приходят администраторам (ADMIN_TELEGRAM_IDS) в чат с ботом.
 */

export type ReportReason = 'flirt' | 'rude' | 'spam' | 'fake' | 'danger' | 'other';

const REASONS: Record<ReportReason, string> = {
  flirt: '💋 Флирт, намёки на свидания',
  rude: '😠 Грубость, оскорбления',
  spam: '📢 Спам или реклама',
  fake: '🎭 Фейк, чужие фото',
  danger: '⚠️ Опасное поведение',
  other: '❓ Другое'
};

const AUTO_HIDE_AFTER = 3; // столько разных людей пожаловались — скрываем до проверки

interface IReport extends Document {
  fromTelegramId: number;
  targetType: 'user' | 'event';
  targetId: string;
  reason: ReportReason;
  comment: string;
  status: 'open' | 'dismissed' | 'actioned';
  createdAt: Date;
}

const ReportSchema = new Schema<IReport>(
  {
    fromTelegramId: { type: Number, required: true },
    targetType: { type: String, enum: ['user', 'event'], required: true },
    targetId: { type: String, required: true, index: true },
    reason: { type: String, enum: Object.keys(REASONS), required: true },
    comment: { type: String, maxlength: 500, default: '' },
    status: { type: String, enum: ['open', 'dismissed', 'actioned'], default: 'open', index: true }
  },
  { timestamps: true }
);
// Один человек — одна жалоба на одну цель
ReportSchema.index({ fromTelegramId: 1, targetType: 1, targetId: 1 }, { unique: true });

const Report = model<IReport>('Report', ReportSchema);

/* ---------- Сообщения администраторам ---------- */

const adminIds = () =>
  (process.env.ADMIN_TELEGRAM_IDS || '').split(',').map((s) => Number(s.trim())).filter(Boolean);

async function callBot(method: string, body: any) {
  const res = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return res.json().catch(() => ({}));
}

function notifyAdmins(html: string, buttons: { text: string; data: string }[]) {
  for (const id of adminIds()) {
    callBot('sendMessage', {
      chat_id: id,
      text: html,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      reply_markup: { inline_keyboard: [buttons.map((b) => ({ text: b.text, callback_data: b.data }))] }
    }).catch(() => {});
  }
}

/* ---------- Действия модератора ---------- */

export async function banUser(telegramId: number) {
  await User.updateOne({ telegramId }, { $set: { isBanned: true, hiddenByReports: false } });
  // Сходки забаненного скрываем
  await Event.updateMany({ 'creator.telegramId': telegramId, isActive: true }, { $set: { isActive: false } });
  await Report.updateMany({ targetType: 'user', targetId: String(telegramId), status: 'open' }, { $set: { status: 'actioned' } });
}

async function clearUser(telegramId: number) {
  await User.updateOne({ telegramId }, { $set: { hiddenByReports: false } });
  await Report.updateMany({ targetType: 'user', targetId: String(telegramId), status: 'open' }, { $set: { status: 'dismissed' } });
}

async function removeEvent(eventId: string) {
  if (!mongoose.Types.ObjectId.isValid(eventId)) return;
  await Event.updateOne({ _id: eventId }, { $set: { isActive: false } });
  await Report.updateMany({ targetType: 'event', targetId: eventId, status: 'open' }, { $set: { status: 'actioned' } });
}

async function clearEvent(eventId: string) {
  if (!mongoose.Types.ObjectId.isValid(eventId)) return;
  await Event.updateOne({ _id: eventId, isActive: false }, { $set: { isActive: true } });
  await Report.updateMany({ targetType: 'event', targetId: eventId, status: 'open' }, { $set: { status: 'dismissed' } });
}

/**
 * Нажатие кнопки под жалобой в боте. Возвращает true, если это была кнопка модерации
 */
export async function handleModerationCallback(query: any): Promise<boolean> {
  const data: string = query.data || '';
  const [action, id] = data.split(':');
  if (!['ban', 'okuser', 'delev', 'okev'].includes(action)) return false;

  if (!isAdmin(query.from?.id)) {
    callBot('answerCallbackQuery', { callback_query_id: query.id, text: 'Только для администратора' });
    return true;
  }

  let result = '';
  if (action === 'ban') {
    await banUser(Number(id));
    result = '🚫 Пользователь забанен';
  } else if (action === 'okuser') {
    await clearUser(Number(id));
    result = '✅ Жалобы отклонены, анкета снова видна';
  } else if (action === 'delev') {
    await removeEvent(id);
    result = '🗑 Сходка скрыта';
  } else if (action === 'okev') {
    await clearEvent(id);
    result = '✅ Жалобы отклонены, сходка снова видна';
  }

  callBot('answerCallbackQuery', { callback_query_id: query.id, text: result });
  // Отмечаем решение прямо в сообщении с жалобой и убираем кнопки
  if (query.message) {
    callBot('editMessageText', {
      chat_id: query.message.chat.id,
      message_id: query.message.message_id,
      text: `${query.message.text}\n\n${result}`,
      disable_web_page_preview: true
    });
  }
  return true;
}

/**
 * Команды администратора: /unban <id>
 */
export async function handleModerationCommand(message: any): Promise<boolean> {
  const text: string = (message.text || '').trim();
  const m = text.match(/^\/unban\s+(\d+)/i);
  if (!m) return false;
  if (!isAdmin(message.from?.id)) return false;
  await User.updateOne({ telegramId: Number(m[1]) }, { $set: { isBanned: false, hiddenByReports: false } });
  sendTelegramMessage(message.chat.id, `✅ Пользователь ${m[1]} разбанен.`);
  return true;
}

/* ---------- Адреса для приложения ---------- */

/**
 * Забаненные не могут ничего менять (ставить 👋, создавать сходки и т.п.) — только смотреть экран блокировки
 */
export function banGuard(req: Request, res: Response, next: NextFunction) {
  if (req.method === 'GET' || req.path.startsWith('/telegram/')) return next();
  telegramAuthMiddleware(req as AuthenticatedRequest, res, async () => {
    try {
      const me = await User.findOne({ telegramId: (req as AuthenticatedRequest).telegramUser!.id }, { isBanned: 1 }).lean();
      if (me?.isBanned) return res.status(403).json({ error: 'Аккаунт заблокирован за нарушение правил' });
      next();
    } catch {
      next();
    }
  });
}

export function setupModerationRoutes(app: Express) {
  app.post('/api/reports', telegramAuthMiddleware as any, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const fromId = req.telegramUser!.id;
      const { targetType, targetId, reason } = req.body;
      const comment = String(req.body.comment || '').slice(0, 500);

      if (!['user', 'event'].includes(targetType) || !targetId || !(reason in REASONS)) {
        return res.status(400).json({ error: 'Неполная жалоба' });
      }

      const reporter = await User.findOne({ telegramId: fromId });
      const reporterLine = `От: ${escapeHtml(reporter?.firstName || 'пользователь')}${reporter?.username ? ` (@${escapeHtml(reporter.username)})` : ''} · ID ${fromId}`;

      try {
        await Report.create({ fromTelegramId: fromId, targetType, targetId: String(targetId), reason, comment });
      } catch (err: any) {
        if (err?.code === 11000) return res.json({ success: true, duplicate: true }); // уже жаловался
        throw err;
      }

      const openCount = await Report.countDocuments({ targetType, targetId: String(targetId), status: 'open' });
      const commentLine = comment ? `\n💬 «${escapeHtml(comment)}»` : '';

      if (targetType === 'user') {
        const targetIdNum = Number(targetId);
        // Тот, кто пожаловался, больше не видит этого человека
        await User.updateOne({ telegramId: fromId }, { $addToSet: { blockedUsers: targetIdNum } });

        const target = await User.findOne({ telegramId: targetIdNum });
        const autoHidden = openCount >= AUTO_HIDE_AFTER && !target?.hiddenByReports;
        if (autoHidden) await User.updateOne({ telegramId: targetIdNum }, { $set: { hiddenByReports: true } });

        notifyAdmins(
          `⚠️ <b>Жалоба на анкету</b> (${openCount} открыт${openCount === 1 ? 'ая' : 'ых'})\n\n` +
            `👤 <b>${escapeHtml(target?.firstName || '—')}</b>${target?.age ? `, ${target.age}` : ''}` +
            `${target?.username ? ` · @${escapeHtml(target.username)}` : ''} · ID ${targetIdNum}\n` +
            `📝 ${escapeHtml(target?.bio || 'без описания')}\n\n` +
            `Причина: ${REASONS[reason as ReportReason]}${commentLine}\n${reporterLine}` +
            (autoHidden ? `\n\n🙈 Анкета скрыта автоматически (${AUTO_HIDE_AFTER}+ жалоб) до твоего решения.` : ''),
          [
            { text: '🚫 Забанить', data: `ban:${targetIdNum}` },
            { text: '✅ Всё в порядке', data: `okuser:${targetIdNum}` }
          ]
        );
      } else {
        const event = mongoose.Types.ObjectId.isValid(targetId) ? await Event.findById(targetId) : null;
        if (!event) return res.status(404).json({ error: 'Сходка не найдена' });
        const autoHidden = openCount >= AUTO_HIDE_AFTER && event.isActive;
        if (autoHidden) await Event.updateOne({ _id: event._id }, { $set: { isActive: false } });

        notifyAdmins(
          `⚠️ <b>Жалоба на сходку</b> (${openCount} открыт${openCount === 1 ? 'ая' : 'ых'})\n\n` +
            `📍 <b>${escapeHtml(event.title)}</b>\n🕒 ${formatWhen(event.dateTime)} · ${escapeHtml(event.locationName)}\n` +
            `📝 ${escapeHtml(event.description)}\n👤 Организатор: ${escapeHtml(event.creator.name)} · ID ${event.creator.telegramId}\n\n` +
            `Причина: ${REASONS[reason as ReportReason]}${commentLine}\n${reporterLine}` +
            (autoHidden ? `\n\n🙈 Сходка скрыта автоматически (${AUTO_HIDE_AFTER}+ жалоб) до твоего решения.` : ''),
          [
            { text: '🗑 Скрыть сходку', data: `delev:${event._id}` },
            { text: '🚫 Забанить автора', data: `ban:${event.creator.telegramId}` },
            { text: '✅ Всё в порядке', data: `okev:${event._id}` }
          ]
        );
      }

      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Не удалось отправить жалобу' });
    }
  });
}
