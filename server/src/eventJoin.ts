import { IEvent } from './models/Event';
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
 * Записать (или поменять, с кем идёт). buddyOf — пришёл по приглашению «Пойдём вместе» от этого человека
 */
export async function joinEvent(
  event: IEvent,
  user: Person,
  tg: TgFallback,
  opts: { guests: number; withKids: boolean; buddyOf?: number }
): Promise<JoinResult> {
  const blocked = joinBlockReason(event, user, tg.id);
  if (blocked) return { ok: false, status: 403, error: blocked };

  const { guests, withKids } = opts;
  const mine = event.participants.find((p) => p.telegramId === tg.id);

  // Места: каждый участник со своими гостями. Свою прошлую запись не считаем — её заменяем
  if (event.maxParticipants && event.maxParticipants > 0) {
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
  // «По записи»: подтверждённую запись меняет только организатор
  if (event.byRequest && mine?.approvedAt && changed && !isEventCreator(event, tg.id)) {
    return { ok: false, status: 403, error: BY_REQUEST_LOCKED(event) };
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
      ...(opts.buddyOf ? { buddyOf: opts.buddyOf } : {})
    });
  }

  await event.save();

  // Организатору — кто идёт и с кем
  if (changed && !isEventCreator(event, tg.id)) {
    const name = escapeHtml(user?.firstName || tg.first_name || '');
    const note = companyNote(guests, withKids);
    const username = user?.username || tg.username;
    const contact = username ? ` · @${escapeHtml(username)}` : '';
    sendTelegramMessage(
      event.creator.telegramId,
      event.byRequest
        ? `📝 <b>${name}</b>${contact} ${mine ? 'изменил(а) заявку' : 'хочет записаться'}${note ? ` (${escapeHtml(note)})` : ''}.\n\nПодтверди запись в приложении: там же можно поменять, сколько человек, или убрать.\n\n${eventSummaryHtml(event)}`
        : `${mine ? '✏️' : '🙌'} <b>${name}</b> ${mine ? 'теперь идёт' : 'идёт на твою сходку'}${note ? ` (${escapeHtml(note)})` : ''}!\n\n${eventSummaryHtml(event)}`,
      'Открыть сходку',
      eventAppPath(event)
    );
  }
  return { ok: true, changed };
}
