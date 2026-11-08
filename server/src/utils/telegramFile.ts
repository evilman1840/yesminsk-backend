import { Response } from 'express';
import sharp from 'sharp';
import { Schema, model } from 'mongoose';

// Один поток на уменьшение: у сервера 0.5 CPU, остальным запросам должно оставаться
sharp.concurrency(1);

// Уменьшенные фото храним и в базе: после перезапуска не пересчитываем заново
const SmallPhoto = model(
  'SmallPhoto',
  new Schema({ fileId: { type: String, required: true, unique: true }, type: String, data: Buffer, createdAt: { type: Date, default: Date.now } })
);

// Не больше 2 фото обрабатываем одновременно, остальные ждут в очереди
let running = 0;
const queue: (() => void)[] = [];
export async function limited<T>(job: () => Promise<T>): Promise<T> {
  if (running >= 2) await new Promise<void>((r) => queue.push(r));
  running++;
  try {
    return await job();
  } finally {
    running--;
    queue.shift()?.();
  }
}

/**
 * Отдаёт фото, хранящееся в Telegram (по file_id), через наш сервер — чтобы не раскрывать токен бота.
 * Последние фото держим в памяти (до ~40 МБ): одно и то же фото сходки или места смотрят многие
 */
const MAX_CACHE_BYTES = 40 * 1024 * 1024;
const cache = new Map<string, { type: string; body: Buffer }>();
let cacheBytes = 0;
// Одно фото, которое прямо сейчас качаем из Telegram, — не качаем второй раз параллельно
const inflight = new Map<string, Promise<{ type: string; body: Buffer } | null>>();

// Уменьшить фото: не больше maxSide по длинной стороне, WebP. Трафик и загрузка — в 3-5 раз меньше.
// Не получилось — null, отдадим как есть
export async function shrinkImage(input: Buffer, maxSide: number): Promise<{ type: string; body: Buffer } | null> {
  try {
    const body = await sharp(input).rotate().resize({ width: maxSide, height: maxSide, fit: 'inside', withoutEnlargement: true }).webp({ quality: 72 }).toBuffer();
    return body.length < input.length ? { type: 'image/webp', body } : null;
  } catch {
    return null;
  }
}

// Из базы (уже уменьшенное) или из Telegram с уменьшением и сохранением в базу
async function loadPhoto(fileId: string) {
  const saved = await SmallPhoto.findOne({ fileId }).lean().catch(() => null);
  // lean() отдаёт BSON Binary, а не Buffer: байты лежат в .buffer
  const raw: any = saved?.data;
  const bytes: Buffer | null = raw ? (Buffer.isBuffer(raw) ? raw : raw.buffer ? Buffer.from(raw.buffer) : null) : null;
  if (bytes && bytes.length > 100) return { type: saved!.type || 'image/webp', body: bytes };
  const got = await limited(() => download(fileId));
  if (got) SmallPhoto.updateOne({ fileId }, { $set: { type: got.type, data: got.body } }, { upsert: true }).catch(() => {});
  return got;
}

// Запрос к Telegram: не дольше 8 секунд, при обрыве — ещё одна попытка
async function tgFetch(url: string): Promise<globalThis.Response> {
  try {
    return await fetch(url, { signal: AbortSignal.timeout(8000) });
  } catch {
    return fetch(url, { signal: AbortSignal.timeout(8000) });
  }
}

async function download(fileId: string) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const t0 = Date.now();
  const info: any = await (await tgFetch(`https://api.telegram.org/bot${token}/getFile?file_id=${encodeURIComponent(fileId)}`)).json();
  if (!info.ok) return null;
  const t1 = Date.now();
  const file = await tgFetch(`https://api.telegram.org/file/bot${token}/${info.result.file_path}`);
  if (!file.ok) return null;
  const body = Buffer.from(await file.arrayBuffer());
  const t2 = Date.now();
  // Медленно — пишем, какой шаг тормозит
  if (t2 - t0 > 1500) console.log(`🐢 фото из Telegram: getFile ${t1 - t0} мс, скачивание ${t2 - t1} мс, ${Math.round(body.length / 1024)} КБ`);
  return (await shrinkImage(body, 1000)) || { type: file.headers.get('content-type') || 'image/jpeg', body };
}

// Маленькие копии (200 px) — для меток на карте и списков: в 5-10 раз легче полного фото
const SMALL_SIDE = 200;
const MAX_THUMB_BYTES = 8 * 1024 * 1024;
const thumbs = new Map<string, { type: string; body: Buffer }>();
let thumbBytes = 0;
const thumbInflight = new Map<string, Promise<{ type: string; body: Buffer }>>();

// small — отдать копию 200 px (?w=200 в адресе)
export async function sendTelegramPhoto(res: Response, fileId: string, small = false) {
  if (small) {
    let t = thumbs.get(fileId);
    if (t) {
      thumbs.delete(fileId);
      thumbs.set(fileId, t);
    } else {
      const full = await getPhoto(fileId);
      if (!full) return res.sendStatus(404);
      let p = thumbInflight.get(fileId);
      if (!p) {
        p = limited(() => shrinkImage(full.body, SMALL_SIDE))
          .then((s) => s || full)
          .finally(() => thumbInflight.delete(fileId));
        thumbInflight.set(fileId, p);
      }
      t = await p;
      if (!thumbs.has(fileId)) {
        thumbs.set(fileId, t);
        thumbBytes += t.body.length;
        while (thumbBytes > MAX_THUMB_BYTES && thumbs.size) {
          const [oldId, old] = thumbs.entries().next().value!;
          thumbs.delete(oldId);
          thumbBytes -= old.body.length;
        }
      }
    }
    res.setHeader('Content-Type', t.type);
    res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
    return res.send(t.body);
  }
  const item = await getPhoto(fileId);
  if (!item) return res.sendStatus(404);
  res.setHeader('Content-Type', item.type);
  res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
  res.send(item.body);
}

// Полное фото (до 1000 px): из памяти, из базы или из Telegram
async function getPhoto(fileId: string): Promise<{ type: string; body: Buffer } | null> {
  let item = cache.get(fileId);
  if (item) {
    // Свежие — в конец очереди
    cache.delete(fileId);
    cache.set(fileId, item);
  } else {
    let p = inflight.get(fileId);
    if (!p) {
      p = loadPhoto(fileId).finally(() => inflight.delete(fileId));
      inflight.set(fileId, p);
    }
    const got = await p;
    if (!got) return null;
    item = got;
    if (!cache.has(fileId)) {
      cache.set(fileId, item);
      cacheBytes += item.body.length;
      while (cacheBytes > MAX_CACHE_BYTES && cache.size) {
        const [oldId, old] = cache.entries().next().value!;
        cache.delete(oldId);
        cacheBytes -= old.body.length;
      }
    }
  }
  return item;
}

// Фото уже в кеше — значит, проверено, что оно наше
export const isCachedPhoto = (fileId: string) => cache.has(fileId);

// Фото удалено модератором: убираем из памяти и из базы уменьшенных
export async function purgePhoto(fileId: string) {
  const item = cache.get(fileId);
  if (item) {
    cache.delete(fileId);
    cacheBytes -= item.body.length;
  }
  const t = thumbs.get(fileId);
  if (t) {
    thumbs.delete(fileId);
    thumbBytes -= t.body.length;
  }
  await SmallPhoto.deleteOne({ fileId }).catch(() => {});
}
