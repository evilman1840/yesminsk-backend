import crypto from 'crypto';
import mongoose, { Schema, model } from 'mongoose';
import { Express, Request, Response } from 'express';
import { User } from './models/User';
import { Event } from './models/Event';
import { shrinkImage } from './utils/telegramFile';

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
    v: { type: String, required: true }
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
  await Avatar.updateOne({ telegramId }, { $set: { data, v } }, { upsert: true });
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

export function setupAvatarRoutes(app: Express) {
  app.get('/api/users/:telegramId/avatar', async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.telegramId);
      if (!Number.isFinite(id)) return res.sendStatus(404);
      const key = `${id}:${req.query.v || ''}`;
      const hit = small.get(key);
      if (hit) {
        res.set('Content-Type', hit.type);
        res.set('Cache-Control', 'public, max-age=2592000, immutable');
        return res.send(hit.body);
      }
      const stored = await Avatar.findOne({ telegramId: id }, { data: 1 }).lean();
      // До переноса фото ещё могло лежать в анкете
      const data = stored?.data || (await User.findOne({ telegramId: id, avatarUrl: /^data:/ }, { avatarUrl: 1 }).lean())?.avatarUrl;
      const m = data?.match(/^data:(image\/[\w.+-]+);base64,(.+)$/s);
      if (!m) return res.sendStatus(404);
      const original = Buffer.from(m[2], 'base64');
      // Аватарка бывает на весь экран анкеты: 900 px хватает и для ретины
      const item = (await shrinkImage(original, 900)) || { type: m[1], body: original };
      if (small.size > 3000) small.delete(small.keys().next().value!);
      small.set(key, item);
      res.set('Content-Type', item.type);
      res.set('Cache-Control', 'public, max-age=2592000, immutable');
      res.send(item.body);
    } catch {
      res.sendStatus(500);
    }
  });
}
