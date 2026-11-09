import { Express, Request, Response } from 'express';
import { Schema, model, Types } from 'mongoose';
import { telegramAuthMiddleware, AuthenticatedRequest } from './middleware/telegramAuth';
import { User } from './models/User';
import { sendWithButtons } from './wishes';
import { escapeHtml } from './utils/telegramNotify';
import {
  DAY,
  SEARCH_STALE_MS,
  HOST_GRACE_MS,
  ONLINE_MS,
  INVITE_WAIT_MS,
  REMATCH_MS,
  LONG_POLL_MS,
  SEARCH_POLL_MS,
  GAME_EMOJIS,
  GAME_PHRASES,
  own,
  GameDay,
  changed,
  listen,
  randomNick,
  makePlayer,
  compatible,
  closeness,
  leftAt,
  seekProfile,
  inviteCode,
  canStart,
  CLOSED,
  minskDay,
  startOfMinskDay,
  callForSeeker,
  registerBusyPlayers
} from './games';

/**
 * «Морской бой» один на один: со случайным игроком (вживую) или со знакомым по ссылке. С ботом играют целиком в приложении.
 * Всё как в «Крестиках-Ноликах»: подбор по анкете, инкогнито, готовые эмодзи вместо чата, долгий опрос, «Ещё партию».
 *
 * Партия идёт в два этапа (phase):
 *   • placing — каждый расставляет корабли (или жмёт «Готов» со случайной расстановкой). На это 90 секунд,
 *     кто не успел — сервер расставит сам;
 *   • battle — стреляют по очереди. Попал — стреляешь ещё раз, промахнулся — ход сопернику.
 *
 * Флот: 1 четырёхпалубный, 2 трёхпалубных, 3 двухпалубных, 4 однопалубных. Корабли не касаются друг друга даже углами.
 * Корабли соперника сервер не отдаёт, пока партия не кончилась: видно только свои выстрелы
 */

export const SEA = 10;
const CELLS = SEA * SEA;
export const SEA_SHIPS = [4, 3, 3, 2, 2, 2, 1, 1, 1, 1];
const SHIP_CELLS = SEA_SHIPS.reduce((a, b) => a + b, 0);
const PLACE_MS = 90 * 1000;

const KEEP: Record<string, number> = { searching: DAY, cancelled: DAY, waiting: 2 * DAY, active: 4 * DAY, finished: 30 * DAY };
const expireAt = (status: string) => new Date(Date.now() + (KEEP[status] || 30 * DAY));

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
    rematch: { type: Boolean },
    ready: { type: Boolean }
  },
  { _id: false }
);

const SeaMatch = model(
  'SeaMatch',
  new Schema(
    {
      mode: { type: String, enum: ['random', 'invite'], required: true },
      status: { type: String, enum: ['searching', 'waiting', 'active', 'finished', 'cancelled'], required: true, index: true },
      phase: { type: String, enum: ['placing', 'battle'], default: 'placing' },
      placeUntil: { type: Date },
      inviteCode: { type: String, index: true, sparse: true },
      players: { type: [PlayerSchema], default: [] }, // [0] стреляет первым
      // fleets[i] — корабли игрока i: '.' вода, '0'…'9' номер корабля
      fleets: { type: [String], default: () => ['', ''] },
      // shots[i] — куда стрелял игрок i: '.' не стрелял, 'm' мимо, 'h' попал, 'a' вокруг потопленного (отмечено само)
      shots: { type: [String], default: () => ['.'.repeat(CELLS), '.'.repeat(CELLS)] },
      turn: { type: Number, default: 0 },
      moves: { type: Number, default: 0 },
      lastShot: { by: Number, cell: Number },
      winner: { type: Number, default: -1 },
      reason: { type: String },
      finishedAt: { type: Date },
      say: { from: Number, text: String, at: Date },
      nextId: { type: Schema.Types.ObjectId },
      v: { type: Number, default: 0 },
      expireAt: { type: Date, default: () => expireAt('searching') },
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
    .index({ expireAt: 1 }, { expireAfterSeconds: 0 })
);

// ---------- Правила ----------

const rc = (cell: number) => [Math.floor(cell / SEA), cell % SEA];
const inside = (r: number, c: number) => r >= 0 && r < SEA && c >= 0 && c < SEA;

// Клетки вокруг (8 соседей)
function around(cell: number): number[] {
  const [r, c] = rc(cell);
  const out: number[] = [];
  for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) if ((dr || dc) && inside(r + dr, c + dc)) out.push((r + dr) * SEA + c + dc);
  return out;
}

// Расстановка по правилам: 10 кораблей нужных размеров, каждый — прямая линия, никто никого не касается
export function validFleet(fleet: string): boolean {
  if (typeof fleet !== 'string' || fleet.length !== CELLS || !/^[.0-9]+$/.test(fleet)) return false;
  const cells: number[][] = SEA_SHIPS.map(() => []);
  for (let i = 0; i < CELLS; i++) if (fleet[i] !== '.') cells[Number(fleet[i])].push(i);
  for (let s = 0; s < SEA_SHIPS.length; s++) {
    const list = cells[s];
    if (list.length !== SEA_SHIPS[s]) return false;
    const rows = new Set(list.map((c) => rc(c)[0])), cols = new Set(list.map((c) => rc(c)[1]));
    if (rows.size !== 1 && cols.size !== 1) return false;
    const step = rows.size === 1 ? 1 : SEA;
    for (let k = 1; k < list.length; k++) if (list[k] - list[k - 1] !== step) return false;
    for (const c of list) for (const n of around(c)) if (fleet[n] !== '.' && fleet[n] !== fleet[c]) return false;
  }
  return true;
}

export function randomFleet(): string {
  for (;;) {
    const f = Array(CELLS).fill('.');
    let ok = true;
    for (let s = 0; s < SEA_SHIPS.length && ok; s++) {
      ok = false;
      for (let tries = 0; tries < 200 && !ok; tries++) {
        const horiz = Math.random() < 0.5;
        const len = SEA_SHIPS[s];
        const r = Math.floor(Math.random() * (horiz ? SEA : SEA - len + 1));
        const c = Math.floor(Math.random() * (horiz ? SEA - len + 1 : SEA));
        const list = Array.from({ length: len }, (_, k) => (horiz ? r * SEA + c + k : (r + k) * SEA + c));
        if (list.some((x) => f[x] !== '.' || around(x).some((n) => f[n] !== '.'))) continue;
        list.forEach((x) => (f[x] = String(s)));
        ok = true;
      }
    }
    if (ok) return f.join('');
  }
}

// Какие корабли потоплены: все клетки подбиты
function sunkShips(fleet: string, shots: string): Set<string> {
  const left = new Map<string, number>();
  for (let i = 0; i < CELLS; i++) if (fleet[i] !== '.' && shots[i] !== 'h') left.set(fleet[i], (left.get(fleet[i]) || 0) + 1);
  return new Set(SEA_SHIPS.map((_, s) => String(s)).filter((s) => !left.get(s)));
}

// Поле глазами стрелявшего: '.' не стрелял, 'm' мимо, 'a' пусто рядом с потопленным, 'h' ранил, 's' потопил
function shotView(fleet: string, shots: string): string {
  if (!fleet) return shots;
  const sunk = sunkShips(fleet, shots);
  return Array.from(shots, (ch, i) => (ch === 'h' && sunk.has(fleet[i]) ? 's' : ch)).join('');
}

// Выстрел: новое поле выстрелов и что вышло
export function fire(fleet: string, shots: string, cell: number): { shots: string; result: 'miss' | 'hit' | 'sunk'; won: boolean } {
  const s = shots.split('');
  if (fleet[cell] === '.') {
    s[cell] = 'm';
    return { shots: s.join(''), result: 'miss', won: false };
  }
  s[cell] = 'h';
  const ship = fleet[cell];
  const shipCells: number[] = [];
  for (let i = 0; i < CELLS; i++) if (fleet[i] === ship) shipCells.push(i);
  const sunk = shipCells.every((c) => s[c] === 'h');
  // Потопил — клетки вокруг корабля отмечаем сами: там кораблей быть не может
  if (sunk) for (const c of shipCells) for (const n of around(c)) if (s[n] === '.') s[n] = 'a';
  const won = s.filter((ch) => ch === 'h').length === SHIP_CELLS;
  return { shots: s.join(''), result: sunk ? 'sunk' : 'hit', won };
}

const shipsLeft = (fleet: string, shots: string) => (fleet ? SEA_SHIPS.length - sunkShips(fleet, shots).size : SEA_SHIPS.length);

// ---------- Партия ----------

const meIndex = (m: any, telegramId: number) => m.players.findIndex((p: any) => p.telegramId === telegramId);

function view(m: any, telegramId: number) {
  const me = meIndex(m, telegramId);
  const opp = 1 - me;
  const fleets = m.fleets || ['', ''];
  const shots = m.shots || ['', ''];
  const over = m.status === 'finished';
  return {
    id: String(m._id),
    game: 'sea',
    mode: m.mode,
    status: m.status,
    phase: m.phase || 'placing',
    placeLeft: m.status === 'active' && m.phase === 'placing' && m.placeUntil ? Math.max(0, new Date(m.placeUntil).getTime() - Date.now()) : undefined,
    v: m.v || 0,
    inviteCode: m.status === 'waiting' && me === 0 ? m.inviteCode : undefined,
    size: SEA,
    turn: m.turn,
    me,
    moves: m.moves,
    lastShot: m.lastShot && m.lastShot.cell != null ? { by: m.lastShot.by, cell: m.lastShot.cell } : undefined,
    winner: m.winner,
    reason: m.reason,
    myFleet: me >= 0 ? fleets[me] || '' : '',
    myBoard: me >= 0 && shots[opp] ? shotView(fleets[me], shots[opp]) : '.'.repeat(CELLS), // куда стрелял соперник
    enemyBoard: me >= 0 && shots[me] ? shotView(fleets[opp], shots[me]) : '.'.repeat(CELLS), // куда стрелял я
    enemyFleet: over && me >= 0 ? fleets[opp] || '' : undefined, // корабли соперника — только после партии
    shipsLeft: me >= 0 ? [shipsLeft(fleets[me], shots[opp] || ''), shipsLeft(fleets[opp], shots[me] || '')] : [10, 10],
    say: m.say?.at && Date.now() - new Date(m.say.at).getTime() < 8000 ? { from: m.say.from, text: m.say.text, at: m.say.at } : undefined,
    nextId: m.nextId ? String(m.nextId) : undefined,
    players: m.players.map((p: any, i: number) => ({
      incognito: p.incognito,
      telegramId: p.incognito && i !== me ? undefined : p.telegramId,
      name: p.incognito ? p.nick : p.firstName,
      avatar: p.incognito ? '' : p.avatar,
      emoji: p.incognito ? p.nickEmoji : '',
      rematch: Boolean(p.rematch),
      ready: Boolean(p.ready),
      online: !p.awayAt && Date.now() - new Date(p.seenAt).getTime() < ONLINE_MS,
      away: Boolean(p.awayAt)
    })),
    updatedAt: m.updatedAt
  };
}

// Изменить партию: версия +1, срок хранения по статусу, разбудить ждущих. Ключ ожидания — «sea:<id>»
async function update(filter: any, set: any, extra: any = {}): Promise<any> {
  const status = set.status;
  const next: any = await SeaMatch.findOneAndUpdate(
    filter,
    { ...extra, $set: { ...set, ...(status ? { expireAt: set.expireAt || expireAt(status) } : {}) }, $inc: { ...(extra.$inc || {}), v: 1 } },
    { new: true }
  ).lean();
  if (next) changed(`sea:${next._id}`);
  if (next && status === 'finished' && next.players?.length === 2 && next.phase === 'battle') {
    GameDay.updateOne({ day: minskDay() }, { $inc: { seaGames: 1 }, $addToSet: { seaPlayers: { $each: next.players.map((p: any) => p.telegramId) } } }, { upsert: true }).catch(() => {});
  }
  return next;
}

// Оба расставили — в бой. Кто стреляет первым — players[0] (порядок уже случайный)
const toBattle = () => ({ phase: 'battle', turn: 0, lastMoveAt: new Date() });

async function settle(m: any): Promise<any> {
  const now = Date.now();
  let set: any = null;
  if (m.status === 'searching' && now - new Date(m.players[0].seenAt).getTime() > SEARCH_STALE_MS) set = { status: 'cancelled' };
  else if (m.status === 'waiting' && now - new Date(m.createdAt).getTime() > INVITE_WAIT_MS) set = { status: 'cancelled' };
  else if (m.status === 'active') {
    const gone = m.players
      .map((p: any, i: number) => ({ i, at: leftAt(p) }))
      .filter((g: any) => now > g.at)
      .sort((a: any, b: any) => a.at - b.at);
    if (gone.length) set = { status: 'finished', winner: 1 - gone[0].i, reason: 'left', finishedAt: new Date() };
    // Время на расстановку вышло — расставляем за того, кто не успел, и начинаем
    else if (m.phase === 'placing' && m.placeUntil && now > new Date(m.placeUntil).getTime()) {
      const fleets = [0, 1].map((i) => (m.players[i].ready && m.fleets?.[i] ? m.fleets[i] : randomFleet()));
      set = { fleets, 'players.0.ready': true, 'players.1.ready': true, ...toBattle() };
    }
  }
  if (!set) return m;
  return (await update({ _id: m._id, status: m.status, phase: m.phase }, set)) || (await SeaMatch.findById(m._id).lean());
}

// Новая партия началась: расстановка, 90 секунд
const startPlacing = () => ({ status: 'active', phase: 'placing', placeUntil: new Date(Date.now() + PLACE_MS), fleets: ['', ''], shots: ['.'.repeat(CELLS), '.'.repeat(CELLS)] });

async function tryPair(mine: any): Promise<any | null> {
  const me = mine.players[0];
  const others = await SeaMatch.find({
    _id: { $ne: mine._id },
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

  const released = await SeaMatch.findOneAndUpdate({ _id: mine._id, status: 'searching' }, { $set: { status: 'cancelled', expireAt: expireAt('cancelled') } });
  if (!released) return SeaMatch.findById(mine._id).lean();

  for (const { o } of fits) {
    const guest = { ...me, seenAt: new Date() };
    if (guest.incognito && guest.nick === o.players[0].nick) [guest.nickEmoji, guest.nick] = randomNick(o.players[0].nick);
    const players = Math.random() < 0.5 ? [o.players[0], guest] : [guest, o.players[0]];
    const taken = await update({ _id: o._id, status: 'searching' }, { ...startPlacing(), players });
    if (taken) return taken;
  }
  await SeaMatch.updateOne({ _id: mine._id }, { $set: { status: 'searching', expireAt: expireAt('searching'), 'players.0.seenAt': new Date() } });
  return null;
}

async function touch(id: string, telegramId: number, back = true): Promise<any> {
  const m: any = await SeaMatch.findOneAndUpdate({ _id: id, 'players.telegramId': telegramId }, { $set: { 'players.$.seenAt': new Date() } }, { new: true, timestamps: false }).lean();
  if (!back || !m || m.status !== 'active' || !m.players.find((p: any) => p.telegramId === telegramId)?.awayAt) return m;
  return (await update({ _id: id, status: 'active', 'players.telegramId': telegramId }, { 'players.$.seenAt': new Date() }, { $unset: { 'players.$.awayAt': 1 } })) || m;
}

// ---------- Статистика ----------

let lobbyCache: { at: number; searching: number; playing: number; total: number } | null = null;
async function seaLobby() {
  if (lobbyCache && Date.now() - lobbyCache.at < 5000) return lobbyCache;
  const fresh = new Date(Date.now() - 40 * 1000);
  const [searching, active, sums] = await Promise.all([
    SeaMatch.countDocuments({ status: 'searching', 'players.0.seenAt': { $gte: new Date(Date.now() - SEARCH_STALE_MS) } }),
    SeaMatch.find({ status: 'active', updatedAt: { $gte: new Date(Date.now() - DAY) } }, { players: 1 }).lean(),
    GameDay.aggregate([{ $group: { _id: null, human: { $sum: { $ifNull: ['$seaGames', 0] } }, bot: { $sum: { $ifNull: ['$seaBotGames', 0] } } } }])
  ]);
  const playing = active.reduce((n: number, m: any) => n + m.players.filter((p: any) => new Date(p.seenAt) >= fresh).length, 0);
  lobbyCache = { at: Date.now(), searching, playing, total: (sums[0]?.human || 0) + (sums[0]?.bot || 0) };
  return lobbyCache;
}

// Сколько человек сейчас в Морском бое с людьми (ищут или играют, заглядывали за последние 40 секунд)
async function liveSeaPlayers(): Promise<number[]> {
  const since = new Date(Date.now() - 40 * 1000);
  const r = await SeaMatch.aggregate([
    { $match: { status: { $in: ['searching', 'active'] }, updatedAt: { $gte: new Date(Date.now() - DAY) } } },
    { $unwind: '$players' },
    { $match: { 'players.seenAt': { $gte: since } } },
    { $group: { _id: '$players.telegramId' } }
  ]);
  return r.map((x: any) => x._id);
}

// Кто сейчас в Морском бое — Крестики-Нолики таких не зовут поиграть
registerBusyPlayers(() =>
  SeaMatch.distinct('players.telegramId', { status: { $in: ['searching', 'active'] }, updatedAt: { $gte: new Date(Date.now() - 2 * 60 * 1000) } }) as Promise<number[]>
);

// Раз в минуту запоминаем пик игроков за день
export function startSeaStatsLoop() {
  setInterval(async () => {
    try {
      const n = (await liveSeaPlayers()).length;
      if (!n) return;
      const day = minskDay();
      const doc: any = await GameDay.findOne({ day }, { seaPeak: 1 }).lean();
      if (n > (doc?.seaPeak || 0)) await GameDay.updateOne({ day }, { $set: { seaPeak: n, seaPeakAt: new Date() } }, { upsert: true });
    } catch (err: any) {
      console.warn('⚠️ Морской бой, пик игроков:', err?.message || err);
    }
  }, 60 * 1000).unref();
}

// Строки для /stats — как у Крестиков-Ноликов
export async function seaStatsLines(): Promise<string[]> {
  const today = startOfMinskDay();
  const started = { status: { $in: ['active', 'finished'] }, createdAt: { $gte: today } };
  const [human, random, invite, players, finished, live, day, week] = await Promise.all([
    SeaMatch.countDocuments(started),
    SeaMatch.countDocuments({ ...started, mode: 'random' }),
    SeaMatch.countDocuments({ ...started, mode: 'invite' }),
    SeaMatch.distinct('players.telegramId', started),
    SeaMatch.countDocuments({ status: 'finished', reason: 'win', createdAt: { $gte: today } }),
    liveSeaPlayers(),
    GameDay.findOne({ day: minskDay() }).lean() as any,
    GameDay.find({ day: { $gte: minskDay(Date.now() - 6 * DAY) } }, { seaPeak: 1 }).lean()
  ]);
  const peakWeek = Math.max(0, ...week.map((d: any) => d.seaPeak || 0));
  const peakAt = day?.seaPeakAt ? new Date(day.seaPeakAt).toLocaleTimeString('ru-RU', { timeZone: 'Europe/Minsk', hour: '2-digit', minute: '2-digit' }) : '';
  return [
    `🚢 <b>Морской бой сегодня</b>`,
    `С людьми: партий ${human} (случайный соперник ${random}, знакомые ${invite}), доиграно до победы ${finished}, играли ${players.length} чел.`,
    `С ботом: партий ${day?.seaBotGames || 0}, играли ${day?.seaBotPlayers?.length || 0} чел.`,
    `Сейчас с людьми: ${live.length} · пик сегодня ${day?.seaPeak || 0}${peakAt ? ` (в ${peakAt})` : ''} · пик за 7 дней ${peakWeek}`
  ];
}

// ---------- Маршруты ----------

export function setupSeaRoutes(app: Express) {
  const auth = telegramAuthMiddleware as any;
  const validId = (req: Request) => Types.ObjectId.isValid(String(req.params.id));

  app.post('/api/sea/search', auth, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const myId = req.telegramUser!.id;
      if (!canStart(myId)) return res.status(403).json({ error: CLOSED });
      const incognito = Boolean(req.body?.incognito);
      const live: any = await SeaMatch.findOne({ mode: 'random', status: { $in: ['searching', 'active'] }, 'players.telegramId': myId }).sort({ createdAt: -1 }).lean();
      if (live) {
        const s = await settle(live);
        if (s.status === 'active') return res.json(view(s, myId));
        if (s.status === 'searching') await update({ _id: s._id, status: 'searching' }, { status: 'cancelled' });
      }
      const u: any = await User.findOne({ telegramId: myId }, { gender: 1, age: 1, preferredGender: 1, preferredAgeRange: 1, photoOnly: 1, hasFacePhoto: 1, photosHidden: 1, goals: 1, goal: 1, areaName: 1, blockedUsers: 1, hasAgreedToRules: 1 }).lean();
      if (!u?.hasAgreedToRules) return res.status(403).json({ error: 'Сначала прими правила «ГУЛЯЙ!»' });
      const me = await makePlayer(myId, incognito);
      const mine: any = (await SeaMatch.create({ mode: 'random', status: 'searching', players: [me], seek: seekProfile(u), expireAt: expireAt('searching') })).toObject();
      const paired = await tryPair(mine);
      if (!paired) callForSeeker({ telegramId: myId, blockedUsers: u.blockedUsers }, 'sea'); // никого нет — зовём подписавшихся
      res.json(view(paired || mine, myId));
    } catch (err: any) {
      console.warn('⚠️ Морской бой, поиск:', err?.message || err);
      res.status(500).json({ error: 'Не получилось начать поиск' });
    }
  });

  app.get('/api/sea/lobby', auth, async (_req: AuthenticatedRequest, res: Response) => {
    try {
      const c = await seaLobby();
      res.json({ searching: c.searching, playing: c.playing, totalGames: c.total });
    } catch {
      res.status(500).json({ error: 'Не получилось' });
    }
  });

  app.post('/api/sea/invite', auth, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const myId = req.telegramUser!.id;
      if (!canStart(myId)) return res.status(403).json({ error: CLOSED });
      const waiting = await SeaMatch.countDocuments({ mode: 'invite', status: 'waiting', 'players.0.telegramId': myId });
      if (waiting >= 5) return res.status(429).json({ error: 'У тебя уже 5 приглашений ждут ответа. Отмени старые или подожди, пока примут' });
      const me = await makePlayer(myId, Boolean(req.body?.incognito));
      const m: any = (await SeaMatch.create({ mode: 'invite', status: 'waiting', inviteCode: inviteCode(), players: [me], expireAt: expireAt('waiting') })).toObject();
      res.json(view(m, myId));
    } catch (err: any) {
      console.warn('⚠️ Морской бой, приглашение:', err?.message || err);
      res.status(500).json({ error: 'Не получилось создать приглашение' });
    }
  });

  app.post('/api/sea/join/:code', auth, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const myId = req.telegramUser!.id;
      const code = String(req.params.code || '').slice(0, 20);
      const m: any = await SeaMatch.findOne({ inviteCode: code }).lean();
      if (!m) return res.status(404).json({ error: 'Приглашение не найдено' });
      if (meIndex(m, myId) >= 0) return res.json(view(await settle(m), myId));
      if (m.status !== 'waiting') return res.status(410).json({ error: 'Эту партию уже начали или отменили' });
      const host: any = await User.findOne({ telegramId: m.players[0].telegramId }, { blockedUsers: 1 }).lean();
      const meUser: any = await User.findOne({ telegramId: myId }, { blockedUsers: 1 }).lean();
      if (host?.blockedUsers?.includes(myId) || meUser?.blockedUsers?.includes(m.players[0].telegramId)) return res.status(404).json({ error: 'Приглашение не найдено' });
      const guest = await makePlayer(myId, Boolean(req.body?.incognito), m.players[0].nick);
      const hostP: any = { ...m.players[0], awayAt: undefined };
      const hostHere = Date.now() - new Date(hostP.seenAt).getTime() < ONLINE_MS && !m.players[0].awayAt;
      if (!hostHere) hostP.graceUntil = new Date(Date.now() + HOST_GRACE_MS);
      const players = Math.random() < 0.5 ? [hostP, guest] : [guest, hostP];
      // Позвавший не в приложении: на расстановку ему — сколько ждём, плюс обычные 90 секунд
      const placing: any = startPlacing();
      if (!hostHere) placing.placeUntil = new Date(Date.now() + HOST_GRACE_MS + PLACE_MS);
      const started: any = await update({ _id: m._id, status: 'waiting' }, { ...placing, players });
      if (!started) return res.status(410).json({ error: 'Эту партию уже начали' });
      if (!hostHere) {
        const u: any = await User.findOne({ telegramId: hostP.telegramId }, { canMessage: 1 }).lean();
        const name = guest.incognito ? `${guest.nickEmoji} ${guest.nick}` : guest.firstName;
        if (u?.canMessage !== false) {
          sendWithButtons(hostP.telegramId, `🚢 <b>${escapeHtml(name)}</b> уже в «Морском бою» и ждёт тебя. Заходи в течение пары минут`, [[{ text: '🚢 Играть', path: `?sea=${started._id}` }]]).catch(() => {});
        }
      }
      res.json(view(started, myId));
    } catch (err: any) {
      console.warn('⚠️ Морской бой, вход по приглашению:', err?.message || err);
      res.status(500).json({ error: 'Не получилось открыть приглашение' });
    }
  });

  app.get('/api/sea/mine', auth, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const myId = req.telegramUser!.id;
      const list: any[] = await SeaMatch.find({ mode: 'invite', status: { $in: ['waiting', 'active'] }, 'players.telegramId': myId }).sort({ updatedAt: -1 }).limit(20).lean();
      const settled = await Promise.all(list.map(settle));
      res.json(settled.filter((m) => m.status === 'waiting' || m.status === 'active').map((m) => view(m, myId)));
    } catch {
      res.status(500).json({ error: 'Не получилось загрузить партии' });
    }
  });

  app.post('/api/sea/bot-played', auth, async (req: AuthenticatedRequest, res: Response) => {
    try {
      await GameDay.updateOne({ day: minskDay() }, { $inc: { seaBotGames: 1 }, $addToSet: { seaBotPlayers: req.telegramUser!.id } }, { upsert: true });
    } catch {
      /* статистика не важнее игры */
    }
    res.json({ ok: true });
  });

  // Состояние партии; ?since=<v>&wait=1 — долгий опрос
  app.get('/api/sea/:id', auth, async (req: AuthenticatedRequest, res: Response) => {
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
      const sub = longPoll ? listen(`sea:${id}`, res) : null;
      let m = await load();
      if (!m) {
        sub?.cancel();
        return res.status(404).json({ error: 'Партия не найдена' });
      }
      const sameGame = String(m._id) === id;
      const waitable = ['searching', 'waiting', 'active', 'finished'].includes(m.status) && !m.nextId;
      if (sub && sameGame && waitable && (m.v || 0) <= since) {
        let wait = m.status === 'searching' ? SEARCH_POLL_MS : LONG_POLL_MS;
        if (m.status === 'active') {
          const deadlines = m.players.filter((p: any) => p.telegramId !== myId).map(leftAt);
          if (m.phase === 'placing' && m.placeUntil) deadlines.push(new Date(m.placeUntil).getTime());
          wait = Math.max(1000, Math.min(wait, Math.min(...deadlines) - Date.now() + 500));
        }
        const stillThere = await sub.wait(wait);
        if (!stillThere) return;
        m = (await load(false)) || m;
      } else sub?.cancel();
      res.json(view(m, myId));
    } catch (err: any) {
      console.warn('⚠️ Морской бой, партия:', err?.message || err);
      if (!res.headersSent) res.status(500).json({ error: 'Не получилось загрузить партию' });
    }
  });

  // Расстановка готова
  app.post('/api/sea/:id/fleet', auth, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const myId = req.telegramUser!.id;
      const fleet = String(req.body?.fleet || '');
      if (!validId(req) || !validFleet(fleet)) return res.status(400).json({ error: 'Корабли стоят не по правилам' });
      let m: any = await SeaMatch.findOne({ _id: String(req.params.id), 'players.telegramId': myId }).lean();
      if (!m) return res.status(404).json({ error: 'Партия не найдена' });
      m = await settle(m);
      const i = meIndex(m, myId);
      if (m.status !== 'active' || m.phase !== 'placing') return res.status(409).json({ error: 'Расстановка уже закончилась', game: view(m, myId) });
      let next: any = await update({ _id: m._id, status: 'active', phase: 'placing' }, { [`fleets.${i}`]: fleet, [`players.${i}.ready`]: true, [`players.${i}.seenAt`]: new Date() });
      // Готовы оба — в бой (условие на обоих «готов» защищает от двойного старта)
      if (next?.players.every((p: any) => p.ready)) {
        next = (await update({ _id: m._id, status: 'active', phase: 'placing', 'players.0.ready': true, 'players.1.ready': true }, toBattle())) || (await SeaMatch.findById(m._id).lean());
      }
      res.json(view(next || m, myId));
    } catch (err: any) {
      console.warn('⚠️ Морской бой, расстановка:', err?.message || err);
      res.status(500).json({ error: 'Не получилось' });
    }
  });

  // Выстрел
  app.post('/api/sea/:id/shot', auth, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const myId = req.telegramUser!.id;
      const cell = Number(req.body?.cell);
      if (!validId(req) || !Number.isInteger(cell) || cell < 0 || cell >= CELLS) return res.status(400).json({ error: 'Такой клетки нет' });
      let m: any = await SeaMatch.findOne({ _id: String(req.params.id), 'players.telegramId': myId }).lean();
      if (!m) return res.status(404).json({ error: 'Партия не найдена' });
      m = await settle(m);
      const i = meIndex(m, myId);
      if (m.status !== 'active' || m.phase !== 'battle') return res.status(409).json({ error: 'Сейчас стрелять нельзя', game: view(m, myId) });
      if (m.turn !== i) return res.status(409).json({ error: 'Сейчас стреляет соперник', game: view(m, myId) });
      if (m.shots[i][cell] !== '.') return res.status(409).json({ error: 'Сюда уже стреляли', game: view(m, myId) });

      const shot = fire(m.fleets[1 - i], m.shots[i], cell);
      const set: any = {
        [`shots.${i}`]: shot.shots,
        lastShot: { by: i, cell },
        lastMoveAt: new Date(),
        turn: shot.result === 'miss' ? 1 - i : i,
        [`players.${i}.seenAt`]: new Date(),
        expireAt: expireAt('active'),
        ...(shot.won ? { status: 'finished', winner: i, reason: 'win', finishedAt: new Date(), expireAt: expireAt('finished') } : {})
      };
      // Защита от двойного нажатия: только если поле выстрелов не поменялось
      const next: any = await update({ _id: m._id, status: 'active', turn: i, [`shots.${i}`]: m.shots[i] }, set, { $inc: { moves: 1 } });
      if (!next) return res.status(409).json({ error: 'Выстрел уже сделан', game: view((await SeaMatch.findById(m._id).lean()) as any, myId) });
      res.json(view(next, myId));
    } catch (err: any) {
      console.warn('⚠️ Морской бой, выстрел:', err?.message || err);
      res.status(500).json({ error: 'Не получилось выстрелить' });
    }
  });

  app.post('/api/sea/:id/say', auth, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const myId = req.telegramUser!.id;
      const key = String(req.body?.say || '');
      const text = own(GAME_EMOJIS, key) ? GAME_EMOJIS[key] : own(GAME_PHRASES, key) ? GAME_PHRASES[key] : '';
      if (!text || !validId(req)) return res.status(400).json({ error: 'Такой фразы нет' });
      const m: any = await SeaMatch.findOne({ _id: String(req.params.id), 'players.telegramId': myId }, { players: 1 }).lean();
      if (!m) return res.status(404).json({ error: 'Партия не найдена' });
      const next: any = await update({ _id: m._id }, { say: { from: meIndex(m, myId), text, at: new Date() } });
      res.json(view(next, myId));
    } catch {
      res.status(500).json({ error: 'Не получилось отправить' });
    }
  });

  app.post('/api/sea/:id/away', auth, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const myId = req.telegramUser!.id;
      if (!validId(req)) return res.sendStatus(404);
      await update({ _id: String(req.params.id), status: 'active', players: { $elemMatch: { telegramId: myId, awayAt: { $exists: false } } } }, { 'players.$.awayAt': new Date() });
      res.json({ ok: true });
    } catch {
      res.status(500).json({ error: 'Не получилось' });
    }
  });

  app.post('/api/sea/:id/leave', auth, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const myId = req.telegramUser!.id;
      if (!validId(req)) return res.sendStatus(404);
      const m: any = await SeaMatch.findOne({ _id: String(req.params.id), 'players.telegramId': myId }).lean();
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

  app.post('/api/sea/:id/block', auth, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const myId = req.telegramUser!.id;
      if (!validId(req)) return res.sendStatus(404);
      const m: any = await SeaMatch.findOne({ _id: String(req.params.id), 'players.telegramId': myId }, { players: 1, status: 1 }).lean();
      const other = m?.players.find((p: any) => p.telegramId !== myId);
      if (!other) return res.status(404).json({ error: 'Партия не найдена' });
      await User.updateOne({ telegramId: myId }, { $addToSet: { blockedUsers: other.telegramId } });
      if (m.status === 'active') await update({ _id: m._id, status: 'active' }, { status: 'finished', winner: meIndex(m, myId), reason: 'left', finishedAt: new Date() });
      res.json({ ok: true });
    } catch {
      res.status(500).json({ error: 'Не получилось' });
    }
  });

  // «Ещё партию»: нажали оба — новая партия, первым стреляет другой
  app.post('/api/sea/:id/rematch', auth, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const myId = req.telegramUser!.id;
      if (!validId(req)) return res.sendStatus(404);
      let m: any = await SeaMatch.findOne({ _id: String(req.params.id), 'players.telegramId': myId }).lean();
      if (!m) return res.status(404).json({ error: 'Партия не найдена' });
      const i = meIndex(m, myId);
      if (m.status !== 'finished') return res.status(409).json({ error: 'Партия ещё идёт' });
      if (m.nextId) return res.json(view(m, myId));
      if (m.reason === 'left' || m.reason === 'resign' || Date.now() - new Date(m.finishedAt || m.updatedAt).getTime() > REMATCH_MS) {
        return res.status(410).json({ error: 'Соперник уже ушёл. Найдём другого?' });
      }
      m = await update({ _id: m._id }, { [`players.${i}.rematch`]: true, [`players.${i}.seenAt`]: new Date() });
      if (m.players.every((p: any) => p.rematch) && !m.nextId) {
        const players = [m.players[1], m.players[0]].map((p: any) => ({ ...p, rematch: undefined, ready: undefined, awayAt: undefined, graceUntil: undefined, seenAt: new Date() }));
        const created: any = await SeaMatch.create({ mode: m.mode, ...startPlacing(), players, expireAt: expireAt('active') });
        const linked = await update({ _id: m._id, nextId: { $exists: false } }, { nextId: created._id });
        if (!linked) await SeaMatch.deleteOne({ _id: created._id });
        m = await SeaMatch.findById(m._id).lean();
      }
      res.json(view(m, myId));
    } catch (err: any) {
      console.warn('⚠️ Морской бой, реванш:', err?.message || err);
      res.status(500).json({ error: 'Не получилось' });
    }
  });
}
