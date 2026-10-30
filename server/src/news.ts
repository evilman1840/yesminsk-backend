import { Express, Request, Response } from 'express';
import { News } from './models/News';
import { Tip } from './models/Tip';
import { sendTelegramMessage } from './utils/telegramNotify';
import { sendTelegramPhoto } from './utils/telegramFile';

/**
 * «Новости проекта»: автор пишет посты боту, приложение их показывает.
 *
 * Боту (только с аккаунтов из ADMIN_TELEGRAM_IDS):
 *   /news Текст поста            — текстовый пост
 *   фото с подписью /news Текст  — пост с фото
 *   альбом, у первого фото подпись /news Текст — пост с несколькими фото
 *   /delnews                     — удалить последний пост
 *   /tip Короткий текст          — запись в строке подсказок у всех, в конце (до 80 символов, сутки или до следующей)
 *   /tiptop Короткий текст       — то же, но первой карточкой
 *   /tip                         — что висит сейчас и правила
 *   /deltip                      — убрать запись
 * Любой человек может узнать свой ID командой /myid
 */

export const adminIds = () =>
  (process.env.ADMIN_TELEGRAM_IDS || '')
    .split(',')
    .map((s) => Number(s.trim()))
    .filter(Boolean);

export const isAdmin = (telegramId?: number) => Boolean(telegramId && adminIds().includes(telegramId));

const NEWS_CMD = /^\/news(@\w+)?\s*/i;
const TIP_CMD = /^\/tip(top)?(@\w+)?(\s+|$)/i; // /tiptop — первой карточкой
export const TIP_MAX = 80; // две строки карточки на телефоне
const TIP_HOURS = 24;

// /tip, /tiptop и /deltip — короткая запись в строке подсказок
async function handleTipCommand(chatId: number, text: string) {
  if (/^\/deltip\b/i.test(text)) {
    const r = await Tip.deleteMany({});
    sendTelegramMessage(chatId, r.deletedCount ? '🗑 Запись убрана из строки подсказок.' : 'Сейчас записи нет.');
    return;
  }
  const first = /^\/tiptop/i.test(text);
  const body = text.replace(TIP_CMD, '').trim();
  const length = [...body].length; // эмодзи — как один символ
  if (!body) {
    const now = await Tip.findOne({ expiresAt: { $gt: new Date() } }).sort({ createdAt: -1 }).lean();
    sendTelegramMessage(
      chatId,
      [
        now ? `Сейчас висит (${now.first ? 'первой' : 'в конце'}):\n«${now.text}»` : 'Сейчас записи нет.',
        '',
        `<b>Как писать:</b> <code>/tip текст</code> — в конце подсказок, <code>/tiptop текст</code> — первой`,
        `• до ${TIP_MAX} символов (эмодзи — один символ): это две строки карточки`,
        `• видна всем над меню ${TIP_HOURS} часа или до следующей /tip или /tiptop`,
        '• человек может закрыть её крестиком',
        '• /deltip — убрать раньше'
      ].join('\n')
    );
    return;
  }
  if (length > TIP_MAX) {
    sendTelegramMessage(chatId, `Длинновато: ${length} символов из ${TIP_MAX}. Сократи на ${length - TIP_MAX}, и пришли снова.`);
    return;
  }
  await Tip.deleteMany({});
  await Tip.create({ text: body, first, expiresAt: new Date(Date.now() + TIP_HOURS * 60 * 60 * 1000) });
  sendTelegramMessage(chatId, `✅ В строке подсказок у всех на ${TIP_HOURS} часа, ${first ? 'первой карточкой' : 'в конце'} (${length}/${TIP_MAX} символов).`);
}

// Возвращает true, если сообщение было командой новостей и обработано
export async function handleNewsMessage(message: any): Promise<boolean> {
  const chatId = message.chat.id;
  const fromId = message.from?.id;
  const text: string = (message.text || message.caption || '').trim();

  if (/^\/myid\b/i.test(text)) {
    sendTelegramMessage(chatId, `Твой Telegram ID: <code>${fromId}</code>`);
    return true;
  }

  const isTipCommand = TIP_CMD.test(text) || /^\/deltip\b/i.test(text);
  const isNewsCommand = NEWS_CMD.test(text) || /^\/delnews\b/i.test(text) || isTipCommand;
  const isAlbumPart = Boolean(message.media_group_id && message.photo);
  if (!isNewsCommand && !isAlbumPart) return false;

  if (!isAdmin(fromId)) {
    if (isNewsCommand) sendTelegramMessage(chatId, 'Публиковать новости может только автор проекта 🙂');
    return isNewsCommand;
  }

  if (isTipCommand) {
    await handleTipCommand(chatId, text);
    return true;
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
          photos: n.photos.map((fileId) => `/api/news/photo/${encodeURIComponent(fileId)}?v=2`),
          createdAt: n.createdAt
        }))
      );
    } catch (err) {
      res.status(500).json({ error: 'Ошибка загрузки новостей' });
    }
  });

  // Запись автора для строки подсказок (или null)
  app.get('/api/tip', async (_req: Request, res: Response) => {
    try {
      const tip = await Tip.findOne({ expiresAt: { $gt: new Date() } }).sort({ createdAt: -1 }).lean();
      res.json(tip ? { id: tip._id.toString(), text: tip.text, first: Boolean(tip.first) } : null);
    } catch {
      res.status(500).json({ error: 'Ошибка загрузки записи' });
    }
  });

  // Фото из Telegram: отдаём через сервер, чтобы не раскрывать токен бота
  app.get('/api/news/photo/:fileId', async (req: Request, res: Response) => {
    try {
      const fileId = String(req.params.fileId);
      // Отдаём только фото, которые есть в опубликованных новостях
      const exists = await News.exists({ isPublished: true, photos: fileId });
      if (!exists) return res.sendStatus(404);

      await sendTelegramPhoto(res, fileId);
    } catch (err) {
      res.sendStatus(500);
    }
  });
}
