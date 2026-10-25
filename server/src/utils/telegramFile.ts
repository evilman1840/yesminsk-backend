import { Response } from 'express';

/**
 * Отдаёт фото, хранящееся в Telegram (по file_id), через наш сервер — чтобы не раскрывать токен бота.
 * Последние фото держим в памяти (до ~40 МБ): одно и то же фото сходки или места смотрят многие
 */
const MAX_CACHE_BYTES = 40 * 1024 * 1024;
const cache = new Map<string, { type: string; body: Buffer }>();
let cacheBytes = 0;
// Одно фото, которое прямо сейчас качаем из Telegram, — не качаем второй раз параллельно
const inflight = new Map<string, Promise<{ type: string; body: Buffer } | null>>();

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
  return { type: file.headers.get('content-type') || 'image/jpeg', body };
}

export async function sendTelegramPhoto(res: Response, fileId: string) {
  let item = cache.get(fileId);
  if (item) {
    // Свежие — в конец очереди
    cache.delete(fileId);
    cache.set(fileId, item);
  } else {
    let p = inflight.get(fileId);
    if (!p) {
      p = download(fileId).finally(() => inflight.delete(fileId));
      inflight.set(fileId, p);
    }
    const got = await p;
    if (!got) return res.sendStatus(404);
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
  res.setHeader('Content-Type', item.type);
  res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
  res.send(item.body);
}

// Фото уже в кеше — значит, проверено, что оно наше
export const isCachedPhoto = (fileId: string) => cache.has(fileId);
