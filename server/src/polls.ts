import { Express, Response } from 'express';
import { Schema, model, Types } from 'mongoose';
import { telegramAuthMiddleware, AuthenticatedRequest } from './middleware/telegramAuth';
import { isAdmin } from './news';
import { User } from './models/User';
import { Reaction } from './models/Reaction';
import { DirectMessage } from './models/DirectMessage';
import { escapeHtml } from './utils/telegramNotify';
import { sendWithButtons } from './wishes';
import { csvCell } from './utils/csv';
import { POLL_TEXTS as T } from './texts';

/**
 * Опрос автора: один на всех, подпись в шапке карты зовёт голосовать, в шторке — варианты и итоги.
 * Отметить можно несколько вариантов; процент — доля проголосовавших, выбравших вариант (в сумме бывает больше 100).
 *
 * Боту (только автор):
 *   /poll Вопрос | 🐾 Вариант = коротко | ☕ Вариант | Свой вариант   — новый опрос (прошлый закрывается)
 *     «= коротко» — имя варианта для строки в шапке после голоса: «Донаты → 🐾 приют»
 *     вторая строка вопроса — пояснение под ним; «Свой вариант» — поле для своей идеи
 *     строка «шапка: Ты в игре? 🎲» — своя подпись в шапке карты (без неё — «Нужен твой совет»)
 *     строка «кнопка: 🎲 Сыграть партию -> игры» — кнопка после голоса, ведёт во вкладку
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
      pill: { type: String, default: '', maxlength: 30 },
      action: { text: { type: String, default: '' }, tab: { type: String, default: '' } },
      active: { type: Boolean, default: true, index: true },
      closedAt: Date
    },
    { timestamps: true }
  )
);

// Один голос на человека (с одним или несколькими вариантами): переголосовать можно, пока опрос идёт
const PollVote = model(
  'PollVote',
  new Schema(
    {
      pollId: { type: Schema.Types.ObjectId, required: true, index: true },
      telegramId: { type: Number, required: true },
      options: { type: [String], default: [] }, // ключи вариантов и/или 'custom'
      option: { type: String, default: '' },    // старые голоса: один вариант
      custom: { type: String, default: '', maxlength: 200 }
    },
    { timestamps: true }
  ).index({ pollId: 1, telegramId: 1 }, { unique: true })
);

// Лог точечной рассылки по выбранным вариантам опроса + база для отслеживания дальнейших действий (/polltrack и /stats)
const PollPushLog = model(
  'PollPushLog',
  new Schema(
    {
      pollId: { type: Schema.Types.ObjectId, required: true, index: true },
      telegramId: { type: Number, required: true },
      optionKeys: { type: [String], default: [] },
      sentAt: { type: Date, required: true },
      delivered: { type: Boolean, default: false }
    },
    { timestamps: true }
  ).index({ pollId: 1, telegramId: 1 }, { unique: true })
);

// Лог массового анонса (например, /chatpush): один раз на человека по ключу кампании
const CampaignPushLog = model(
  'CampaignPushLog',
  new Schema(
    {
      campaign: { type: String, required: true, index: true },
      telegramId: { type: Number, required: true },
      sentAt: { type: Date, required: true },
      delivered: { type: Boolean, default: false }
    },
    { timestamps: true }
  ).index({ campaign: 1, telegramId: 1 }, { unique: true })
);

const CHAT_COMFORT_CAMPAIGN = 'chat_comfort_2026_11';
const CHAT_COMFORT_PUSH_HTML =
  `Привет! У нас в «ГУЛЯЙ!» появился <b>личный чат прямо внутри приложения</b> 💬\n\n` +
  `Теперь после взаимного 👋 можно спокойно переписываться здесь, не светя свой Telegram. Если человек не подходит, его можно скрыть одним нажатием.\n\n` +
  `А ещё в анкете (вкладка «Я» → «Комфортно») появились тайные галочки для тех, кто ищет серьёзные отношения или близость. Их видят <b>только те, кто выбрал то же самое</b> - для всех остальных всё остаётся чисто по-дружески.\n\n` +
  `Загляни проверить свою анкету!`;

const CUSTOM = 'custom';
// «кнопка: … -> игры»: куда ведёт кнопка после голоса
const ACTION_TABS: Record<string, string> = { игры: 'games', люди: 'feed', сходки: 'events', места: 'places', карта: 'main' };
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

// Варианты голоса: новые — списком, старые — одним полем
const optionsOf = (v: any): string[] => (v?.options?.length ? v.options : v?.option ? [v.option] : []);

// map — сколько человек отметили вариант, total — сколько человек проголосовало
async function counts(pollId: Types.ObjectId) {
  const votes = await PollVote.find({ pollId }, { options: 1, option: 1 }).lean();
  const map = new Map<string, number>();
  for (const v of votes) for (const k of new Set(optionsOf(v))) map.set(k, (map.get(k) || 0) + 1);
  return { map, total: votes.length };
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
    pill: poll.pill || '',
    action: poll.action?.text && poll.action?.tab ? { text: poll.action.text, tab: poll.action.tab } : null,
    total,
    myVote: mine ? { options: optionsOf(mine), custom: mine.custom || '' } : null,
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
      // { options: ['o1', 'custom'], custom } — несколько вариантов; { option } — старое приложение, один
      const { pollId } = req.body || {};
      const raw = Array.isArray(req.body?.options) ? req.body.options : [req.body?.option];
      const options = [...new Set(raw.map(String))].slice(0, MAX_OPTIONS + 1) as string[];
      const custom = String(req.body?.custom || '').trim().slice(0, POLL_CUSTOM_MAX);
      if (!Types.ObjectId.isValid(String(pollId))) return res.status(400).json({ error: T.closed });
      const poll: any = await Poll.findOne({ _id: pollId, active: true }).lean();
      if (!poll) return res.status(410).json({ error: T.closed });
      const hasCustom = options.includes(CUSTOM);
      if (hasCustom && (!poll.allowCustom || !custom)) return res.status(400).json({ error: T.emptyCustom });
      if (!options.length || options.some((k) => k !== CUSTOM && !poll.options.some((o: PollOption) => o.key === k))) {
        return res.status(400).json({ error: T.badOption });
      }
      const telegramId = req.telegramUser!.id;
      await PollVote.updateOne({ pollId: poll._id, telegramId }, { $set: { options, option: '', custom: hasCustom ? custom : '' } }, { upsert: true });
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

// Таблица без имён: варианты, своя идея, когда
async function sendCsv(chatId: number, poll: any) {
  const votes = await PollVote.find({ pollId: poll._id }).sort({ createdAt: 1 }).lean();
  const label = new Map<string, string>(poll.options.map((o: PollOption) => [o.key, o.label]));
  label.set(CUSTOM, 'Свой вариант');
  const rows = [
    ['Варианты', 'Своя идея', 'Когда'],
    ...votes.map((v: any) => [optionsOf(v).map((k) => label.get(k) || k).join('; '), v.custom || '', new Date(v.updatedAt).toLocaleString('ru-RU', { timeZone: 'Europe/Minsk' })])
  ];
  const form = new FormData();
  form.append('chat_id', String(chatId));
  form.append('caption', T.csvCaption(votes.length));
  form.append('document', new Blob(['﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\n')], { type: 'text/csv' }), 'opros.csv');
  await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendDocument`, { method: 'POST', body: form }).catch(() => {});
}

export async function pollPushStatsLines(): Promise<string[]> {
  const latestLog: any = await PollPushLog.findOne({ delivered: true }).sort({ sentAt: -1 }).lean();
  if (!latestLog) return [];
  const pollId = latestLog.pollId;
  const logs: any[] = await PollPushLog.find({ pollId, delivered: true }, { telegramId: 1, sentAt: 1, optionKeys: 1 }).lean();
  if (!logs.length) return [];

  const sentAtByUser = new Map<number, number>(logs.map((l) => [l.telegramId, new Date(l.sentAt).getTime()]));
  const ids = [...sentAtByUser.keys()];
  const minSentAt = new Date(Math.min(...sentAtByUser.values()));

  const [poll, users, reactions, messages] = await Promise.all([
    Poll.findById(pollId, { question: 1 }).lean() as Promise<any>,
    User.find(
      { telegramId: { $in: ids } },
      { telegramId: 1, lastActiveAt: 1, openToSerious: 1, openToCasual: 1, casualPace: 1 }
    ).lean(),
    Reaction.find(
      {
        fromTelegramId: { $in: ids },
        type: 'like',
        $or: [{ likedAt: { $gte: minSentAt } }, { directChatOpenedAt: { $gte: minSentAt } }]
      },
      { fromTelegramId: 1, likedAt: 1, directChatOpenedAt: 1 }
    ).lean(),
    DirectMessage.find(
      { senderId: { $in: ids }, createdAt: { $gte: minSentAt } },
      { senderId: 1, createdAt: 1 }
    ).lean()
  ]);

  let returned = 0;
  let serious = 0;
  let casual = 0;
  const paces = { chat_first: 0, coffee_first: 0, direct: 0 };
  for (const u of users) {
    const since = sentAtByUser.get(u.telegramId) || 0;
    if (u.lastActiveAt && new Date(u.lastActiveAt).getTime() >= since) returned++;
    if (u.openToSerious) serious++;
    if (u.openToCasual) {
      casual++;
      const p = (u.casualPace || 'chat_first') as keyof typeof paces;
      if (p in paces) paces[p]++;
    }
  }

  const wavedSet = new Set<number>();
  const openedChatSet = new Set<number>();
  for (const r of reactions) {
    const since = sentAtByUser.get(r.fromTelegramId) || 0;
    if (r.likedAt && new Date(r.likedAt).getTime() >= since) wavedSet.add(r.fromTelegramId);
    if (r.directChatOpenedAt && new Date(r.directChatOpenedAt).getTime() >= since) openedChatSet.add(r.fromTelegramId);
  }

  const wroteChatSet = new Set<number>();
  for (const m of messages) {
    const since = sentAtByUser.get(m.senderId) || 0;
    if (m.createdAt && new Date(m.createdAt).getTime() >= since) wroteChatSet.add(m.senderId);
  }

  const total = ids.length;
  const pct = (n: number) => (total ? `${Math.round((n * 100) / total)}%` : '0%');
  const title = poll?.question ? ` (${escapeHtml(String(poll.question).slice(0, 40))})` : '';
  const paceLine = casual ? ` (💬 ${paces.chat_first} · ☕ ${paces.coffee_first} · ⚡ ${paces.direct})` : '';

  return [
    `📣 <b>Когорта пуша по опросу</b>${title}`,
    `Получили пуш: ${total} · зашли после пуша: ${returned} (${pct(returned)})`,
    `Включили ❤️ Отношения: ${serious} · 🔥 Близость: ${casual}${paceLine}`,
    `После пуша: 👋 поставили ${wavedSet.size} · открыли чат ${openedChatSet.size} · написали в чат ${wroteChatSet.size}`
  ];
}

export async function handlePollCommand(message: any): Promise<boolean> {
  const text: string = (message.text || '').trim();
  const cmd = text.match(/^\/(poll|pollend|pollcsv|pollpush|polltrack|chatpush)(@\w+)?(?=\s|$)/i)?.[1]?.toLowerCase();
  if (!cmd) return false;
  const chatId = message.chat.id;
  if (!isAdmin(message.from?.id)) return true;

  if (cmd === 'chatpush') {
    const arg = text.replace(/^\/chatpush(@\w+)?/i, '').trim().toLowerCase();
    const [pollPushedIds, alreadyCampaignIds, alreadySetCount] = await Promise.all([
      PollPushLog.distinct('telegramId', {}),
      CampaignPushLog.distinct('telegramId', { campaign: CHAT_COMFORT_CAMPAIGN }),
      User.countDocuments({
        hasAgreedToRules: true,
        isBanned: { $ne: true },
        $or: [{ openToSerious: true }, { openToCasual: true }]
      })
    ]);
    const excludeIds = [...new Set([...(pollPushedIds as number[]), ...(alreadyCampaignIds as number[])])];
    const recipients = await User.find(
      {
        hasAgreedToRules: true,
        isBanned: { $ne: true },
        canMessage: { $ne: false },
        openToSerious: { $ne: true },
        openToCasual: { $ne: true },
        ...(excludeIds.length ? { telegramId: { $nin: excludeIds } } : {})
      },
      { telegramId: 1 }
    ).lean();

    if (arg !== 'send') {
      await sendWithButtons(
        chatId,
        `📣 <b>Предпросмотр /chatpush (анонс чата и «Комфортно»)</b>\n\n` +
          `Получат пуш: <b>${recipients.length}</b> чел.\n` +
          `Исключено:\n` +
          `• уже получили пуш по опросу: ${pollPushedIds.length}\n` +
          `• уже включили галочки в «Комфортно»: ${alreadySetCount}\n` +
          `• уже получили этот пуш ранее: ${alreadyCampaignIds.length}\n\n` +
          `<b>Текст сообщения:</b>\n${CHAT_COMFORT_PUSH_HTML}\n\n` +
          `Чтобы реально запустить рассылку, отправь:\n<code>/chatpush send</code>`,
        []
      );
      return true;
    }

    await sendWithButtons(chatId, `⏳ Запускаю рассылку /chatpush для ${recipients.length} чел.…`, []);
    let deliveredCount = 0;
    let failedCount = 0;
    for (const u of recipients) {
      const sent = await sendWithButtons(u.telegramId, CHAT_COMFORT_PUSH_HTML, [
        [{ text: '⚙️ Проверить анкету', path: '?tab=profile&fromPush=1' }],
        [{ text: '💬 Открыть «На связи»', path: '?tab=feed&fromPush=1' }]
      ]).catch(() => false);
      const ok = Boolean(sent);
      if (ok) deliveredCount++;
      else failedCount++;
      await CampaignPushLog.updateOne(
        { campaign: CHAT_COMFORT_CAMPAIGN, telegramId: u.telegramId },
        { $setOnInsert: { campaign: CHAT_COMFORT_CAMPAIGN, telegramId: u.telegramId, sentAt: new Date(), delivered: ok } },
        { upsert: true }
      ).catch(() => {});
      await new Promise((r) => setTimeout(r, 60));
    }

    await sendWithButtons(
      chatId,
      `✅ <b>Рассылка /chatpush завершена</b>\nДоставлено: <b>${deliveredCount}</b> · не дошло: ${failedCount}`,
      []
    );
    return true;
  }

  if (cmd === 'polltrack') {
    const lines = await pollPushStatsLines();
    await sendWithButtons(chatId, lines.length ? lines.join('\n') : 'По опросам ещё не отправляли пуш (/pollpush).', []);
    return true;
  }

  if (cmd === 'pollpush') {
    const latestPoll: any = await Poll.findOne().sort({ createdAt: -1 }).lean();
    if (!latestPoll) {
      await sendWithButtons(chatId, 'Опросов в базе пока нет.', []);
      return true;
    }
    const rawArgs = text.replace(/^\/pollpush(@\w+)?/i, '').trim();
    const pipeIdx = rawArgs.indexOf('|');
    const keysRaw = (pipeIdx === -1 ? rawArgs : rawArgs.slice(0, pipeIdx)).trim();
    const pushBody = pipeIdx === -1 ? '' : rawArgs.slice(pipeIdx + 1).trim();

    const validKeys = new Set<string>(latestPoll.options.map((o: PollOption) => o.key));
    const chosenKeys = keysRaw
      ? keysRaw.split(/[\s,]+/).map((s) => s.trim().toLowerCase()).filter((k) => validKeys.has(k))
      : [];

    if (!chosenKeys.length) {
      const { map } = await counts(latestPoll._id);
      const list = latestPoll.options
        .map((o: PollOption) => `<code>${o.key}</code> — ${escapeHtml(`${o.emoji} ${o.label}`.trim())} (<b>${map.get(o.key) || 0}</b>)`)
        .join('\n');
      await sendWithButtons(
        chatId,
        `📣 <b>Пуш по последнему опросу</b>\n«${escapeHtml(latestPoll.question)}»\n\nВарианты:\n${list}\n\n` +
          `Сначала проверь число получателей:\n<code>/pollpush o1,o2</code>\n\n` +
          `Чтобы реально отправить:\n<code>/pollpush o1,o2 | Текст сообщения</code>`,
        []
      );
      return true;
    }

    const votes = await PollVote.find(
      {
        pollId: latestPoll._id,
        $or: [{ options: { $in: chosenKeys } }, { option: { $in: chosenKeys } }]
      },
      { telegramId: 1 }
    ).lean();
    const voterIds = [...new Set(votes.map((v: any) => v.telegramId))];
    const alreadySent = new Set<number>(
      (await PollPushLog.find({ pollId: latestPoll._id, telegramId: { $in: voterIds } }, { telegramId: 1 }).lean()).map((l: any) => l.telegramId)
    );
    const pendingIds = voterIds.filter((id) => !alreadySent.has(id));
    const reachable = await User.find(
      { telegramId: { $in: pendingIds }, isBanned: { $ne: true }, canMessage: { $ne: false } },
      { telegramId: 1 }
    ).lean();

    if (!pushBody) {
      await sendWithButtons(
        chatId,
        `📣 <b>Предпросмотр /pollpush</b>\nОпрос: «${escapeHtml(latestPoll.question)}»\nВарианты: <code>${chosenKeys.join(', ')}</code>\n\n` +
          `Проголосовало: <b>${voterIds.length}</b>\nУже получали пуш: ${alreadySent.size}\nДоступно для бота сейчас: <b>${reachable.length}</b>\n\n` +
          `Для отправки пришли:\n<code>/pollpush ${chosenKeys.join(',')} | Текст пуша</code>`,
        []
      );
      return true;
    }

    await sendWithButtons(chatId, `⏳ Запускаю рассылку для ${reachable.length} чел. по вариантам ${chosenKeys.join(', ')}…`, []);
    let deliveredCount = 0;
    let failedCount = 0;
    const html = escapeHtml(pushBody);
    for (const u of reachable) {
      const sent = await sendWithButtons(u.telegramId, html, [
        [{ text: '⚙️ Открыть «Комфортно»', path: '?tab=profile&fromPush=1' }],
        [{ text: '💬 Открыть «На связи»', path: '?tab=feed&fromPush=1' }]
      ]).catch(() => false);
      const ok = Boolean(sent);
      if (ok) deliveredCount++;
      else failedCount++;
      await PollPushLog.updateOne(
        { pollId: latestPoll._id, telegramId: u.telegramId },
        { $setOnInsert: { pollId: latestPoll._id, telegramId: u.telegramId, optionKeys: chosenKeys, sentAt: new Date(), delivered: ok } },
        { upsert: true }
      ).catch(() => {});
      await new Promise((r) => setTimeout(r, 60));
    }

    await sendWithButtons(
      chatId,
      `✅ <b>Рассылка по опросу завершена</b>\nДоставлено: <b>${deliveredCount}</b> · не дошло: ${failedCount}\n\n` +
        `Дальнейшие действия этих людей теперь отслеживаются по команде /polltrack и в /stats.`,
      []
    );
    return true;
  }

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
  const [question, ...headLines] = head.split('\n').map((s) => s.trim()).filter(Boolean);
  const special = (name: string) => headLines.find((l) => l.toLowerCase().startsWith(name + ':'))?.slice(name.length + 1).trim() || '';
  const pill = special('шапка');
  const actionRaw = special('кнопка');
  const [actionText = '', actionTabRaw = ''] = actionRaw.split('->').map((s) => s.trim());
  const action = actionRaw ? { text: actionText, tab: ACTION_TABS[actionTabRaw.toLowerCase()] || '' } : null;
  const noteLines = headLines.filter((l) => !/^(шапка|кнопка):/i.test(l));
  const allowCustom = rawOptions.some((o) => /^(✏️\s*)?свой вариант$/i.test(o));
  const options = rawOptions.filter((o) => !/^(✏️\s*)?свой вариант$/i.test(o)).slice(0, MAX_OPTIONS).map(parseOption);
  if (
    !question || question.length > 140 || options.length + Number(allowCustom) < 2 || options.some((o) => !o.label || o.label.length > 60 || !o.short) ||
    pill.length > 30 || (action && (!action.text || action.text.length > 40 || !action.tab))
  ) {
    sendWithButtons(chatId, T.bad + T.usage, []);
    return true;
  }

  await Poll.updateMany({ active: true }, { $set: { active: false, closedAt: new Date() } });
  const poll = await Poll.create({ question, note: noteLines.join(' ').slice(0, 300), options, allowCustom, pill, action: action || undefined });
  const extras = [pill && `Шапка: <b>${escapeHtml(pill)}</b>`, action && `Кнопка после голоса: <b>${escapeHtml(action.text)}</b> → ${actionTabRaw}`].filter(Boolean).join('\n');
  sendWithButtons(chatId, T.created + (await resultsText(poll)) + (extras ? `\n\n${extras}` : '') + (current ? T.replaced : ''), []);
  return true;
}
