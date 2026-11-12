import { Express, Response } from 'express';
import { telegramAuthMiddleware, AuthenticatedRequest } from './middleware/telegramAuth';
import { User, IUser } from './models/User';
import { Reaction } from './models/Reaction';
import { CUSTOM_TEMPLATE_KEY } from './models/EventTemplate';
import { isMatch, goalsOf, blockedEither, sharedWishes, fitEventsFor } from './buddyInvites';
import { formatWhen } from './eventNotify';
import { sendWithButtons } from './wishes';
import { escapeHtml } from './utils/telegramNotify';
import { avatarFor } from './avatars';
import { HELLO_TEXTS as T } from './texts';

/**
 * Жребий «кто пишет первым». После взаимного 👋 большинство ждёт, что напишет другой, и никто не пишет.
 * Поэтому при новом «На связи» сервер бросает монетку: одному «первым пишешь ты», второму «первым пишет {имя}».
 * Выпасть может только тому, чьему собеседнику есть куда написать (у собеседника есть @username).
 *
 * «✍️ Что написать» открывает приложение (?user={id}&hello=1): шторка с тремя готовыми фразами
 * из общего (желания, сходки, интересы, район). Тап по фразе — чат t.me/{username}?text=…, сервер отмечает выбор.
 * Через сутки, если тому, кому выпало, так и не выбрал фразу, — одно сообщение второму «{имя} стесняется»
 */

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NUDGE_AFTER = DAY;
const NUDGE_WINDOW = 3 * DAY; // старые жребии (например, сервер лежал) не догоняем

const pairFilter = (a: number, b: number) => ({
  $or: [
    { fromTelegramId: a, toTelegramId: b },
    { fromTelegramId: b, toTelegramId: a }
  ]
});

/**
 * Бросить монетку для новой пары. Возвращает telegramId того, кто пишет первым, или null —
 * если @username нет у обоих (написать некому, остаются сообщения «заведи имя пользователя»)
 */
export async function tossCoin(a: IUser, b: IUser): Promise<number | null> {
  const candidates: number[] = [];
  if (b.username) candidates.push(a.telegramId); // a сможет написать b
  if (a.username) candidates.push(b.telegramId);
  if (!candidates.length) return null;
  const first = candidates[Math.floor(Math.random() * candidates.length)];
  await Reaction.updateMany(
    { ...pairFilter(a.telegramId, b.telegramId), type: 'like' },
    { $set: { firstMove: first, firstMoveAt: new Date() }, $unset: { helloNudgeAt: 1 } }
  );
  return first;
}

// Строка про монетку для сообщения «Вы на связи!»
export const coinLine = (toId: number, first: number | null, otherName: string) =>
  first === null ? '' : first === toId ? T.coinMe : T.coinThem(otherName);

export const helloPath = (friendId: number) => `?user=${friendId}&hello=1`;

const shuffle = <V>(list: V[]) => {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

// Три фразы: сначала из общего, остальное — универсальные шутливые
export async function helloPhrases(me: IUser, friend: IUser): Promise<string[]> {
  const out: string[] = [];
  const wishes = await sharedWishes(me.telegramId, friend.telegramId).catch(() => []);
  if (wishes[0]) out.push(T.wish(wishes[0].what, wishes[0].when));
  const pick = (await fitEventsFor(me, friend, 50).catch(() => [])).find(({ ev, bothLike }) => bothLike && ev.templateId && ev.templateId !== CUSTOM_TEMPLATE_KEY);
  if (pick) out.push(T.event(pick.ev.title, formatWhen(pick.ev.dateTime)));
  const mine = new Set(goalsOf(me));
  const common = shuffle(goalsOf(friend).filter((g) => mine.has(g) && g !== 'other' && T.goals[g]));
  if (common[0] && out.length < 3) out.push(T.goals[common[0]]);
  const area = me.areaName && me.areaName === friend.areaName && !me.isTourist && !friend.isTourist && me.areaName !== 'Минск' ? me.areaName : '';
  if (area && out.length < 3) out.push(T.area(area));
  for (const p of shuffle(T.universal)) {
    if (out.length >= 3) break;
    out.push(p);
  }
  return out.slice(0, 3);
}

/* ---------- Через сутки тишины ---------- */

async function nudgeSilentPairs() {
  const now = Date.now();
  // Записи того, кому выпало писать: он не выбрал фразу, сутки прошли, второму ещё не писали
  const due = await Reaction.find({
    type: 'like',
    firstMoveAt: { $lte: new Date(now - NUDGE_AFTER), $gte: new Date(now - NUDGE_WINDOW) },
    helloNudgeAt: { $exists: false },
    helloPickedAt: { $exists: false },
    $expr: { $eq: ['$fromTelegramId', '$firstMove'] }
  })
    .limit(100)
    .lean();
  for (const r of due) {
    const shyId = r.fromTelegramId;
    const otherId = r.toTelegramId;
    // Помечаем пару сразу: даже если не дойдёт, второй раз не пишем
    const claimed = await Reaction.updateMany({ ...pairFilter(shyId, otherId), helloNudgeAt: { $exists: false } }, { $set: { helloNudgeAt: new Date() } });
    if (!claimed.modifiedCount) continue;
    // Второй сам уже выбрал фразу — напоминать нечего
    const back = await Reaction.findOne({ fromTelegramId: otherId, toTelegramId: shyId, type: 'like' }).lean();
    if (!back || back.helloPickedAt) continue;
    const [shy, other] = await Promise.all([User.findOne({ telegramId: shyId }), User.findOne({ telegramId: otherId })]);
    if (!shy || !other || !shy.username || other.isBanned || shy.isBanned || other.canMessage === false || blockedEither(shy, other)) continue;
    const sent = await sendWithButtons(otherId, T.nudge(`<b>${escapeHtml(shy.firstName)}</b>`), [[{ text: T.helloBtn, path: helloPath(shyId) }]]).catch(() => false);
    if (sent) await Reaction.updateOne({ fromTelegramId: otherId, toTelegramId: shyId }, { $set: { helloNudgeSent: true } });
    await new Promise((res) => setTimeout(res, 60));
  }
}

export function startHelloLoop() {
  const run = () => nudgeSilentPairs().catch((err) => console.warn('⚠️ Жребий, напоминание:', err?.message || err));
  setTimeout(run, 2 * 60 * 1000);
  setInterval(run, 15 * 60 * 1000).unref();
}

/* ---------- Для приложения ---------- */

async function pairOrError(myId: number, friendId: number): Promise<{ me: IUser; friend: IUser } | { status: number; error: string }> {
  if (!Number.isSafeInteger(friendId) || friendId === myId) return { status: 400, error: T.notMatch };
  const [me, friend] = await Promise.all([User.findOne({ telegramId: myId }), User.findOne({ telegramId: friendId })]);
  if (!me || !friend || friend.isBanned || blockedEither(me, friend) || !(await isMatch(myId, friendId))) return { status: 403, error: T.notMatch };
  return { me, friend };
}

export function setupHelloRoutes(app: Express) {
  const auth = telegramAuthMiddleware as any;

  // Шторка «✍️ Что написать»: три фразы и куда писать
  app.get('/api/hello/:friendId', auth, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const myId = req.telegramUser!.id;
      const pair = await pairOrError(myId, Number(req.params.friendId));
      if ('error' in pair) return res.status(pair.status).json({ error: pair.error });
      const { me, friend } = pair;
      if (!friend.username) return res.status(409).json({ error: T.noUsername(friend.firstName) });
      const mine = await Reaction.findOneAndUpdate(
        { fromTelegramId: myId, toTelegramId: friend.telegramId, type: 'like' },
        { $set: { helloOpenedAt: new Date() } },
        { new: true }
      ).lean();
      res.json({
        friend: { telegramId: friend.telegramId, firstName: friend.firstName, username: friend.username, avatarUrl: friend.photosHidden ? '' : avatarFor(friend.telegramId, friend.avatarUrl) },
        firstMoveAt: mine?.firstMoveAt || null,
        phrases: await helloPhrases(me, friend),
        firstMove: mine?.firstMove ? (mine.firstMove === myId ? 'me' : 'them') : null
      });
    } catch (err: any) {
      console.warn('⚠️ /api/hello:', err?.message || err);
      res.status(500).json({ error: 'Не получилось придумать фразы' });
    }
  });

  // Выбрал фразу и ушёл в чат
  app.post('/api/hello/:friendId/pick', auth, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const myId = req.telegramUser!.id;
      const friendId = Number(req.params.friendId);
      if (!Number.isSafeInteger(friendId)) return res.sendStatus(400);
      await Reaction.updateOne({ fromTelegramId: myId, toTelegramId: friendId, type: 'like' }, { $set: { helloPickedAt: new Date() } });
      res.json({ ok: true });
    } catch {
      res.status(500).json({ error: 'Не получилось' });
    }
  });
}

/* ---------- /stats ---------- */

export async function helloStatsLines(): Promise<string[]> {
  const week = new Date(Date.now() - 7 * DAY);
  const [tossedRecords, opened, pickedChosen, pickedOther, nudgedRecords] = await Promise.all([
    Reaction.countDocuments({ firstMoveAt: { $gte: week } }),
    Reaction.countDocuments({ helloOpenedAt: { $gte: week } }),
    Reaction.countDocuments({ helloPickedAt: { $gte: week }, firstMove: { $exists: true }, $expr: { $eq: ['$fromTelegramId', '$firstMove'] } }),
    Reaction.countDocuments({ helloPickedAt: { $gte: week }, firstMove: { $exists: true }, $expr: { $ne: ['$fromTelegramId', '$firstMove'] } }),
    Reaction.countDocuments({ helloNudgeAt: { $gte: week }, helloNudgeSent: true })
  ]);
  if (!tossedRecords && !opened) return [];
  // Жребий стоит у обеих записей пары — пар вдвое меньше; «дошло» — только у записи получателя
  return [T.statsTitle, T.stats(Math.round(tossedRecords / 2), opened, pickedChosen, pickedOther, nudgedRecords)];
}
