import mongoose from 'mongoose';
import { captureAnalytics } from './analytics';
import { Event, IEvent } from './models/Event';
import { User } from './models/User';
import { reserveRecentAction } from './middleware/participantLimits';
import { audienceError } from './eventAudience';
import { seatsTaken, companyNote, eventSummaryHtml, eventAppPath } from './eventNotify';
import { sendTelegramMessage, escapeHtml } from './utils/telegramNotify';

/**
 * Запись на сходку: проверки (для кого сходка, отказ организатора, «только эмпаты», места) и сообщение организатору.
 * Общая для «Пойду!» в приложении и «✅ Пойдём» в приглашении от знакомого (buddyInvites.ts)
 */

export const isEventCreator = (ev: IEvent, viewerId: number) => Number(ev.creator.telegramId) === Number(viewerId);

// «По записи»: подтверждённую запись меняет и отменяет только организатор
export const BY_REQUEST_LOCKED = (ev: IEvent) =>
  `Запись подтверждена организатором. Чтобы отменить или изменить её, напиши ${ev.creator.username ? `@${ev.creator.username}` : 'организатору'}`;

type Person = { telegramId?: number; firstName?: string; username?: string; avatarUrl?: string; gender?: string; age?: number; isEmpath?: boolean } | null;
type TgFallback = { id: number; first_name?: string; username?: string; photo_url?: string };
type JoinAccount = NonNullable<Person> & { hasAgreedToRules: boolean; isBanned?: boolean; blockedUsers?: number[] };

export function joinAccountError(user: JoinAccount | null): string | null {
  if (user?.isBanned) return 'Аккаунт заблокирован за нарушение правил';
  if (!user?.hasAgreedToRules) return 'Открой ГУЛЯЙ! и прими правила, чтобы записаться на сходку';
  return null;
}

const CANCELLATION_WINDOW_MS = 24 * 60 * 60 * 1000;

async function needsApproval(event: IEvent, telegramId: number): Promise<boolean> {
  const recent = {
    telegramId,
    via: { $in: ['app', 'bot'] },
    cancelledAt: { $gte: new Date(Date.now() - CANCELLATION_WINDOW_MS) }
  };
  if ((event.cancellations || []).filter((c) => c.telegramId === telegramId && c.via !== 'host' && c.cancelledAt >= recent.cancelledAt.$gte).length >= 2) return true;
  return (await Event.countDocuments({ cancellations: { $elemMatch: recent } }).limit(3)) >= 3;
}

// Почему человеку нельзя на эту сходку; null — можно. Организатора не касается
export function joinBlockReason(event: IEvent, user: Person, telegramId: number): string | null {
  if (isEventCreator(event, telegramId)) return null;
  const notFit = audienceError(event, user);
  if (notFit) return notFit;
  if ((event.cancellations || []).some((c) => c.via === 'host' && c.telegramId === telegramId)) return 'Организатор отказал в участии в этой сходке';
  if ((event.tags || []).includes('empaths') && !user?.isEmpath) return 'Эта сходка только для эмпатов. Если это про тебя, отметь «Эмпат» в анкете';
  return null;
}

// Свободные места (без ограничения — бесконечно)
export const freeSeats = (event: IEvent) => (event.maxParticipants && event.maxParticipants > 0 ? event.maxParticipants - seatsTaken(event) : Infinity);

export type JoinResult = { ok: true; changed: boolean } | { ok: false; status: number; error: string };

/**
 * Записать (или поменять, с кем идёт). buddyOf — пришёл по приглашению «Пойдём вместе» от этого человека,
 * viaRecruit — по сообщению «Компания собирается»
 */
export async function joinEvent(
  event: IEvent,
  user: JoinAccount | null,
  tg: TgFallback,
  opts: { guests: number; withKids: boolean; buddyOf?: number; viaRecruit?: boolean; analyticsEntryPoint?: 'bottom_notice' }
): Promise<JoinResult> {
  const accountError = joinAccountError(user);
  if (accountError) return { ok: false, status: 403, error: accountError };

  const blocked = joinBlockReason(event, user, tg.id);
  if (blocked) return { ok: false, status: 403, error: blocked };

  const isHost = isEventCreator(event, tg.id);
  const hostId = event.creator.telegramId;
  if (!isHost && (user?.blockedUsers?.includes(hostId) ||
    await User.exists({ telegramId: hostId, $or: [{ blockedUsers: tg.id }, { isBanned: true }] }))) {
    return { ok: false, status: 403, error: 'Запись на эту сходку недоступна' };
  }

  const { guests, withKids } = opts;
  if (!Number.isSafeInteger(guests) || guests < 0) {
    return { ok: false, status: 400, error: 'Проверь, сколько гостей идёт с тобой' };
  }
  const mine = event.participants.find((p) => p.telegramId === tg.id);

  const approvalRequired = mine?.approvalRequired || (!mine && !isHost && !event.byRequest && await needsApproval(event, tg.id));
  const needsSeat = !(approvalRequired && !mine?.approvedAt);
  // Места: каждый участник со своими гостями. Свою прошлую запись не считаем — её заменяем
  if (needsSeat && event.maxParticipants && event.maxParticipants > 0) {
    const othersSeats = seatsTaken(event) - (mine ? 1 + (mine.guests || 0) : 0);
    const free = event.maxParticipants - othersSeats;
    if (1 + guests > free) {
      return {
        ok: false,
        status: 400,
        error: free <= 0 ? 'Все места заняты' : free === 1 ? 'Осталось одно место, только для тебя' : `Осталось мест: ${free}, можно взять не больше +${free - 1}`
      };
    }
  }

  const changed = !mine || (mine.guests || 0) !== guests || Boolean(mine.withKids) !== withKids;
  const addBuddy = mine && opts.buddyOf && !mine.buddyOf;
  if (!changed && !addBuddy) return { ok: true, changed: false };

  // «По записи»: подтверждённую запись меняет только организатор
  if (event.byRequest && mine?.approvedAt && changed && !isEventCreator(event, tg.id)) {
    return { ok: false, status: 403, error: BY_REQUEST_LOCKED(event) };
  }
  if (changed && !isHost && !(await reserveRecentAction(tg.id, [{ field: 'recentJoinAttempts', max: 8, since: new Date(Date.now() - 10 * 60 * 1000) }]))) {
    return { ok: false, status: 429, error: 'Слишком много записей или правок подряд. Попробуй снова через несколько минут' };
  }
  if (mine) {
    mine.guests = guests;
    mine.withKids = withKids;
    if (opts.buddyOf && !mine.buddyOf) mine.buddyOf = opts.buddyOf;
  } else {
    event.participants.push({
      telegramId: tg.id,
      name: user?.firstName || tg.first_name || 'Без имени',
      username: user?.username || tg.username,
      avatarUrl: user?.avatarUrl || tg.photo_url || '',
      joinedAt: new Date(),
      guests,
      withKids,
      ...(approvalRequired ? { approvalRequired: true } : {}),
      ...(opts.buddyOf ? { buddyOf: opts.buddyOf } : {}),
      ...(opts.viaRecruit ? { viaRecruit: true } : {})
    });
  }

  // Две одновременные записи не должны занять одно место или добавить участника дважды.
  event.increment();
  try {
    await event.save();
  } catch (err) {
    if (err instanceof mongoose.Error.VersionError) {
      return { ok: false, status: 409, error: 'Список участников только что изменился. Попробуй записаться ещё раз' };
    }
    throw err;
  }
  if (!mine && !isEventCreator(event,tg.id)) {
    const origin = opts.analyticsEntryPoint === 'bottom_notice' ? { entry_point: 'bottom_notice' as const } : {};
    captureAnalytics(tg.id,'gulyai_meetup_signup_saved', origin);
    captureAnalytics(tg.id,(event.byRequest || approvalRequired)?'gulyai_meetup_join_requested':'gulyai_meetup_joined', origin);
  }

  // Организатору — кто идёт и с кем
  if (changed && !isEventCreator(event, tg.id)) {
    const name = escapeHtml(user?.firstName || tg.first_name || '');
    const note = companyNote(guests, withKids);
    sendTelegramMessage(
      event.creator.telegramId,
      (event.byRequest || (approvalRequired && !mine?.approvedAt))
        ? `📝 <b>${name}</b> ${mine ? 'изменил(а) заявку' : 'хочет записаться'}${note ? ` (${escapeHtml(note)})` : ''}.\n\nПодтверди запись в приложении: там же можно поменять, сколько человек, или убрать.\n\n${eventSummaryHtml(event)}`
        : `${mine ? '✏️' : '🙌'} <b>${name}</b> ${mine ? 'теперь идёт' : 'идёт на твою сходку'}${note ? ` (${escapeHtml(note)})` : ''}!\n\n${eventSummaryHtml(event)}`,
      'Открыть сходку',
      eventAppPath(event)
    );
  }
  return { ok: true, changed };
}
