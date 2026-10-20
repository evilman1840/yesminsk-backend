import crypto from 'crypto';
import { Express, Request, Response } from 'express';
import mongoose from 'mongoose';
import { sendTelegramMessage, escapeHtml } from './utils/telegramNotify';
import { Event } from './models/Event';
import { Donation } from './models/Donation';
import { handleNewsMessage } from './news';
import { eventSummaryHtml, eventAppPath } from './eventNotify';

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

    // Донат звёздами: Telegram спрашивает «можно принять оплату?» — отвечаем «да» (в течение 10 секунд)
    const preCheckout = req.body?.pre_checkout_query;
    if (preCheckout) {
      answerPreCheckout(preCheckout.id);
      return;
    }

    // Оплата прошла — сохраняем и благодарим
    const payment = req.body?.message?.successful_payment;
    if (payment) {
      handleDonation(req.body.message.chat.id, req.body.message.from?.id, payment);
      return;
    }

    const message = req.body?.message;
    const chatId = message?.chat?.id;
    // Отвечаем только в личной переписке с ботом
    if (!chatId || message.chat.type !== 'private') return;

    handleMessage(message, chatId).catch((err) => console.warn('⚠️ Ошибка обработки сообщения боту:', err?.message || err));
  });
}

async function handleMessage(message: any, chatId: number) {
  // Новости проекта (/news, /delnews, /myid) — в том числе фото и альбомы
  if (await handleNewsMessage(message)) return;

  if (typeof message.text !== 'string') return;
  const text = message.text.trim();

  // Ссылка-приглашение на сходку: t.me/<бот>?start=event_<id>
  const eventMatch = text.match(/^\/start\s+event_([a-f0-9]{24})$/i);
  if (eventMatch) {
    sendEventInvite(chatId, eventMatch[1], message.from?.first_name);
    return;
  }

  if (text.startsWith('/start') || text.startsWith('/help')) {
    sendTelegramMessage(chatId, GREETING(message.from?.first_name), 'Открыть YesMinsk');
  } else {
    sendTelegramMessage(chatId, HINT, 'Открыть YesMinsk');
  }
}

async function answerPreCheckout(queryId: string) {
  try {
    await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/answerPreCheckoutQuery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pre_checkout_query_id: queryId, ok: true })
    });
  } catch (err: any) {
    console.warn('⚠️ Ошибка подтверждения оплаты:', err?.message || err);
  }
}

async function handleDonation(chatId: number, telegramId: number, payment: any) {
  try {
    await Donation.updateOne(
      { chargeId: payment.telegram_payment_charge_id },
      { $setOnInsert: { telegramId, stars: payment.total_amount, chargeId: payment.telegram_payment_charge_id } },
      { upsert: true }
    );
    console.log(`💛 Донат: ${payment.total_amount} ⭐ от ${telegramId}`);
  } catch (err: any) {
    console.warn('⚠️ Не удалось сохранить донат:', err?.message || err);
  }
  sendTelegramMessage(chatId, `💛 <b>Спасибо за поддержку!</b>\n\nТвои ${payment.total_amount} ⭐ помогают ДА! МИНСК оставаться бесплатным и становиться лучше.`);
}

// Ответ на ссылку-приглашение: карточка сходки и кнопка, открывающая её в приложении
async function sendEventInvite(chatId: number, eventId: string, firstName?: string) {
  try {
    const event = mongoose.Types.ObjectId.isValid(eventId) ? await Event.findById(eventId) : null;
    if (!event || !event.isActive || event.dateTime.getTime() < Date.now() - 2 * 60 * 60 * 1000) {
      sendTelegramMessage(chatId, `Эта сходка уже прошла или отменена 😔\nНо в приложении есть другие встречи — загляни!`, 'Открыть YesMinsk', '?tab=events');
      return;
    }
    sendTelegramMessage(
      chatId,
      `👋 Привет${firstName ? `, ${escapeHtml(firstName)}` : ''}! Тебя зовут на сходку:\n\n${eventSummaryHtml(event)}\n\nОткрой, чтобы посмотреть подробности и присоединиться 👇`,
      'Открыть сходку',
      eventAppPath(event)
    );
  } catch (err: any) {
    console.warn('⚠️ Ошибка приглашения на сходку:', err?.message || err);
  }
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
        allowed_updates: ['message', 'pre_checkout_query'],
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
