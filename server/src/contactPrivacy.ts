import type { IUser } from './models/User';
import type { IEvent, IEventParticipant } from './models/Event';

type ContactAccount = Pick<IUser, 'telegramId' | 'hasAgreedToRules' | 'isBanned' | 'hiddenByReports' | 'blockedUsers' | 'username'>;

export function matchedUsername(viewer: ContactAccount | null, person: ContactAccount, isMatch: boolean): string | undefined {
  if (!isMatch || !viewer?.hasAgreedToRules || !person.hasAgreedToRules ||
      viewer.isBanned || person.isBanned || viewer.hiddenByReports || person.hiddenByReports) return undefined;
  if (viewer.blockedUsers?.includes(person.telegramId) || person.blockedUsers?.includes(viewer.telegramId)) return undefined;
  return person.username;
}

export function meetupHostUsername(event: Pick<IEvent, 'creator'>, viewerId: number, viewerEntry?: IEventParticipant): string | undefined {
  return event.creator.telegramId === viewerId || (viewerEntry?.telegramId === viewerId && viewerEntry.approvedAt)
    ? event.creator.username
    : undefined;
}
