import crypto from 'crypto';
import { handleTemplatesCommand, handleTemplatesCallback } from './eventTemplates';
import { handleWishCallback, handleWishStart } from './wishes';
import { handleNudgeCallback, handleNudgeCommand } from './nudges';
import { handleProposalCallback, handleWishesCommand, handleGroupPlaceReply } from './proposals';
import { handleSuggestionCallback, handleSuggestionEditMessage } from './placeSuggestions';
import { Express, Request, Response } from 'express';
import mongoose from 'mongoose';
import { sendTelegramMessage, escapeHtml } from './utils/telegramNotify';
import { Event } from './models/Event';
import { Donation } from './models/Donation';
import { handleNewsMessage } from './news';
import { handleModerationCallback, handleModerationCommand, banUser } from './moderation';
import { handlePhotoModerationCallback, handlePhotosCommand } from './photoModeration';
import { handleStatsCommand } from './stats';
import { handleFundCommand } from './fund';
import { handleIdeasCommand } from './ideas';
import { handleDigestCommand } from './digest';
import { handleInviteStart } from './invites';
import { markCanMessage } from './utils/telegramNotify';
import { handlePlaceMessage, handlePlaceCallback } from './places';
import { handleCsvMessage, handleCsvCallback } from './csvImport';
import { handleFeedbackCallback, handleFeedbackText, handleFeedbackCommand } from './feedback';
import { eventSummaryHtml, eventAppPath } from './eventNotify';

/**
 * Telegram-бот: отвечает на /start приветствием и кнопкой «Открыть «ГУЛЯЙ!»».
 * Работает через вебхук: Telegram сам присылает сообщения боту на наш сервер.
 * На Render адрес сервера берётся из RENDER_EXTERNAL_URL (Render задаёт его автоматически)
 * или из PUBLIC_URL. Локально вебхук не включается.
 */

const WEBHOOK_PATH = '/api/telegram/webhook';

// Секрет, по которому проверяем, что запрос пришёл именно от Telegram (выводится из токена бота)
const getWebhookSecret = (botToken: string) =>
  crypto.createHash('sha256').update(`yesminsk-webhook:${botToken}`).digest('hex').slice(0, 64);

const GREETING = (firstName?: string) =>
  `👋 Привет${firstName ? `, ${escapeHtml(firstName)}` : ''}! Это <b>ГУЛЯЙ!</b> 🙂 Здесь легко найти, куда и с кем выйти погулять в Минске.\n\n` +
  `📍 Места по настроению: куда сходить соло, компанией или с детьми\n` +
  `🗓 Сходки: присоединяйся к прогулкам, кофе и настолкам или собери свою\n` +
  `👋 Люди рядом: без флирта, только дружба\n\n` +
  `Жми кнопку ниже, чтобы открыть приложение 👇`;

const HINT = `Я пока не умею отвечать на сообщения 🙂\nВсё есть в приложении «ГУЛЯЙ!». Жми кнопку ниже 👇`;

export function setupTelegramBot(app: Express) {
  app.post(WEBHOOK_PATH, (req: Request, res: Response) => {
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    if (!botToken || req.header('X-Telegram-Bot-Api-Secret-Token') !== getWebhookSecret(botToken)) {
      return res.sendStatus(401);
    }

    // Сразу отвечаем Telegram «ок», а сообщение обрабатываем следом
    res.sendStatus(200);

    // Нажатие кнопки под жалобой (бан / всё в порядке)
    if (req.body?.callback_query) {
      const q = req.body.callback_query;
      (async () => (await handleFeedbackCallback(q)) || (await handleCsvCallback(q)) || (await handleTemplatesCallback(q)) || (await handleWishCallback(q)) || (await handleNudgeCallback(q)) || (await handleProposalCallback(q)) || (await handleSuggestionCallback(q)) || (await handlePhotoModerationCallback(q, banUser)) || (await handlePlaceCallback(q)) || (await handleModerationCallback(q)))().catch((err) =>
        console.warn('⚠️ Ошибка обработки кнопки:', err?.message || err)
      );
      return;
    }

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
  // Человек написал боту (в том числе «Старт») — теперь бот может ему писать
  markCanMessage(chatId);
  // Пара слов организатору после «Как прошло?»
  if (await handleFeedbackText(message)) return;
  // Таблицы (CSV-файл) и шаблоны (/template) — раньше мест, чтобы файл не попал в черновик места
  if (await handleCsvMessage(message)) return;
  // Добавление мест (/place …) — раньше новостей, чтобы фото места не попали в новости
  if (await handleSuggestionEditMessage(message)) return;
  if (await handlePlaceMessage(message)) return;
  // Новости проекта (/news, /delnews, /tip, /deltip, /myid) — в том числе фото и альбомы
  if (await handleNewsMessage(message)) return;
  if (await handleModerationCommand(message)) return;
  if (await handlePhotosCommand(message)) return;
  if (await handleStatsCommand(message)) return;
  if (await handleFundCommand(message)) return;
  if (await handleIdeasCommand(message)) return;
  if (await handleDigestCommand(message)) return;
  if (await handleFeedbackCommand(message)) return;
  if (await handleTemplatesCommand(message)) return;
  if (await handleNudgeCommand(message)) return;
  if (await handleWishesCommand(message)) return;
  // Ссылка на место от участника группы «Хочу сходить», которую бот спросил про место
  if (await handleGroupPlaceReply(message)) return;

  if (typeof message.text !== 'string') return;
  const text = message.text.trim();

  // Приглашение в приложение от друга: t.me/<бот>?start=invite_<id>
  const inviteMatch = text.match(/^\/start\s+invite_(\d+)$/i);
  if (inviteMatch) {
    handleInviteStart(chatId, message.from?.id, Number(inviteMatch[1]), message.from?.first_name);
    return;
  }

  // «Хочу сходить» из поста: t.me/<бот>?start=wish_cinema_weekend
  const wishMatch = text.match(/^\/start\s+wish_([a-z0-9_]{3,60})$/i);
  if (wishMatch) {
    handleWishStart(chatId, wishMatch[1].toLowerCase());
    return;
  }

  // Ссылка-приглашение на сходку: t.me/<бот>?start=event_<id>
  const eventMatch = text.match(/^\/start\s+event_([a-f0-9]{24})$/i);
  if (eventMatch) {
    sendEventInvite(chatId, eventMatch[1], message.from?.first_name);
    return;
  }

  if (text.startsWith('/start') || text.startsWith('/help')) {
    sendTelegramMessage(chatId, GREETING(message.from?.first_name), 'Открыть «ГУЛЯЙ!»');
  } else {
    sendTelegramMessage(chatId, HINT, 'Открыть «ГУЛЯЙ!»');
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
  sendTelegramMessage(chatId, `💛 <b>Спасибо за поддержку!</b>\n\nТвои ${payment.total_amount} ⭐ помогают «ГУЛЯЙ!» оставаться бесплатным и становиться лучше.`);
}

// Ответ на ссылку-приглашение: карточка сходки и кнопка, открывающая её в приложении
async function sendEventInvite(chatId: number, eventId: string, firstName?: string) {
  try {
    const event = mongoose.Types.ObjectId.isValid(eventId) ? await Event.findById(eventId) : null;
    if (!event || !event.isActive || event.dateTime.getTime() < Date.now() - 2 * 60 * 60 * 1000) {
      sendTelegramMessage(chatId, `Эта сходка уже прошла или отменена 😔\nНо в приложении есть другие встречи, загляни!`, 'Открыть «ГУЛЯЙ!»', '?tab=events');
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

// Меню команд (кнопка «/» в чате): всем — только /start, администраторам — свои команды
async function registerBotCommands(botToken: string) {
  const call = (body: any) =>
    fetch(`https://api.telegram.org/bot${botToken}/setMyCommands`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }).catch(() => {});

  await call({ commands: [{ command: 'start', description: 'Открыть «ГУЛЯЙ!»' }] });

  const adminCommands = [
    { command: 'stats', description: 'Статистика приложения' },
    { command: 'ideas', description: 'Что вписывают в «Своя идея»' },
    { command: 'digest', description: 'Моя подборка сейчас: /digest daily|weekend|weekly' },
    { command: 'feedback', description: 'Проверить «Как прошло?» на своей сходке' },
    { command: 'template', description: 'Шаблоны таблиц (места, отзывы)' },
    { command: 'place', description: 'Добавить место' },
    { command: 'places', description: 'Список мест' },
    { command: 'delplace', description: 'Удалить место: /delplace номер' },
    { command: 'placecat', description: 'Тип места: /placecat номер' },
    { command: 'placephoto', description: 'Фото к месту: /placephoto номер' },
    { command: 'delphotos', description: 'Убрать фото места: /delphotos номер' },
    { command: 'placelink', description: 'Ссылка на Яндекс Карты: /placelink номер ссылка' },
    { command: 'cancel', description: 'Отменить добавление места' },
    { command: 'news', description: 'Опубликовать новость: /news текст' },
    { command: 'fund', description: 'Шкала донатов: /fund всего котёл' },
    { command: 'placeedit', description: 'Поправить место: /placeedit номер' },
    { command: 'delnews', description: 'Удалить последнюю новость' },
    { command: 'tip', description: 'Запись в подсказках, в конце: /tip текст (до 80 символов)' },
    { command: 'tiptop', description: 'Запись в подсказках, первой: /tiptop текст' },
    { command: 'deltip', description: 'Убрать запись из строки подсказок' },
    { command: 'unban', description: 'Разбанить: /unban ID' },
    { command: 'myid', description: 'Мой Telegram ID' },
    { command: 'start', description: 'Открыть «ГУЛЯЙ!»' }
  ];
  for (const id of (process.env.ADMIN_TELEGRAM_IDS || '').split(',').map((x) => Number(x.trim())).filter(Boolean)) {
    await call({ commands: adminCommands, scope: { type: 'chat', chat_id: id } });
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
        allowed_updates: ['message', 'pre_checkout_query', 'callback_query'],
        drop_pending_updates: true
      })
    });
    const data: any = await res.json();
    if (data.ok) {
      console.log(`🤖 Вебхук бота подключён: ${publicUrl}${WEBHOOK_PATH}`);
      registerBotCommands(botToken);
    } else {
      console.warn('⚠️ Не удалось подключить вебхук бота:', data.description);
    }
  } catch (err: any) {
    console.warn('⚠️ Ошибка подключения вебхука бота:', err?.message || err);
  }
}
