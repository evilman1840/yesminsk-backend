import { Express, Request, Response } from 'express';
import { telegramAuthMiddleware, AuthenticatedRequest } from './middleware/telegramAuth';
import { sendTelegramPhoto, isCachedPhoto } from './utils/telegramFile';
import { Event } from './models/Event';
import { User } from './models/User';
import { PHOTO_TEXTS as T } from './texts';

/**
 * Фото сходок и анкет: приложение присылает сжатое фото, бот кладёт его в приватный канал (PHOTO_CHANNEL_ID)
 * и хранит file_id — как с фото мест. Отдаём через наш сервер, только если фото чьё-то
 */

export const MAX_PHOTOS = 5;
const MAX_BYTES = 1_500_000;      // после сжатия на телефоне обычно 100–300 КБ
const UPLOADS_PER_HOUR = 40;

// При разработке без бота: храним в памяти
const devPhotos = new Map<string, Buffer>();
const isDevStorage = () => process.env.NODE_ENV === 'development' && (!process.env.TELEGRAM_BOT_TOKEN || !process.env.PHOTO_CHANNEL_ID);

const uploads = new Map<number, number[]>();
const tooMany = (telegramId: number) => {
  const now = Date.now();
  const recent = (uploads.get(telegramId) || []).filter((t) => now - t < 60 * 60 * 1000);
  recent.push(now);
  uploads.set(telegramId, recent);
  return recent.length > UPLOADS_PER_HOUR;
};

// Фото → file_id: отправляем в канал без звука, берём самый большой размер
async function storePhoto(buffer: Buffer, mime: string): Promise<string> {
  if (isDevStorage()) {
    const id = `dev_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    devPhotos.set(id, buffer);
    return id;
  }
  const form = new FormData();
  form.append('chat_id', String(process.env.PHOTO_CHANNEL_ID));
  form.append('disable_notification', 'true');
  form.append('photo', new Blob([new Uint8Array(buffer)], { type: mime }), 'photo.jpg');
  const res: any = await (await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendPhoto`, { method: 'POST', body: form })).json();
  if (!res?.ok) throw new Error(res?.description || 'sendPhoto failed');
  const sizes = res.result.photo || [];
  return sizes[sizes.length - 1].file_id;
}

// Чистим список file_id из формы: строки, без повторов, не больше 5
export const cleanPhotoIds = (v: unknown): string[] | undefined =>
  Array.isArray(v)
    ? [...new Set(v.filter((id) => typeof id === 'string').map((id) => id.split('?')[0]).filter((id) => /^[\w-]{6,200}$/.test(id)))].slice(0, MAX_PHOTOS)
    : undefined;

// ?v=2 — телефоны закешировали пустые ответы (баг 25.10), новая версия адреса заставит скачать заново
export const PHOTO_URL_VERSION = 'v=2';
export const photoUrl = (id: string) => `/api/photos/${encodeURIComponent(id)}?${PHOTO_URL_VERSION}`;

export function setupPhotoRoutes(app: Express) {
  // Загрузить фото: { dataUrl } → { id }
  app.post('/api/photos', telegramAuthMiddleware as any, async (req: AuthenticatedRequest, res: Response) => {
    try {
      if (!isDevStorage() && !process.env.PHOTO_CHANNEL_ID) return res.status(503).json({ error: T.notConfigured });
      if (tooMany(req.telegramUser!.id)) return res.status(429).json({ error: T.tooMany });
      const match = String(req.body?.dataUrl || '').match(/^data:(image\/(jpeg|png|webp));base64,(.+)$/);
      if (!match) return res.status(400).json({ error: T.badFile });
      const buffer = Buffer.from(match[3], 'base64');
      if (buffer.length > MAX_BYTES) return res.status(413).json({ error: T.tooBig });
      res.json({ id: await storePhoto(buffer, match[1]) });
    } catch (err: any) {
      console.warn('⚠️ Фото не сохранилось:', err?.message || err);
      res.status(500).json({ error: T.failed });
    }
  });

  // Отдать фото — только если оно у какой-то сходки или анкеты
  app.get('/api/photos/:fileId', async (req: Request, res: Response) => {
    try {
      const id = String(req.params.fileId);
      if (devPhotos.has(id)) {
        res.setHeader('Content-Type', 'image/jpeg');
        return res.send(devPhotos.get(id));
      }
      const t0 = Date.now();
      if (!isCachedPhoto(id) && !(await Event.exists({ photos: id })) && !(await User.exists({ photos: id }))) return res.sendStatus(404);
      if (Date.now() - t0 > 1000) console.log(`🐢 проверка фото в базе: ${Date.now() - t0} мс`);
      await sendTelegramPhoto(res, id);
    } catch {
      res.sendStatus(500);
    }
  });
}
