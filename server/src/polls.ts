import { Express, Response } from 'express';
import { Schema, model, Types } from 'mongoose';
import { telegramAuthMiddleware, AuthenticatedRequest } from './middleware/telegramAuth';
import { isAdmin } from './news';
import { escapeHtml } from './utils/telegramNotify';
import { sendWithButtons } from './wishes';
import { csvCell } from './utils/csv';
import { POLL_TEXTS as T } from './texts';

/**
 * Опрос автора: один на всех, подпись в шапке карты зовёт голосовать, в шторке — варианты и итоги.
 *
 * Боту (только автор):
 *   /poll Вопрос | 🐾 Вариант = коротко | ☕ Вариант | Свой вариант   — новый опрос (прошлый закрывается)
 *     «= коротко» — имя варианта для строки в шапке после голоса: «Донаты → 🐾 приют»
 *     вторая строка вопроса — пояснение под ним; «Свой вариант» — поле для своей идеи
 *   /poll       — что идёт сейчас и сколько голосов
 *   /pollend    — закрыть опрос и прислать итоги с таблицей
 *   /pollcsv    — таблица голосов и идей, не закрывая
 */

interface PollOption {
  key: string;
  label: string;
  emoji: string;
  short: string;
}

const Poll = model(
  'Poll',
  new Schema(
    {
      question: { type: String, required: true, maxlength: 140 },
      note: { type: String, default: '', maxlength: 300 },
      options: { type: [{ key: String, label: String, emoji: String, short: String, _id: false }], default: [] },
      allowCustom: { type: Boolean, default: false },
      active: { type: Boolean, default: true, index: true },
      closedAt: Date
    },
    { timestamps: true }
  )
);

// Один голос на человека: переголосовать можно, пока опрос идёт
const PollVote = model(
  'PollVote',
  new Schema(
    {
      pollId: { type: Schema.Types.ObjectId, required: true, index: true },
      telegramId: { type: Number, required: true },
      option: { type: String, required: true }, // ключ варианта или 'custom'
      custom: { type: String, default: '', maxlength: 200 }
    },
    { timestamps: true }
  ).index({ pollId: 1, telegramId: 1 }, { unique: true })
);

const CUSTOM = 'custom';
export const POLL_CUSTOM_MAX = 200;
const MAX_OPTIONS = 6;
const LEADING_EMOJI = /^(\p{Extended_Pictographic}(️|‍\p{Extended_Pictographic})*)\s*/u;

// «🐾 Приют для животных = приют» → значок, подпись и короткое имя (без «=» — первое слово)
const parseOption = (raw: string, i: number): PollOption => {
  const [main, shortRaw = ''] = raw.split('=').map((s) => s.trim());
  const m = main.match(LEADING_EMOJI);
  const label = main.replace(LEADING_EMOJI, '').trim();
  const short = (shortRaw || label.split(/\s+/)[0] || '').slice(0, 30);
  return { key: `o${i + 1}`, emoji: m ? m[1] : '', label, short: short.charAt(0).toLowerCase() + short.slice(1) };
};

async function counts(pollId: Types.ObjectId) {
  const rows: { _id: string; n: number }[] = await PollVote.aggregate([{ $match: { pollId } }, { $group: { _id: '$option', n: { $sum: 1 } } }]);
  const map = new Map(rows.map((r) => [r._id, r.n]));
  const total = rows.reduce((s, r) => s + r.n, 0);
  return { map, total };
}

// Для приложения: итоги видны только после своего голоса, чтобы чужой выбор не подталкивал
async function pollForUser(telegramId: number) {
  const poll: any = await Poll.findOne({ active: true }).sort({ createdAt: -1 }).lean();
  if (!poll) return null;
  const [mine, { map, total }] = await Promise.all([PollVote.findOne({ pollId: poll._id, telegramId }).lean(), counts(poll._id)]);
  const keys = [...poll.options.map((o: PollOption) => o.key), ...(poll.allowCustom ? [CUSTOM] : [])];
  const percents = keys.map((k) => (total ? Math.round(((map.get(k) || 0) * 100) / total) : 0));
  return {
    id: String(poll._id),
    question: poll.question,
    note: poll.note || '',
    options: poll.options,
    allowCustom: Boolean(poll.allowCustom),
    total,
    myVote: mine ? { option: mine.option, custom: mine.custom || '' } : null,
    results: mine ? keys.map((key, i) => ({ key, percent: percents[i] })) : null
  };
}

export function setupPollRoutes(app: Express) {
  app.get('/api/poll', telegramAuthMiddleware as any, async (req: AuthenticatedRequest, res: Response) => {
    try {
      res.json(await pollForUser(req.telegramUser!.id));
    } catch {
      res.status(500).json({ error: T.loadError });
    }
  });

  app.post('/api/poll/vote', telegramAuthMiddleware as any, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { pollId, option } = req.body || {};
      const custom = String(req.body?.custom || '').trim().slice(0, POLL_CUSTOM_MAX);
      if (!Types.ObjectId.isValid(String(pollId))) return res.status(400).json({ error: T.closed });
      const poll: any = await Poll.findOne({ _id: pollId, active: true }).lean();
      if (!poll) return res.status(410).json({ error: T.closed });
      const isCustom = option === CUSTOM;
      if (isCustom ? !poll.allowCustom || !custom : !poll.options.some((o: PollOption) => o.key === option)) {
        return res.status(400).json({ error: isCustom ? T.emptyCustom : T.badOption });
      }
      const telegramId = req.telegramUser!.id;
      await PollVote.updateOne({ pollId: poll._id, telegramId }, { $set: { option, custom: isCustom ? custom : '' } }, { upsert: true });
      res.json(await pollForUser(telegramId));
    } catch {
      res.status(500).json({ error: T.voteError });
    }
  });
}

/* ---------- Бот ---------- */

async function resultsText(poll: any) {
  const { map, total } = await counts(poll._id);
  const line = (label: string, n: number) => `${label}: <b>${n}</b>${total ? ` (${Math.round((n * 100) / total)}%)` : ''}`;
  const lines = poll.options.map((o: PollOption) => line(escapeHtml(`${o.emoji} ${o.label}`.trim()), map.get(o.key) || 0));
  if (poll.allowCustom) lines.push(line('✏️ Свой вариант', map.get(CUSTOM) || 0));
  return `🗳 <b>${escapeHtml(poll.question)}</b>\n\n${lines.join('\n')}\n\n${T.total(total)}`;
}

// Таблица без имён: вариант, своя идея, когда
async function sendCsv(chatId: number, poll: any) {
  const votes = await PollVote.find({ pollId: poll._id }).sort({ createdAt: 1 }).lean();
  const label = new Map<string, string>(poll.options.map((o: PollOption) => [o.key, o.label]));
  label.set(CUSTOM, 'Свой вариант');
  const rows = [
    ['Вариант', 'Своя идея', 'Когда'],
    ...votes.map((v: any) => [label.get(v.option) || v.option, v.custom || '', new Date(v.updatedAt).toLocaleString('ru-RU', { timeZone: 'Europe/Minsk' })])
  ];
  const form = new FormData();
  form.append('chat_id', String(chatId));
  form.append('caption', T.csvCaption(votes.length));
  form.append('document', new Blob(['﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\n')], { type: 'text/csv' }), 'opros.csv');
  await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendDocument`, { method: 'POST', body: form }).catch(() => {});
}

export async function handlePollCommand(message: any): Promise<boolean> {
  const text: string = (message.text || '').trim();
  const cmd = text.match(/^\/(poll|pollend|pollcsv)(@\w+)?(?=\s|$)/i)?.[1]?.toLowerCase();
  if (!cmd) return false;
  const chatId = message.chat.id;
  if (!isAdmin(message.from?.id)) return true;
  const current: any = await Poll.findOne({ active: true }).sort({ createdAt: -1 }).lean();

  if (cmd === 'pollend' || cmd === 'pollcsv') {
    if (!current) {
      sendWithButtons(chatId, T.none + T.usage, []);
      return true;
    }
    if (cmd === 'pollend') await Poll.updateOne({ _id: current._id }, { $set: { active: false, closedAt: new Date() } });
    await sendWithButtons(chatId, (cmd === 'pollend' ? T.ended : '') + (await resultsText(current)), []);
    await sendCsv(chatId, current);
    return true;
  }

  const body = text.replace(/^\/poll(@\w+)?/i, '').trim();
  if (!body) {
    sendWithButtons(chatId, current ? (await resultsText(current)) + T.usage : T.none + T.usage, []);
    return true;
  }

  const parts = body.split('|').map((s) => s.trim()).filter(Boolean);
  const [head, ...rawOptions] = parts;
  const [question, ...noteLines] = head.split('\n').map((s) => s.trim());
  const allowCustom = rawOptions.some((o) => /^(✏️\s*)?свой вариант$/i.test(o));
  const options = rawOptions.filter((o) => !/^(✏️\s*)?свой вариант$/i.test(o)).slice(0, MAX_OPTIONS).map(parseOption);
  if (!question || question.length > 140 || options.length + Number(allowCustom) < 2 || options.some((o) => !o.label || o.label.length > 60 || !o.short)) {
    sendWithButtons(chatId, T.bad + T.usage, []);
    return true;
  }

  await Poll.updateMany({ active: true }, { $set: { active: false, closedAt: new Date() } });
  const poll = await Poll.create({ question, note: noteLines.join(' ').slice(0, 300), options, allowCustom });
  sendWithButtons(chatId, T.created + (await resultsText(poll)) + (current ? T.replaced : ''), []);
  return true;
}
