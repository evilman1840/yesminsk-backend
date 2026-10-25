import crypto from 'crypto';
import { Express, Request, Response } from 'express';
import { User } from './models/User';

/**
 * Фото профиля хранятся в базе строкой data:image/… (~20-100 КБ). Чтобы не вкладывать их в каждый ответ
 * (список людей, сходки с участниками), отдаём ссылку /api/users/:id/avatar, а браузер кеширует картинку
 */
const baseUrl = () => (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${process.env.PORT || 4000}`).replace(/\/+$/, '');

// Версия в ссылке — новое фото получит новую ссылку, старое можно кешировать надолго
const version = (data: string) => crypto.createHash('md5').update(data).digest('hex').slice(0, 10);

export function avatarFor(telegramId: number, avatarUrl?: string): string {
  if (!avatarUrl || !avatarUrl.startsWith('data:')) return avatarUrl || '';
  return `${baseUrl()}/api/users/${telegramId}/avatar?v=${version(avatarUrl)}`;
}

export function setupAvatarRoutes(app: Express) {
  app.get('/api/users/:telegramId/avatar', async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.telegramId);
      if (!Number.isFinite(id)) return res.sendStatus(404);
      const u = await User.findOne({ telegramId: id, isBanned: { $ne: true } }, { avatarUrl: 1 }).lean();
      const m = u?.avatarUrl?.match(/^data:(image\/[\w.+-]+);base64,(.+)$/s);
      if (!m) return res.sendStatus(404);
      res.set('Content-Type', m[1]);
      res.set('Cache-Control', 'public, max-age=2592000, immutable');
      res.send(Buffer.from(m[2], 'base64'));
    } catch {
      res.sendStatus(500);
    }
  });
}
