import { Express, Request, Response } from 'express';
import { News } from './models/News';
import { sendTelegramMessage } from './utils/telegramNotify';

/**
 * «Новости проекта»: автор пишет посты боту, приложение их показывает.
 *
 * Боту (только с аккаунтов из ADMIN_TELEGRAM_IDS):
 *   /news Текст поста            — текстовый пост
 *   фото с подписью /news Текст  — пост с фото
 *   альбом, у первого фото подпись /news Текст — пост с несколькими фото
 *   /delnews                     — удалить последний пост
 * Любой человек может узнать свой ID командой /myid
 */

const adminIds = () =>
  (process.env.ADMIN_TELEGRAM_IDS || '')
    .split(',')
    .map((s) => Number(s.trim()))
    .filter(Boolean);

export const isAdmin = (telegramId?: number) => Boolean(telegramId && adminIds().includes(telegramId));

const NEWS_CMD = /^\/news(@\w+)?\s*/i;

// Возвращает true, если сообщение было командой новостей и обработано
export async function handleNewsMessage(message: any): Promise<boolean> {
  const chatId = message.chat.id;
  const fromId = message.from?.id;
  const text: string = (message.text || message.caption || '').trim();

  if (/^\/myid\b/i.test(text)) {
    sendTelegramMessage(chatId, `Твой Telegram ID: <code>${fromId}</code>`);
    return true;
  }

  const isNewsCommand = NEWS_CMD.test(text) || /^\/delnews\b/i.test(text);
  const isAlbumPart = Boolean(message.media_group_id && message.photo);
  if (!isNewsCommand && !isAlbumPart) return false;

  if (!isAdmin(fromId)) {
    if (isNewsCommand) sendTelegramMessage(chatId, 'Публиковать новости может только автор проекта 🙂');
    return isNewsCommand;
  }

  if (/^\/delnews\b/i.test(text)) {
    const last = await News.findOne({ isPublished: true }).sort({ createdAt: -1 });
    if (last) await last.deleteOne();
    sendTelegramMessage(chatId, last ? '🗑 Последняя новость удалена.' : 'Новостей пока нет.');
    return true;
  }

  const body = text.replace(NEWS_CMD, '').trim();
  const photo = message.photo ? message.photo[message.photo.length - 1].file_id : null; // самое большое фото
  const hasCommand = NEWS_CMD.test(text);

  // Альбом: фото приходят отдельными сообщениями с общим media_group_id, подпись — только у одного
  if (message.media_group_id) {
    const update: any = { $setOnInsert: { mediaGroupId: message.media_group_id } };
    if (photo) update.$push = { photos: photo };
    if (hasCommand) update.$set = { text: body, isPublished: true };
    await News.updateOne({ mediaGroupId: message.media_group_id }, update, { upsert: true });
    if (hasCommand) sendTelegramMessage(chatId, '✅ Опубликовано в «Новостях проекта».');
    return true;
  }

  if (!body && !photo) {
    sendTelegramMessage(chatId, 'Напиши текст после /news, например:\n<code>/news Сегодня запустили фильтры в «Людях»!</code>');
    return true;
  }

  await News.create({ text: body, photos: photo ? [photo] : [], isPublished: true });
  sendTelegramMessage(chatId, '✅ Опубликовано в «Новостях проекта».');
  return true;
}

export function setupNewsRoutes(app: Express) {
  // Список новостей для приложения
  app.get('/api/news', async (_req: Request, res: Response) => {
    try {
      const items = await News.find({ isPublished: true }).sort({ createdAt: -1 }).limit(30).lean();
      res.json(
        items.map((n) => ({
          id: n._id.toString(),
          text: n.text,
          photos: n.photos.map((fileId) => `/api/news/photo/${encodeURIComponent(fileId)}`),
          createdAt: n.createdAt
        }))
      );
    } catch (err) {
      res.status(500).json({ error: 'Ошибка загрузки новостей' });
    }
  });

  // Фото из Telegram: отдаём через сервер, чтобы не раскрывать токен бота
  app.get('/api/news/photo/:fileId', async (req: Request, res: Response) => {
    try {
      const fileId = String(req.params.fileId);
      // Отдаём только фото, которые есть в опубликованных новостях
      const exists = await News.exists({ isPublished: true, photos: fileId });
      if (!exists) return res.sendStatus(404);

      const token = process.env.TELEGRAM_BOT_TOKEN;
      const info: any = await (await fetch(`https://api.telegram.org/bot${token}/getFile?file_id=${encodeURIComponent(fileId)}`)).json();
      if (!info.ok) return res.sendStatus(404);

      const file = await fetch(`https://api.telegram.org/file/bot${token}/${info.result.file_path}`);
      if (!file.ok) return res.sendStatus(502);

      res.setHeader('Content-Type', file.headers.get('content-type') || 'image/jpeg');
      res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
      res.send(Buffer.from(await file.arrayBuffer()));
    } catch (err) {
      res.sendStatus(500);
    }
  });
}
