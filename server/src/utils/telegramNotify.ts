import { User } from '../models/User';
/**
 * Отправка уведомлений пользователям через Telegram-бота.
 * Бот может написать человеку, только если тот хоть раз открывал чат с ботом (нажимал «Старт»)
 * или разрешил боту писать при запуске мини-приложения. Ошибки доставки не ломают основной запрос.
 */

// Бот не может написать (человек не нажимал «Старт», не разрешил сообщения или заблокировал бота) — запоминаем
export const markCannotMessage = (chatId: number) => {
  User.updateOne({ telegramId: chatId }, { $set: { canMessage: false, botBlockedAt: new Date() } }).catch(() => {});
};
export const markCanMessage = (chatId: number) => {
  User.updateOne({ telegramId: chatId, canMessage: { $ne: true } }, { $set: { canMessage: true }, $unset: { botBlockedAt: 1 } }).catch(() => {});
};

export const escapeHtml = (text: string): string =>
  String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/**
 * appPath — что открыть в приложении, например `?event=<id>` (откроет сразу нужную сходку)
 */
export async function sendTelegramMessage(
  chatId: number,
  html: string,
  buttonText = 'Открыть «ГУЛЯЙ!»',
  appPath = ''
): Promise<boolean> {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken || !chatId) return false;

  const miniAppUrl = process.env.MINI_APP_URL;
  const body: any = {
    chat_id: chatId,
    text: html,
    parse_mode: 'HTML',
    disable_web_page_preview: true
  };

  // Кнопка, открывающая мини-приложение прямо из уведомления
  if (miniAppUrl) {
    body.reply_markup = {
      inline_keyboard: [[{ text: buttonText, web_app: { url: `${miniAppUrl.replace(/\/+$/, '')}/${appPath}` } }]]
    };
  }

  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      const data: any = await res.json().catch(() => ({}));
      console.warn(`⚠️ Уведомление для ${chatId} не доставлено:`, data?.description || res.status);
      if (res.status === 403) markCannotMessage(chatId);
      return false;
    }
    return true;
  } catch (err: any) {
    console.warn('⚠️ Ошибка отправки уведомления в Telegram:', err?.message || err);
    return false;
  }
}

/**
 * Ссылка на человека в сообщении бота.
 * Если есть @username — обычная ссылка, иначе ссылка по ID (работает в приложениях Telegram).
 */
export const userMentionHtml = (user: { telegramId: number; firstName: string; username?: string }): string => {
  const name = escapeHtml(user.firstName || 'Пользователь');
  if (user.username) {
    return `<a href="https://t.me/${escapeHtml(user.username)}">${name} (@${escapeHtml(user.username)})</a>`;
  }
  return `<a href="tg://user?id=${user.telegramId}">${name}</a>`;
};
