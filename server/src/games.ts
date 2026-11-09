import { Express, Request, Response } from 'express';
import { Schema, model, Types } from 'mongoose';
import { telegramAuthMiddleware, AuthenticatedRequest } from './middleware/telegramAuth';
import { User } from './models/User';
import { avatarFor } from './avatars';
import { preferencesAllow } from './preferences';
import { sendWithButtons } from './wishes';
import { escapeHtml } from './utils/telegramNotify';
import { isAdmin } from './news';
import { recordFiveMatch, recordFiveBot } from './gameScores';

/**
 * Мини-игры: «Крестики-Нолики» на поле 10×10, пять в ряд.
 *
 * Как играют:
 *   • с ботом — целиком в приложении, сервер только считает партии для /stats;
 *   • со случайным игроком — партия «вживую»: оба на экране, ходы по очереди. Подбор — по анкете
 *     (кого человек готов видеть в «С кем хочу общаться», общие интересы, район). Инкогнито — без подбора
 *     по анкете, и соперник не видит ни имени, ни фото;
 *   • со знакомым — по ссылке-приглашению. Можно ходить с паузами: бот напишет «Твой ход».
 *
 * Общение в игре — только готовые эмодзи и фразы, без свободного чата.
 * Не инкогнито — соперник может открыть анкету и нажать 👋 «Пообщаться», как обычно.
 *
 * Нагрузка: приложение спрашивает о партии «долгим опросом» — сервер держит вопрос до 25 секунд и отвечает,
 * как только в партии что-то поменялось (у партии номер версии v). Ожидающие — в памяти этого сервера:
 * сервер один. Если когда-нибудь их станет несколько, ничего не сломается — ответ просто придёт по таймеру
 */

export const BOARD = 10;
const CELLS = BOARD * BOARD;
const WIN = 5;

const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;
const SEARCH_STALE_MS = 20 * 1000;      // ищущий не спрашивал о партии 20 секунд — закрыл приложение
const LIVE_LEFT_MS = 45 * 1000;         // соперник пропал на 45 секунд (закрыл приложение, пропала связь) — ушёл, победа за тобой
const AWAY_MS = 15 * 1000;              // свернул приложение дольше чем на 15 секунд — тоже ушёл
const HOST_GRACE_MS = 2 * MIN;          // знакомый принял приглашение, а позвавший уже не в приложении: ждём его 2 минуты
const ONLINE_MS = 35 * 1000;            // «на месте» для значка в партии
const INVITE_WAIT_MS = DAY;             // приглашение никто не принял за сутки — закрываем
const REMATCH_MS = MIN;                 // «Ещё партию» ждём минуту
const LONG_POLL_MS = 25 * 1000;         // сколько сервер держит вопрос «что нового»
const SEARCH_POLL_MS = 6 * 1000;        // в поиске — короче: заодно ещё раз пробуем подобрать пару

// Сколько хранить партии в базе (удаляет сама база по полю expireAt)
const KEEP: Record<string, number> = { searching: DAY, cancelled: DAY, waiting: 2 * DAY, active: 4 * DAY, finished: 30 * DAY };
const expireAt = (status: string) => new Date(Date.now() + (KEEP[status] || 30 * DAY));

// Ключ — что присылает приложение, значение — что увидит соперник
export const GAME_EMOJIS: Record<string, string> = {
  skull: '💀', sob: '😭', moai: '🗿', pinch: '🤌', nails: '💅', boom: '🤯', six7: '6️⃣7️⃣', fire: '🔥'
};
export const GAME_PHRASES: Record<string, string> = {
  sixseven: '67!',
  base: 'Это база',
  cringe: 'Кринж…',
  minusvibe: 'Пу-Пу-Пууу',
  nochance: 'Без шансов',
  hurt: 'Это было больно 🥀',
  onemore: 'Ещё одну и спать',
  nice: 'Хороший ход!'
};
const own = (o: Record<string, string>, k: string) => Object.prototype.hasOwnProperty.call(o, k);

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
  awayAt?: Date;     // свернул приложение
  graceUntil?: Date; // до этого времени не считаем ушедшим
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
    awayAt: { type: Date },
    graceUntil: { type: Date },
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
      v: { type: Number, default: 0 },          // версия: растёт с каждым изменением, кроме «я на месте»
      expireAt: { type: Date, default: () => expireAt('searching') },
      // Подбор по анкете: что о ищущем знаем заранее, чтобы не грузить анкеты на каждый опрос
      seek: {
        gender: String,
        age: Number,
        preferredGender: String,
        preferredAgeRange: { min: Number, max: Number },
        photoOnly: Boolean,
        hasFacePhoto: Boolean,
        photosHidden: Boolean,
        goals: [String],
        areaName: String,
        blockedUsers: [Number]
      }
    },
    { timestamps: true }
  )
    .index({ status: 1, mode: 1, createdAt: 1 })
    .index({ 'players.telegramId': 1, status: 1 })
    .index({ expireAt: 1 }, { expireAfterSeconds: 0 }) // база сама удаляет старые партии и поиски
);

// Сводка по дням для /stats: партии с ботом (считаются на телефоне) и пик игроков одновременно
const GameDay = model(
  'GameDay',
  new Schema({
    day: { type: String, unique: true }, // '2026-11-05' по Минску
    botGames: { type: Number, default: 0 },
    botPlayers: { type: [Number], default: [] },
    // Партии с живыми людьми: сами партии хранятся 30 дней, а итоги по дням — всегда (для «всего сыграно» в меню)
    humanGames: { type: Number },
    humanPlayers: { type: [Number], default: undefined },
    peak: { type: Number, default: 0 },
    peakAt: { type: Date },
    eveningSent: { type: Boolean } // «Час игр» сегодня уже позвали
  })
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

// Ход закончил партию? Крестики — у игрока 0, нолики — у игрока 1
function finishIfOver(board: string, cell: number): any {
  const line = winLineAt(board, cell);
  if (line) return { status: 'finished', winner: board[cell] === 'x' ? 0 : 1, winLine: line, reason: 'win', finishedAt: new Date(), expireAt: expireAt('finished') };
  if (!board.includes('.')) return { status: 'finished', winner: -1, reason: 'draw', finishedAt: new Date(), expireAt: expireAt('finished') };
  return null;
}

// ---------- Долгий опрос: кто ждёт новостей по партии ----------

const waiters = new Map<string, Set<() => void>>();

// В партии что-то поменялось — будим всех, кто ждёт
function changed(id: any) {
  const key = String(id);
  const set = waiters.get(key);
  if (!set) return;
  waiters.delete(key);
  set.forEach((wake) => wake());
}

// Подписаться на изменения партии заранее, до чтения из базы: так не пропустим ход, сделанный между чтением и ожиданием.
// wait(ms) — ждать не дольше ms; false — человек закрыл приложение и ответ не нужен. cancel() — не ждать.
// Смотрим на закрытие ответа (res), а не запроса: у запроса «close» в Node приходит сразу после чтения
function listen(id: string, res: Response) {
  let set = waiters.get(id);
  if (!set) waiters.set(id, (set = new Set()));
  let fired = false;
  let gone = false;
  let resolver: ((stillThere: boolean) => void) | null = null;
  let timer: NodeJS.Timeout | null = null;
  const off = () => {
    set!.delete(wake);
    if (!set!.size && waiters.get(id) === set) waiters.delete(id);
    res.off('close', onClose);
    if (timer) clearTimeout(timer);
  };
  const finish = () => {
    off();
    const r = resolver;
    resolver = null;
    r?.(!gone);
  };
  function wake() {
    fired = true;
    finish();
  }
  function onClose() {
    if (!res.writableEnded) gone = true;
    wake();
  }
  set.add(wake);
  res.on('close', onClose);
  return {
    wait: (ms: number) =>
      new Promise<boolean>((resolve) => {
        if (fired) return resolve(!gone);
        resolver = resolve;
        timer = setTimeout(finish, ms);
      }),
    cancel: off
  };
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
    v: m.v || 0,
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
        online: !p.awayAt && Date.now() - new Date(p.seenAt).getTime() < ONLINE_MS,
        away: Boolean(p.awayAt)
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

// Изменить партию: версия +1, срок хранения по новому статусу, разбудить ждущих
async function update(filter: any, set: any, extra: any = {}): Promise<any> {
  const status = set.status;
  const next: any = await GameMatch.findOneAndUpdate(
    filter,
    { ...extra, $set: { ...set, ...(status ? { expireAt: set.expireAt || expireAt(status) } : {}) }, $inc: { ...(extra.$inc || {}), v: 1 } },
    { new: true }
  ).lean();
  if (next) changed(next._id);
  // Партия только что закончилась — в личную статистику игроков
  if (next && status === 'finished' && next.players?.length === 2) {
    recordFiveMatch(next).catch((err) => console.warn('⚠️ Игры, статистика партии:', err?.message || err));
    GameDay.updateOne(
      { day: minskDay() },
      { $inc: { humanGames: 1 }, $addToSet: { humanPlayers: { $each: next.players.map((p: any) => p.telegramId) } } },
      { upsert: true }
    ).catch(() => {});
  }
  return next;
}

// С какого момента игрок считается ушедшим из партии: закрыл приложение или свернул его надолго
function leftAt(p: any): number {
  const seen = new Date(p.seenAt).getTime() + LIVE_LEFT_MS;
  const away = p.awayAt ? new Date(p.awayAt).getTime() + AWAY_MS : Infinity;
  return Math.max(p.graceUntil ? new Date(p.graceUntil).getTime() : 0, Math.min(seen, away));
}

// Партия устарела: соперник ушёл, приглашение никто не принял и т.п. Закрываем при чтении
async function settle(m: any): Promise<any> {
  const now = Date.now();
  let set: any = null;
  if (m.status === 'searching' && now - new Date(m.players[0].seenAt).getTime() > SEARCH_STALE_MS) {
    set = { status: 'cancelled' };
  } else if (m.status === 'waiting' && now - new Date(m.createdAt).getTime() > INVITE_WAIT_MS) {
    set = { status: 'cancelled' };
  } else if (m.status === 'active') {
    // Ушли оба (например, связь пропала у обоих) — победа тому, кто продержался дольше
    const gone = m.players
      .map((p: any, i: number) => ({ i, at: leftAt(p) }))
      .filter((g: any) => now > g.at)
      .sort((a: any, b: any) => a.at - b.at);
    if (gone.length) set = { status: 'finished', winner: 1 - gone[0].i, reason: 'left', finishedAt: new Date() };
  }
  if (!set) return m;
  return (await update({ _id: m._id, status: m.status }, set)) || (await GameMatch.findById(m._id).lean());
}

const seekProfile = (u: any) => ({
  gender: u?.gender,
  age: u?.age,
  preferredGender: u?.preferredGender,
  preferredAgeRange: u?.preferredAgeRange,
  photoOnly: u?.photoOnly,
  hasFacePhoto: u?.hasFacePhoto,
  photosHidden: u?.photosHidden,
  goals: u?.goals?.length ? u.goals : u?.goal ? [u.goal] : [],
  areaName: u?.areaName,
  blockedUsers: u?.blockedUsers || []
});

/**
 * Подбор: ищем самого подходящего среди тех, кто уже ждёт. Нашли — садимся к нему (кто ходит первым — случайно).
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
  const released = await GameMatch.findOneAndUpdate({ _id: mine._id, status: 'searching' }, { $set: { status: 'cancelled', expireAt: expireAt('cancelled') } });
  if (!released) return GameMatch.findById(mine._id).lean();

  for (const { o } of fits) {
    const guest = { ...me, seenAt: new Date() };
    if (guest.incognito && guest.nick === o.players[0].nick) [guest.nickEmoji, guest.nick] = randomNick(o.players[0].nick);
    const players = Math.random() < 0.5 ? [o.players[0], guest] : [guest, o.players[0]];
    const taken = await update({ _id: o._id, status: 'searching' }, { status: 'active', players, turn: 0, lastMoveAt: new Date() });
    if (taken) return taken;
  }
  // Пока перебирали, всех разобрали — встаём в очередь снова
  await GameMatch.updateOne({ _id: mine._id }, { $set: { status: 'searching', expireAt: expireAt('searching'), 'players.0.seenAt': new Date() } });
  return null;
}

const inviteCode = () => Math.random().toString(36).slice(2, 8) + Math.random().toString(36).slice(2, 6);

// Пока игры проверяет автор: искать соперника и звать знакомых могут только админы.
// По ссылке-приглашению от админа сыграть может любой. Открыть всем — GAMES_OPEN=1 на сервере
const canStart = (telegramId: number) => process.env.GAMES_OPEN === '1' || isAdmin(telegramId);
const CLOSED = 'Игры скоро появятся 🎲';

// «Я на месте» и сама партия — одним запросом к базе
// back — человек снова смотрит на партию: снимаем «свернул», сопернику об этом сообщаем
async function touch(id: string, telegramId: number, back = true): Promise<any> {
  const m: any = await GameMatch.findOneAndUpdate({ _id: id, 'players.telegramId': telegramId }, { $set: { 'players.$.seenAt': new Date() } }, { new: true, timestamps: false }).lean();
  if (!back || !m || m.status !== 'active' || !m.players.find((p: any) => p.telegramId === telegramId)?.awayAt) return m;
  return (await update({ _id: id, status: 'active', 'players.telegramId': telegramId }, { 'players.$.seenAt': new Date() }, { $unset: { 'players.$.awayAt': 1 } })) || m;
}

// ---------- Статистика ----------

const MINSK_OFFSET = 3 * 60 * 60 * 1000;
const minskDay = (t = Date.now()) => new Date(t + MINSK_OFFSET).toISOString().slice(0, 10);
const startOfMinskDay = () => {
  const now = Date.now();
  return new Date(now - ((now + MINSK_OFFSET) % DAY));
};

// Сколько человек сейчас в игре с людьми (ищут или играют, заглядывали за последние 40 секунд)
async function livePlayers(): Promise<number> {
  const since = new Date(Date.now() - 40 * 1000);
  const r = await GameMatch.aggregate([
    { $match: { status: { $in: ['searching', 'active'] }, updatedAt: { $gte: new Date(Date.now() - DAY) } } },
    { $unwind: '$players' },
    { $match: { 'players.seenAt': { $gte: since } } },
    { $group: { _id: '$players.telegramId' } },
    { $count: 'n' }
  ]);
  return r[0]?.n || 0;
}

// ---------- Позвать людей поиграть ----------
// Кто нажал «🔔 Позови меня»: бот пишет, когда кто-то ищет соперника, и в 21:00 — «Час игр».
// Одному человеку — не чаще раза в сутки, ночью (23:00–9:00) не пишем

const NOTIFY_GAP_MS = DAY;
const WAVE_GAP_MS = 10 * MIN;   // «кто-то ищет соперника» — волна не чаще раза в 10 минут
const WAVE_SIZE = 25;           // и не больше 25 человек за раз
export const EVENING_HOUR = 21;
let lastWaveAt = 0;
const minskHour = (t = Date.now()) => new Date(t + MINSK_OFFSET).getUTCHours();
const quietNow = () => minskHour() >= 23 || minskHour() < 9;
const sleepMs = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function callSubscribers(kind: 'wave' | 'evening', seeker?: any) {
  const since = new Date(Date.now() - NOTIFY_GAP_MS);
  const exclude = seeker ? [seeker.telegramId, ...(seeker.blockedUsers || [])] : [];
  const fresh = { $or: [{ gameNotifiedAt: { $exists: false } }, { gameNotifiedAt: { $lt: since } }] };
  const users: any[] = await User.find(
    { gameNotify: true, canMessage: { $ne: false }, telegramId: { $nin: exclude }, ...fresh },
    { telegramId: 1, blockedUsers: 1 }
  )
    .sort({ lastActiveAt: -1 })
    .limit(kind === 'wave' ? WAVE_SIZE * 2 : 1000)
    .lean();
  // Кто и так сейчас в игре — не зовём
  const busy = new Set<number>(await GameMatch.distinct('players.telegramId', { status: { $in: ['searching', 'active'] }, updatedAt: { $gte: new Date(Date.now() - 2 * MIN) } }));
  const text =
    kind === 'wave'
      ? '🎲 Кто-то прямо сейчас ищет соперника в «Крестики-Нолики». Заходи, сыграйте!'
      : `🎲 ${EVENING_HOUR}:00, час игр в ГУЛЯЙ! Вечером соперник находится быстрее. Сыграем в «Крестики-Нолики»?`;
  let sent = 0;
  for (const u of users) {
    if (kind === 'wave' && sent >= WAVE_SIZE) break;
    if (busy.has(u.telegramId) || !canStart(u.telegramId)) continue;
    if (seeker && (u.blockedUsers || []).includes(seeker.telegramId)) continue;
    // Отмечаем до отправки: два сервера или две волны одного и того же не позовут
    const claimed = await User.updateOne({ telegramId: u.telegramId, ...fresh }, { $set: { gameNotifiedAt: new Date() } });
    if (!claimed.modifiedCount) continue;
    await sendWithButtons(u.telegramId, text, [[{ text: '🎲 Играть', path: '?tab=games' }], [{ text: '🔕 Больше не звать', data: 'games:off' }]]).catch(() => false);
    sent++;
    await sleepMs(50); // Telegram: не больше ~30 сообщений в секунду
  }
  if (sent) console.log(`🎲 Игры: позвал поиграть (${kind}) — ${sent} чел.`);
}

// Ищет соперника, а никого нет — зовём подписавшихся
function callForSeeker(seeker: any) {
  if (quietNow() || Date.now() - lastWaveAt < WAVE_GAP_MS) return;
  lastWaveAt = Date.now();
  callSubscribers('wave', seeker).catch((err) => console.warn('⚠️ Игры, позвать поиграть:', err?.message || err));
}

// Кнопка «🔕 Больше не звать» под сообщением бота
export async function handleGameCallback(q: any): Promise<boolean> {
  if (q?.data !== 'games:off') return false;
  await User.updateOne({ telegramId: q.from?.id }, { $set: { gameNotify: false } });
  await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callback_query_id: q.id, text: 'Больше не позову. Включить снова можно в «Играх»' })
  }).catch(() => null);
  return true;
}

// Сколько людей сейчас в играх — для счётчика в меню. Считаем не чаще раза в 5 секунд на всех
// За всё время: сколько партий сыграно в приложении (с людьми и с ботом) и сколько человек играли с живыми людьми.
// Складываем итоги по дням; считаем не чаще раза в минуту
let totalsCache: { at: number; games: number; livePlayers: number } | null = null;
async function allTimeTotals() {
  if (totalsCache && Date.now() - totalsCache.at < MIN) return totalsCache;
  const [sums, people] = await Promise.all([
    GameDay.aggregate([{ $group: { _id: null, human: { $sum: { $ifNull: ['$humanGames', 0] } }, bot: { $sum: '$botGames' } } }]),
    GameDay.aggregate([{ $unwind: '$humanPlayers' }, { $group: { _id: '$humanPlayers' } }, { $count: 'n' }])
  ]);
  totalsCache = { at: Date.now(), games: (sums[0]?.human || 0) + (sums[0]?.bot || 0), livePlayers: people[0]?.n || 0 };
  return totalsCache;
}

// Один раз: итоги по дням для партий, сыгранных до того, как их стали считать (из тех, что ещё хранятся)
async function backfillHumanDays() {
  const days: any[] = await GameMatch.aggregate([
    { $match: { status: 'finished', 'players.1': { $exists: true } } },
    { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: { $ifNull: ['$finishedAt', '$updatedAt'] }, timezone: 'Europe/Minsk' } }, n: { $sum: 1 }, ids: { $push: '$players.telegramId' } } }
  ]);
  for (const d of days) {
    const ids = [...new Set(d.ids.flat())];
    // Уже посчитанные дни не трогаем; дня в базе нет — создаём (если создать не вышло, значит, его уже считают)
    await GameDay.updateOne({ day: d._id, humanGames: { $exists: false } }, { $set: { humanGames: d.n, humanPlayers: ids } }, { upsert: true }).catch(() => {});
  }
}

let lobbyCache: { at: number; searching: number; playing: number; today: number } | null = null;
async function lobbyCounts() {
  if (lobbyCache && Date.now() - lobbyCache.at < 5000) return lobbyCache;
  const fresh = new Date(Date.now() - 40 * 1000);
  const today = startOfMinskDay();
  const [searching, active, human, day] = await Promise.all([
    GameMatch.countDocuments({ status: 'searching', 'players.0.seenAt': { $gte: new Date(Date.now() - SEARCH_STALE_MS) } }),
    GameMatch.find({ status: 'active', updatedAt: { $gte: new Date(Date.now() - DAY) } }, { players: 1 }).lean(),
    GameMatch.countDocuments({ status: { $in: ['active', 'finished'] }, createdAt: { $gte: today } }),
    GameDay.findOne({ day: minskDay() }, { botGames: 1 }).lean() as any
  ]);
  const playing = active.reduce((n: number, m: any) => n + m.players.filter((p: any) => new Date(p.seenAt) >= fresh).length, 0);
  lobbyCache = { at: Date.now(), searching, playing, today: human + (day?.botGames || 0) };
  return lobbyCache;
}

// «Час игр» в 21:00 по Минску — один раз за день
async function eveningCall() {
  const t = new Date(Date.now() + MINSK_OFFSET);
  if (t.getUTCHours() !== EVENING_HOUR || t.getUTCMinutes() > 10) return;
  const day = minskDay();
  // Только один сервер и один раз: кто первым поставил отметку, тот и зовёт
  const doc = await GameDay.findOneAndUpdate({ day, eveningSent: { $ne: true } }, { $set: { eveningSent: true } }, { upsert: true, new: true }).catch(() => null);
  if (!doc) return;
  await callSubscribers('evening');
}

// Раз в минуту запоминаем пик за день. Заодно старым партиям без срока хранения — срок
export function startGameStatsLoop() {
  GameMatch.updateMany({ expireAt: { $exists: false } }, { $set: { expireAt: expireAt('finished') } }, { timestamps: false }).catch(() => {});
  backfillHumanDays().catch((err) => console.warn('⚠️ Игры, итоги по дням:', err?.message || err));
  const tick = async () => {
    eveningCall().catch((err) => console.warn('⚠️ Игры, час игр:', err?.message || err));
    try {
      const n = await livePlayers();
      if (!n) return;
      const day = minskDay();
      const doc: any = await GameDay.findOne({ day }, { peak: 1 }).lean();
      if (n > (doc?.peak || 0)) await GameDay.updateOne({ day }, { $set: { peak: n, peakAt: new Date() } }, { upsert: true });
    } catch (err: any) {
      console.warn('⚠️ Игры, пик игроков:', err?.message || err);
    }
  };
  setInterval(tick, MIN).unref();
}

export async function gameStatsLines(): Promise<string[]> {
  const today = startOfMinskDay();
  const [humanToday, randomToday, inviteToday, playersToday, liveNow, day, week] = await Promise.all([
    GameMatch.countDocuments({ status: { $in: ['active', 'finished'] }, createdAt: { $gte: today } }),
    GameMatch.countDocuments({ mode: 'random', status: { $in: ['active', 'finished'] }, createdAt: { $gte: today } }),
    GameMatch.countDocuments({ mode: 'invite', status: { $in: ['active', 'finished'] }, createdAt: { $gte: today } }),
    GameMatch.distinct('players.telegramId', { status: { $in: ['active', 'finished'] }, createdAt: { $gte: today } }),
    livePlayers(),
    GameDay.findOne({ day: minskDay() }).lean() as any,
    GameDay.find({ day: { $gte: minskDay(Date.now() - 6 * DAY) } }, { peak: 1 }).lean()
  ]);
  const peakWeek = Math.max(0, ...week.map((d: any) => d.peak || 0));
  const peakAt = day?.peakAt ? new Date(day.peakAt).toLocaleTimeString('ru-RU', { timeZone: 'Europe/Minsk', hour: '2-digit', minute: '2-digit' }) : '';
  return [
    `🎲 <b>Игры сегодня</b>`,
    `С людьми: партий ${humanToday} (случайный соперник ${randomToday}, знакомые ${inviteToday}), играли ${playersToday.length} чел.`,
    `С ботом: партий ${day?.botGames || 0}, играли ${day?.botPlayers?.length || 0} чел.`,
    `Сейчас с людьми: ${liveNow} · пик сегодня ${day?.peak || 0}${peakAt ? ` (в ${peakAt})` : ''} · пик за 7 дней ${peakWeek}`
  ];
}

// ---------- Маршруты ----------

export function setupGameRoutes(app: Express) {
  const auth = telegramAuthMiddleware as any;
  const validId = (req: Request) => Types.ObjectId.isValid(String(req.params.id));

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
        if (s.status === 'searching') await update({ _id: s._id, status: 'searching' }, { status: 'cancelled' });
      }
      const u: any = await User.findOne({ telegramId: myId }, { gender: 1, age: 1, preferredGender: 1, preferredAgeRange: 1, photoOnly: 1, hasFacePhoto: 1, photosHidden: 1, goals: 1, goal: 1, areaName: 1, blockedUsers: 1, hasAgreedToRules: 1 }).lean();
      if (!u?.hasAgreedToRules) return res.status(403).json({ error: 'Сначала прими правила «ГУЛЯЙ!»' });
      const me = await makePlayer(myId, incognito);
      const mine: any = (await GameMatch.create({ mode: 'random', status: 'searching', players: [me], seek: seekProfile(u), expireAt: expireAt('searching') })).toObject();
      const paired = await tryPair(mine);
      if (!paired) callForSeeker({ telegramId: myId, blockedUsers: u.blockedUsers });
      res.json(view(paired || mine, myId));
    } catch (err: any) {
      console.warn('⚠️ Игры, поиск:', err?.message || err);
      res.status(500).json({ error: 'Не получилось начать поиск' });
    }
  });

  // Меню игр: сколько людей ищут соперника и играют, сколько партий сегодня, позвать ли меня
  app.get('/api/games/lobby', auth, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const [c, all, me] = await Promise.all([lobbyCounts(), allTimeTotals().catch(() => null), User.findOne({ telegramId: req.telegramUser!.id }, { gameNotify: 1, canMessage: 1 }).lean() as any]);
      const hour = minskHour();
      res.json({
        searching: c.searching,
        playing: c.playing,
        today: c.today,
        totalGames: all?.games ?? null,
        livePlayers: all?.livePlayers ?? null,
        notify: Boolean(me?.gameNotify),
        canMessage: me?.canMessage !== false,
        eveningHour: EVENING_HOUR,
        eveningNow: hour === EVENING_HOUR
      });
    } catch {
      res.status(500).json({ error: 'Не получилось' });
    }
  });

  // «🔔 Позови меня, когда кто-то захочет сыграть»
  app.post('/api/games/notify', auth, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const on = Boolean(req.body?.on);
      await User.updateOne({ telegramId: req.telegramUser!.id }, { $set: { gameNotify: on } });
      res.json({ notify: on });
    } catch {
      res.status(500).json({ error: 'Не получилось' });
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
      const m: any = (await GameMatch.create({ mode: 'invite', status: 'waiting', inviteCode: inviteCode(), players: [me], expireAt: expireAt('waiting') })).toObject();
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
      // Позвавший, скорее всего, уже в чате с тобой: ждём его пару минут и один раз зовём ботом
      const hostP: any = { ...m.players[0], awayAt: undefined };
      const hostHere = Date.now() - new Date(hostP.seenAt).getTime() < ONLINE_MS && !m.players[0].awayAt;
      if (!hostHere) hostP.graceUntil = new Date(Date.now() + HOST_GRACE_MS);
      const players = Math.random() < 0.5 ? [hostP, guest] : [guest, hostP];
      const started: any = await update({ _id: m._id, status: 'waiting' }, { status: 'active', players, lastMoveAt: new Date() });
      if (!started) return res.status(410).json({ error: 'Эту партию уже начали' });
      if (!hostHere) {
        const u: any = await User.findOne({ telegramId: hostP.telegramId }, { canMessage: 1 }).lean();
        const name = guest.incognito ? `${guest.nickEmoji} ${guest.nick}` : guest.firstName;
        if (u?.canMessage !== false) {
          sendWithButtons(hostP.telegramId, `🎲 <b>${escapeHtml(name)}</b> уже в игре «Крестики-Нолики» и ждёт тебя. Заходи в течение пары минут`, [[{ text: '🎲 Играть', path: `?game=${started._id}` }]]).catch(() => {});
        }
      }
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

  // Сыграли с ботом — только для /stats
  app.post('/api/games/bot-played', auth, async (req: AuthenticatedRequest, res: Response) => {
    try {
      await GameDay.updateOne({ day: minskDay() }, { $inc: { botGames: 1 }, $addToSet: { botPlayers: req.telegramUser!.id } }, { upsert: true });
      await recordFiveBot(req.telegramUser!.id, Boolean(req.body?.won));
    } catch {
      /* статистика не важнее игры */
    }
    res.json({ ok: true });
  });

  /**
   * Состояние партии. Заодно — «я на месте» и повторная попытка подобрать соперника.
   * ?since=<v>&wait=1 — долгий опрос: если нового нет, ждём изменения до 25 секунд (в поиске — до 6)
   */
  app.get('/api/games/:id', auth, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const myId = req.telegramUser!.id;
      const id = String(req.params.id);
      if (!validId(req)) return res.sendStatus(404);
      const load = async (back = true) => {
        let m: any = await touch(id, myId, back);
        if (!m) return null;
        m = await settle(m);
        if (m.status === 'searching') m = (await tryPair(m)) || m;
        return m;
      };
      const since = Number(req.query.since);
      const longPoll = req.query.wait === '1' && Number.isFinite(since);
      const sub = longPoll ? listen(id, res) : null; // подписка до чтения: ход соперника не проскочит
      let m = await load();
      if (!m) {
        sub?.cancel();
        return res.status(404).json({ error: 'Партия не найдена' });
      }
      const sameGame = String(m._id) === id;
      const waitable = ['searching', 'waiting', 'active', 'finished'].includes(m.status) && !m.nextId;
      if (sub && sameGame && waitable && (m.v || 0) <= since) {
        let wait = m.status === 'searching' ? SEARCH_POLL_MS : LONG_POLL_MS;
        // Соперник свернул приложение или пропал — проснуться к моменту, когда партию пора закрыть
        if (m.status === 'active') {
          const soonest = Math.min(...m.players.filter((p: any) => p.telegramId !== myId).map(leftAt));
          wait = Math.max(1000, Math.min(wait, soonest - Date.now() + 500));
        }
        const stillThere = await sub.wait(wait);
        if (!stillThere) return; // человек закрыл приложение — отвечать некому
        m = (await load(false)) || m; // пока ждали, человек мог свернуть приложение: «вернулся» не ставим
      } else sub?.cancel();
      res.json(view(m, myId));
    } catch (err: any) {
      console.warn('⚠️ Игры, партия:', err?.message || err);
      if (!res.headersSent) res.status(500).json({ error: 'Не получилось загрузить партию' });
    }
  });

  // Ход
  app.post('/api/games/:id/move', auth, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const myId = req.telegramUser!.id;
      const cell = Number(req.body?.cell);
      if (!validId(req) || !Number.isInteger(cell) || cell < 0 || cell >= CELLS) return res.status(400).json({ error: 'Такой клетки нет' });
      let m: any = await GameMatch.findOne({ _id: String(req.params.id), 'players.telegramId': myId }).lean();
      if (!m) return res.status(404).json({ error: 'Партия не найдена' });
      m = await settle(m);
      const i = meIndex(m, myId);
      if (m.status !== 'active') return res.status(409).json({ error: 'Партия уже закончилась', game: view(m, myId) });
      if (m.turn !== i) return res.status(409).json({ error: 'Сейчас ход соперника', game: view(m, myId) });
      if (m.board[cell] !== '.') return res.status(409).json({ error: 'Клетка занята', game: view(m, myId) });

      const board = m.board.slice(0, cell) + (i === 0 ? 'x' : 'o') + m.board.slice(cell + 1);
      const end = finishIfOver(board, cell);
      const set: any = { board, lastMove: cell, lastMoveAt: new Date(), turn: 1 - i, [`players.${i}.seenAt`]: new Date(), expireAt: expireAt('active'), ...(end || {}) };
      // Защита от двойного нажатия: ход засчитываем, только если доска не поменялась
      const next: any = await update({ _id: m._id, status: 'active', board: m.board, turn: i }, set, { $inc: { moves: 1 } });
      if (!next) return res.status(409).json({ error: 'Ход уже сделан', game: view((await GameMatch.findById(m._id).lean()) as any, myId) });
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
      const text = own(GAME_EMOJIS, key) ? GAME_EMOJIS[key] : own(GAME_PHRASES, key) ? GAME_PHRASES[key] : '';
      if (!text || !validId(req)) return res.status(400).json({ error: 'Такой фразы нет' });
      const m: any = await GameMatch.findOne({ _id: String(req.params.id), 'players.telegramId': myId }, { players: 1 }).lean();
      if (!m) return res.status(404).json({ error: 'Партия не найдена' });
      const next: any = await update({ _id: m._id }, { say: { from: meIndex(m, myId), text, at: new Date() } });
      res.json(view(next, myId));
    } catch {
      res.status(500).json({ error: 'Не получилось отправить' });
    }
  });

  // Свернул приложение: через 15 секунд партия закроется, если не вернётся
  app.post('/api/games/:id/away', auth, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const myId = req.telegramUser!.id;
      if (!validId(req)) return res.sendStatus(404);
      await update({ _id: String(req.params.id), status: 'active', players: { $elemMatch: { telegramId: myId, awayAt: { $exists: false } } } }, { 'players.$.awayAt': new Date() });
      res.json({ ok: true });
    } catch {
      res.status(500).json({ error: 'Не получилось' });
    }
  });

  // Завершить игру / отменить поиск / отменить приглашение
  app.post('/api/games/:id/leave', auth, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const myId = req.telegramUser!.id;
      if (!validId(req)) return res.sendStatus(404);
      const m: any = await GameMatch.findOne({ _id: String(req.params.id), 'players.telegramId': myId }).lean();
      if (!m) return res.status(404).json({ error: 'Партия не найдена' });
      const i = meIndex(m, myId);
      let set: any = null;
      if (m.status === 'searching' || m.status === 'waiting') set = { status: 'cancelled' };
      else if (m.status === 'active') set = { status: 'finished', winner: 1 - i, reason: 'resign', finishedAt: new Date() };
      const next: any = set ? await update({ _id: m._id, status: m.status }, set) : m;
      res.json(view(next || m, myId));
    } catch {
      res.status(500).json({ error: 'Не получилось выйти из партии' });
    }
  });

  // «Больше не попадаться»: соперник в блок, как в анкете. Работает и с соперником в инкогнито — его id знает только сервер
  app.post('/api/games/:id/block', auth, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const myId = req.telegramUser!.id;
      if (!validId(req)) return res.sendStatus(404);
      const m: any = await GameMatch.findOne({ _id: String(req.params.id), 'players.telegramId': myId }, { players: 1, status: 1 }).lean();
      const other = m?.players.find((p: any) => p.telegramId !== myId);
      if (!other) return res.status(404).json({ error: 'Партия не найдена' });
      await User.updateOne({ telegramId: myId }, { $addToSet: { blockedUsers: other.telegramId } });
      if (m.status === 'active') await update({ _id: m._id, status: 'active' }, { status: 'finished', winner: meIndex(m, myId), reason: 'left', finishedAt: new Date() });
      res.json({ ok: true });
    } catch {
      res.status(500).json({ error: 'Не получилось' });
    }
  });

  // «Ещё партию» с тем же соперником: когда нажали оба — новая партия, первым ходит другой
  app.post('/api/games/:id/rematch', auth, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const myId = req.telegramUser!.id;
      if (!validId(req)) return res.sendStatus(404);
      let m: any = await GameMatch.findOne({ _id: String(req.params.id), 'players.telegramId': myId }).lean();
      if (!m) return res.status(404).json({ error: 'Партия не найдена' });
      const i = meIndex(m, myId);
      if (m.status !== 'finished') return res.status(409).json({ error: 'Партия ещё идёт' });
      if (m.nextId) return res.json(view(m, myId));
      if (m.reason === 'left' || m.reason === 'resign' || Date.now() - new Date(m.finishedAt || m.updatedAt).getTime() > REMATCH_MS) {
        return res.status(410).json({ error: 'Соперник уже ушёл. Найдём другого?' });
      }
      m = await update({ _id: m._id }, { [`players.${i}.rematch`]: true, [`players.${i}.seenAt`]: new Date() });
      if (m.players.every((p: any) => p.rematch) && !m.nextId) {
        const players = [m.players[1], m.players[0]].map((p: any) => ({ ...p, rematch: undefined, awayAt: undefined, graceUntil: undefined, seenAt: new Date() }));
        const created: any = await GameMatch.create({ game: m.game, mode: m.mode, status: 'active', players, lastMoveAt: new Date(), expireAt: expireAt('active') });
        const linked = await update({ _id: m._id, nextId: { $exists: false } }, { nextId: created._id });
        if (!linked) await GameMatch.deleteOne({ _id: created._id }); // второй успел первым
        m = await GameMatch.findById(m._id).lean();
      }
      res.json(view(m, myId));
    } catch (err: any) {
      console.warn('⚠️ Игры, реванш:', err?.message || err);
      res.status(500).json({ error: 'Не получилось' });
    }
  });
}
