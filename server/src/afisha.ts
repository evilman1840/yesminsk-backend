import { Express, Response } from 'express';
import mongoose from 'mongoose';
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';
import { telegramAuthMiddleware, AuthenticatedRequest } from './middleware/telegramAuth';
import { CityEvent, CITY_EVENT_CATEGORIES, ICityEvent } from './models/CityEvent';
import { escapeHtml, sendTelegramMessage } from './utils/telegramNotify';
import { sendWithButtons } from './wishes';
import { geocode } from './places';
import { isAdmin, adminIds } from './news';

/**
 * Афиша города: читаем публичные минские каналы (веб-версия t.me/s/…, без аккаунта),
 * Claude Haiku раскладывает пост по полям, автор одобряет карточку в боте.
 * Текст постов не копируем: своё короткое описание и ссылка на источник.
 *
 * Боту (только админам):
 *   /afisha      — прочитать каналы сейчас и показать, сколько ждёт одобрения
 *   /afisha list — прислать карточки всех, кто ждёт
 */

// Каналы можно поменять без кода: AFISHA_CHANNELS=minsk_kuda,Minsk_kudaGo
const channels = () =>
  (process.env.AFISHA_CHANNELS || 'minsk_kuda,Minsk_kudaGo')
    .split(',')
    .map((s) => s.trim().replace(/^@/, ''))
    .filter(Boolean);

const MODEL = 'claude-haiku-5-5';
const MAX_AGE_DAYS = 14; // посты старше — не разбираем (первый запуск не тянет весь архив)
const EVERY_HOURS = 3;

// ---------- Чтение канала ----------

interface ChannelPost {
  key: string; // «minsk_kuda/1234»
  url: string;
  postedAt: Date;
  text: string;
  photoUrl: string;
}

const decode = (s: string) =>
  s
    .replace(/<br\s*\/?>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, '&')
    .trim();

// Последние ~20 постов канала из веб-версии
export async function fetchChannelPosts(channel: string): Promise<ChannelPost[]> {
  const res = await fetch(`https://t.me/s/${encodeURIComponent(channel)}`, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; YesMinskAfisha/1.0)', 'Accept-Language': 'ru' }
  });
  if (!res.ok) throw new Error(`t.me/s/${channel}: ${res.status}`);
  const html = await res.text();
  const posts: ChannelPost[] = [];
  for (const block of html.split('<div class="tgme_widget_message_wrap').slice(1)) {
    const key = block.match(/data-post="([^"]+)"/)?.[1];
    const date = block.match(/<time[^>]+datetime="([^"]+)"/)?.[1];
    const body = block.match(/<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/)?.[1];
    if (!key || !date || !body) continue;
    posts.push({
      key,
      url: `https://t.me/${key}`,
      postedAt: new Date(date),
      text: decode(body),
      photoUrl: block.match(/tgme_widget_message_photo_wrap[^>]+background-image:url\('([^']+)'\)/)?.[1] || ''
    });
  }
  return posts;
}

// ---------- Разбор поста ----------

const Parsed = z.object({
  isEvent: z.boolean().describe('true — анонс конкретного события в Минске, которое можно посетить. false — реклама канала, новость, ТВ-шоу, розыгрыш, событие не в Минске'),
  title: z.string().describe('Название события, коротко, без эмодзи'),
  summary: z.string().describe('Одна-две фразы своими словами, что там будет. Не копировать текст поста'),
  category: z.enum(CITY_EVENT_CATEGORIES),
  startDate: z.string().describe('Первый день, YYYY-MM-DD. Пусто, если дат нет'),
  endDate: z.string().describe('Последний день, YYYY-MM-DD. У разового события = startDate. У выставки «по 14 декабря» — 14 декабря'),
  when: z.string().describe('Когда, коротко для людей: «25 октября (вс), 17:00» или «по 14 декабря, пн-чт 12:00–20:00»'),
  venue: z.string().describe('Название площадки: «Эхо», «ТРЦ Galileo»'),
  address: z.string().describe('Улица и дом в Минске, без названия площадки и пояснений про вход'),
  price: z.string().describe('Как в посте: «Вход свободный», «любая купюра», «от 75 BYN»'),
  isFree: z.boolean().describe('true — вход свободный или «любая купюра»/донат'),
  indoor: z.boolean().describe('true — под крышей (зал, ТРЦ, музей, библиотека)'),
  kidsOk: z.boolean().describe('true — подходит детям или прямо написано про детей и семьи')
});
type ParsedEvent = z.infer<typeof Parsed>;

const SYSTEM = `Ты разбираешь посты минских Telegram-каналов с афишей и заполняешь карточку события.
Отвечай по-русски. Пиши только то, что есть в посте, ничего не выдумывай.
В постах обычно нет года: бери ближайшую дату не раньше даты поста.
Если в одном посте несколько показов (кинопоказы с расписанием), это одно событие: startDate — первый показ, endDate — последний.
Розыгрыш или конкурс ("разыгрываем билеты", "подпишись и выиграй") — всегда isEvent: false, даже если событие настоящее.`;

let client: Anthropic | null = null;
const getClient = () => (client ||= new Anthropic());

export async function parsePost(post: ChannelPost): Promise<ParsedEvent | null> {
  const response = await getClient().messages.parse({
    model: MODEL,
    max_tokens: 2000,
    output_config: { effort: 'low', format: zodOutputFormat(Parsed) },
    system: SYSTEM,
    messages: [{ role: 'user', content: `Дата поста: ${post.postedAt.toISOString().slice(0, 10)}\n\n${post.text}` }]
  });
  if (response.stop_reason === 'refusal' || response.stop_reason === 'max_tokens') return null;
  return response.parsed_output;
}

const toDate = (s: string) => (/^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(`${s}T00:00:00+03:00`) : undefined);
// Полночь сегодняшнего дня по Минску — даты событий храним так же
const minskToday = () => toDate(new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString().slice(0, 10))!;

// ---------- Дубли ----------

// «Концерт «Комната #7»» → {концерт, комната, 7}
const words = (s: string) =>
  new Set(
    s
      .toLowerCase()
      .replace(/ё/g, 'е')
      .replace(/[^a-zа-я0-9]+/g, ' ')
      .split(' ')
      .filter((w) => w.length > 2)
  );

const similar = (a: string, b: string) => {
  const A = words(a);
  const B = words(b);
  if (!A.size || !B.size) return false;
  let common = 0;
  A.forEach((w) => B.has(w) && common++);
  return common / Math.min(A.size, B.size) >= 0.6;
};

// То же событие из другого канала: похожее название и даты пересекаются
async function findDuplicate(ev: { channel: string; title: string; startDate?: Date; endDate?: Date }) {
  if (!ev.startDate || !ev.endDate) return null;
  const candidates = await CityEvent.find({
    isEvent: true,
    dupOf: { $exists: false },
    startDate: { $lte: ev.endDate },
    endDate: { $gte: ev.startDate }
  }).lean();
  return candidates.find((c) => similar(c.title, ev.title)) || null;
}

// ---------- Карточка автору ----------

const dateKey = (d?: Date) => (d ? d.toISOString().slice(0, 10) : '');

function cardHtml(e: ICityEvent | any) {
  return [
    `🎟 <b>${escapeHtml(e.title)}</b>`,
    e.summary ? escapeHtml(e.summary) : '',
    '',
    `⏰ ${escapeHtml(e.when || '—')}`,
    `📍 ${escapeHtml([e.venue, e.address].filter(Boolean).join(', ') || '—')}${e.coords ? '' : ' <i>(не нашёл на карте)</i>'}`,
    `💵 ${escapeHtml(e.price || '—')}`,
    [e.isFree ? '🆓 бесплатно' : '', e.indoor ? '🏠 под крышей' : '🌳 на улице', e.kidsOk ? '👶 с детьми' : ''].filter(Boolean).join(' · '),
    '',
    `<i>Источник: <a href="${e.sourceUrl}">@${escapeHtml(e.channel)}</a> · даты ${dateKey(e.startDate)}…${dateKey(e.endDate)}</i>`
  ]
    .filter((l, i, a) => l || a[i - 1])
    .join('\n');
}

const sendCard = (chatId: number, e: any) =>
  sendWithButtons(chatId, cardHtml(e), [
    [
      { text: '✅ В афишу', data: `aff:ok:${e._id}` },
      { text: '❌ Нет', data: `aff:no:${e._id}` }
    ],
    [{ text: '🔗 Открыть пост', url: e.sourceUrl }]
  ]);

// ---------- Обход каналов ----------

let running = false;

export async function runAfisha(): Promise<{ read: number; events: number; dups: number; errors: number }> {
  const stats = { read: 0, events: 0, dups: 0, errors: 0 };
  if (running || !process.env.ANTHROPIC_API_KEY) return stats;
  running = true;
  try {
    const minDate = new Date(Date.now() - MAX_AGE_DAYS * 24 * 60 * 60 * 1000);
    const today = minskToday();
    for (const channel of channels()) {
      let posts: ChannelPost[] = [];
      try {
        posts = await fetchChannelPosts(channel);
      } catch (err: any) {
        stats.errors++;
        console.warn('⚠️ Афиша, канал:', err?.message || err);
        continue;
      }
      for (const post of posts) {
        if (post.postedAt < minDate || (await CityEvent.exists({ postKey: post.key }))) continue;
        stats.read++;
        let parsed: ParsedEvent | null = null;
        try {
          parsed = await parsePost(post);
        } catch (err: any) {
          stats.errors++;
          console.warn('⚠️ Афиша, разбор поста:', post.key, err?.message || err);
          continue; // не сохраняем — попробуем в следующий раз
        }
        const base = { postKey: post.key, channel, sourceUrl: post.url, postedAt: post.postedAt, photoUrl: post.photoUrl };
        if (!parsed?.isEvent) {
          await CityEvent.create({ ...base, isEvent: false, status: 'skipped' });
          continue;
        }
        const startDate = toDate(parsed.startDate);
        const endDate = toDate(parsed.endDate) || startDate;
        const dup = await findDuplicate({ channel, title: parsed.title, startDate, endDate });
        const found = parsed.address ? await geocode(parsed.address).catch(() => null) : null;
        const ev = await CityEvent.create({
          ...base,
          ...parsed,
          title: parsed.title.slice(0, 200),
          summary: parsed.summary.slice(0, 400),
          startDate,
          endDate,
          coords: found?.coords,
          dupOf: dup ? String(dup._id) : undefined,
          // Прошедшие и дубли автору не показываем
          status: dup || !endDate || endDate < today ? 'skipped' : 'pending'
        });
        if (dup) stats.dups++;
        if (ev.status !== 'pending') continue;
        stats.events++;
        for (const id of adminIds()) await sendCard(id, ev);
      }
    }
  } finally {
    running = false;
  }
  if (stats.read) console.log(`🎟 Афиша: разобрано ${stats.read}, новых событий ${stats.events}, дублей ${stats.dups}`);
  return stats;
}

export function startAfishaLoop() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log('ℹ️ Афиша выключена: нет ANTHROPIC_API_KEY');
    return;
  }
  const run = () => runAfisha().catch((err) => console.warn('⚠️ Ошибка афиши:', err?.message || err));
  setTimeout(run, 2 * 60 * 1000);
  setInterval(run, EVERY_HOURS * 60 * 60 * 1000);
}

// ---------- Бот ----------

export async function handleAfishaCommand(message: any): Promise<boolean> {
  const text: string = (message.text || '').trim();
  const m = text.match(/^\/afisha(@\w+)?\s*(list)?/i);
  if (!m || !isAdmin(message.from?.id)) return false;
  const chatId = message.chat.id;
  if (!process.env.ANTHROPIC_API_KEY) {
    sendTelegramMessage(chatId, 'Афиша выключена: на сервере нет ANTHROPIC_API_KEY.');
    return true;
  }
  if (m[2]) {
    const pending = await CityEvent.find({ status: 'pending' }).sort({ startDate: 1 }).limit(20).lean();
    if (!pending.length) sendTelegramMessage(chatId, 'Одобрения никто не ждёт 🙂');
    for (const e of pending) await sendCard(chatId, e);
    return true;
  }
  sendTelegramMessage(chatId, `🎟 Читаю каналы: ${channels().map((c) => '@' + c).join(', ')}…`);
  const s = await runAfisha();
  const pending = await CityEvent.countDocuments({ status: 'pending' });
  sendTelegramMessage(
    chatId,
    `Готово. Новых постов: ${s.read}, событий: ${s.events}, дублей: ${s.dups}${s.errors ? `, ошибок: ${s.errors}` : ''}.\nЖдут одобрения: ${pending}. Показать все: /afisha list`
  );
  return true;
}

// Кнопки карточки: aff:ok:<id> / aff:no:<id>
export async function handleAfishaCallback(query: any): Promise<boolean> {
  const data: string = query.data || '';
  if (!data.startsWith('aff:')) return false;
  const call = (method: string, body: any) =>
    fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).catch(() => {});
  call('answerCallbackQuery', { callback_query_id: query.id });
  if (!isAdmin(query.from?.id)) return true;
  const [, action, id] = data.split(':');
  const e = mongoose.Types.ObjectId.isValid(id) ? await CityEvent.findById(id) : null;
  if (!e || e.status !== 'pending') return true;
  e.status = action === 'ok' ? 'approved' : 'rejected';
  await e.save();
  call('editMessageReplyMarkup', { chat_id: query.message?.chat?.id, message_id: query.message?.message_id, reply_markup: { inline_keyboard: [] } });
  sendTelegramMessage(query.message.chat.id, e.status === 'approved' ? `✅ «${escapeHtml(e.title)}» в афише` : `❌ «${escapeHtml(e.title)}» пропускаем`);
  return true;
}

// ---------- Приложение ----------

export function setupAfishaRoutes(app: Express) {
  // Одобренные события, которые ещё не закончились. ?free=1 — бесплатные, ?indoor=1 — под крышей, ?days=7 — на ближайшие дни
  app.get('/api/afisha', telegramAuthMiddleware as any, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const today = minskToday();
      const q: any = { status: 'approved', endDate: { $gte: today } };
      if (req.query.free === '1') q.isFree = true;
      if (req.query.indoor === '1') q.indoor = true;
      const days = Number(req.query.days);
      if (days > 0) q.startDate = { $lte: new Date(today.getTime() + days * 24 * 60 * 60 * 1000) };
      const events = await CityEvent.find(q, { postKey: 0, isEvent: 0, dupOf: 0, status: 0 }).sort({ startDate: 1 }).limit(100).lean();
      res.json(events);
    } catch {
      res.status(500).json({ error: 'Не получилось загрузить афишу' });
    }
  });
}
