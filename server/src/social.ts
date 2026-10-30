import { USERNAME_TEXTS as U } from './texts';
import { IUser } from './models/User';
import { Reaction } from './models/Reaction';
import { sendTelegramMessage, userMentionHtml, escapeHtml } from './utils/telegramNotify';
import { preferencesAllow } from './preferences';

/**
 * 👋 «Пообщаться» от одного человека другому. Если в ответ уже было 👋 — оба «На связи», бот пишет обоим.
 * context — откуда привет (например, «после сходки «Пикник»»), попадёт в уведомление
 * Возвращает null, если привет передать нельзя (скрыли друг друга)
 */
export async function sendLike(me: IUser, target: IUser, context = ''): Promise<{ isMatch: boolean; isNewLike: boolean } | null> {
  if (me.telegramId === target.telegramId) return null;
  if ((me.blockedUsers || []).includes(target.telegramId) || (target.blockedUsers || []).includes(me.telegramId)) return null;
  // Его настройки «с кем хочу общаться» меня не допускают — привет не передаём (если он сам передал мне 👋 — можно ответить)
  if (!preferencesAllow(target, me) && !(await Reaction.exists({ fromTelegramId: target.telegramId, toTelegramId: me.telegramId, type: 'like' }))) return null;

  const previous = await Reaction.findOne({ fromTelegramId: me.telegramId, toTelegramId: target.telegramId });
  await Reaction.findOneAndUpdate(
    { fromTelegramId: me.telegramId, toTelegramId: target.telegramId },
    { $set: { type: 'like' } },
    { upsert: true }
  );

  const reverse = await Reaction.findOne({ fromTelegramId: target.telegramId, toTelegramId: me.telegramId, type: 'like' });
  const isMatch = Boolean(reverse);
  const isNewLike = previous?.type !== 'like'; // не спамим уведомлениями при повторном нажатии

  if (isNewLike) {
    if (isMatch) {
      // Оба нажали 👋 — уведомляем обоих, что они на связи
      sendTelegramMessage(
        target.telegramId,
        `🤝 <b>Вы на связи!</b>\n\nВы и ${userMentionHtml(me)} оба хотите пообщаться. Можно написать прямо сейчас!`,
        'Открыть анкету',
        `?user=${me.telegramId}`
      );
      sendTelegramMessage(
        me.telegramId,
        `🤝 <b>Вы на связи!</b>\n\nВы и ${userMentionHtml(target)} оба хотите пообщаться. Можно написать прямо сейчас!`,
        'Открыть анкету',
        `?user=${target.telegramId}`
      );
      // Без @username второй человек не сможет написать первым — подсказываем завести
      if (!target.username) sendTelegramMessage(target.telegramId, U.noUsernameMatch(escapeHtml(me.firstName), Boolean(me.username)), 'Открыть анкету', `?user=${me.telegramId}`);
      if (!me.username) sendTelegramMessage(me.telegramId, U.noUsernameMatch(escapeHtml(target.firstName), Boolean(target.username)), 'Открыть анкету', `?user=${target.telegramId}`);
    } else {
      sendTelegramMessage(
        target.telegramId,
        `👋 <b>${escapeHtml(me.firstName)}</b> передаёт тебе привет и хочет пообщаться${context ? ` ${escapeHtml(context)}` : ''}!\n\nЗагляни в «Хотят пообщаться». Если тоже захочешь, нажми 👋, и сможете написать друг другу.`,
        'Посмотреть анкету',
        `?user=${me.telegramId}`
      );
    }
  }
  return { isMatch, isNewLike };
}
