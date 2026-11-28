import type { Express, Response } from 'express';
import { Types } from 'mongoose';
import { Event, IEvent, participantPending } from './models/Event';
import { IMeetupMessage, IMeetupMessageReaction, IMeetupMessageReply, MeetupMessage } from './models/MeetupMessage';
import { User } from './models/User';
import { AuthenticatedRequest, telegramAuthMiddleware } from './middleware/telegramAuth';
import { rateLimit } from './middleware/security';
import { reserveRecentAction } from './middleware/participantLimits';
import { joinBlockReason } from './eventJoin';
import { escapeHtml, sendTelegramMessage } from './utils/telegramNotify';
import { avatarFor } from './avatars';
import { checkStopWords } from './stopWords';
import { reportChatStopWords } from './moderation';

const MINUTE = 60_000;
const DEFAULT_DURATION = 120;
const RETENTION = 48 * 60 * MINUTE;
const PAGE_SIZE = 40;
const userFields = 'telegramId firstName avatarUrl photosHidden canMessage hasAgreedToRules isBanned blockedUsers gender age isEmpath';

export const CHAT_REACTIONS = ['👍', '❤️', '😂', '🔥', '🙏'] as const;
const allowedReactions = new Set<string>(CHAT_REACTIONS);

type ChatKind = 'group' | 'question';
type ChatUser = {
  telegramId: number;
  firstName: string;
  avatarUrl?: string;
  photosHidden?: boolean;
  hasAgreedToRules: boolean;
  isBanned?: boolean;
  canMessage?: boolean;
  blockedUsers?: number[];
};
const userAvatar = (user: Pick<ChatUser, 'telegramId' | 'avatarUrl' | 'photosHidden'>) =>
  user.photosHidden ? '' : avatarFor(user.telegramId, user.avatarUrl);
const enabled = (user: ChatUser | null | undefined): user is ChatUser => Boolean(user?.hasAgreedToRules && !user.isBanned);
const blocked = (a: ChatUser, b: ChatUser) =>
  Boolean(a.blockedUsers?.includes(b.telegramId) || b.blockedUsers?.includes(a.telegramId));

export const meetupEnd = (event: Pick<IEvent, 'dateTime' | 'durationMinutes'>) =>
  event.dateTime.getTime() + (event.durationMinutes || DEFAULT_DURATION) * MINUTE;

export const meetupChatExpiresAt = (event: Pick<IEvent, 'dateTime' | 'durationMinutes'>) =>
  new Date(meetupEnd(event) + RETENTION);

export function canUseGroupChat(event: IEvent, userId: number): boolean {
  if (event.creator.telegramId === userId) return true;
  const entry = event.participants.find((p) => p.telegramId === userId);
  return Boolean(entry && !participantPending(event, entry));
}

class ChatError extends Error {
  constructor(public status: number, message: string, public extra?: Record<string, unknown>) {
    super(message);
  }
}

async function chatContext(req: AuthenticatedRequest, kind: ChatKind) {
  const id = String(req.params.id);
  if (!/^[\da-f]{24}$/i.test(id)) throw new ChatError(404, 'Сходка не найдена');
  const myId = req.telegramUser!.id;
  const [event, me] = await Promise.all([
    Event.findById(id),
    User.findOne({ telegramId: myId }, userFields).lean()
  ]);
  if (!event?.isActive) throw new ChatError(404, 'Сходка уже недоступна');
  if (!enabled(me)) throw new ChatError(403, 'Прими правила ГУЛЯЙ!, чтобы открыть переписку');
  const expiresAt = meetupChatExpiresAt(event);
  if (expiresAt.getTime() <= Date.now()) throw new ChatError(410, 'Срок переписки истёк');
  const isHost = event.creator.telegramId === myId;
  const unclaimedExternal = event.creator.telegramId === 0 && Boolean(event.external && !event.external.claimedBy);
  if (unclaimedExternal && kind === 'question') {
    throw new ChatError(403, 'Автор этой встречи пока в Threads - открой оригинал поста');
  }
  const host = unclaimedExternal ? null : isHost ? me : await User.findOne({ telegramId: event.creator.telegramId }, userFields).lean();
  if (!unclaimedExternal && (!enabled(host) || blocked(me, host!))) throw new ChatError(403, 'Переписка по этой сходке недоступна');
  if (kind === 'group' && !canUseGroupChat(event, myId)) {
    throw new ChatError(403, 'Чат откроется, когда твоя запись на сходку будет подтверждена');
  }
  return { event, me, host, isHost, expiresAt };
}

type ChatContext = Awaited<ReturnType<typeof chatContext>>;

async function questionPeer(ctx: ChatContext, askerId: number) {
  if (!ctx.host) throw new ChatError(403, 'Автор этой встречи пока в Threads - открой оригинал поста');
  if (!Number.isSafeInteger(askerId) || askerId <= 0 || askerId === ctx.host.telegramId ||
      (!ctx.isHost && askerId !== ctx.me.telegramId)) {
    throw new ChatError(404, 'Переписка не найдена');
  }
  const peer = ctx.isHost ? await User.findOne({ telegramId: askerId }, userFields).lean() : ctx.host;
  if (!enabled(peer) || blocked(ctx.me, peer)) throw new ChatError(403, 'Эта переписка недоступна');
  return peer;
}

const formatReactions = (reactions: IMeetupMessageReaction[] | undefined, myId: number, hiddenIds?: Set<number>) => {
  if (!reactions?.length) return [];
  return reactions
    .map((r) => {
      const visibleIds = hiddenIds?.size ? r.userIds.filter((uid) => !hiddenIds.has(uid)) : r.userIds;
      return {
        emoji: r.emoji,
        count: visibleIds.length,
        mine: visibleIds.includes(myId)
      };
    })
    .filter((r) => r.count > 0);
};

const messageView = (m: IMeetupMessage, me: ChatUser, sender: ChatUser, hiddenIds: Set<number>) => ({
  id: String(m._id),
  mine: m.senderId === me.telegramId,
  senderId: m.senderId,
  name: m.senderId === me.telegramId ? 'Ты' : sender.firstName,
  avatarUrl: userAvatar(sender),
  text: m.text,
  ...(m.replyTo?.messageId
    ? {
        replyTo: hiddenIds.has(m.replyTo.senderId)
          ? { id: String(m.replyTo.messageId), senderName: 'Участник', text: 'Сообщение скрыто' }
          : {
              id: String(m.replyTo.messageId),
              senderName: m.replyTo.senderId === me.telegramId ? 'Ты' : m.replyTo.senderName,
              text: m.replyTo.text
            }
      }
    : {}),
  reactions: formatReactions(m.reactions, me.telegramId, hiddenIds),
  createdAt: m.createdAt
});

function chatKind(value: unknown): ChatKind {
  if (value === 'group' || value === 'question') return value;
  throw new ChatError(400, 'Выбери, какую переписку открыть');
}

function replyError(res: Response, error: unknown) {
  if (error instanceof ChatError) return res.status(error.status).json({ error: error.message, ...(error.extra || {}) });
  return res.status(500).json({ error: 'Переписка пока недоступна. Попробуй ещё раз' });
}

async function hostInbox(ctx: ChatContext) {
  if (!ctx.host) return [];
  const rows = await MeetupMessage.aggregate<{ _id: number; at: Date }>([
    { $match: { eventId: ctx.event._id, hostId: ctx.host.telegramId, expiresAt: { $gt: new Date() } } },
    { $group: { _id: '$askerId', at: { $max: '$createdAt' } } },
    { $sort: { at: -1 } }
  ]);
  const people = await User.find({ telegramId: { $in: rows.map((row) => row._id) } }, userFields).lean();
  const visible = new Map(people.filter((p) => enabled(p) && !blocked(ctx.me, p)).map((p) => [p.telegramId, p]));
  return rows.filter((row) => visible.has(row._id)).map((row) => {
    const person = visible.get(row._id)!;
    return {
      askerId: row._id,
      name: person.firstName,
      avatarUrl: userAvatar(person),
      updatedAt: row.at
    };
  });
}

export function setupMeetupChatRoutes(app: Express) {
  const auth = telegramAuthMiddleware as any;
  const readLimit = rateLimit({ name: 'переписка на сходках', windowMs: MINUTE, max: 60 });
  const sendLimit = rateLimit({ name: 'сообщения на сходках', windowMs: MINUTE, max: 8 });
  const reactLimit = rateLimit({ name: 'реакции в чате сходки', windowMs: MINUTE, max: 30 });
  const path = '/api/events/:id/chat';

  app.get(path, auth, readLimit, async (req: AuthenticatedRequest, res: Response) => {
    res.set('Cache-Control', 'no-store');
    try {
      const kind = chatKind(req.query.kind);
      const ctx = await chatContext(req, kind);
      const title = ctx.event.title;
      const chatPaused = Boolean(ctx.event.chatPaused);
      const askerId = kind === 'group' ? 0 : Number(req.query.askerId ?? ctx.me.telegramId);
      if (kind === 'question' && ctx.isHost && req.query.askerId === undefined) {
        return res.json({ title, expiresAt: ctx.expiresAt, chatPaused, threads: await hostInbox(ctx) });
      }
      const peer = kind === 'question' ? await questionPeer(ctx, askerId) : null;
      const hostId = peer && ctx.host ? ctx.host.telegramId : 0;
      const before = req.query.before;
      if (before !== undefined && (typeof before !== 'string' || !/^[\da-f]{24}$/i.test(before))) {
        throw new ChatError(400, 'Не получилось загрузить предыдущие сообщения');
      }
      // Отсеиваем скрытые сообщения до ограничения страницы, чтобы пустая страница не скрыла историю.
      const hiddenBy = kind === 'group' ? await User.distinct('telegramId', {
        $or: [{ blockedUsers: ctx.me.telegramId }, { isBanned: true }]
      }) : [];
      const hiddenIds = new Set<number>([...hiddenBy, ...(ctx.me.blockedUsers || [])]);
      const rows = await MeetupMessage.find({
        eventId: ctx.event._id,
        hostId,
        askerId,
        expiresAt: { $gt: new Date() },
        ...(hiddenIds.size ? { senderId: { $nin: [...hiddenIds] } } : {}),
        ...(before ? { _id: { $lt: new Types.ObjectId(before) } } : {})
      }).sort({ _id: -1 }).limit(PAGE_SIZE + 1).lean();
      const page = rows.slice(0, PAGE_SIZE).reverse();
      const authors = peer ? [ctx.me, peer] : await User.find({
        telegramId: { $in: [...new Set(page.map((m) => m.senderId))] }
      }, userFields).lean();
      const visible = new Map(authors.filter((p) => enabled(p) && !blocked(ctx.me, p)).map((p) => [p.telegramId, p]));
      const messages = page.flatMap((m) => {
        const sender = visible.get(m.senderId);
        return sender ? [messageView(m, ctx.me, sender, hiddenIds)] : [];
      });
      const canSend = !chatPaused && (kind === 'group' || ctx.isHost || page.length > 0 || meetupEnd(ctx.event) > Date.now() || Boolean(before));
      return res.json({
        title, expiresAt: ctx.expiresAt, chatPaused, messages, canSend,
        peerName: peer?.firstName,
        peerAvatarUrl: peer ? userAvatar(peer) : undefined,
        peerId: peer?.telegramId,
        before: rows.length > PAGE_SIZE ? String(page[0]._id) : null
      });
    } catch (error) {
      return replyError(res, error);
    }
  });

  app.post(path, auth, sendLimit, async (req: AuthenticatedRequest, res: Response) => {
    res.set('Cache-Control', 'no-store');
    try {
      const kind = chatKind(req.body?.kind);
      const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
      const clientId = req.body?.clientId;
      const replyToId = req.body?.replyToId;
      if (!text || text.length > 600) throw new ChatError(400, 'Напиши сообщение до 600 знаков');
      if (typeof clientId !== 'string' || !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(clientId)) {
        throw new ChatError(400, 'Не получилось отправить сообщение. Попробуй ещё раз');
      }
      if (replyToId !== undefined && (typeof replyToId !== 'string' || !/^[\da-f]{24}$/i.test(replyToId))) {
        throw new ChatError(400, 'Не получилось прикрепить ответ на сообщение');
      }

      const ctx = await chatContext(req, kind);
      if (ctx.event.chatPaused) {
        throw new ChatError(403, 'Чат временно отключён на проверку модератором', { chatPaused: true });
      }
      const askerId = kind === 'group' ? 0 : Number(req.body?.askerId ?? ctx.me.telegramId);
      const peer = kind === 'question' ? await questionPeer(ctx, askerId) : null;
      const hostId = peer && ctx.host ? ctx.host.telegramId : 0;
      const thread = { eventId: ctx.event._id as Types.ObjectId, hostId, askerId };
      const now = new Date();
      const existing = peer ? await MeetupMessage.exists({ ...thread, expiresAt: { $gt: now } }) : null;
      if (peer && !existing) {
        if (ctx.isHost) throw new ChatError(404, 'В этой переписке пока нет вопроса');
        if (meetupEnd(ctx.event) <= now.getTime()) throw new ChatError(409, 'Сходка уже закончилась. Новый вопрос задать не получится');
        if (joinBlockReason(ctx.event, ctx.me, ctx.me.telegramId)) throw new ChatError(403, 'Вопрос к этой сходке недоступен');
        if (!(await reserveRecentAction(ctx.me.telegramId, [{ field: 'recentMeetupQuestions', max: 4, since: new Date(now.getTime() - 30 * MINUTE) }]))) {
          throw new ChatError(429, 'Ты уже задал несколько вопросов подряд. Попробуй чуть позже');
        }
      }

      // Фильтр политических стоп-слов (тот же список, что при создании сходок):
      // сообщение не публикуем, чат временно ставим на паузу и уведомляем администратора на проверку.
      const stop = checkStopWords(text);
      if (stop) {
        await Event.updateOne({ _id: ctx.event._id }, { $set: { chatPaused: true, chatPausedAt: now } });
        void reportChatStopWords(stop, ctx.me.telegramId, ctx.event, kind, text);
        throw new ChatError(403, 'Сообщение не отправлено: чат временно отключён на проверку модератором.', { chatPaused: true });
      }

      let replyTo: IMeetupMessageReply | undefined;
      if (replyToId) {
        const target = await MeetupMessage.findOne({ _id: new Types.ObjectId(replyToId), ...thread, expiresAt: { $gt: now } }).lean();
        if (target) {
          const targetAuthor = target.senderId === ctx.me.telegramId
            ? ctx.me
            : await User.findOne({ telegramId: target.senderId }, 'telegramId firstName').lean();
          replyTo = {
            messageId: target._id as Types.ObjectId,
            senderId: target.senderId,
            senderName: targetAuthor?.firstName || 'Участник',
            text: target.text.slice(0, 140)
          };
        }
      }

      const key = { ...thread, senderId: ctx.me.telegramId, clientId };
      const result = await MeetupMessage.updateOne(key, {
        $setOnInsert: { ...key, text, ...(replyTo ? { replyTo } : {}), createdAt: now, expiresAt: ctx.expiresAt }
      }, { upsert: true }).catch((error: { code?: number }) => {
        if (error.code !== 11000) throw error;
        return null;
      });
      if (peer?.canMessage !== false && peer && result?.upsertedCount) {
        // Уведомление без текста сообщения. Если сообщения пришли подряд, достаточно первого.
        const previous = await MeetupMessage.exists({
          ...thread, senderId: ctx.me.telegramId, _id: { $lt: result.upsertedId },
          createdAt: { $gt: new Date(now.getTime() - 5 * MINUTE) }
        }).catch(() => true);
        if (!previous) void sendTelegramMessage(
          peer.telegramId,
          `💬 Новое сообщение по сходке «${escapeHtml(ctx.event.title)}»`,
          'Открыть переписку',
          `?event=${ctx.event._id}&meetupChat=question${ctx.isHost ? '' : `&asker=${askerId}`}`
        );
      }
      return res.sendStatus(204);
    } catch (error) {
      return replyError(res, error);
    }
  });

  app.post(`${path}/messages/:messageId/react`, auth, reactLimit, async (req: AuthenticatedRequest, res: Response) => {
    res.set('Cache-Control', 'no-store');
    try {
      const kind = chatKind(req.body?.kind);
      const emoji = typeof req.body?.emoji === 'string' ? req.body.emoji.trim() : '';
      const messageId = String(req.params.messageId || '');
      if (!allowedReactions.has(emoji)) throw new ChatError(400, 'Выбери одну из доступных реакций');
      if (!/^[\da-f]{24}$/i.test(messageId)) throw new ChatError(404, 'Сообщение не найдено');

      const ctx = await chatContext(req, kind);
      if (ctx.event.chatPaused) {
        throw new ChatError(403, 'Чат временно отключён на проверку модератором', { chatPaused: true });
      }
      const askerId = kind === 'group' ? 0 : Number(req.body?.askerId ?? ctx.me.telegramId);
      const peer = kind === 'question' ? await questionPeer(ctx, askerId) : null;
      const hostId = peer && ctx.host ? ctx.host.telegramId : 0;
      const msg = await MeetupMessage.findOne({
        _id: new Types.ObjectId(messageId),
        eventId: ctx.event._id,
        hostId,
        askerId,
        expiresAt: { $gt: new Date() }
      });
      if (!msg) throw new ChatError(404, 'Сообщение не найдено');

      const list = msg.reactions ? [...msg.reactions] : [];
      const existing = list.find((r) => r.emoji === emoji);
      if (existing) {
        if (existing.userIds.includes(ctx.me.telegramId)) {
          existing.userIds = existing.userIds.filter((uid) => uid !== ctx.me.telegramId);
        } else {
          existing.userIds.push(ctx.me.telegramId);
        }
      } else {
        list.push({ emoji, userIds: [ctx.me.telegramId] });
      }
      msg.reactions = list.filter((r) => r.userIds.length > 0);
      await msg.save();

      return res.json({ reactions: formatReactions(msg.reactions, ctx.me.telegramId) });
    } catch (error) {
      return replyError(res, error);
    }
  });
}
