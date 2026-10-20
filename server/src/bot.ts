import crypto from 'crypto';
import { Express, Request, Response } from 'express';
import { sendTelegramMessage, escapeHtml } from './utils/telegramNotify';

/**
 * Telegram-бот: отвечает на /start приветствием и кнопкой «Открыть YesMinsk».
 * Работает через вебхук: Telegram сам присылает сообщения боту на наш сервер.
 * На Render адрес сервера берётся из RENDER_EXTERNAL_URL (Render задаёт его автоматически)
 * или из PUBLIC_URL. Локально вебхук не включается.
 */

const WEBHOOK_PATH = '/api/telegram/webhook';

// Секрет, по которому проверяем, что запрос пришёл именно от Telegram (выводится из токена бота)
const getWebhookSecret = (botToken: string) =>
  crypto.createHash('sha256').update(`yesminsk-webhook:${botToken}`).digest('hex').slice(0, 64);

const GREETING = (firstName?: string) =>
  `👋 Привет${firstName ? `, ${escapeHtml(firstName)}` : ''}! Это <b>YesMinsk</b> — компания для прогулок, кофе и общения в Минске.\n\n` +
  `Без дейтинга, только дружеское общение. Находи людей рядом, присоединяйся к сходкам или создавай свои.\n\n` +
  `Жми кнопку ниже, чтобы открыть приложение 👇`;

const HINT = `Я пока не умею отвечать на сообщения 🙂\nВсё общение — в приложении YesMinsk. Жми кнопку ниже 👇`;

export function setupTelegramBot(app: Express) {
  app.post(WEBHOOK_PATH, (req: Request, res: Response) => {
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    if (!botToken || req.header('X-Telegram-Bot-Api-Secret-Token') !== getWebhookSecret(botToken)) {
      return res.sendStatus(401);
    }

    // Сразу отвечаем Telegram «ок», а сообщение обрабатываем следом
    res.sendStatus(200);

    const message = req.body?.message;
    const chatId = message?.chat?.id;
    // Отвечаем только в личной переписке с ботом
    if (!chatId || message.chat.type !== 'private' || typeof message.text !== 'string') return;

    const text = message.text.trim();
    if (text.startsWith('/start') || text.startsWith('/help')) {
      sendTelegramMessage(chatId, GREETING(message.from?.first_name), 'Открыть YesMinsk');
    } else {
      sendTelegramMessage(chatId, HINT, 'Открыть YesMinsk');
    }
  });
}

// Регистрирует вебхук в Telegram при запуске сервера
export async function registerTelegramWebhook() {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const publicUrl = (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/+$/, '');
  if (!botToken || !publicUrl) {
    console.log('ℹ️ Вебхук бота не настроен (нет TELEGRAM_BOT_TOKEN или публичного адреса сервера)');
    return;
  }

  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/setWebhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: `${publicUrl}${WEBHOOK_PATH}`,
        secret_token: getWebhookSecret(botToken),
        allowed_updates: ['message'],
        drop_pending_updates: true
      })
    });
    const data: any = await res.json();
    if (data.ok) {
      console.log(`🤖 Вебхук бота подключён: ${publicUrl}${WEBHOOK_PATH}`);
    } else {
      console.warn('⚠️ Не удалось подключить вебхук бота:', data.description);
    }
  } catch (err: any) {
    console.warn('⚠️ Ошибка подключения вебхука бота:', err?.message || err);
  }
}
