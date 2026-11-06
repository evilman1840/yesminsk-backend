import { Express, Response } from 'express';
import { Schema, model } from 'mongoose';
import { telegramAuthMiddleware, AuthenticatedRequest } from './middleware/telegramAuth';
import { User } from './models/User';
import { isAdmin } from './news';

/**
 * Личная статистика в играх: сколько сыграл и выиграл, рекорды, рейтинг дня.
 * Одна запись на человека, игру и день по Минску — так легко посчитать и «всего», и «сегодня».
 *
 *   • «Крестики-Нолики» (five): партии с людьми записывает сервер, когда партия кончилась; партии с ботом — приложение;
 *   • «Трактор в Минске» (tractor): матч целиком идёт на телефоне, в конце приложение присылает итог.
 *
 * Итог трактора считает телефон, поэтому проверяем только, что числа правдоподобные: это игра, а не деньги.
 */

const MINSK_OFFSET = 3 * 60 * 60 * 1000;
export const minskDay = (t = Date.now()) => new Date(t + MINSK_OFFSET).toISOString().slice(0, 10);

// Обо что разбивается трактор: то, что считает приложение
const CRASH_KEYS = ['border', 'river', 'own', 'trail', 'tractor', 'gates', 'kostel', 'stela', 'komar', 'almaz'];

const GameScore = model(
  'GameScore',
  new Schema(
    {
      telegramId: { type: Number, required: true },
      game: { type: String, enum: ['five', 'tractor'], required: true },
      day: { type: String, required: true }, // '2026-11-06' по Минску
      games: { type: Number, default: 0 },    // партии / матчи
      wins: { type: Number, default: 0 },     // выигранные партии / матчи
      botGames: { type: Number, default: 0 }, // «Крестики-Нолики» с ботом
      rounds: { type: Number, default: 0 },   // трактор: раундов сыграно
      roundWins: { type: Number, default: 0 },
      best: { type: Number, default: 0 },     // трактор: дольше всего на ходу в раунде, секунд
      crash: { type: Map, of: Number, default: {} }
    },
    { timestamps: true }
  )
    .index({ telegramId: 1, game: 1, day: 1 }, { unique: true })
    .index({ game: 1, day: 1, wins: -1 })
);

const canPlay = (telegramId: number) => process.env.GAMES_OPEN === '1' || isAdmin(telegramId);

/** «Крестики-Нолики»: партия с людьми закончилась (зовётся из games.ts) */
export async function recordFiveMatch(m: any) {
  const day = minskDay();
  await Promise.all(
    (m.players || []).map((p: any, i: number) =>
      GameScore.updateOne({ telegramId: p.telegramId, game: 'five', day }, { $inc: { games: 1, wins: m.winner === i ? 1 : 0 } }, { upsert: true })
    )
  );
}

/** «Крестики-Нолики» с ботом: приложение сообщает, выиграл ли */
export async function recordFiveBot(telegramId: number, won: boolean) {
  await GameScore.updateOne({ telegramId, game: 'five', day: minskDay() }, { $inc: { games: 1, botGames: 1, wins: won ? 1 : 0 } }, { upsert: true });
}

const int = (v: any, max: number) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? Math.max(0, Math.min(max, n)) : 0;
};

// ---------- Сводка для меню и стартового экрана ----------

async function totals(telegramId: number, game: 'five' | 'tractor') {
  const docs: any[] = await GameScore.find({ telegramId, game }).lean();
  const crash: Record<string, number> = {};
  let games = 0, wins = 0, best = 0, rounds = 0, roundWins = 0;
  for (const d of docs) {
    games += d.games || 0;
    wins += d.wins || 0;
    rounds += d.rounds || 0;
    roundWins += d.roundWins || 0;
    best = Math.max(best, d.best || 0);
    for (const [k, v] of Object.entries(d.crash || {})) crash[k] = (crash[k] || 0) + (v as number);
  }
  const nemesis = Object.entries(crash).sort((a, b) => b[1] - a[1])[0];
  return { games, wins, best, rounds, roundWins, nemesis: nemesis && nemesis[1] >= 2 ? nemesis[0] : null };
}

// Рейтинг дня по трактору: больше выигранных матчей, при равенстве — больше выигранных раундов
async function tractorDay(telegramId: number) {
  const day = minskDay();
  const all: any[] = await GameScore.find({ game: 'tractor', day, games: { $gt: 0 } }, { telegramId: 1, wins: 1, roundWins: 1, games: 1 })
    .sort({ wins: -1, roundWins: -1, updatedAt: 1 })
    .lean();
  const myIndex = all.findIndex((d) => d.telegramId === telegramId);
  const show = all.slice(0, 3);
  if (myIndex >= 3) show.push(all[myIndex]);
  const users: any[] = await User.find({ telegramId: { $in: show.map((d) => d.telegramId) } }, { telegramId: 1, firstName: 1 }).lean();
  const nameOf = (id: number) => users.find((u) => u.telegramId === id)?.firstName || 'Игрок';
  return {
    players: all.length,
    myPlace: myIndex >= 0 ? myIndex + 1 : null,
    top: show.map((d) => ({ place: all.indexOf(d) + 1, name: nameOf(d.telegramId), wins: d.wins || 0, me: d.telegramId === telegramId }))
  };
}

// Трактор за всё время у всех: сколько матчей сыграно и сколько человек играли. Не чаще раза в минуту
let allCache: { at: number; games: number; players: number } | null = null;
async function tractorAll() {
  if (allCache && Date.now() - allCache.at < 60 * 1000) return allCache;
  const [sum, people] = await Promise.all([
    GameScore.aggregate([{ $match: { game: 'tractor' } }, { $group: { _id: null, games: { $sum: '$games' } } }]),
    GameScore.distinct('telegramId', { game: 'tractor', games: { $gt: 0 } })
  ]);
  allCache = { at: Date.now(), games: sum[0]?.games || 0, players: people.length };
  return allCache;
}

async function summary(telegramId: number) {
  const [five, tractor, day, all] = await Promise.all([totals(telegramId, 'five'), totals(telegramId, 'tractor'), tractorDay(telegramId), tractorAll()]);
  return {
    five: { games: five.games, wins: five.wins },
    tractor: {
      games: tractor.games, wins: tractor.wins, rounds: tractor.rounds, roundWins: tractor.roundWins, best: tractor.best, nemesis: tractor.nemesis, day,
      all: { games: all.games, players: all.players }
    }
  };
}

// ---------- /stats ----------

export async function tractorStatsLines(): Promise<string[]> {
  const day = minskDay();
  const weekAgo = minskDay(Date.now() - 6 * 24 * 60 * 60 * 1000);
  const [today, week] = await Promise.all([
    GameScore.find({ game: 'tractor', day, games: { $gt: 0 } }).sort({ wins: -1, roundWins: -1 }).lean() as any,
    GameScore.find({ game: 'tractor', day: { $gte: weekAgo }, games: { $gt: 0 } }, { telegramId: 1, games: 1 }).lean() as any
  ]);
  const sum = (a: any[], k: string) => a.reduce((n, d) => n + (d[k] || 0), 0);
  const crash: Record<string, number> = {};
  for (const d of today) for (const [k, v] of Object.entries(d.crash || {})) crash[k] = (crash[k] || 0) + (v as number);
  const CRASH_NAMES: Record<string, string> = {
    border: 'МКАД', river: 'Свислочь', own: 'своя борозда', trail: 'чужая борозда', tractor: 'лоб в лоб',
    gates: 'Ворота Минска', kostel: 'Красный костёл', stela: 'стела', komar: 'Комаровка', almaz: '«Алмаз»'
  };
  const topCrash = Object.entries(crash).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${CRASH_NAMES[k] || k} ${v}`);
  const leader = today[0];
  const leaderName = leader ? ((await User.findOne({ telegramId: leader.telegramId }, { firstName: 1 }).lean()) as any)?.firstName || 'Игрок' : '';
  return [
    `🚜 <b>Трактор в Минске сегодня</b>`,
    `Матчей ${sum(today, 'games')}, раундов ${sum(today, 'rounds')}, играли ${today.length} чел. · за 7 дней ${sum(week, 'games')} матчей, ${new Set(week.map((d: any) => d.telegramId)).size} чел.`,
    ...(leader ? [`Лидер дня: ${leaderName}, побед ${leader.wins} · рекорд на ходу сегодня ${Math.max(0, ...today.map((d: any) => d.best || 0))} с`] : []),
    ...(topCrash.length ? [`Чаще всего врезаются: ${topCrash.join(', ')}`] : [])
  ];
}

// ---------- Маршруты ----------

export function setupGameScoreRoutes(app: Express) {
  const auth = telegramAuthMiddleware as any;

  // Меню игр и стартовый экран трактора: мои победы, рекорды, рейтинг дня
  app.get('/api/games/summary', auth, async (req: AuthenticatedRequest, res: Response) => {
    try {
      res.json(await summary(req.telegramUser!.id));
    } catch (err: any) {
      console.warn('⚠️ Игры, сводка:', err?.message || err);
      res.status(500).json({ error: 'Не получилось' });
    }
  });

  // Трактор: матч закончился. Возвращаем свежую сводку — экран итогов покажет место в рейтинге дня
  app.post('/api/games/tractor/match', auth, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const myId = req.telegramUser!.id;
      if (!canPlay(myId)) return res.status(403).json({ error: 'Игры скоро появятся 🎲' });
      const b = req.body || {};
      const rounds = int(b.rounds, 15);
      const roundWins = Math.min(int(b.roundWins, 3), rounds);
      if (!rounds) return res.status(400).json({ error: 'Пустой матч' });
      const crashInc: Record<string, number> = {};
      for (const k of CRASH_KEYS) {
        const n = int(b.crash?.[k], 15);
        if (n) crashInc[`crash.${k}`] = n;
      }
      const best = int(b.best, 600);
      await GameScore.updateOne(
        { telegramId: myId, game: 'tractor', day: minskDay() },
        { $inc: { games: 1, wins: b.won ? 1 : 0, rounds, roundWins, ...crashInc }, $max: { best } },
        { upsert: true }
      );
      if (allCache) allCache.games++; // свой матч сразу виден в «всего сыграно»
      res.json(await summary(myId));
    } catch (err: any) {
      console.warn('⚠️ Трактор, итог матча:', err?.message || err);
      res.status(500).json({ error: 'Не получилось сохранить матч' });
    }
  });
}
