import mongoose from 'mongoose';
import { Event, IEvent } from './models/Event';
import { User } from './models/User';
import { escapeHtml, sendTelegramMessage } from './utils/telegramNotify';
import { sendLike } from './social';
import { isAdmin } from './news';

/**
 * «Как прошло?» — после сходки бот спрашивает участников: оценка, пара слов организатору
 * и «хочешь общаться с участниками дальше?» (бот передаст им 👋 — кто ответит тем же, окажутся «На связи»).
 * Через сутки организатор получает сводку
 */

const HOUR = 60 * 60 * 1000;
const MINSK = 3 * HOUR;
const ASK_AFTER = 4 * HOUR;    // спрашиваем не раньше чем через 4 часа после начала
const ASK_UNTIL = 48 * HOUR;   // и не позже чем через двое суток
const SUMMARY_AFTER = 24 * HOUR; // сводка организатору — через сутки после вопроса

const SCORES: Record<number, { emoji: string; label: string }> = {
  3: { emoji: '😍', label: 'Отлично' },
  2: { emoji: '🙂', label: 'Нормально' },
  1: { emoji: '😕', label: 'Не очень' }
};

// Ждём пару слов организатору после оценки
const pendingComments = new Map<number, { eventId: string; until: number }>();

async function callBot(method: string, body: any) {
  const res = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return res.json().catch(() => ({}));
}

const say = (chatId: number, html: string, keyboard?: { text: string; callback_data: string }[][]) =>
  callBot('sendMessage', {
    chat_id: chatId,
    text: html,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {})
  });

// Днём по Минску — чтобы не будить людей
const isDaytimeInMinsk = (now = Date.now()) => {
  const hour = new Date(now + MINSK).getUTCHours();
  return hour >= 11 && hour < 21;
};

async function askParticipants(event: IEvent) {
  const others = event.participants.filter((p) => p.telegramId !== event.creator.telegramId);
  for (const p of others) {
    await say(p.telegramId, `👋 Как прошла сходка «<b>${escapeHtml(event.title)}</b>»?`, [
      [3, 2, 1].map((score) => ({ text: `${SCORES[score].emoji} ${SCORES[score].label}`, callback_data: `fb:${event._id}:${score}` }))
    ]);
    await new Promise((r) => setTimeout(r, 60));
  }
}

async function sendSummary(event: IEvent) {
  const feedback = event.feedback || [];
  if (!feedback.length) return;
  const counts = [3, 2, 1].map((s) => `${SCORES[s].emoji} ${SCORES[s].label} — ${feedback.filter((f) => f.score === s).length}`);
  const comments = feedback.filter((f) => f.comment).slice(0, 10);
  const wantContact = feedback.filter((f) => f.wantsContact).length;
  const lines = [`📊 <b>Как прошла твоя сходка «${escapeHtml(event.title)}»</b>`, '', counts.join(' · ')];
  if (comments.length) lines.push('', '<b>Что пишут:</b>', ...comments.map((f) => `«${escapeHtml(f.comment!)}» — ${escapeHtml(f.name || 'участник')}`));
  if (wantContact) lines.push('', `🤝 Хотят общаться дальше: ${wantContact}`);
  lines.push('', 'Спасибо, что собираешь людей! Соберёшь ещё одну? 🙌');
  await sendTelegramMessage(event.creator.telegramId, lines.join('\n'), 'Создать сходку', '?tab=events');
}

async function runFeedback() {
  const now = Date.now();
  if (isDaytimeInMinsk(now)) {
    const toAsk = await Event.find({
      isActive: true,
      dateTime: { $lte: new Date(now - ASK_AFTER), $gte: new Date(now - ASK_UNTIL) },
      feedbackAskedAt: { $exists: false }
    });
    for (const event of toAsk) {
      // Отмечаем сразу — чтобы не спросить дважды, если цикл запустится снова
      await Event.updateOne({ _id: event._id }, { $set: { feedbackAskedAt: new Date() } });
      await askParticipants(event);
    }
  }
  const toSummarize = await Event.find({
    feedbackAskedAt: { $lte: new Date(now - SUMMARY_AFTER) },
    feedbackSummarySentAt: { $exists: false }
  });
  for (const event of toSummarize) {
    await Event.updateOne({ _id: event._id }, { $set: { feedbackSummarySentAt: new Date() } });
    await sendSummary(event);
  }
}

export function startFeedbackLoop() {
  const run = () => runFeedback().catch((err) => console.warn('⚠️ Ошибка «Как прошло?»:', err?.message || err));
  setTimeout(run, 90 * 1000);
  setInterval(run, 10 * 60 * 1000);
}

/**
 * Кнопки: fb:<сходка>:<оценка> и fbc:<сходка>:yes|no (общаться дальше)
 */
export async function handleFeedbackCallback(query: any): Promise<boolean> {
  const data: string = query.data || '';
  if (!data.startsWith('fb:') && !data.startsWith('fbc:')) return false;
  const chatId: number = query.message?.chat?.id;
  const fromId: number = query.from?.id;
  const [kind, eventId, value] = data.split(':');
  const answer = (text = '') => callBot('answerCallbackQuery', { callback_query_id: query.id, text });

  if (!mongoose.Types.ObjectId.isValid(eventId)) return answer(), true;
  const event = await Event.findById(eventId);
  if (!event || !event.participants.some((p) => p.telegramId === fromId)) {
    answer('Сходка не найдена');
    return true;
  }

  if (kind === 'fb') {
    const score = Number(value);
    if (!SCORES[score]) return answer(), true;
    const name = event.participants.find((p) => p.telegramId === fromId)?.name || query.from?.first_name || '';
    const existing = (event.feedback || []).find((f) => f.telegramId === fromId);
    if (existing) existing.score = score;
    else event.feedback = [...(event.feedback || []), { telegramId: fromId, name, score, createdAt: new Date() }];
    await event.save();
    answer(`${SCORES[score].emoji} Спасибо!`);
    callBot('editMessageText', {
      chat_id: chatId,
      message_id: query.message.message_id,
      text: `Как прошла сходка «${event.title}»? — ${SCORES[score].emoji} ${SCORES[score].label}`
    });

    pendingComments.set(chatId, { eventId, until: Date.now() + 30 * 60 * 1000 });
    const others = event.participants.filter((p) => p.telegramId !== fromId).length;
    const lines = ['Спасибо! ✍️ Если хочешь, напиши пару слов о сходке — передам организатору.'];
    if (others > 0) lines.push('', `🤝 Хочешь общаться с участниками дальше? Бот передаст им 👋 от тебя — кто ответит тем же, окажется у тебя «На связи».`);
    await say(
      chatId,
      lines.join('\n'),
      others > 0
        ? [
            [
              { text: '👋 Да, передай привет', callback_data: `fbc:${eventId}:yes` },
              { text: 'Не сейчас', callback_data: `fbc:${eventId}:no` }
            ]
          ]
        : undefined
    );
    return true;
  }

  // fbc — общаться дальше
  callBot('editMessageReplyMarkup', { chat_id: chatId, message_id: query.message.message_id, reply_markup: { inline_keyboard: [] } });
  const entry = (event.feedback || []).find((f) => f.telegramId === fromId);
  if (entry) {
    entry.wantsContact = value === 'yes';
    await event.save();
  }
  if (value !== 'yes') {
    answer('Хорошо');
    return true;
  }
  const me = await User.findOne({ telegramId: fromId });
  if (!me) return answer(), true;
  const targets = await User.find({ telegramId: { $in: event.participants.map((p) => p.telegramId).filter((id) => id !== fromId) } });
  let sent = 0;
  let matches = 0;
  for (const target of targets) {
    const res = await sendLike(me, target, `после сходки «${event.title}»`);
    if (res) {
      sent++;
      if (res.isMatch) matches++;
    }
  }
  answer('👋 Готово');
  await sendTelegramMessage(
    chatId,
    sent
      ? `👋 Привет передан участникам: ${sent}.${matches ? ` С ${matches} вы уже на связи — можно писать!` : ''} Кто ответит 👋 — тоже окажется «На связи».`
      : 'Не получилось передать привет — возможно, вы скрыли друг друга.',
    'Открыть «На связи»',
    '?tab=feed'
  );
  return true;
}

/**
 * Пара слов организатору — следующее текстовое сообщение после оценки
 */
export async function handleFeedbackText(message: any): Promise<boolean> {
  const chatId: number = message.chat.id;
  const text: string = (message.text || '').trim();
  const pending = pendingComments.get(chatId);
  if (!pending || !text || text.startsWith('/')) return false;
  pendingComments.delete(chatId);
  if (pending.until < Date.now()) return false;

  const event = await Event.findById(pending.eventId);
  const entry = event?.feedback?.find((f) => f.telegramId === message.from?.id);
  if (!event || !entry) return false;
  entry.comment = text.slice(0, 300);
  await event.save();
  say(chatId, '🙌 Спасибо, передам организатору!');
  return true;
}

/**
 * /feedback — автор проверяет сценарий: бот пришлёт вопрос по последней прошедшей сходке, где автор участвовал
 */
export async function handleFeedbackCommand(message: any): Promise<boolean> {
  const text: string = (message.text || '').trim();
  if (!/^\/feedback\b/i.test(text)) return false;
  if (!isAdmin(message.from?.id)) return false;
  const event = await Event.findOne({ 'participants.telegramId': message.from.id, dateTime: { $lte: new Date() } }).sort({ dateTime: -1 });
  if (!event) {
    say(message.chat.id, 'Не нашёл прошедших сходок, где ты участвовал.');
    return true;
  }
  await say(message.chat.id, `<i>Так участники увидят вопрос после сходки:</i>\n\n👋 Как прошла сходка «<b>${escapeHtml(event.title)}</b>»?`, [
    [3, 2, 1].map((score) => ({ text: `${SCORES[score].emoji} ${SCORES[score].label}`, callback_data: `fb:${event._id}:${score}` }))
  ]);
  return true;
}
