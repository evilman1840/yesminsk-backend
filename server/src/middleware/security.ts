import { Request, Response, NextFunction } from 'express';
import { verifyTelegramWebAppData } from './telegramAuth';

/**
 * Защита API: заголовки безопасности, очистка входных данных от операторов MongoDB и ограничение частоты запросов
 */

// API отдаёт только JSON и картинки: запрещаем браузеру исполнять что-либо из ответов
export function securityHeaders(_req: Request, res: Response, next: NextFunction) {
  res.removeHeader('X-Powered-By');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin'); // фото и аватарки грузит мини-приложение с другого домена
  next();
}

// Ключи вида «$ne» или «a.b» в теле и параметрах запроса — попытка подменить запрос к базе. Приложение таких не шлёт
const isBadKey = (key: string) => key.startsWith('$') || key.includes('.');

function strip(value: any, depth = 0): any {
  if (!value || typeof value !== 'object' || depth > 10) return value;
  for (const key of Object.keys(value)) {
    if (isBadKey(key)) delete value[key];
    else value[key] = strip(value[key], depth + 1);
  }
  return value;
}

export function stripMongoOperators(req: Request, _res: Response, next: NextFunction) {
  strip(req.body);
  strip(req.query);
  next();
}

/**
 * Ограничение частоты: не больше max запросов за windowMs на один ключ.
 * Ключ — Telegram ID из проверенной initData (у мобильных операторов один IP на тысячи людей), иначе IP
 */
export function rateLimit(opts: { windowMs: number; max: number; name: string; skip?: (req: Request) => boolean }) {
  const hits = new Map<string, { count: number; resetAt: number }>();
  setInterval(() => {
    const now = Date.now();
    hits.forEach((v, k) => v.resetAt <= now && hits.delete(k));
  }, opts.windowMs).unref();

  return (req: Request, res: Response, next: NextFunction) => {
    if (opts.skip?.(req)) return next();
    const key = clientKey(req);
    const now = Date.now();
    let entry = hits.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + opts.windowMs };
      hits.set(key, entry);
    }
    entry.count++;
    if (entry.count > opts.max) {
      if (entry.count === opts.max + 1) console.warn(`🚦 Лимит «${opts.name}»: ${key}`);
      res.setHeader('Retry-After', String(Math.ceil((entry.resetAt - now) / 1000)));
      return res.status(429).json({ error: 'Слишком много запросов. Подожди минутку и попробуй снова' });
    }
    next();
  };
}

// Проверка подписи initData — одна HMAC, дёшево. Результат кешируем на запрос
function clientKey(req: Request): string {
  const cached = (req as any)._rateKey;
  if (cached) return cached;
  const initData = req.headers['x-telegram-init-data'];
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const user = typeof initData === 'string' && initData && botToken ? verifyTelegramWebAppData(initData, botToken) : null;
  const key = user ? `tg:${user.id}` : `ip:${req.ip}`;
  (req as any)._rateKey = key;
  return key;
}
