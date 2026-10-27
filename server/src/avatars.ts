import crypto from 'crypto';
import mongoose, { Schema, model } from 'mongoose';
import { Express, Request, Response } from 'express';
import { User } from './models/User';
import { Event } from './models/Event';
import { shrinkImage, limited } from './utils/telegramFile';

/**
 * Фото профиля (data:image/…, ~20-100 КБ) живут в отдельной коллекции avatars.
 * В анкете и сходках — короткая метка «avatar:<версия>», в ответах — ссылка /api/users/:id/avatar?v=…
 * Так анкеты весят сотни байт, а не десятки килобайт, и база не перебирает мегабайты на каждый запрос
 */
const Avatar = model(
  'Avatar',
  new Schema({
    telegramId: { type: Number, required: true, unique: true },
    data: { type: String, required: true },
    v: { type: String, required: true },
    // Уменьшенные версии (WebP): 900 px — анкета на весь экран, 200 px — кружки на карте и в списках.
    // Хранятся в базе, чтобы после перезапуска сервера не пересчитывать сотни фото заново
    img900: Buffer,
    img200: Buffer
  })
);

const NO_AVATAR = 'https://yesminsk-app.vercel.app/favicon.svg';

const baseUrl = () => (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${process.env.PORT || 4000}`).replace(/\/+$/, '');

// Версия в ссылке — новое фото получит новую ссылку, старое можно кешировать надолго
const version = (data: string) => crypto.createHash('md5').update(data).digest('hex').slice(0, 10);

export function avatarFor(telegramId: number, avatarUrl?: string): string {
  if (!avatarUrl) return '';
  if (avatarUrl.startsWith('avatar:')) return `${baseUrl()}/api/users/${telegramId}/avatar?v=${avatarUrl.slice(7)}`;
  if (avatarUrl.startsWith('data:')) return `${baseUrl()}/api/users/${telegramId}/avatar?v=${version(avatarUrl)}`;
  return avatarUrl;
}

// Ссылка на наше же фото (приложение прислало анкету обратно) — фото не меняли
export const isOwnAvatarLink = (url: string) => url.startsWith('avatar:') || /\/api\/users\/\d+\/avatar\b/.test(url);

// Новое фото из приложения: кладём в коллекцию, в анкету — метку
export async function storeAvatar(telegramId: number, data: string): Promise<string> {
  const v = version(data);
  await Avatar.updateOne({ telegramId }, { $set: { data, v }, $unset: { img900: 1, img200: 1 } }, { upsert: true });
  return `avatar:${v}`;
}

// Удаление аккаунта: фото профиля тоже стираем
export const deleteAvatar = (telegramId: number) => Avatar.deleteOne({ telegramId });

// Один раз: фото из анкет и копии в сходках → коллекция avatars и метки
export async function moveAvatarsOut() {
  const KEY = 'avatars-collection-2026-10-25';
  try {
    const migrations = mongoose.connection.db!.collection('migrations');
    if (await migrations.findOne({ key: KEY })) return;
    const marks = new Map<number, string>();
    const cursor = User.find({ avatarUrl: /^data:/ }, { telegramId: 1, avatarUrl: 1 }).lean().cursor();
    for await (const u of cursor) {
      const mark = await storeAvatar(u.telegramId, u.avatarUrl);
      await User.updateOne({ _id: u._id }, { $set: { avatarUrl: mark } });
      marks.set(u.telegramId, mark);
    }
    // В сходках у организатора и участников лежали копии фото
    const markOf = async (id: number) => marks.get(id) || ((await User.findOne({ telegramId: id }, { avatarUrl: 1 }).lean())?.avatarUrl ?? '');
    const evCursor = Event.find({ $or: [{ 'creator.avatarUrl': /^data:/ }, { 'participants.avatarUrl': /^data:/ }] }).cursor();
    let events = 0;
    for await (const ev of evCursor) {
      if (ev.creator.avatarUrl?.startsWith('data:')) ev.creator.avatarUrl = (await markOf(ev.creator.telegramId)) || NO_AVATAR;
      for (const p of ev.participants) if (p.avatarUrl?.startsWith('data:')) p.avatarUrl = (await markOf(p.telegramId)) || NO_AVATAR;
      await Event.updateOne({ _id: ev._id }, { $set: { creator: ev.creator, participants: ev.participants } });
      events++;
    }
    await migrations.insertOne({ key: KEY, at: new Date() });
    console.log(`✅ Фото профиля вынесены: анкет ${marks.size}, сходок ${events}`);
  } catch (err: any) {
    console.warn('⚠️ Перенос фото профиля:', err?.message || err);
  }
}

// Уменьшенные фото профиля в памяти (по версии): одну аватарку видят многие
const small = new Map<string, { type: string; body: Buffer }>();
let smallBytes = 0;
const MAX_SMALL_BYTES = 20 * 1024 * 1024; // память сервера 512 МБ — держим не больше 20 МБ аватарок
const remember = (key: string, item: { type: string; body: Buffer }) => {
  if (small.has(key)) return;
  small.set(key, item);
  smallBytes += item.body.length;
  while (smallBytes > MAX_SMALL_BYTES && small.size) {
    const [k, old] = small.entries().next().value!;
    small.delete(k);
    smallBytes -= old.body.length;
  }
};
// lean() отдаёт BSON Binary: байты в .buffer
const toBuffer = (raw: any): Buffer | null => (!raw ? null : Buffer.isBuffer(raw) ? raw : raw.buffer ? Buffer.from(raw.buffer) : null);

export function setupAvatarRoutes(app: Express) {
  app.get('/api/users/:telegramId/avatar', async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.telegramId);
      if (!Number.isFinite(id)) return res.sendStatus(404);
      // ?w=200 — кружок на карте и в списках; иначе — 900 px для анкеты
      const w = req.query.w === '200' ? 200 : 900;
      const field = w === 200 ? 'img200' : 'img900';
      const key = `${id}:${req.query.v || ''}:${w}`;
      const hit = small.get(key);
      if (hit) {
        res.set('Content-Type', hit.type);
        res.set('Cache-Control', 'public, max-age=2592000, immutable');
        return res.send(hit.body);
      }
      const ready = await Avatar.findOne({ telegramId: id }, { [field]: 1 }).lean();
      const readyBytes = toBuffer((ready as any)?.[field]);
      if (readyBytes && readyBytes.length > 100) {
        const item = { type: 'image/webp', body: readyBytes };
        remember(key, item);
        res.set('Content-Type', item.type);
        res.set('Cache-Control', 'public, max-age=2592000, immutable');
        return res.send(item.body);
      }
      const stored = await Avatar.findOne({ telegramId: id }, { data: 1 }).lean();
      // До переноса фото ещё могло лежать в анкете
      const data = stored?.data || (await User.findOne({ telegramId: id, avatarUrl: /^data:/ }, { avatarUrl: 1 }).lean())?.avatarUrl;
      // Только обычные картинки: SVG и прочее могли бы выполнить код в браузере
      const m = data?.match(/^data:(image\/(?:jpeg|png|webp));base64,(.+)$/s);
      if (!m) return res.sendStatus(404);
      const original = Buffer.from(m[2], 'base64');
      const shrunk = await limited(() => shrinkImage(original, w));
      const item = shrunk || { type: m[1], body: original };
      // Сохраняем уменьшенную версию в базу — после перезапуска возьмём готовую
      if (shrunk && stored) Avatar.updateOne({ telegramId: id }, { $set: { [field]: shrunk.body } }).catch(() => {});
      remember(key, item);
      res.set('Content-Type', item.type);
      res.set('Cache-Control', 'public, max-age=2592000, immutable');
      res.send(item.body);
    } catch {
      res.sendStatus(500);
    }
  });
}
