import { Express, Response } from 'express';
import mongoose, { Schema, model } from 'mongoose';
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';
import { telegramAuthMiddleware, AuthenticatedRequest } from './middleware/telegramAuth';
import { Event, EVENT_CATEGORIES, EventCategory, IEvent } from './models/Event';
import { User } from './models/User';
import { geocode } from './places';
import { isAdmin, adminIds } from './news';
import { NO_PHOTO } from './avatars';
import { escapeHtml, sendTelegramMessage, userMentionHtml } from './utils/telegramNotify';
import { AREA_COORDINATES } from './profile/areas';

/**
 * Находки из Threads для ГУЛЯЙ!:
 * 1) Админ кидает боту ссылку (или сразу пачку ссылок) threads.com/share/... или threads.com/@.../post/...
 *    (если пост закрыт экраном входа, можно прислать ссылку + скопированный текст в одном сообщении).
 * 2) Сервер читает OpenGraph-метаданные поста, Claude Haiku определяет тип (готовая встреча, постоянный ведущий,
 *    человек ищет компанию или пропуск), собирает карточку и живой тёплый ответ автору.
 * 3) По кнопке «✅ В Сходки» встреча появляется в ленте Сходок и на Карте с пометкой «🌐 Из Threads»,
 *    возможностью нашим участникам собраться туда за компанию и кнопкой «Забрать встречу себе» для самого автора.
 */

const MODEL = 'claude-haiku-5-5';
const MINSK_CENTER: [number, number] = [53.9045, 27.5615]; // [lat, lng]
const THREADS_URL_RE = /https?:\/\/(?:www\.)?threads\.(?:com|net)\/[^\s<>()]+/gi;

const PARSE_CATEGORIES = [
  'walk', 'cafe', 'bar', 'restaurant', 'exhibition', 'museum', 'cinema',
  'trip_outdoors', 'boardgames', 'sport', 'relax', 'learn', 'talk', 'other'
] as const;

type DraftKind = 'meetup' | 'host' | 'seeker' | 'skip';
type DraftPayment = 'free' | 'donation' | 'paid' | 'unknown';

interface IThreadsDraft {
  sourceUrl: string;
  shareUrl?: string;
  authorName: string;
  authorHandle?: string;
  rawText: string;
  kind: DraftKind;
  skipReason?: string;
  title: string;
  summary: string;
  category: EventCategory;
  customCategory?: string;
  dateTime?: Date;
  locationName: string;
  searchAddress: string;
  coords: [number, number]; // [lat, lng]
  coordsExact: boolean;
  payment: DraftPayment;
  priceByn?: number;
  priceNote?: string;
  audienceGender: 'all' | 'female' | 'male';
  authorReply: string;
  status: 'pending' | 'published' | 'skipped';
  publishedEventId?: string;
  createdAt: Date;
}

const ThreadsDraftSchema = new Schema<IThreadsDraft>(
  {
    sourceUrl: { type: String, required: true, index: true },
    shareUrl: { type: String },
    authorName: { type: String, default: 'Автор в Threads' },
    authorHandle: { type: String },
    rawText: { type: String, default: '' },
    kind: { type: String, enum: ['meetup', 'host', 'seeker', 'skip'], default: 'meetup' },
    skipReason: { type: String },
    title: { type: String, default: '' },
    summary: { type: String, default: '' },
    category: { type: String, enum: EVENT_CATEGORIES, default: 'other' },
    customCategory: { type: String, default: '' },
    dateTime: { type: Date },
    locationName: { type: String, default: 'Минск' },
    searchAddress: { type: String, default: '' },
    coords: { type: [Number], default: () => [...MINSK_CENTER] },
    coordsExact: { type: Boolean, default: false },
    payment: { type: String, enum: ['free', 'donation', 'paid', 'unknown'], default: 'unknown' },
    priceByn: { type: Number },
    priceNote: { type: String },
    audienceGender: { type: String, enum: ['all', 'female', 'male'], default: 'all' },
    authorReply: { type: String, default: '' },
    status: { type: String, enum: ['pending', 'published', 'skipped'], default: 'pending', index: true },
    publishedEventId: { type: String }
  },
  { timestamps: true }
);

export const ThreadsDraft = model<IThreadsDraft>('ThreadsDraft', ThreadsDraftSchema);

interface IThreadsAuthor {
  handle: string;
  name: string;
  profileUrl: string;
  samplePostUrl?: string;
  topic?: string;
  publishedCount: number;
  createdAt: Date;
  updatedAt: Date;
}

const ThreadsAuthorSchema = new Schema<IThreadsAuthor>(
  {
    handle: { type: String, required: true, unique: true },
    name: { type: String, default: '' },
    profileUrl: { type: String, required: true },
    samplePostUrl: { type: String },
    topic: { type: String, default: '' },
    publishedCount: { type: Number, default: 0 }
  },
  { timestamps: true }
);

export const ThreadsAuthor = model<IThreadsAuthor>('ThreadsAuthor', ThreadsAuthorSchema);

// ---------- Чтение ссылки Threads без входа и Meta API ----------

const decodeHtmlEntities = (s = '') =>
  s
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#039;/g, "'")
    .replace(/&laquo;/g, '«')
    .replace(/&raquo;/g, '»')
    .replace(/&ndash;/g, '-')
    .replace(/&mdash;/g, '-')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .trim();

const noLongDash = (s = '') => s.replace(/\s*[—–]\s*/g, ' - ').replace(/\s{2,}/g, ' ').trim();
const noLongDashMultiline = (s = '') =>
  s
    .split('\n')
    .map((line) => line.replace(/\s*[—–]\s*/g, ' - ').trimEnd())
    .join('\n')
    .trim();

function cleanRawMessageForUrls(raw: string): { urls: string[]; extraText: string } {
  // Убираем обратные слэши из скопированного Markdown («https\://www\.threads.com/share/\_2VtnPsKS/»)
  const unescaped = raw.replace(/\\([:/._-])/g, '$1');
  const matches = unescaped.match(THREADS_URL_RE) || [];
  const urls = [...new Set(matches.map((u) => u.replace(/[.,;!?)]+$/, '')))];
  let rest = unescaped;
  for (const m of matches) rest = rest.replace(m, ' ');
  const extraText = rest.replace(/\s+/g, ' ').trim();
  return { urls, extraText };
}

interface FetchedThreadsPost {
  canonicalUrl: string;
  shareUrl: string;
  authorName: string;
  authorHandle: string;
  text: string;
  restricted: boolean;
}

export async function fetchThreadsPost(rawUrl: string): Promise<FetchedThreadsPost> {
  const normalized = rawUrl.replace(/^http:\/\//i, 'https://').replace('threads.net/', 'threads.com/');
  const res = await fetch(normalized, {
    headers: {
      'User-Agent': 'facebookexternalhit/1.1',
      'Accept-Language': 'ru,en;q=0.8'
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(12000)
  });
  const html = await res.text();
  const meta = (prop: string) => {
    const m =
      html.match(new RegExp(`<meta[^>]+(?:property|name)="${prop}"[^>]+content="([\\s\\S]*?)"`, 'i')) ||
      html.match(new RegExp(`<meta[^>]+content="([\\s\\S]*?)"[^>]+(?:property|name)="${prop}"`, 'i'));
    return m ? decodeHtmlEntities(m[1]) : '';
  };
  const pageTitle = decodeHtmlEntities(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '');
  const ogTitle = meta('og:title');
  const ogDesc = meta('og:description');
  const ogUrl = meta('og:url') || res.url.split('?')[0] || normalized;

  // Пример og:title: «Валерия • дружеские знакомства (@lets_tallk) в приложении Threads»
  const handleFromTitle = ogTitle.match(/\(@([A-Za-z0-9._]+)\)/)?.[1] || '';
  const handleFromUrl = ogUrl.match(/threads\.(?:com|net)\/@([A-Za-z0-9._]+)/i)?.[1] || '';
  const authorHandle = handleFromTitle || handleFromUrl;
  const authorName = ogTitle
    .replace(/\s*\(@[A-Za-z0-9._]+\).*$/i, '')
    .replace(/\s+в приложении Threads$/i, '')
    .replace(/\s+on Threads$/i, '')
    .trim();

  const isLoginWall =
    /Threads\s*[•·-]\s*(?:Войти|Log in)/i.test(ogTitle || pageTitle) ||
    /Присоединяйтесь к Threads|Join Threads to share ideas/i.test(ogDesc);

  // В <title> иногда лежит чуть более длинный кусок текста, чем в og:description
  const cleanPageTitle = isLoginWall ? '' : pageTitle.replace(/\s*\(@[A-Za-z0-9._]+\)\s+on Threads$/i, '').trim();
  const bestText = cleanPageTitle.length > ogDesc.length ? cleanPageTitle : ogDesc;

  return {
    canonicalUrl: ogUrl.startsWith('http') ? ogUrl.split('?')[0] : normalized,
    shareUrl: normalized,
    authorName: isLoginWall ? '' : authorName || (authorHandle ? `@${authorHandle}` : 'Автор в Threads'),
    authorHandle,
    text: isLoginWall ? '' : bestText,
    restricted: isLoginWall || !bestText.trim()
  };
}

// ---------- Разбор через Claude Haiku ----------

const ParsedThreads = z.object({
  kind: z
    .enum(['meetup', 'host', 'seeker', 'skip'])
    .describe(
      'meetup - конкретная будущая встреча/сходка/мероприятие в Минске; host - регулярный клуб/ведущий/расписание в Минске без одной точной даты; seeker - человек ищет компанию («не с кем пойти»); skip - прошедшая дата, другой город (не Минск), чистая реклама товара/услуги без групповой встречи'
    ),
  skipReason: z.string().describe('Если kind = skip, коротко почему (например: «Уже прошло 25 октября» или «Гродно, не Минск»). Иначе пусто'),
  title: z.string().describe('Короткое тёплое название встречи или клуба до 85 символов, без капслока и без длинных тире'),
  summary: z
    .string()
    .describe('2-3 живые понятные фразы своими словами на «ты», что за встреча, для кого и что в программе. Не копируй чужой текст дословно, без длинных тире'),
  category: z.enum(PARSE_CATEGORIES),
  customCategory: z.string().describe('Если category = other, короткое название вида: «Книжный клуб», «Театр», «Керамика», «Баня». Иначе пусто'),
  startDate: z.string().describe('Ближайшая будущая дата встречи в Минске YYYY-MM-DD. Если точной даты нет, пусто'),
  startTime: z.string().describe('Время начала HH:MM по 24ч формату (например 19:00). Если в посте только день без часа, поставь 19:00'),
  locationName: z.string().describe('Где проходит в Минске: название места и улица/метро/район, например «Хостел Урбан, ул. Заборского 3» или «м. Кунцевщина»'),
  searchAddress: z.string().describe('Чистый адрес или ориентир в Минске для поиска на карте: улица и дом, название станции метро или район Минска'),
  payment: z.enum(['free', 'donation', 'paid', 'unknown']).describe('free - точно бесплатно/вход свободный; donation - донат/свободная оплата; paid - платно; unknown - в тексте не сказано'),
  priceByn: z.number().nullable().describe('Сумма в BYN числом, если явно указана в посте, иначе null'),
  priceNote: z.string().describe('Короткое пояснение по оплате до 50 символов, если суммы нет или есть нюанс: «Уточняется у автора», «Донат по желанию», «Вход свободный»'),
  audienceGender: z.enum(['all', 'female', 'male']).describe('female - только для женщин/девичник; male - только для мужчин; иначе all'),
  authorReply: z
    .string()
    .describe(
      'Живой дружелюбный комментарий от первого лица («я») ДО 125 символов под пост автора в Threads без ссылок, без спама и без длинных тире. Отметь конкретную деталь поста и скажи, что добавил анонс на карту встреч Минска в ГУЛЯЙ!'
    )
});

const SYSTEM_PROMPT = `Ты помогаешь Мише (создателю минского приложения дружеских встреч и компаний «ГУЛЯЙ!») разбирать посты из Threads.
Правила:
1. Пиши по-русски, живо, тепло, БЕЗ длинных тире (используй обычный дефис «-», никогда не ставь «—» или «–»).
2. Если в посте несколько городов (например, Минск 5 декабря, Гродно 6 декабря) - бери ТОЛЬКО Минск и минскую дату!
3. Если в посте нет года - ориентируйся на сегодняшнюю дату, выбирай ближайшую дату. Если все даты в посте уже прошли относительно сегодняшнего дня - ставь kind: "skip" (кроме случая, когда это явный регулярный клуб каждую неделю/месяц - тогда kind: "host").
4. Цену НЕ додумывай: если про деньги ничего не сказано, ставь payment: "unknown" и priceNote: "Условия у автора в посте", а НЕ "free"!
5. В authorReply пиши по-человечески от лица Миши, КОРОТКО (строго до 125 символов, без ссылок - ссылку бот подставит сам):
   - для meetup: отметь деталь встречи и напиши, что добавил анонс -> например: «Классная идея с настолками! Добавил твой анонс на карту встреч Минска в ГУЛЯЙ!, пусть наши ребята тоже заглянут 🤗»;
   - для host: отметь тему клуба и предложи бесплатно собирать участников и вести запись в ГУЛЯЙ! без потери людей в комментариях;
   - для seeker: поддержи по-дружески и подскажи заглянуть в ГУЛЯЙ! в Telegram, где минчане как раз ищут компанию без дейтинга.`;

let anthropicClient: Anthropic | null = null;
const getClient = () => (anthropicClient ||= new Anthropic());

function minskNowDateStr() {
  return new Date(Date.now() + 3 * 3600 * 1000).toISOString().slice(0, 10);
}

function parseMinskDateTime(dateStr: string, timeStr: string): Date | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return undefined;
  const cleanTime = /^\d{1,2}:\d{2}$/.test(timeStr) ? timeStr.padStart(5, '0') : '19:00';
  const d = new Date(`${dateStr}T${cleanTime}:00+03:00`);
  return Number.isFinite(d.getTime()) ? d : undefined;
}

async function resolveMinskCoords(searchAddress: string, locationName: string): Promise<{ coords: [number, number]; exact: boolean }> {
  for (const candidate of [searchAddress, locationName].map((s) => s.trim()).filter(Boolean)) {
    const found = await geocode(candidate).catch(() => null);
    if (found?.coords) return { coords: found.coords, exact: true };
    const low = candidate.toLowerCase();
    for (const [area, [lat, lng]] of Object.entries(AREA_COORDINATES)) {
      const words = area.toLowerCase().split(/[\/\s,]+/).filter((w) => w.length >= 4);
      if (words.some((w) => low.includes(w.slice(0, Math.max(4, w.length - 1))))) {
        return { coords: [lat, lng], exact: false };
      }
    }
  }
  return { coords: [...MINSK_CENTER], exact: false };
}

async function analyzeThreadsPost(post: FetchedThreadsPost, extraNote: string) {
  const fullText = [post.text, extraNote].filter(Boolean).join('\n\nДополнение от Миши:\n');
  const response = await getClient().messages.parse({
    model: MODEL,
    max_tokens: 1800,
    output_config: { effort: 'low', format: zodOutputFormat(ParsedThreads) },
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: `Сегодня в Минске: ${minskNowDateStr()}\nАвтор: ${post.authorName}${post.authorHandle ? ` (@${post.authorHandle})` : ''}\nСсылка: ${post.canonicalUrl}\n\nТекст поста:\n${fullText}`
      }
    ]
  });
  if (response.stop_reason === 'refusal' || response.stop_reason === 'max_tokens' || !response.parsed_output) return null;
  return response.parsed_output;
}

// ---------- Отправка карточек и кнопок в Telegram ----------

const tgCall = async (method: string, body: any): Promise<any> => {
  if (!process.env.TELEGRAM_BOT_TOKEN) return null;
  const res = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }).catch(() => null);
  return res ? res.json().catch(() => null) : null;
};

const formatMinskWhen = (d?: Date) =>
  d
    ? new Date(d).toLocaleString('ru-RU', {
        timeZone: 'Europe/Minsk',
        weekday: 'short',
        day: 'numeric',
        month: 'long',
        hour: '2-digit',
        minute: '2-digit'
      })
    : 'дата не указана';

const paymentLine = (d: IThreadsDraft) => {
  if (d.payment === 'free') return '💚 Бесплатно / вход свободный';
  if (d.payment === 'donation') return `🙋 Донат${d.priceByn ? ` (~${d.priceByn} BYN)` : ''}${d.priceNote ? ` · ${d.priceNote}` : ''}`;
  if (d.payment === 'paid') return `🎟 Платно${d.priceByn ? `: ~${d.priceByn} BYN` : ''}${d.priceNote ? ` (${d.priceNote})` : ''}`;
  return `💬 ${d.priceNote || 'Условия у автора в посте'}`;
};

const KIND_HEADER: Record<DraftKind, string> = {
  meetup: '🌐 <b>Находка из Threads: готовая встреча</b>',
  host: '🌟 <b>Постоянный ведущий / клуб в Минске</b>',
  seeker: '🙋 <b>Человек ищет компанию в Минске</b>',
  skip: '⏭ <b>Похоже, мимо (проверь глазами)</b>'
};

function draftCardHtml(d: IThreadsDraft & { _id: any }) {
  const authorLabel = `${escapeHtml(d.authorName)}${d.authorHandle ? ` (@${escapeHtml(d.authorHandle)})` : ''}`;
  const lines = [
    KIND_HEADER[d.kind] || KIND_HEADER.meetup,
    d.skipReason ? `<i>Причина: ${escapeHtml(d.skipReason)}</i>` : '',
    '',
    `<b>${escapeHtml(d.title || 'Без названия')}</b>`,
    d.summary ? escapeHtml(d.summary) : '',
    '',
    `👤 Автор: <a href="${escapeHtml(d.sourceUrl)}">${authorLabel}</a>`,
    ...(d.kind === 'meetup' || d.dateTime
      ? [
          `🕒 ${escapeHtml(formatMinskWhen(d.dateTime))}`,
          `📍 ${escapeHtml(d.locationName || 'Минск')}${d.coordsExact ? '' : ' <i>(точка по району/центру)</i>'}`,
          `💵 ${escapeHtml(paymentLine(d))}`,
          ...(d.audienceGender === 'female' ? ['👩 Только для девушек'] : d.audienceGender === 'male' ? ['👨 Только для мужчин'] : [])
        ]
      : []),
    ...(d.authorReply ? ['', `💬 <b>Ответ под постом:</b>\n<i>${escapeHtml(d.authorReply)}</i>`] : [])
  ];
  return lines.filter((l, i, arr) => l !== '' || arr[i - 1] !== '').join('\n');
}

// Telegram copy_text принимает максимум 256 символов: подрезаем вступление по слову, чтобы ссылка в хвосте никогда не обрезалась
function fitCopyWithTail(leadRaw: string, tailRaw: string, maxLen = 254): string {
  const tail = noLongDash(tailRaw);
  const lead = noLongDash(leadRaw);
  if (!tail) return lead.slice(0, maxLen);
  const budget = maxLen - tail.length - 1;
  if (budget <= 10) return tail.slice(0, maxLen);
  if (lead.length <= budget) return `${lead} ${tail}`;
  const cut = lead.slice(0, budget - 1);
  const lastSpace = cut.lastIndexOf(' ');
  const cleanLead = (lastSpace > 25 ? cut.slice(0, lastSpace) : cut).replace(/[,:;.\s-]+$/, '');
  return `${cleanLead}… ${tail}`;
}

function buildOutreachPack(eventId: string, authorReply?: string) {
  const botName = process.env.BOT_USERNAME || 'yesminsk_app_bot';
  const eventLink = `https://t.me/${botName}/start?startapp=event_${eventId}`;
  const claimLink = `https://t.me/${botName}/start?startapp=claim_${eventId}`;
  const baseLead = authorReply?.trim() || 'Классная идея встречи! Добавил твой анонс на карту событий Минска в ГУЛЯЙ! 🤗';

  const commentWithLink = fitCopyWithTail(baseLead, `Карточка: ${eventLink} (внутри есть кнопка для автора)`);
  const commentNoLink = fitCopyWithTail(baseLead, `Карточка в Телеграме: @${botName} (внутри есть кнопка для автора)`);
  const dmClaim = fitCopyWithTail(
    'Привет! Я Миша из минского приложения встреч ГУЛЯЙ! 🤗 Добавил твой анонс к нам на карту.',
    `Забрать карточку в своё управление: ${claimLink}`
  );
  return { botName, eventLink, claimLink, commentWithLink, commentNoLink, dmClaim };
}

async function sendDraftCard(chatId: number, d: IThreadsDraft & { _id: any }) {
  const id = String(d._id);
  const copyReply = d.authorReply ? noLongDash(d.authorReply).slice(0, 254) : '';
  const rows: any[][] = [];

  if (d.status === 'pending') {
    if (d.kind === 'meetup' || d.dateTime) {
      rows.push([
        { text: '✅ В Сходки', callback_data: `thd:pub:${id}` },
        { text: '❌ Пропустить', callback_data: `thd:skip:${id}` }
      ]);
      rows.push([
        { text: '✏️ Поправить', callback_data: `thd:edit:${id}` },
        ...(d.authorHandle ? [{ text: '⭐ В авторы', callback_data: `thd:save:${id}` }] : [])
      ]);
    } else {
      rows.push([
        ...(d.authorHandle ? [{ text: '⭐ Сохранить автора', callback_data: `thd:save:${id}` }] : []),
        { text: '✏️ Сделать сходкой', callback_data: `thd:edit:${id}` }
      ]);
      rows.push([{ text: '❌ Пропустить', callback_data: `thd:skip:${id}` }]);
    }
    const bottomRow: any[] = [];
    if (copyReply) bottomRow.push({ text: '📋 Черновик ответа', copy_text: { text: copyReply } });
    bottomRow.push({ text: '🔗 Пост', url: d.sourceUrl });
    rows.push(bottomRow);
  } else if (d.status === 'published' && d.publishedEventId) {
    const pack = buildOutreachPack(String(d.publishedEventId), d.authorReply);
    rows.push([{ text: '📋 Коммент под пост (со ссылкой)', copy_text: { text: pack.commentWithLink } }]);
    rows.push([
      { text: '💬 Коммент без ссылки', copy_text: { text: pack.commentNoLink } },
      { text: '📩 В личку (Забрать)', copy_text: { text: pack.dmClaim } }
    ]);
    rows.push([{ text: '🔗 Пост в Threads', url: d.sourceUrl }]);
  } else {
    rows.push([{ text: '🔗 Пост', url: d.sourceUrl }]);
  }

  await tgCall('sendMessage', {
    chat_id: chatId,
    text: draftCardHtml(d),
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    reply_markup: { inline_keyboard: rows }
  });
}

// ---------- Публикация черновика в основную ленту Сходок ----------

async function publishDraftToEvents(d: mongoose.HydratedDocument<IThreadsDraft>): Promise<IEvent> {
  const when = d.dateTime && d.dateTime.getTime() > Date.now() - 2 * 3600 * 1000
    ? d.dateTime
    : new Date(Date.now() + 24 * 3600 * 1000);

  const isPaid = d.payment === 'paid' || d.payment === 'donation';
  const payTo = d.payment === 'donation' || d.payment === 'paid' ? ('host' as const) : undefined;
  const donation = d.payment === 'donation' ? true : undefined;
  const priceNote =
    d.payment === 'unknown'
      ? d.priceNote || 'Условия в посте'
      : d.payment === 'paid' && !d.priceByn
        ? d.priceNote || 'Стоимость в посте'
        : undefined;

  const ev = await Event.create({
    external: {
      platform: 'threads',
      url: d.sourceUrl,
      authorName: d.authorName || (d.authorHandle ? `@${d.authorHandle}` : 'Автор в Threads'),
      authorHandle: d.authorHandle || undefined,
      priceNote
    },
    title: noLongDash(d.title || 'Встреча в Минске').slice(0, 100),
    description: noLongDashMultiline(d.summary || d.rawText).slice(0, 600),
    category: d.category || 'other',
    customCategory: d.category === 'other' ? (d.customCategory || 'Встреча').slice(0, 30) : '',
    tags: [],
    badges: [],
    isPaid,
    price: isPaid && d.priceByn && d.priceByn > 0 ? d.priceByn : undefined,
    payTo,
    donation,
    payFor: isPaid && d.priceNote ? noLongDash(d.priceNote).slice(0, 60) : undefined,
    audienceGender: d.audienceGender || 'all',
    locationName: noLongDash(d.locationName || 'Минск').slice(0, 150),
    location: {
      type: 'Point',
      coordinates: [d.coords[1], d.coords[0]] // [lng, lat]
    },
    dateTime: when,
    creator: {
      telegramId: 0,
      name: d.authorHandle ? `@${d.authorHandle}` : d.authorName || 'Из Threads',
      avatarUrl: NO_PHOTO
    },
    participants: [],
    maxParticipants: 0,
    isActive: true,
    // Пока настоящий ведущий не забрал встречу себе, не запускаем соседскую рассылку и вопросы организатору
    nearbyInvitedAt: new Date(),
    feedbackHostAskedAt: new Date(),
    feedbackSummarySentAt: new Date()
  });

  d.status = 'published';
  d.publishedEventId = String(ev._id);
  await d.save();

  if (d.authorHandle) {
    await ThreadsAuthor.findOneAndUpdate(
      { handle: d.authorHandle.toLowerCase() },
      {
        $set: {
          name: d.authorName || `@${d.authorHandle}`,
          profileUrl: `https://www.threads.com/@${d.authorHandle}`,
          samplePostUrl: d.sourceUrl,
          topic: d.title
        },
        $inc: { publishedCount: 1 }
      },
      { upsert: true }
    ).catch(() => {});
  }

  return ev;
}

// ---------- Редактирование полей черновика текстом в боте ----------

const editingDraft = new Map<number, string>(); // chatId -> draftId

function formatEditTemplate(d: IThreadsDraft) {
  const dt = d.dateTime
    ? new Date(d.dateTime.getTime() + 3 * 3600 * 1000).toISOString().slice(0, 16).replace('T', ' ')
    : `${minskNowDateStr()} 19:00`;
  const [ymd, hm] = dt.split(' ');
  const [y, m, day] = ymd.split('-');
  const pay =
    d.payment === 'free'
      ? 'бесплатно'
      : d.payment === 'donation'
        ? `донат${d.priceByn ? ` ${d.priceByn}` : ''}`
        : d.payment === 'paid'
          ? `${d.priceByn || 'платно'}`
          : 'уточнить';
  return [
    `Название: ${d.title}`,
    `Описание: ${d.summary}`,
    `Когда: ${day}.${m}.${y} ${hm}`,
    `Место: ${d.locationName}`,
    `Цена: ${pay}`
  ].join('\n');
}

function parseWhenInput(raw: string): Date | undefined {
  const m = raw.trim().match(/^(\d{1,2})\.(\d{1,2})(?:\.(\d{2,4}))?\s+(\d{1,2}):(\d{2})$/);
  if (!m) return undefined;
  const yearNow = new Date(Date.now() + 3 * 3600 * 1000).getUTCFullYear();
  const year = m[3] ? (m[3].length === 2 ? `20${m[3]}` : m[3]) : String(yearNow);
  return parseMinskDateTime(`${year}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`, `${m[4].padStart(2, '0')}:${m[5]}`);
}

export async function handleThreadsEditMessage(message: any): Promise<boolean> {
  const chatId: number = message.chat?.id;
  const draftId = editingDraft.get(chatId);
  if (!draftId || !isAdmin(message.from?.id)) return false;
  const text: string = (message.text || '').trim();
  if (/^\/cancel\b/i.test(text)) {
    editingDraft.delete(chatId);
    sendTelegramMessage(chatId, 'Ок, правку отменил.');
    return true;
  }
  if (!text || text.startsWith('/')) return false;

  const d = mongoose.Types.ObjectId.isValid(draftId) ? await ThreadsDraft.findById(draftId) : null;
  if (!d) {
    editingDraft.delete(chatId);
    return true;
  }

  const labels = [
    { label: 'название', key: 'title' },
    { label: 'описание', key: 'summary' },
    { label: 'когда', key: 'when' },
    { label: 'место', key: 'location' },
    { label: 'цена', key: 'price' }
  ] as const;

  const parsed: Record<string, string> = {};
  let cur = '';
  for (const line of text.split('\n')) {
    const hit = labels.find((l) => line.toLowerCase().startsWith(l.label + ':'));
    if (hit) {
      cur = hit.key;
      parsed[cur] = line.slice(hit.label.length + 1).trim();
    } else if (cur && line.trim()) {
      parsed[cur] += ' ' + line.trim();
    }
  }

  if (!Object.keys(parsed).length) {
    sendTelegramMessage(chatId, 'Пришли строки в формате «Поле: значение» (например, «Когда: 06.12.2026 18:30») или нажми /cancel.');
    return true;
  }

  if (parsed.title) d.title = noLongDash(parsed.title).slice(0, 100);
  if (parsed.summary) d.summary = noLongDashMultiline(parsed.summary).slice(0, 550);
  if (parsed.when) {
    const dt = parseWhenInput(parsed.when);
    if (!dt) {
      sendTelegramMessage(chatId, 'Не понял дату 🙈 Напиши в виде «06.12.2026 17:00» или «06.12 17:00».');
      return true;
    }
    d.dateTime = dt;
    d.kind = 'meetup';
  }
  if (parsed.location) {
    d.locationName = noLongDash(parsed.location).slice(0, 150);
    d.searchAddress = d.locationName;
    const geo = await resolveMinskCoords(d.searchAddress, d.locationName);
    d.coords = geo.coords;
    d.coordsExact = geo.exact;
  }
  if (parsed.price) {
    const p = parsed.price.toLowerCase();
    const num = Number(p.replace(',', '.').match(/\d+(?:\.\d+)?/)?.[0]);
    if (/бесплат|свободн/i.test(p)) {
      d.payment = 'free';
      d.priceByn = undefined;
      d.priceNote = '';
    } else if (/донат/i.test(p)) {
      d.payment = 'donation';
      d.priceByn = Number.isFinite(num) && num > 0 ? num : undefined;
      d.priceNote = 'Донат по желанию';
    } else if (/уточн|неизвест|\?/i.test(p)) {
      d.payment = 'unknown';
      d.priceByn = undefined;
      d.priceNote = 'Условия у автора в посте';
    } else if (Number.isFinite(num) && num > 0) {
      d.payment = 'paid';
      d.priceByn = num;
      d.priceNote = '';
    } else {
      d.payment = 'paid';
      d.priceByn = undefined;
      d.priceNote = noLongDash(parsed.price).slice(0, 50);
    }
  }

  editingDraft.delete(chatId);
  await d.save();
  await sendDraftCard(chatId, d as any);
  return true;
}

// ---------- Обработка ссылок и команд в боте ----------

export async function handleThreadsCommand(message: any): Promise<boolean> {
  const text: string = (message.text || '').trim();
  const m = text.match(/^\/threads(?:@\w+)?(?:\s+(list|authors))?$/i);
  if (!m || !isAdmin(message.from?.id)) return false;
  const chatId: number = message.chat.id;
  const sub = (m[1] || '').toLowerCase();

  if (sub === 'list') {
    const list = await ThreadsDraft.find({ status: 'pending' }).sort({ createdAt: -1 }).limit(15);
    if (!list.length) {
      sendTelegramMessage(chatId, 'В очереди из Threads сейчас пусто 🙂 Просто пришли мне любую ссылку threads.com/share/…');
      return true;
    }
    for (const d of list) await sendDraftCard(chatId, d as any);
    return true;
  }

  if (sub === 'authors') {
    const authors = await ThreadsAuthor.find({}).sort({ updatedAt: -1 }).limit(40).lean();
    if (!authors.length) {
      sendTelegramMessage(chatId, 'Сохранённых авторов пока нет. Нажимай «⭐ В авторы» под интересными находками!');
      return true;
    }
    const lines = authors.map(
      (a, i) =>
        `${i + 1}. <a href="${escapeHtml(a.profileUrl)}">@${escapeHtml(a.handle)}</a> - ${escapeHtml(a.name || a.handle)}${
          a.topic ? ` (${escapeHtml(a.topic.slice(0, 45))})` : ''
        }${a.publishedCount ? ` · встреч: ${a.publishedCount}` : ''}`
    );
    await tgCall('sendMessage', {
      chat_id: chatId,
      text: `🌟 <b>Постоянные авторы из Threads (${authors.length})</b>\n\n${lines.join('\n')}`,
      parse_mode: 'HTML',
      disable_web_page_preview: true
    });
    return true;
  }

  const [pending, published, authorsCount] = await Promise.all([
    ThreadsDraft.countDocuments({ status: 'pending' }),
    ThreadsDraft.countDocuments({ status: 'published' }),
    ThreadsAuthor.countDocuments({})
  ]);

  sendTelegramMessage(
    chatId,
    `🌐 <b>Куратор Сходок из Threads</b>\n\n` +
      `• Ждут решения: <b>${pending}</b> (/threads list)\n` +
      `• Опубликовано встреч: <b>${published}</b>\n` +
      `• Сохранено авторов: <b>${authorsCount}</b> (/threads authors)\n\n` +
      `<b>Как добавлять:</b> просто перешли сюда ссылку <code>threads.com/share/…</code> с телефона (можно сразу несколько ссылок в одном сообщении). Если пост закрыт от гостей - вставь рядом со ссылкой скопированный текст поста.`
  );
  return true;
}

export async function handleThreadsLinkMessage(message: any): Promise<boolean> {
  if (!isAdmin(message.from?.id) || typeof message.text !== 'string') return false;
  if (message.text.trim().startsWith('/')) return false;
  const { urls, extraText } = cleanRawMessageForUrls(message.text);
  if (!urls.length) return false;

  const chatId: number = message.chat.id;
  if (!process.env.ANTHROPIC_API_KEY) {
    sendTelegramMessage(chatId, 'На сервере не задан ANTHROPIC_API_KEY - не могу разобрать пост через Haiku.');
    return true;
  }

  const batch = urls.slice(0, 10);
  // Короткую пометку при пачке ссылок («сходка платная») не приклеиваем ко всем, а при одной ссылке длинный текст спасает закрытые посты
  const manualBody = batch.length === 1 && extraText.length >= 25 ? extraText : '';

  sendTelegramMessage(
    chatId,
    batch.length === 1 ? '🔎 Читаю пост из Threads и собираю карточку…' : `🔎 Нашёл ссылок: ${batch.length}. Разбираю по очереди…`
  );

  for (const url of batch) {
    try {
      const post = await fetchThreadsPost(url);
      if (post.restricted && !manualBody) {
        await tgCall('sendMessage', {
          chat_id: chatId,
          text:
            `🔒 Пост по ссылке <a href="${escapeHtml(url)}">${escapeHtml(url)}</a> скрыт за окном входа Threads.\n` +
            `Скопируй текст поста в приложении и пришли мне в одном сообщении со ссылкой - сразу соберу карточку!`,
          parse_mode: 'HTML',
          disable_web_page_preview: true
        });
        continue;
      }

      const existing = await ThreadsDraft.findOne({ sourceUrl: post.canonicalUrl });
      if (existing && !manualBody) {
        await sendDraftCard(chatId, existing as any);
        continue;
      }

      const parsed = await analyzeThreadsPost(post, manualBody);
      if (!parsed) {
        sendTelegramMessage(chatId, `⚠️ Не получилось разобрать пост: ${escapeHtml(post.canonicalUrl)}`);
        continue;
      }

      const dateTime = parsed.startDate ? parseMinskDateTime(parsed.startDate, parsed.startTime) : undefined;
      const geo =
        parsed.kind === 'meetup' || parsed.searchAddress || parsed.locationName
          ? await resolveMinskCoords(parsed.searchAddress || '', parsed.locationName || '')
          : { coords: [...MINSK_CENTER] as [number, number], exact: false };

      const draft = await ThreadsDraft.create({
        sourceUrl: post.canonicalUrl,
        shareUrl: post.shareUrl,
        authorName: post.authorName || (post.authorHandle ? `@${post.authorHandle}` : 'Автор в Threads'),
        authorHandle: post.authorHandle || undefined,
        rawText: [post.text, manualBody].filter(Boolean).join('\n\n').slice(0, 2000),
        kind: parsed.kind,
        skipReason: noLongDash(parsed.skipReason || ''),
        title: noLongDash(parsed.title || 'Встреча в Минске').slice(0, 100),
        summary: noLongDashMultiline(parsed.summary || '').slice(0, 550),
        category: (parsed.category as EventCategory) || 'other',
        customCategory: noLongDash(parsed.customCategory || '').slice(0, 30),
        dateTime,
        locationName: noLongDash(parsed.locationName || 'Минск').slice(0, 150),
        searchAddress: parsed.searchAddress || '',
        coords: geo.coords,
        coordsExact: geo.exact,
        payment: parsed.payment,
        priceByn: parsed.priceByn && parsed.priceByn > 0 ? Math.round(parsed.priceByn * 100) / 100 : undefined,
        priceNote: noLongDash(parsed.priceNote || '').slice(0, 60),
        audienceGender: parsed.audienceGender || 'all',
        authorReply: noLongDashMultiline(parsed.authorReply || '').slice(0, 400),
        status: 'pending'
      });

      await sendDraftCard(chatId, draft as any);
    } catch (err: any) {
      console.warn('⚠️ Разбор ссылки Threads:', url, err?.message || err);
      sendTelegramMessage(chatId, `⚠️ Не удалось открыть ссылку ${escapeHtml(url)}: ${escapeHtml(err?.message || 'ошибка сети')}`);
    }
  }
  return true;
}

// ---------- Кнопки карточек и запросов «Забрать встречу» ----------

export async function handleThreadsCallback(query: any): Promise<boolean> {
  const data: string = query.data || '';
  if (!data.startsWith('thd:') && !data.startsWith('thc:')) return false;

  const answer = (text = '', alert = false) =>
    tgCall('answerCallbackQuery', { callback_query_id: query.id, text, show_alert: alert });

  if (!isAdmin(query.from?.id)) {
    await answer('Только для администратора', true);
    return true;
  }

  const chatId = query.message?.chat?.id;
  const messageId = query.message?.message_id;

  // Запрос ведущего забрать опубликованную встречу: thc:ok:<eventId>:<userId> / thc:no:<eventId>:<userId>
  if (data.startsWith('thc:')) {
    const [, action, eventId, uidStr] = data.split(':');
    const targetId = Number(uidStr);
    const ev = mongoose.Types.ObjectId.isValid(eventId) ? await Event.findById(eventId) : null;
    if (!ev || !ev.external) {
      await answer('Сходка не найдена');
      return true;
    }
    if (ev.external.claimedBy) {
      await answer('Эту встречу уже передали ведущему');
      return true;
    }
    if (action === 'no') {
      ev.external.claimRequests = (ev.external.claimRequests || []).filter((r) => r.telegramId !== targetId);
      await ev.save();
      await answer('Отклонено');
      if (messageId) await tgCall('editMessageReplyMarkup', { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } });
      sendTelegramMessage(chatId, `Заявка на встречу «${escapeHtml(ev.title)}» отклонена.`);
      return true;
    }

    const hostUser = await User.findOne({ telegramId: targetId });
    if (!hostUser) {
      await answer('Пользователь ещё не создал анкету в ГУЛЯЙ!', true);
      return true;
    }

    ev.creator = {
      telegramId: hostUser.telegramId,
      name: hostUser.firstName || 'Организатор',
      username: hostUser.username,
      avatarUrl: hostUser.avatarUrl || NO_PHOTO
    };
    ev.external.claimedBy = hostUser.telegramId;
    ev.external.claimedAt = new Date();
    if (!ev.participants.some((p) => p.telegramId === hostUser.telegramId)) {
      ev.participants.unshift({
        telegramId: hostUser.telegramId,
        name: hostUser.firstName || 'Организатор',
        username: hostUser.username,
        avatarUrl: hostUser.avatarUrl || NO_PHOTO,
        joinedAt: new Date(),
        approvedAt: new Date()
      });
    }
    // Теперь у встречи настоящий ведущий: после сходки спросим его и пришлём сводку отзывов
    ev.feedbackHostAskedAt = undefined;
    ev.feedbackSummarySentAt = undefined;
    await ev.save();

    await answer('Встреча передана автору!');
    if (messageId) await tgCall('editMessageReplyMarkup', { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } });
    sendTelegramMessage(chatId, `🎉 Готово: встреча «${escapeHtml(ev.title)}» передана ${escapeHtml(hostUser.firstName)}!`);
    sendTelegramMessage(
      hostUser.telegramId,
      `🎉 <b>Встреча «${escapeHtml(ev.title)}» теперь в твоём управлении!</b>\n\n` +
        `Ты можешь редактировать описание, видеть участников и отвечать им прямо во встроенном чате сходки 🤗`,
      'Открыть мою встречу',
      `?event=${ev._id}`
    );
    return true;
  }

  // Действия с черновиком из Threads: thd:<action>:<draftId>
  const [, action, id] = data.split(':');
  if (action === 'noop') {
    await answer();
    return true;
  }

  const d = mongoose.Types.ObjectId.isValid(id) ? await ThreadsDraft.findById(id) : null;
  if (!d) {
    await answer('Черновик не найден');
    return true;
  }

  if (action === 'save') {
    if (!d.authorHandle) {
      await answer('У поста не определился @ник автора', true);
      return true;
    }
    await ThreadsAuthor.findOneAndUpdate(
      { handle: d.authorHandle.toLowerCase() },
      {
        $set: {
          name: d.authorName || `@${d.authorHandle}`,
          profileUrl: `https://www.threads.com/@${d.authorHandle}`,
          samplePostUrl: d.sourceUrl,
          topic: d.title
        }
      },
      { upsert: true }
    );
    await answer(`@${d.authorHandle} в списке авторов ⭐`);
    return true;
  }

  if (action === 'edit') {
    editingDraft.set(chatId, id);
    await answer();
    await tgCall('sendMessage', {
      chat_id: chatId,
      text:
        `✏️ Скопируй блок ниже, поправь нужные строки и пришли мне (или только одну строку, например <code>Когда: 06.12 18:30</code>). Отмена - /cancel\n\n` +
        `<pre>${escapeHtml(formatEditTemplate(d))}</pre>`,
      parse_mode: 'HTML'
    });
    return true;
  }

  if (action === 'skip') {
    d.status = 'skipped';
    await d.save();
    await answer('Пропущено');
    if (messageId) await tgCall('editMessageReplyMarkup', { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } });
    return true;
  }

  if (action === 'pub') {
    if (d.status === 'published' && d.publishedEventId) {
      await answer('Уже опубликовано');
      return true;
    }
    const ev = await publishDraftToEvents(d as any);
    await answer('Опубликовано в Сходках!');
    if (messageId) await tgCall('editMessageReplyMarkup', { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } });

    const pack = buildOutreachPack(String(ev._id), d.authorReply);
    const appUrl = (process.env.MINI_APP_URL || '').replace(/\/+$/, '');

    const rows: any[][] = [
      [{ text: '📋 Коммент под пост (со ссылкой на сходку)', copy_text: { text: pack.commentWithLink } }],
      [
        { text: '💬 Коммент без ссылки', copy_text: { text: pack.commentNoLink } },
        { text: '📩 В личку (Забрать)', copy_text: { text: pack.dmClaim } }
      ]
    ];
    if (appUrl) rows.push([{ text: '👀 Посмотреть карточку в ГУЛЯЙ!', web_app: { url: `${appUrl}/?event=${ev._id}` } }]);

    await tgCall('sendMessage', {
      chat_id: chatId,
      text:
        `✅ <b>«${escapeHtml(ev.title)}» в Сходках и на Карте!</b>\n\n` +
        `<b>1. Публичный коммент под пост</b> (ссылка безопасна и для участников, и для автора):\n` +
        `<i>${escapeHtml(pack.commentWithLink)}</i>\n\n` +
        `<b>2. Если пишешь автору в личку</b> (откроет сразу «Забрать встречу»):\n` +
        `<code>${escapeHtml(pack.claimLink)}</code>`,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      reply_markup: { inline_keyboard: rows }
    });
    return true;
  }

  await answer();
  return true;
}

// ---------- API для приложения: кнопка «Это моя встреча - забрать себе» ----------

export function setupThreadsCuratorRoutes(app: Express, formatEvent: (ev: IEvent, viewerId: number) => any) {
  app.post('/api/events/:id/claim', telegramAuthMiddleware as any, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const myId = req.telegramUser!.id;
      const id = String(req.params.id || '').trim();
      if (!mongoose.Types.ObjectId.isValid(id)) return res.status(404).json({ error: 'Встреча не найдена' });

      const [me, ev] = await Promise.all([User.findOne({ telegramId: myId }), Event.findById(id)]);
      if (!me || me.isBanned || !me.hasAgreedToRules) {
        return res.status(403).json({ error: 'Сначала открой ГУЛЯЙ! и прими правила приложения' });
      }
      if (!ev || !ev.isActive || !ev.external) {
        return res.status(404).json({ error: 'Эта встреча уже обычная или недоступна' });
      }
      if (ev.external.claimedBy) {
        return res.status(409).json({ error: 'У этой встречи уже подтверждён организатор' });
      }

      const handle = String(req.body?.handle || '')
        .trim()
        .replace(/^@/, '')
        .slice(0, 60);

      const list = ev.external.claimRequests || [];
      if (!list.some((r) => r.telegramId === myId)) {
        list.push({
          telegramId: myId,
          name: me.firstName || req.telegramUser!.first_name || 'Без имени',
          username: me.username || req.telegramUser!.username,
          handle: handle || undefined,
          requestedAt: new Date()
        });
        ev.external.claimRequests = list;
        await ev.save();

        const who = userMentionHtml({ telegramId: myId, firstName: me.firstName || req.telegramUser!.first_name, username: me.username || req.telegramUser!.username });
        const msg =
          `🙋 <b>Запрос забрать встречу из Threads</b>\n\n` +
          `Встреча: <b>${escapeHtml(ev.title)}</b> (${ev.external.authorHandle ? `@${escapeHtml(ev.external.authorHandle)}` : escapeHtml(ev.external.authorName)})\n` +
          `Пост: <a href="${escapeHtml(ev.external.url)}">открыть в Threads</a>\n` +
          `Просит: ${who} · ID ${myId}${handle ? `\nУказал ник в Threads: @${escapeHtml(handle)}` : ''}`;

        for (const adminId of adminIds()) {
          await tgCall('sendMessage', {
            chat_id: adminId,
            text: msg,
            parse_mode: 'HTML',
            disable_web_page_preview: true,
            reply_markup: {
              inline_keyboard: [
                [
                  { text: '✅ Передать встречу', callback_data: `thc:ok:${ev._id}:${myId}` },
                  { text: '❌ Отклонить', callback_data: `thc:no:${ev._id}:${myId}` }
                ]
              ]
            }
          });
        }
      }

      res.json({ ok: true, event: formatEvent(ev, myId) });
    } catch (err: any) {
      console.warn('⚠️ /api/events/:id/claim:', err?.message || err);
      res.status(500).json({ error: 'Не получилось отправить запрос, попробуй ещё раз' });
    }
  });
}
