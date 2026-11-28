import type { IUser } from './models/User';
import type { IEvent, IEventParticipant } from './models/Event';

type ContactAccount = Pick<IUser, 'telegramId' | 'hasAgreedToRules' | 'isBanned' | 'hiddenByReports' | 'blockedUsers' | 'username'>;

export function matchedUsername(_viewer: ContactAccount | null, _person: ContactAccount, _isMatch: boolean): string | undefined {
  // Личный Telegram больше не раскрывается автоматически при взаимном 👋:
  // люди общаются внутри чата ГУЛЯЙ!, а своим ником каждый делится сам, если захочет.
  return undefined;
}

export function meetupHostUsername(event: Pick<IEvent, 'creator'>, viewerId: number, viewerEntry?: IEventParticipant): string | undefined {
  return event.creator.telegramId === viewerId || (viewerEntry?.telegramId === viewerId && viewerEntry.approvedAt)
    ? event.creator.username
    : undefined;
}
