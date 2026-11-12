import { USERNAME_TEXTS as U, BUDDY_TEXTS as B } from './texts';
import { IUser } from './models/User';
import { Reaction } from './models/Reaction';
import { sendTelegramMessage, userMentionHtml, escapeHtml } from './utils/telegramNotify';
import { preferencesAllow } from './preferences';
import { waveQuota, markWaveLimitHit, WaveLimitError } from './waveLimit';
import { noteIncomingWave } from './waveNotify';
import { matchBridgeLine } from './buddyInvites';
import { sendWithButtons } from './wishes';
import { tossCoin, coinLine, helloPath } from './hello';
import { canStart } from './games';
import { HELLO_TEXTS as H, DUEL_TEXTS as D } from './texts';

/**
 * 👋 «Пообщаться» от одного человека другому. Если в ответ уже было 👋 — оба «На связи», бот пишет обоим.
 * context — откуда привет (например, «после сходки «Пикник»»), попадёт в уведомление
 * opts.free — не в счёт дневного лимита (привет участникам после сходки)
 * opts.bulk — привет сразу многим (после сходки): тех, с кем я сам раньше нажал «Отменить», не трогаем
 * Возвращает null, если привет передать нельзя (скрыли друг друга).
 * Бросает WaveLimitError, если дневной лимит 👋 исчерпан (ответ на чужой 👋 в лимит не входит)
 */
export async function sendLike(
  me: IUser,
  target: IUser,
  context = '',
  opts: { free?: boolean; bulk?: boolean } = {}
): Promise<{ isMatch: boolean; isNewLike: boolean; firstMove?: number | null } | null> {
  if (me.telegramId === target.telegramId) return null;
  if ((me.blockedUsers || []).includes(target.telegramId) || (target.blockedUsers || []).includes(me.telegramId)) return null;
  const [previous, reverse] = await Promise.all([
    Reaction.findOne({ fromTelegramId: me.telegramId, toTelegramId: target.telegramId }),
    Reaction.findOne({ fromTelegramId: target.telegramId, toTelegramId: me.telegramId, type: 'like' })
  ]);
  // Его настройки «с кем хочу общаться» меня не допускают — привет не передаём (если он сам передал мне 👋 — можно ответить)
  if (!preferencesAllow(target, me) && !reverse) return null;
  // Массовый привет не возвращает в «На связи» тех, кого я оттуда убрал
  if (opts.bulk && previous?.type === 'unmatch') return null;

  const isMatch = Boolean(reverse);
  const isNewLike = previous?.type !== 'like'; // не спамим уведомлениями при повторном нажатии
  const free = Boolean(opts.free) || isMatch;

  // Дневной лимит: только для новых 👋 первым
  let lastOne = false;
  if (isNewLike && !free) {
    const quota = await waveQuota(me);
    if (quota.left <= 0) {
      markWaveLimitHit(me.telegramId);
      throw new WaveLimitError(quota);
    }
    lastOne = quota.left === 1;
  }

  if (isNewLike) {
    await Reaction.findOneAndUpdate(
      { fromTelegramId: me.telegramId, toTelegramId: target.telegramId },
      { $set: { type: 'like', likedAt: new Date(), likeFree: free } },
      { upsert: true }
    );
    if (lastOne) markWaveLimitHit(me.telegramId);
  }

  let firstMove: number | null | undefined;
  if (isNewLike) {
    if (isMatch) {
      // Оба нажали 👋 — уведомляем обоих, что они на связи, и сразу мостик к сходке компанией:
      // общее «Хочу сходить» или сходка, интересная обоим. «👯 Пойдём вместе» открывает шторку выбора.
      // Монетка решает, кто пишет первым; тому, кому выпало, — «✍️ Что написать» с готовыми фразами
      const first = await tossCoin(me, target).catch(() => null);
      firstMove = first;
      const notify = async (to: IUser, other: IUser) => {
        const bridge = await matchBridgeLine(to, other).catch(() => null);
        const coin = coinLine(to.telegramId, first, `<b>${escapeHtml(other.firstName)}</b>`);
        await sendWithButtons(to.telegramId, `${B.matched(userMentionHtml(other))}${coin ? `\n\n${coin}` : ''}\n\n${bridge || B.bridgeAny}`, [
          ...(first === to.telegramId ? [[{ text: H.helloBtn, path: helloPath(other.telegramId) }]] : []),
          [{ text: B.togetherBtn, path: `?user=${other.telegramId}&together=1` }],
          [{ text: B.profileBtn, path: `?user=${other.telegramId}` }],
          // Партия как повод начать разговор (пока игры открыты не всем — только тем, у кого есть раздел)
          ...(canStart(to.telegramId) ? [[{ text: D.duelBtn, path: `?user=${other.telegramId}&duel=1` }]] : [])
        ]);
      };
      notify(target, me).catch(() => {});
      notify(me, target).catch(() => {});
      // Без @username второй человек не сможет написать первым — подсказываем завести
      if (!target.username) sendTelegramMessage(target.telegramId, U.noUsernameMatch(escapeHtml(me.firstName), Boolean(me.username)), 'Открыть анкету', `?user=${me.telegramId}`);
      if (!me.username) sendTelegramMessage(me.telegramId, U.noUsernameMatch(escapeHtml(target.firstName), Boolean(target.username)), 'Открыть анкету', `?user=${target.telegramId}`);
    } else if (await noteIncomingWave(target.telegramId)) {
      // Первые 3 за день — сразу; дальше копим до вечерней сводки (waveNotify.ts)
      sendTelegramMessage(
        target.telegramId,
        `👋 <b>${escapeHtml(me.firstName)}</b> передаёт тебе привет и хочет пообщаться${context ? ` ${escapeHtml(context)}` : ''}!\n\nЗагляни в «Хотят пообщаться». Если тоже захочешь, нажми 👋, и сможете написать друг другу.`,
        'Посмотреть анкету',
        `?user=${me.telegramId}`
      );
    }
  }
  return { isMatch, isNewLike, firstMove };
}
