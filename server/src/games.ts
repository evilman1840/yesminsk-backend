import { Express, Response } from 'express';
import { Schema, model, Types } from 'mongoose';
import { telegramAuthMiddleware, AuthenticatedRequest } from './middleware/telegramAuth';
import { User } from './models/User';
import { avatarFor } from './avatars';
import { preferencesAllow } from './preferences';
import { sendWithButtons } from './wishes';
import { escapeHtml } from './utils/telegramNotify';
import { isAdmin } from './news';

/**
 * Мини-игры: «Пять в ряд» (крестики-нолики на поле 10×10).
 *
 * Как играют:
 *   • с ботом — целиком в приложении, сервер не нужен;
 *   • со случайным игроком — партия «вживую»: оба на экране, ходы по очереди. Подбор — по анкете
 *     (кого человек готов видеть в «С кем хочу общаться», общие интересы, район). Инкогнито — без подбора
 *     по анкете, и соперник не видит ни имени, ни фото;
 *   • со знакомым — по ссылке-приглашению. Можно ходить с паузами: бот напишет «Твой ход».
 *
 * Общение в игре — только готовые эмодзи и фразы, без свободного чата.
 * Не инкогнито — соперник может открыть анкету и нажать 👋 «Пообщаться», как обычно.
 */

export const BOARD = 10;
const CELLS = BOARD * BOARD;
const WIN = 5;

const SEARCH_STALE_MS = 15 * 1000;      // ищущий не спрашивал о партии 15 секунд — закрыл приложение
const LIVE_LEFT_MS = 45 * 1000;         // случайный соперник пропал на 45 секунд — ушёл, победа за тобой
const INVITE_EXPIRE_MS = 3 * 24 * 60 * 60 * 1000; // партия со знакомым: 3 дня без ходов — закрываем
const INVITE_WAIT_MS = 24 * 60 * 60 * 1000;       // приглашение никто не принял за сутки — закрываем
const NOTIFY_AWAY_MS = 30 * 1000;       // «Твой ход» от бота — если человек не заглядывал в партию 30 секунд
const REMATCH_MS = 60 * 1000;           // «Ещё партию» ждём минуту

export const GAME_EMOJIS = ['👍', '😄', '😮', '🤔', '🔥', '🙈', '👏', '🤝'];
export const GAME_PHRASES: Record<string, string> = {
  hi: 'Привет! 👋',
  nice: 'Хороший ход!',
  think: 'Дай подумать…',
  oops: 'Ой 🙈',
  gg: 'Хорошая игра!',
  again: 'Ещё разок?'
};

// Ник в инкогнито: зверёк, один на партию
const INCOGNITO_NICKS = [
  ['🦊', 'Лиса'], ['🦉', 'Сова'], ['🐻', 'Мишка'], ['🦔', 'Ёжик'], ['🐼', 'Панда'], ['🐨', 'Коала'],
  ['🦝', 'Енот'], ['🐸', 'Лягушка'], ['🐧', 'Пингвин'], ['🦦', 'Выдра'], ['🐢', 'Черепаха'], ['🦫', 'Бобр']
];

interface Player {
  telegramId: number;
  incognito: boolean;
  firstName: string;
  avatar: string;
  nick: string;      // для инкогнито
  nickEmoji: string;
  seenAt: Date;
  notifiedAt?: Date;
  rematch?: boolean;
}

const PlayerSchema = new Schema(
  {
    telegramId: { type: Number, required: true },
    incognito: { type: Boolean, default: false },
    firstName: { type: String, default: '' },
    avatar: { type: String, default: '' },
    nick: { type: String, default: '' },
    nickEmoji: { type: String, default: '' },
    seenAt: { type: Date, default: Date.now },
    notifiedAt: { type: Date },
    rematch: { type: Boolean }
  },
  { _id: false }
);

const GameMatch = model(
  'GameMatch',
  new Schema(
    {
      game: { type: String, default: 'five', index: true },
      mode: { type: String, enum: ['random', 'invite'], required: true },
      status: { type: String, enum: ['searching', 'waiting', 'active', 'finished', 'cancelled'], required: true, index: true },
      inviteCode: { type: String, index: true, sparse: true },
      players: { type: [PlayerSchema], default: [] }, // [0] ходит крестиками и первым
      board: { type: String, default: () => '.'.repeat(CELLS) },
      turn: { type: Number, default: 0 },
      moves: { type: Number, default: 0 },
      lastMove: { type: Number, default: -1 },
      lastMoveAt: { type: Date },
      winner: { type: Number, default: -1 }, // индекс игрока, -1 — нет (ничья или не закончена)
      winLine: { type: [Number], default: undefined },
      reason: { type: String },
      finishedAt: { type: Date },
      say: { from: Number, text: String, at: Date },
      nextId: { type: Schema.Types.ObjectId }, // «Ещё партию»: куда перейти
      // Подбор по анкете: что о ищущем знаем заранее, чтобы не грузить анкеты на каждый опрос
      seek: {
        gender: String,
        age: Number,
        preferredGender: String,
        preferredAgeRange: { min: Number, max: Number },
        goals: [String],
        areaName: String,
        blockedUsers: [Number]
      }
    },
    { timestamps: true }
  ).index({ status: 1, mode: 1, createdAt: 1 }).index({ 'players.telegramId': 1, status: 1 })
);

// ---------- Правила ----------

const DIRS = [[0, 1], [1, 0], [1, 1], [1, -1]];

// Пять (или больше) в ряд через клетку cell — возвращает линию, иначе null
export function winLineAt(board: string, cell: number): number[] | null {
  const mark = board[cell];
  if (mark === '.') return null;
  const r0 = Math.floor(cell / BOARD), c0 = cell % BOARD;
  for (const [dr, dc] of DIRS) {
    const line = [cell];
    for (const sign of [1, -1]) {
      let r = r0 + dr * sign, c = c0 + dc * sign;
      while (r >= 0 && r < BOARD && c >= 0 && c < BOARD && board[r * BOARD + c] === mark) {
        line.push(r * BOARD + c);
        r += dr * sign;
        c += dc * sign;
      }
    }
    if (line.length >= WIN) return line.sort((a, b) => a - b);
  }
  return null;
}

// ---------- Вспомогательное ----------

const randomNick = (taken?: string) => {
  const free = INCOGNITO_NICKS.filter(([, n]) => n !== taken);
  return free[Math.floor(Math.random() * free.length)];
};

async function makePlayer(telegramId: number, incognito: boolean, takenNick?: string): Promise<Player> {
  const u: any = await User.findOne({ telegramId }, { firstName: 1, avatarUrl: 1, photosHidden: 1 }).lean();
  const [nickEmoji, nick] = randomNick(takenNick);
  return {
    telegramId,
    incognito,
    firstName: u?.firstName || 'Игрок',
    avatar: u && !u.photosHidden ? avatarFor(telegramId, u.avatarUrl) : '',
    nick,
    nickEmoji,
    seenAt: new Date()
  };
}

const meIndex = (m: any, telegramId: number) => m.players.findIndex((p: any) => p.telegramId === telegramId);

// Партия глазами игрока: о сопернике в инкогнито — только ник
function view(m: any, telegramId: number) {
  const me = meIndex(m, telegramId);
  return {
    id: String(m._id),
    game: m.game,
    mode: m.mode,
    status: m.status,
    inviteCode: m.status === 'waiting' && me === 0 ? m.inviteCode : undefined,
    board: m.board,
    size: BOARD,
    turn: m.turn,
    me,
    moves: m.moves,
    lastMove: m.lastMove,
    winner: m.winner,
    winLine: m.winLine,
    reason: m.reason,
    say: m.say?.at && Date.now() - new Date(m.say.at).getTime() < 8000 ? { from: m.say.from, text: m.say.text, at: m.say.at } : undefined,
    nextId: m.nextId ? String(m.nextId) : undefined,
    players: m.players.map((p: any, i: number) => {
      // В инкогнито и себе показываем зверька: так ты видишь себя глазами соперника
      return {
        incognito: p.incognito,
        telegramId: p.incognito && i !== me ? undefined : p.telegramId,
        name: p.incognito ? p.nick : p.firstName,
        avatar: p.incognito ? '' : p.avatar,
        emoji: p.incognito ? p.nickEmoji : '',
        rematch: Boolean(p.rematch),
        online: Date.now() - new Date(p.seenAt).getTime() < 20 * 1000
      };
    }),
    updatedAt: m.updatedAt
  };
}

// Подходят ли двое друг другу для подбора по анкете
function compatible(a: any, aIncognito: boolean, b: any, bIncognito: boolean): boolean {
  const aId = a.telegramId, bId = b.telegramId;
  if (aId === bId) return false;
  // Заблокировал — не сводим никогда, даже в инкогнито
  if ((a.blockedUsers || []).includes(bId) || (b.blockedUsers || []).includes(aId)) return false;
  // Кто-то в инкогнито — подбор по анкете не нужен: имени и фото никто не увидит
  if (aIncognito || bIncognito) return true;
  return preferencesAllow(a, b) && preferencesAllow(b, a);
}

// Чем больше общего, тем раньше сводим
function closeness(a: any, b: any): number {
  const shared = (a.goals || []).filter((g: string) => (b.goals || []).includes(g)).length;
  return shared * 2 + (a.areaName && a.areaName === b.areaName && a.areaName !== 'Минск' ? 3 : 0);
}

// Партия устарела: соперник ушёл, приглашение никто не принял и т.п. Закрываем при чтении
async function settle(m: any): Promise<any> {
  const now = Date.now();
  let update: any = null;
  if (m.status === 'searching' && now - new Date(m.players[0].seenAt).getTime() > SEARCH_STALE_MS) {
    update = { status: 'cancelled' };
  } else if (m.status === 'waiting' && now - new Date(m.createdAt).getTime() > INVITE_WAIT_MS) {
    update = { status: 'cancelled' };
  } else if (m.status === 'active' && m.mode === 'random') {
    const gone = m.players.findIndex((p: any) => now - new Date(p.seenAt).getTime() > LIVE_LEFT_MS);
    if (gone >= 0) update = { status: 'finished', winner: 1 - gone, reason: 'left', finishedAt: new Date() };
  } else if (m.status === 'active' && m.mode === 'invite') {
    const last = new Date(m.lastMoveAt || m.updatedAt).getTime();
    if (now - last > INVITE_EXPIRE_MS) update = { status: 'finished', winner: m.moves ? 1 - m.turn : -1, reason: 'expired', finishedAt: new Date() };
  }
  if (!update) return m;
  return (await GameMatch.findOneAndUpdate({ _id: m._id, status: m.status }, { $set: update }, { new: true }).lean()) || (await GameMatch.findById(m._id).lean());
}

const seekProfile = (u: any) => ({
  gender: u?.gender,
  age: u?.age,
  preferredGender: u?.preferredGender,
  preferredAgeRange: u?.preferredAgeRange,
  goals: u?.goals?.length ? u.goals : u?.goal ? [u.goal] : [],
  areaName: u?.areaName,
  blockedUsers: u?.blockedUsers || []
});

/**
 * Подбор: ищем самого подходящего среди тех, кто уже ждёт. Нашли — садимся к нему (он ходит первым или нет — случайно).
 * Не нашли — ждём сами. Повторяем на каждом опросе: двое могли встать в очередь одновременно и не увидеть друг друга
 */
async function tryPair(mine: any): Promise<any | null> {
  const me = mine.players[0];
  const others = await GameMatch.find({
    _id: { $ne: mine._id },
    game: mine.game,
    mode: 'random',
    status: 'searching',
    'players.0.seenAt': { $gte: new Date(Date.now() - SEARCH_STALE_MS) },
    'players.0.telegramId': { $ne: me.telegramId }
  })
    .sort({ createdAt: 1 })
    .limit(50)
    .lean();
  const mySeek = { ...mine.seek, telegramId: me.telegramId };
  const fits = others
    .filter((o: any) => compatible(mySeek, me.incognito, { ...o.seek, telegramId: o.players[0].telegramId }, o.players[0].incognito))
    .map((o: any) => ({ o, score: me.incognito || o.players[0].incognito ? 0 : closeness(mySeek, o.seek) }))
    .sort((a, b) => b.score - a.score);
  if (!fits.length) return null;

  // Сначала снимаем свою заявку: если её уже кто-то занял — играем там
  const released = await GameMatch.findOneAndUpdate({ _id: mine._id, status: 'searching' }, { $set: { status: 'cancelled' } });
  if (!released) return GameMatch.findById(mine._id).lean();

  for (const { o } of fits) {
    const guest = { ...me, seenAt: new Date() };
    if (guest.incognito && guest.nick === o.players[0].nick) [guest.nickEmoji, guest.nick] = randomNick(o.players[0].nick);
    const players = Math.random() < 0.5 ? [o.players[0], guest] : [guest, o.players[0]];
    const taken = await GameMatch.findOneAndUpdate(
      { _id: o._id, status: 'searching' },
      { $set: { status: 'active', players, turn: 0, lastMoveAt: new Date() } },
      { new: true }
    ).lean();
    if (taken) return taken;
  }
  // Пока перебирали, всех разобрали — встаём в очередь снова
  await GameMatch.updateOne({ _id: mine._id }, { $set: { status: 'searching', 'players.0.seenAt': new Date() } });
  return null;
}

// «Твой ход» от бота: партия со знакомым, человек давно не заглядывал
async function notifyTurn(m: any) {
  if (m.mode !== 'invite' || m.status !== 'active') return;
  const p = m.players[m.turn];
  const other = m.players[1 - m.turn];
  if (!p || Date.now() - new Date(p.seenAt).getTime() < NOTIFY_AWAY_MS) return;
  if (p.notifiedAt && new Date(p.notifiedAt).getTime() > new Date(p.seenAt).getTime()) return; // уже писали, человек ещё не заходил
  const u: any = await User.findOne({ telegramId: p.telegramId }, { canMessage: 1 }).lean();
  if (u?.canMessage === false) return;
  await GameMatch.updateOne({ _id: m._id }, { $set: { [`players.${m.turn}.notifiedAt`]: new Date() } });
  const name = other.incognito ? `${other.nickEmoji} ${other.nick}` : other.firstName;
  sendWithButtons(p.telegramId, `🎲 Твой ход в «Пять в ряд»! <b>${escapeHtml(name)}</b> ждёт`, [[{ text: '🎲 Сходить', path: `?game=${m._id}` }]]).catch(() => {});
}

// Ход закончил партию? Крестики — у игрока 0, нолики — у игрока 1
function finishIfOver(board: string, cell: number): any {
  const line = winLineAt(board, cell);
  if (line) return { status: 'finished', winner: board[cell] === 'x' ? 0 : 1, winLine: line, reason: 'win', finishedAt: new Date() };
  if (!board.includes('.')) return { status: 'finished', winner: -1, reason: 'draw', finishedAt: new Date() };
  return null;
}

// Пока игры проверяет автор: искать соперника и звать знакомых могут только админы.
// По ссылке-приглашению от админа сыграть может любой. Открыть всем — GAMES_OPEN=1 на сервере
const canStart = (telegramId: number) => process.env.GAMES_OPEN === '1' || isAdmin(telegramId);
const CLOSED = 'Игры скоро появятся 🎲';

const inviteCode = () => Math.random().toString(36).slice(2, 8) + Math.random().toString(36).slice(2, 6);

// ---------- Маршруты ----------

export function setupGameRoutes(app: Express) {
  const auth = telegramAuthMiddleware as any;

  // Встать в поиск случайного соперника. incognito — без подбора по анкете и без имени/фото
  app.post('/api/games/search', auth, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const myId = req.telegramUser!.id;
      if (!canStart(myId)) return res.status(403).json({ error: CLOSED });
      const incognito = Boolean(req.body?.incognito);
      // Уже в живой партии — возвращаем её (например, приложение перезапустили)
      const live: any = await GameMatch.findOne({ mode: 'random', status: { $in: ['searching', 'active'] }, 'players.telegramId': myId }).sort({ createdAt: -1 }).lean();
      if (live) {
        const s = await settle(live);
        if (s.status === 'active') return res.json(view(s, myId));
        if (s.status === 'searching') await GameMatch.updateOne({ _id: s._id }, { $set: { status: 'cancelled' } });
      }
      const u: any = await User.findOne({ telegramId: myId }, { gender: 1, age: 1, preferredGender: 1, preferredAgeRange: 1, goals: 1, goal: 1, areaName: 1, blockedUsers: 1, hasAgreedToRules: 1 }).lean();
      if (!u?.hasAgreedToRules) return res.status(403).json({ error: 'Сначала прими правила «ГУЛЯЙ!»' });
      const me = await makePlayer(myId, incognito);
      const mine: any = (await GameMatch.create({ mode: 'random', status: 'searching', players: [me], seek: seekProfile(u) })).toObject();
      const paired = await tryPair(mine);
      res.json(view(paired || mine, myId));
    } catch (err: any) {
      console.warn('⚠️ Игры, поиск:', err?.message || err);
      res.status(500).json({ error: 'Не получилось начать поиск' });
    }
  });

  // Позвать знакомого: партия ждёт, пока он откроет ссылку
  app.post('/api/games/invite', auth, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const myId = req.telegramUser!.id;
      if (!canStart(myId)) return res.status(403).json({ error: CLOSED });
      const waiting = await GameMatch.countDocuments({ mode: 'invite', status: 'waiting', 'players.0.telegramId': myId });
      if (waiting >= 5) return res.status(429).json({ error: 'У тебя уже 5 приглашений ждут ответа. Отмени старые или подожди, пока примут' });
      const me = await makePlayer(myId, Boolean(req.body?.incognito));
      const m: any = (await GameMatch.create({ mode: 'invite', status: 'waiting', inviteCode: inviteCode(), players: [me] })).toObject();
      res.json(view(m, myId));
    } catch (err: any) {
      console.warn('⚠️ Игры, приглашение:', err?.message || err);
      res.status(500).json({ error: 'Не получилось создать приглашение' });
    }
  });

  // Открыли ссылку-приглашение
  app.post('/api/games/join/:code', auth, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const myId = req.telegramUser!.id;
      const code = String(req.params.code || '').slice(0, 20);
      const m: any = await GameMatch.findOne({ inviteCode: code }).lean();
      if (!m) return res.status(404).json({ error: 'Приглашение не найдено' });
      if (meIndex(m, myId) >= 0) return res.json(view(await settle(m), myId)); // своё приглашение или уже играем
      if (m.status !== 'waiting') return res.status(410).json({ error: 'Эту партию уже начали или отменили' });
      const host: any = await User.findOne({ telegramId: m.players[0].telegramId }, { blockedUsers: 1 }).lean();
      const meUser: any = await User.findOne({ telegramId: myId }, { blockedUsers: 1 }).lean();
      if (host?.blockedUsers?.includes(myId) || meUser?.blockedUsers?.includes(m.players[0].telegramId)) return res.status(404).json({ error: 'Приглашение не найдено' });
      const guest = await makePlayer(myId, Boolean(req.body?.incognito), m.players[0].nick);
      const players = Math.random() < 0.5 ? [m.players[0], guest] : [guest, m.players[0]];
      const started: any = await GameMatch.findOneAndUpdate({ _id: m._id, status: 'waiting' }, { $set: { status: 'active', players, lastMoveAt: new Date() } }, { new: true }).lean();
      if (!started) return res.status(410).json({ error: 'Эту партию уже начали' });
      notifyTurn(started).catch(() => {}); // хозяин ходит первым и ушёл из приложения — бот позовёт
      res.json(view(started, myId));
    } catch (err: any) {
      console.warn('⚠️ Игры, вход по приглашению:', err?.message || err);
      res.status(500).json({ error: 'Не получилось открыть приглашение' });
    }
  });

  // Мои партии со знакомыми: идут сейчас и ждут ответа
  app.get('/api/games/mine', auth, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const myId = req.telegramUser!.id;
      const list: any[] = await GameMatch.find({ mode: 'invite', status: { $in: ['waiting', 'active'] }, 'players.telegramId': myId }).sort({ updatedAt: -1 }).limit(20).lean();
      const settled = await Promise.all(list.map(settle));
      res.json(settled.filter((m) => m.status === 'waiting' || m.status === 'active').map((m) => view(m, myId)));
    } catch {
      res.status(500).json({ error: 'Не получилось загрузить партии' });
    }
  });

  // Состояние партии. Заодно — «я на месте» и повторная попытка подобрать соперника
  app.get('/api/games/:id', auth, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const myId = req.telegramUser!.id;
      if (!Types.ObjectId.isValid(String(req.params.id))) return res.sendStatus(404);
      const i = await GameMatch.findOne({ _id: String(req.params.id), 'players.telegramId': myId }, { players: 1 }).lean().then((m: any) => (m ? meIndex(m, myId) : -1));
      if (i < 0) return res.status(404).json({ error: 'Партия не найдена' });
      let m: any = await GameMatch.findOneAndUpdate({ _id: String(req.params.id) }, { $set: { [`players.${i}.seenAt`]: new Date() } }, { new: true, timestamps: false }).lean();
      m = await settle(m);
      if (m.status === 'searching') m = (await tryPair(m)) || m;
      res.json(view(m, myId));
    } catch (err: any) {
      console.warn('⚠️ Игры, партия:', err?.message || err);
      res.status(500).json({ error: 'Не получилось загрузить партию' });
    }
  });

  // Ход
  app.post('/api/games/:id/move', auth, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const myId = req.telegramUser!.id;
      const cell = Number(req.body?.cell);
      if (!Types.ObjectId.isValid(String(req.params.id)) || !Number.isInteger(cell) || cell < 0 || cell >= CELLS) return res.status(400).json({ error: 'Такой клетки нет' });
      let m: any = await GameMatch.findOne({ _id: String(req.params.id), 'players.telegramId': myId }).lean();
      if (!m) return res.status(404).json({ error: 'Партия не найдена' });
      m = await settle(m);
      const i = meIndex(m, myId);
      if (m.status !== 'active') return res.status(409).json({ error: 'Партия уже закончилась', game: view(m, myId) });
      if (m.turn !== i) return res.status(409).json({ error: 'Сейчас ход соперника', game: view(m, myId) });
      if (m.board[cell] !== '.') return res.status(409).json({ error: 'Клетка занята', game: view(m, myId) });

      const board = m.board.slice(0, cell) + (i === 0 ? 'x' : 'o') + m.board.slice(cell + 1);
      const end = finishIfOver(board, cell);
      const set: any = { board, lastMove: cell, lastMoveAt: new Date(), turn: 1 - i, [`players.${i}.seenAt`]: new Date(), ...(end || {}) };
      // Защита от двойного нажатия: ход засчитываем, только если доска не поменялась
      const next: any = await GameMatch.findOneAndUpdate({ _id: m._id, status: 'active', board: m.board, turn: i }, { $set: set, $inc: { moves: 1 } }, { new: true }).lean();
      if (!next) return res.status(409).json({ error: 'Ход уже сделан', game: view((await GameMatch.findById(m._id).lean()) as any, myId) });
      notifyTurn(next).catch(() => {});
      res.json(view(next, myId));
    } catch (err: any) {
      console.warn('⚠️ Игры, ход:', err?.message || err);
      res.status(500).json({ error: 'Не получилось сходить' });
    }
  });

  // Эмодзи или готовая фраза сопернику
  app.post('/api/games/:id/say', auth, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const myId = req.telegramUser!.id;
      const key = String(req.body?.say || '');
      const text = GAME_EMOJIS.includes(key) ? key : GAME_PHRASES[key];
      if (!text || !Types.ObjectId.isValid(String(req.params.id))) return res.status(400).json({ error: 'Такой фразы нет' });
      const m: any = await GameMatch.findOne({ _id: String(req.params.id), 'players.telegramId': myId }, { players: 1 }).lean();
      if (!m) return res.status(404).json({ error: 'Партия не найдена' });
      const i = meIndex(m, myId);
      const next: any = await GameMatch.findOneAndUpdate({ _id: m._id }, { $set: { say: { from: i, text, at: new Date() } } }, { new: true, timestamps: false }).lean();
      res.json(view(next, myId));
    } catch {
      res.status(500).json({ error: 'Не получилось отправить' });
    }
  });

  // Сдаться / отменить поиск / отменить приглашение
  app.post('/api/games/:id/leave', auth, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const myId = req.telegramUser!.id;
      if (!Types.ObjectId.isValid(String(req.params.id))) return res.sendStatus(404);
      const m: any = await GameMatch.findOne({ _id: String(req.params.id), 'players.telegramId': myId }).lean();
      if (!m) return res.status(404).json({ error: 'Партия не найдена' });
      const i = meIndex(m, myId);
      let set: any = null;
      if (m.status === 'searching' || m.status === 'waiting') set = { status: 'cancelled' };
      else if (m.status === 'active') set = { status: 'finished', winner: 1 - i, reason: 'resign', finishedAt: new Date() };
      const next: any = set ? await GameMatch.findOneAndUpdate({ _id: m._id, status: m.status }, { $set: set }, { new: true }).lean() : m;
      res.json(view(next || m, myId));
    } catch {
      res.status(500).json({ error: 'Не получилось выйти из партии' });
    }
  });

  // «Больше не попадаться»: соперник в блок, как в анкете. Работает и с соперником в инкогнито — его id знает только сервер
  app.post('/api/games/:id/block', auth, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const myId = req.telegramUser!.id;
      if (!Types.ObjectId.isValid(String(req.params.id))) return res.sendStatus(404);
      const m: any = await GameMatch.findOne({ _id: String(req.params.id), 'players.telegramId': myId }, { players: 1, status: 1 }).lean();
      const other = m?.players.find((p: any) => p.telegramId !== myId);
      if (!other) return res.status(404).json({ error: 'Партия не найдена' });
      await User.updateOne({ telegramId: myId }, { $addToSet: { blockedUsers: other.telegramId } });
      if (m.status === 'active') await GameMatch.updateOne({ _id: m._id, status: 'active' }, { $set: { status: 'finished', winner: meIndex(m, myId), reason: 'left', finishedAt: new Date() } });
      res.json({ ok: true });
    } catch {
      res.status(500).json({ error: 'Не получилось' });
    }
  });

  // «Ещё партию» с тем же соперником: когда нажали оба — новая партия, первым ходит другой
  app.post('/api/games/:id/rematch', auth, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const myId = req.telegramUser!.id;
      if (!Types.ObjectId.isValid(String(req.params.id))) return res.sendStatus(404);
      let m: any = await GameMatch.findOne({ _id: String(req.params.id), 'players.telegramId': myId }).lean();
      if (!m) return res.status(404).json({ error: 'Партия не найдена' });
      const i = meIndex(m, myId);
      if (m.status !== 'finished') return res.status(409).json({ error: 'Партия ещё идёт' });
      if (m.nextId) return res.json(view(m, myId));
      if (m.mode === 'random' && Date.now() - new Date(m.finishedAt || m.updatedAt).getTime() > REMATCH_MS) {
        return res.status(410).json({ error: 'Соперник уже ушёл. Найдём другого?' });
      }
      m = await GameMatch.findOneAndUpdate({ _id: m._id }, { $set: { [`players.${i}.rematch`]: true, [`players.${i}.seenAt`]: new Date() } }, { new: true }).lean();
      if (m.players.every((p: any) => p.rematch) && !m.nextId) {
        const players = [m.players[1], m.players[0]].map((p: any) => ({ ...p, rematch: undefined, notifiedAt: undefined, seenAt: new Date() }));
        const created: any = await GameMatch.create({ game: m.game, mode: m.mode, status: 'active', players, lastMoveAt: new Date() });
        const linked = await GameMatch.findOneAndUpdate({ _id: m._id, nextId: { $exists: false } }, { $set: { nextId: created._id } }, { new: true }).lean();
        if (!linked) await GameMatch.deleteOne({ _id: created._id }); // второй успел первым
        else notifyTurn(created.toObject()).catch(() => {});
        m = await GameMatch.findById(m._id).lean();
      } else if (m.mode === 'invite') {
        // Знакомый мог уже закрыть приложение — бот позовёт на реванш
        const other = m.players[1 - i];
        const name = m.players[i].incognito ? `${m.players[i].nickEmoji} ${m.players[i].nick}` : m.players[i].firstName;
        if (Date.now() - new Date(other.seenAt).getTime() > NOTIFY_AWAY_MS) {
          sendWithButtons(other.telegramId, `🎲 <b>${escapeHtml(name)}</b> зовёт сыграть ещё партию в «Пять в ряд»`, [[{ text: '🎲 Сыграть', path: `?game=${m._id}` }]]).catch(() => {});
        }
      }
      res.json(view(m, myId));
    } catch (err: any) {
      console.warn('⚠️ Игры, реванш:', err?.message || err);
      res.status(500).json({ error: 'Не получилось' });
    }
  });
}
