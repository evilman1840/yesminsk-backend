import type { Express, Response } from 'express';
import { Types } from 'mongoose';
import { DirectMessage, IDirectMessage, IDirectMessageReaction, IDirectMessageReply } from './models/DirectMessage';
import { Reaction } from './models/Reaction';
import { User, IUser } from './models/User';
import { AuthenticatedRequest, telegramAuthMiddleware } from './middleware/telegramAuth';
import { rateLimit } from './middleware/security';
import { isMatch } from './buddyInvites';
import { helloPhrases } from './hello';
import { avatarFor } from './avatars';
import { escapeHtml, sendTelegramMessage } from './utils/telegramNotify';
import { checkStopWords } from './stopWords';
import { BANNED_ERROR, reportStopWords, submitUserReport } from './moderation';
import { captureAnalytics } from './analytics';
import { canStart } from './games';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
export const DIRECT_CHAT_TTL_DAYS = 7;
const RETENTION_MS = DIRECT_CHAT_TTL_DAYS * DAY;
const PAGE_SIZE = 40;
const NOTIFY_COOLDOWN_MS = 30 * MINUTE;
const NOTIFY_MIN_GAP_MS = 30_000;
const PEER_ACTIVE_IN_CHAT_MS = 20_000;

export const DIRECT_CHAT_REACTIONS = ['👍', '❤️', '😂', '🔥', '🙏'] as const;
const allowedReactions = new Set<string>(DIRECT_CHAT_REACTIONS);

export const directPairKey = (a: number, b: number) => `${Math.min(a, b)}:${Math.max(a, b)}`;

const userAvatar = (user: Pick<IUser, 'telegramId' | 'avatarUrl' | 'photosHidden'>) =>
  user.photosHidden ? '' : avatarFor(user.telegramId, user.avatarUrl);

const activeUser = (user: IUser | null | undefined): user is IUser =>
  Boolean(user?.hasAgreedToRules && !user.isBanned && !user.hiddenByReports);

const blockedEither = (a: IUser, b: IUser) =>
  Boolean(a.blockedUsers?.includes(b.telegramId) || b.blockedUsers?.includes(a.telegramId));

class DirectChatError extends Error {
  constructor(public status: number, message: string, public extra?: Record<string, unknown>) {
    super(message);
  }
}

function replyError(res: Response, error: unknown) {
  if (error instanceof DirectChatError) {
    return res.status(error.status).json({ error: error.message, ...(error.extra || {}) });
  }
  return res.status(500).json({ error: 'Чат пока недоступен. Попробуй ещё раз' });
}

const formatReactions = (reactions: IDirectMessageReaction[] | undefined, myId: number) => {
  if (!reactions?.length) return [];
  return reactions
    .map((r) => ({
      emoji: r.emoji,
      count: r.userIds.length,
      mine: r.userIds.includes(myId)
    }))
    .filter((r) => r.count > 0);
};

const messageView = (m: IDirectMessage, me: IUser, peer: IUser) => {
  const mine = m.senderId === me.telegramId;
  const sender = mine ? me : peer;
  return {
    id: String(m._id),
    mine,
    senderId: m.senderId,
    name: mine ? 'Ты' : sender.firstName,
    avatarUrl: userAvatar(sender),
    text: m.text,
    ...(m.replyTo?.messageId
      ? {
          replyTo: {
            id: String(m.replyTo.messageId),
            senderName: m.replyTo.senderId === me.telegramId ? 'Ты' : peer.firstName,
            text: m.replyTo.text
          }
        }
      : {}),
    reactions: formatReactions(m.reactions, me.telegramId),
    createdAt: m.createdAt
  };
};

async function directContext(req: AuthenticatedRequest) {
  const myId = req.telegramUser!.id;
  const peerId = Number(req.params.peerId);
  if (!Number.isSafeInteger(peerId) || peerId <= 0 || peerId === myId) {
    throw new DirectChatError(404, 'Чат не найден');
  }
  const [me, peer, matched] = await Promise.all([
    User.findOne({ telegramId: myId }),
    User.findOne({ telegramId: peerId }),
    isMatch(myId, peerId)
  ]);
  if (!activeUser(me)) {
    throw new DirectChatError(403, 'Прими правила ГУЛЯЙ!, чтобы открыть чат');
  }
  if (!activeUser(peer) || blockedEither(me, peer) || !matched) {
    throw new DirectChatError(403, 'Чат доступен только тем, кто у тебя «На связи»');
  }
  return { me, peer, pairKey: directPairKey(myId, peerId) };
}

export async function recentDirectMessagesForReport(myId: number, peerId: number, limit = 10) {
  const pairKey = directPairKey(myId, peerId);
  const [rows, users] = await Promise.all([
    DirectMessage.find({ pairKey, expiresAt: { $gt: new Date() } })
      .sort({ _id: -1 })
      .limit(limit)
      .lean(),
    User.find({ telegramId: { $in: [myId, peerId] } }, { telegramId: 1, firstName: 1 }).lean()
  ]);
  const names = new Map(users.map((u) => [u.telegramId, u.firstName]));
  return rows.reverse().map((m) => ({
    senderName: names.get(m.senderId) || `ID ${m.senderId}`,
    text: m.text,
    createdAt: m.createdAt
  }));
}

export function setupDirectChatRoutes(app: Express) {
  const auth = telegramAuthMiddleware as any;
  const readLimit = rateLimit({ name: 'личный чат', windowMs: MINUTE, max: 90 });
  const sendLimit = rateLimit({ name: 'личные сообщения', windowMs: MINUTE, max: 15 });
  const reactLimit = rateLimit({ name: 'реакции в личном чате', windowMs: MINUTE, max: 40 });
  const reportLimit = rateLimit({ name: 'жалобы из чата', windowMs: 10 * MINUTE, max: 8 });

  // Сводка для вкладки «На связи»: непрочитанные и время последнего сообщения по парам
  app.get('/api/chats/summary', auth, readLimit, async (req: AuthenticatedRequest, res: Response) => {
    res.set('Cache-Control', 'no-store');
    try {
      const myId = req.telegramUser!.id;
      const [me, myLikes, theirLikes] = await Promise.all([
        User.findOne({ telegramId: myId }, { telegramId: 1, hasAgreedToRules: 1, isBanned: 1, hiddenByReports: 1, blockedUsers: 1 }).lean(),
        Reaction.find({ fromTelegramId: myId, type: 'like' }, { toTelegramId: 1, directChatReadAt: 1 }).lean(),
        Reaction.find({ toTelegramId: myId, type: 'like' }, { fromTelegramId: 1 }).lean()
      ]);
      if (!me?.hasAgreedToRules || me.isBanned || me.hiddenByReports) {
        return res.json({ totalUnread: 0, threads: {} });
      }
      const theirSet = new Set(theirLikes.map((r) => r.fromTelegramId));
      const blockedSet = new Set(me.blockedUsers || []);
      const matchedReactions = myLikes.filter((r) => theirSet.has(r.toTelegramId) && !blockedSet.has(r.toTelegramId));
      if (!matchedReactions.length) {
        return res.json({ totalUnread: 0, threads: {} });
      }

      const peerIds = matchedReactions.map((r) => r.toTelegramId);
      const peers = await User.find(
        {
          telegramId: { $in: peerIds },
          hasAgreedToRules: true,
          isBanned: { $ne: true },
          hiddenByReports: { $ne: true },
          blockedUsers: { $ne: myId }
        },
        { telegramId: 1, firstName: 1, avatarUrl: 1, photosHidden: 1 }
      ).lean();
      const peerById = new Map(peers.map((p) => [p.telegramId, p]));
      const readAtByPeer = new Map<number, number>();
      const pairKeys: string[] = [];
      for (const r of matchedReactions) {
        if (!peerById.has(r.toTelegramId)) continue;
        readAtByPeer.set(r.toTelegramId, r.directChatReadAt ? r.directChatReadAt.getTime() : 0);
        pairKeys.push(directPairKey(myId, r.toTelegramId));
      }
      if (!pairKeys.length) {
        return res.json({ totalUnread: 0, threads: {} });
      }

      const now = new Date();
      const [latestRows, incomingRows] = await Promise.all([
        DirectMessage.aggregate<{ _id: string; lastMessageAt: Date; text: string; senderId: number }>([
          { $match: { pairKey: { $in: pairKeys }, expiresAt: { $gt: now } } },
          { $sort: { _id: -1 } },
          { $group: { _id: '$pairKey', lastMessageAt: { $first: '$createdAt' }, text: { $first: '$text' }, senderId: { $first: '$senderId' } } }
        ]),
        DirectMessage.find(
          { recipientId: myId, pairKey: { $in: pairKeys }, expiresAt: { $gt: now } },
          { senderId: 1, createdAt: 1 }
        ).lean()
      ]);

      const unreadByPeer = new Map<number, number>();
      for (const m of incomingRows) {
        const readAt = readAtByPeer.get(m.senderId) || 0;
        if (m.createdAt.getTime() > readAt) {
          unreadByPeer.set(m.senderId, (unreadByPeer.get(m.senderId) || 0) + 1);
        }
      }

      const threads: Record<
        string,
        {
          unreadCount: number;
          lastMessageAt: string;
          lastMessagePreview: string;
          lastMessageMine: boolean;
          peerName: string;
          peerAvatarUrl: string;
        }
      > = {};
      let totalUnread = 0;
      for (const row of latestRows) {
        const [a, b] = row._id.split(':').map(Number);
        const peerId = a === myId ? b : a;
        const peerDoc = peerById.get(peerId);
        const unreadCount = unreadByPeer.get(peerId) || 0;
        totalUnread += unreadCount;
        threads[String(peerId)] = {
          unreadCount,
          lastMessageAt: row.lastMessageAt.toISOString(),
          lastMessagePreview: row.text.slice(0, 80),
          lastMessageMine: row.senderId === myId,
          peerName: peerDoc?.firstName || 'Собеседник',
          peerAvatarUrl: peerDoc ? userAvatar(peerDoc) : ''
        };
      }

      return res.json({ totalUnread, threads });
    } catch (error) {
      return replyError(res, error);
    }
  });

  // Открытие / загрузка личного чата 1 на 1
  app.get('/api/chats/:peerId', auth, readLimit, async (req: AuthenticatedRequest, res: Response) => {
    res.set('Cache-Control', 'no-store');
    try {
      const { me, peer, pairKey } = await directContext(req);
      const before = req.query.before;
      const quiet = req.query.quiet === '1';
      if (before !== undefined && (typeof before !== 'string' || !/^[\da-f]{24}$/i.test(before))) {
        throw new DirectChatError(400, 'Не получилось загрузить предыдущие сообщения');
      }

      const now = new Date();
      const [rows, myReaction] = await Promise.all([
        DirectMessage.find({
          pairKey,
          expiresAt: { $gt: now },
          ...(before ? { _id: { $lt: new Types.ObjectId(before) } } : {})
        })
          .sort({ _id: -1 })
          .limit(PAGE_SIZE + 1)
          .lean(),
        Reaction.findOne({ fromTelegramId: me.telegramId, toTelegramId: peer.telegramId, type: 'like' }).lean()
      ]);

      const page = rows.slice(0, PAGE_SIZE).reverse();
      const messages = page.map((m) => messageView(m, me, peer));

      // Отмечаем прочтение и факт открытия чата (только для актуальной страницы)
      if (!before) {
        const setFields: Record<string, unknown> = { directChatReadAt: now };
        const isFirstOpen = !myReaction?.directChatOpenedAt;
        if (isFirstOpen && !quiet) {
          setFields.directChatOpenedAt = now;
        }
        await Reaction.updateOne(
          { fromTelegramId: me.telegramId, toTelegramId: peer.telegramId, type: 'like' },
          { $set: setFields }
        );
        if (isFirstOpen && !quiet) {
          captureAnalytics(me.telegramId, 'gulyai_direct_chat_opened');
        }
      }

      const phrases = !before && messages.length === 0 ? await helloPhrases(me, peer) : [];
      const firstMove = myReaction?.firstMove
        ? myReaction.firstMove === me.telegramId
          ? 'me'
          : 'them'
        : null;

      const mutualSerious = Boolean(me.openToSerious && peer.openToSerious);
      const mutualCasual = Boolean(me.openToCasual && peer.openToCasual);

      return res.json({
        peer: {
          telegramId: peer.telegramId,
          firstName: peer.firstName,
          age: peer.age,
          avatarUrl: userAvatar(peer)
        },
        firstMove,
        firstMoveAt: myReaction?.firstMoveAt || null,
        phrases,
        messages,
        before: rows.length > PAGE_SIZE ? String(page[0]._id) : null,
        canSend: true,
        expiresInDays: DIRECT_CHAT_TTL_DAYS,
        canPlay: canStart(me.telegramId),
        comfort: {
          mutualSerious,
          mutualCasual,
          myCasualPace: me.openToCasual ? (me.casualPace || 'chat_first') : undefined,
          peerCasualPace: mutualCasual ? (peer.casualPace || 'chat_first') : undefined
        }
      });
    } catch (error) {
      return replyError(res, error);
    }
  });

  // Отправка сообщения в личный чат
  app.post('/api/chats/:peerId/messages', auth, sendLimit, async (req: AuthenticatedRequest, res: Response) => {
    res.set('Cache-Control', 'no-store');
    try {
      const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
      const clientId = req.body?.clientId;
      const replyToId = req.body?.replyToId;

      if (!text || text.length > 1000) {
        throw new DirectChatError(400, 'Напиши сообщение до 1000 знаков');
      }
      if (typeof clientId !== 'string' || !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(clientId)) {
        throw new DirectChatError(400, 'Не получилось отправить сообщение. Попробуй ещё раз');
      }
      if (replyToId !== undefined && (typeof replyToId !== 'string' || !/^[\da-f]{24}$/i.test(replyToId))) {
        throw new DirectChatError(400, 'Не получилось прикрепить ответ на сообщение');
      }

      const { me, peer, pairKey } = await directContext(req);
      const now = new Date();

      const stop = checkStopWords(text);
      if (stop) {
        void reportStopWords(stop, 'directChat', me.telegramId, [text]);
        if (stop.level === 'ban') {
          throw new DirectChatError(403, BANNED_ERROR);
        }
      }

      let replyTo: IDirectMessageReply | undefined;
      if (replyToId) {
        const target = await DirectMessage.findOne({
          _id: new Types.ObjectId(replyToId),
          pairKey,
          expiresAt: { $gt: now }
        }).lean();
        if (target) {
          replyTo = {
            messageId: target._id as Types.ObjectId,
            senderId: target.senderId,
            senderName: target.senderId === me.telegramId ? me.firstName : peer.firstName,
            text: target.text.slice(0, 140)
          };
        }
      }

      const [myReaction, peerReaction, existingBefore] = await Promise.all([
        Reaction.findOne({ fromTelegramId: me.telegramId, toTelegramId: peer.telegramId, type: 'like' }).lean(),
        Reaction.findOne({ fromTelegramId: peer.telegramId, toTelegramId: me.telegramId, type: 'like' }).lean(),
        DirectMessage.exists({ pairKey, expiresAt: { $gt: now } })
      ]);

      const expiresAt = new Date(now.getTime() + RETENTION_MS);
      const key = { pairKey, senderId: me.telegramId, clientId };
      const upsertRes = await DirectMessage.updateOne(
        key,
        {
          $setOnInsert: {
            ...key,
            recipientId: peer.telegramId,
            text,
            ...(replyTo ? { replyTo } : {}),
            createdAt: now,
            expiresAt
          }
        },
        { upsert: true }
      ).catch((error: { code?: number }) => {
        if (error.code !== 11000) throw error;
        return null;
      });

      const insertedId = upsertRes?.upsertedId as Types.ObjectId | undefined;
      const inserted = Boolean(upsertRes?.upsertedCount && insertedId);

      // Скользящий таймер 7 дней тишины: продлеваем срок хранения всех сообщений этой пары
      await DirectMessage.updateMany({ pairKey }, { $set: { expiresAt } });

      // Обновляем прочтение и отметку первого сообщения (чтобы через сутки не пришло напоминание «стесняется»)
      const myUpdate: Record<string, unknown> = { directChatReadAt: now };
      if (!myReaction?.helloPickedAt) myUpdate.helloPickedAt = now;
      if (!myReaction?.directChatOpenedAt) myUpdate.directChatOpenedAt = now;
      await Reaction.updateOne(
        { fromTelegramId: me.telegramId, toTelegramId: peer.telegramId, type: 'like' },
        { $set: myUpdate }
      );

      if (inserted) {
        if (!existingBefore) {
          captureAnalytics(me.telegramId, 'gulyai_direct_chat_first_message');
        }

        // Однократное событие «живой диалог состоялся»: оба написали по 2+ сообщения
        if (!myReaction?.directChatDialogDone && !peerReaction?.directChatDialogDone) {
          const [mineCount, peerCount] = await Promise.all([
            DirectMessage.countDocuments({ pairKey, senderId: me.telegramId, expiresAt: { $gt: now } }),
            DirectMessage.countDocuments({ pairKey, senderId: peer.telegramId, expiresAt: { $gt: now } })
          ]);
          if (mineCount >= 2 && peerCount >= 2) {
            const marked = await Reaction.updateMany(
              {
                $or: [
                  { fromTelegramId: me.telegramId, toTelegramId: peer.telegramId },
                  { fromTelegramId: peer.telegramId, toTelegramId: me.telegramId }
                ],
                type: 'like',
                directChatDialogDone: { $ne: true }
              },
              { $set: { directChatDialogDone: true } }
            );
            if (marked.modifiedCount > 0) {
              captureAnalytics(me.telegramId, 'gulyai_direct_chat_dialog_started');
            }
          }
        }

        // Умное уведомление в Telegram-боте без текста сообщения и с анти-спам троттлингом.
        // Если собеседник прямо сейчас в открытом чате с нами (читал < 20 сек назад), бот не спамит.
        if (peer.canMessage !== false) {
          const peerReadAt = peerReaction?.directChatReadAt?.getTime() || 0;
          const lastNotifiedAt = myReaction?.directChatNotifiedAt?.getTime() || 0;
          const peerInThisChatNow = peerReadAt > 0 && now.getTime() - peerReadAt < PEER_ACTIVE_IN_CHAT_MS;
          if (!peerInThisChatNow) {
            const hadUnreadBefore = await DirectMessage.exists({
              pairKey,
              senderId: me.telegramId,
              _id: { $ne: insertedId },
              createdAt: { $gt: new Date(peerReadAt) },
              expiresAt: { $gt: now }
            }).catch(() => true);

            const peerVisitedSinceLastPush = Boolean(
              peer.lastActiveAt && lastNotifiedAt && peer.lastActiveAt.getTime() > lastNotifiedAt
            );
            const shouldNotify =
              (!hadUnreadBefore && now.getTime() - lastNotifiedAt > NOTIFY_MIN_GAP_MS) ||
              (now.getTime() - lastNotifiedAt > NOTIFY_COOLDOWN_MS && peerVisitedSinceLastPush);

            if (shouldNotify) {
              await Reaction.updateOne(
                { fromTelegramId: me.telegramId, toTelegramId: peer.telegramId, type: 'like' },
                { $set: { directChatNotifiedAt: now } }
              );
              void sendTelegramMessage(
                peer.telegramId,
                `💬 <b>${escapeHtml(me.firstName)}</b> пишет тебе в ГУЛЯЙ!`,
                'Открыть чат',
                `?user=${me.telegramId}&chat=1`
              );
            }
          }
        }
      }

      const saved = await DirectMessage.findOne(key).lean();
      return res.json({
        message: saved ? messageView(saved, me, peer) : null
      });
    } catch (error) {
      return replyError(res, error);
    }
  });

  // Переключение реакции на сообщение
  app.post('/api/chats/:peerId/messages/:messageId/reactions', auth, reactLimit, async (req: AuthenticatedRequest, res: Response) => {
    res.set('Cache-Control', 'no-store');
    try {
      const emoji = typeof req.body?.emoji === 'string' ? req.body.emoji.trim() : '';
      const messageId = String(req.params.messageId || '');
      if (!allowedReactions.has(emoji)) throw new DirectChatError(400, 'Выбери одну из доступных реакций');
      if (!/^[\da-f]{24}$/i.test(messageId)) throw new DirectChatError(404, 'Сообщение не найдено');

      const { me, pairKey } = await directContext(req);
      const msg = await DirectMessage.findOne({
        _id: new Types.ObjectId(messageId),
        pairKey,
        expiresAt: { $gt: new Date() }
      });
      if (!msg) throw new DirectChatError(404, 'Сообщение не найдено');

      const list = msg.reactions ? [...msg.reactions] : [];
      const existing = list.find((r) => r.emoji === emoji);
      if (existing) {
        if (existing.userIds.includes(me.telegramId)) {
          existing.userIds = existing.userIds.filter((uid) => uid !== me.telegramId);
        } else {
          existing.userIds.push(me.telegramId);
        }
      } else {
        list.push({ emoji, userIds: [me.telegramId] });
      }
      msg.reactions = list.filter((r) => r.userIds.length > 0);
      await msg.save();

      return res.json({ reactions: formatReactions(msg.reactions, me.telegramId) });
    } catch (error) {
      return replyError(res, error);
    }
  });

  // Жалоба из личного чата: сервер сам подтягивает последние 10 сообщений пары из базы
  app.post('/api/chats/:peerId/report', auth, reportLimit, async (req: AuthenticatedRequest, res: Response) => {
    res.set('Cache-Control', 'no-store');
    try {
      const myId = req.telegramUser!.id;
      const peerId = Number(req.params.peerId);
      if (!Number.isSafeInteger(peerId) || peerId <= 0 || peerId === myId) {
        return res.status(400).json({ error: 'Неполная жалоба' });
      }
      const chatMessages = await recentDirectMessagesForReport(myId, peerId, 10);
      const result = await submitUserReport({
        fromId: myId,
        targetId: peerId,
        reason: String(req.body?.reason || ''),
        comment: String(req.body?.comment || ''),
        chatMessages
      });
      return res.status(result.status).json(result.body);
    } catch (error) {
      return replyError(res, error);
    }
  });
}

/* ---------- /stats ---------- */

export async function directChatStatsLines(): Promise<string[]> {
  const week = new Date(Date.now() - 7 * DAY);
  const [openedReactions, messagePairs] = await Promise.all([
    Reaction.find(
      { type: 'like', directChatOpenedAt: { $gte: week } },
      { fromTelegramId: 1, toTelegramId: 1 }
    ).lean(),
    DirectMessage.aggregate<{ _id: string; senders: { senderId: number; count: number }[] }>([
      { $match: { createdAt: { $gte: week } } },
      { $group: { _id: { pairKey: '$pairKey', senderId: '$senderId' }, count: { $sum: 1 } } },
      { $group: { _id: '$_id.pairKey', senders: { $push: { senderId: '$_id.senderId', count: '$count' } } } }
    ])
  ]);

  const openedPairs = new Set(openedReactions.map((r) => directPairKey(r.fromTelegramId, r.toTelegramId)));
  const wrotePairs = messagePairs.length;
  const bothTwoPlus = messagePairs.filter(
    (p) => p.senders.length >= 2 && p.senders.every((s) => s.count >= 2)
  ).length;

  if (!openedPairs.size && !wrotePairs) return [];
  return [
    '💬 <b>Личные чаты за 7 дней</b>',
    `Открыли чат: ${openedPairs.size} пар · написали 1+ сообщение: ${wrotePairs} · ответили оба (2+ сообщения): ${bothTwoPlus}`
  ];
}
