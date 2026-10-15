import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';

export interface TelegramUserData {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  photo_url?: string;
  language_code?: string;
}

export interface AuthenticatedRequest extends Request {
  telegramUser?: TelegramUserData;
}

/**
 * Валидация строки initData от Telegram Web App по алгоритму HMAC-SHA256
 */
export function verifyTelegramWebAppData(initData: string, botToken: string): TelegramUserData | null {
  if (!initData) return null;

  try {
    const urlParams = new URLSearchParams(initData);
    const hash = urlParams.get('hash');
    if (!hash) return null;

    urlParams.delete('hash');

    // Сортировка параметров в алфавитном порядке согласно спецификации Telegram
    const paramsList: string[] = [];
    Array.from(urlParams.keys())
      .sort()
      .forEach((key) => {
        paramsList.push(`${key}=${urlParams.get(key)}`);
      });

    const dataCheckString = paramsList.join('\n');

    // Вычисление секретного ключа: HMAC_SHA256("WebAppData", botToken)
    const secretKey = crypto
      .createHmac('sha256', 'WebAppData')
      .update(botToken)
      .digest();

    // Вычисление хэша строки параметров
    const calculatedHash = crypto
      .createHmac('sha256', secretKey)
      .update(dataCheckString)
      .digest('hex');

    // Безопасное сравнение строк от тайминг-атак
    const isValid = crypto.timingSafeEqual(
      Buffer.from(calculatedHash, 'hex'),
      Buffer.from(hash, 'hex')
    );

    if (!isValid) return null;

    const userParam = urlParams.get('user');
    return userParam ? JSON.parse(userParam) : null;
  } catch (err) {
    console.error('Ошибка верификации Telegram initData:', err);
    return null;
  }
}

/**
 * Express Middleware для защиты роутов
 */
export const telegramAuthMiddleware = (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) => {
  const initData = req.headers['x-telegram-init-data'] as string;
  const botToken = process.env.TELEGRAM_BOT_TOKEN;

  // Мок-пользователь для локального тестирования в браузере (без открытия через Telegram)
  if (process.env.NODE_ENV === 'development' && (!botToken || !initData)) {
    req.telegramUser = {
      id: 999001,
      first_name: 'Алексей',
      last_name: 'Минчанин',
      username: 'minsk_stroller'
    };
    return next();
  }

  if (!botToken) {
    return res.status(500).json({ error: 'TELEGRAM_BOT_TOKEN не задан в .env' });
  }

  const user = verifyTelegramWebAppData(initData, botToken);
  if (!user) {
    return res.status(401).json({ error: 'Недействительная или устаревшая сессия Telegram' });
  }

  req.telegramUser = user;
  next();
};
