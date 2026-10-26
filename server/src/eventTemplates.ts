import { Express, Response } from 'express';
import { EventTemplate, IEventTemplate, ITemplateField } from './models/EventTemplate';
import { EventCategory, EventTag, EVENT_TAGS } from './models/Event';
import { matchPlaceType } from './models/Place';
import { DEFAULT_TEMPLATES } from './data/eventTemplates';
import { telegramAuthMiddleware, AuthenticatedRequest } from './middleware/telegramAuth';
import { escapeHtml } from './utils/telegramNotify';
import { csvCell } from './utils/csv';
import { TEMPLATE_TEXTS as T, MEETUP_ERRORS } from './texts';
import { isAdmin } from './news';

/**
 * Шаблоны сходок: стартовый набор в базе, выдача приложению, метки сходки по доп. полям
 * и таблица для автора (/templates: выгрузить, поправить, прислать обратно)
 */

/* ---------- Стартовый набор ---------- */

// Добавляем шаблоны, которых нет в базе; то, что автор поправил, не трогаем
export async function seedEventTemplates() {
  try {
    const res = await EventTemplate.bulkWrite(
      DEFAULT_TEMPLATES.map((t) => ({ updateOne: { filter: { key: t.key }, update: { $setOnInsert: t }, upsert: true } }))
    );
    if (res.upsertedCount) console.log(`🧩 Добавлены шаблоны сходок: ${res.upsertedCount}`);
    // Цена теперь общая для всех сходок: убираем старое поле «Сколько стоит?» у «Поиграем?», ставим «Платно»
    await EventTemplate.updateOne({ key: 'sport', 'fields.key': 'cost' }, { $pull: { fields: { key: 'cost' } }, $set: { paid: true } });
    await EventTemplate.updateOne({ key: 'cinema', paid: { $exists: false } }, { $set: { paid: true } });
    // Кофе: сначала кофейни, кафе — если кофеен нет (порядок типов = приоритет)
    await EventTemplate.updateOne({ key: 'coffee', placeTypes: ['Кафе', 'Кофейня'] }, { $set: { placeTypes: ['Кофейня', 'Кафе'] } });
    // «Хочу сходить»: фраза желания у шаблонов, созданных до неё
    for (const t of DEFAULT_TEMPLATES.filter((d) => d.wishPhrase)) {
      await EventTemplate.updateOne({ key: t.key, wishPhrase: { $exists: false } }, { $set: { wishPhrase: t.wishPhrase } });
    }
  } catch (err: any) {
    console.warn('⚠️ Шаблоны сходок:', err?.message || err);
  }
}

/* ---------- Для приложения ---------- */

export const formatTemplate = (t: IEventTemplate) => ({
  key: t.key,
  emoji: t.emoji,
  name: t.name,
  category: t.category || null,
  title: t.title || '',
  fallbackTitle: t.fallbackTitle || '',
  description: t.description || '',
  seats: t.seats || 0,
  durationMinutes: t.durationMinutes || 0,
  placeTypes: t.placeTypes || [],
  tags: t.tags || [],
  paid: Boolean(t.paid),
  wishPhrase: t.wishPhrase || '',
  fields: t.fields || []
});

export function setupEventTemplateRoutes(app: Express) {
  app.get('/api/event-templates', telegramAuthMiddleware as any, async (_req: AuthenticatedRequest, res: Response) => {
    try {
      const list = await EventTemplate.find({ active: true }).sort({ order: 1 });
      res.json(list.map(formatTemplate));
    } catch {
      res.status(500).json({ error: 'Не удалось загрузить шаблоны' });
    }
  });
}

export const findTemplate = (key?: unknown) =>
  typeof key === 'string' && /^[a-z0-9_]{1,30}$/.test(key) ? EventTemplate.findOne({ key }) : Promise.resolve(null);

/* ---------- Ссылки «собрать сходку» ---------- */

export interface CreateMeetupLink {
  template?: string; // ключ шаблона
  when?: 'today' | 'tomorrow' | 'saturday' | 'sunday' | 'weekend';
  placeId?: string;
}

// Для кнопки бота (web_app): откроет форму с выбранным шаблоном, временем и местом
export const meetupCreatePath = (link: CreateMeetupLink = {}) => {
  const q = new URLSearchParams({ create: link.template || '' });
  if (link.when) q.set('when', link.when);
  if (link.placeId) q.set('place', link.placeId);
  return `?${q.toString()}`;
};

// Для постов и Threads: t.me/<бот>?startapp=create_coffee_weekend_<id> (не длиннее 64 символов)
export const meetupStartParam = (link: CreateMeetupLink = {}) =>
  ['create', link.template, link.when, link.placeId].filter(Boolean).join('_').slice(0, 64);

/* ---------- Доп. поля сходки → значения и метки ---------- */

export interface TemplateExtras {
  extras: Record<string, string>;
  badges: string[];
  error?: string;
}

// Проверяем, что пришло из формы, и собираем метки сходки: «🏓 Настольный теннис · любой уровень», «🎒 …», «💸 …»
export function buildExtras(fields: ITemplateField[], raw: any): TemplateExtras {
  const extras: Record<string, string> = {};
  const groups = new Map<string, string[]>();
  const badges: (string | { group: string })[] = [];
  const addBadge = (field: ITemplateField, text: string) => {
    if (!text) return;
    if (!field.badgeGroup) return badges.push(text);
    if (!groups.has(field.badgeGroup)) {
      groups.set(field.badgeGroup, []);
      badges.push({ group: field.badgeGroup });
    }
    groups.get(field.badgeGroup)!.push(text);
  };

  for (const field of fields || []) {
    let v = String(raw?.[field.key] ?? '').trim().slice(0, 80);
    if (!v && field.default) v = field.default;
    if (!v) {
      if (field.required) return { extras, badges: [], error: MEETUP_ERRORS.required(field.label) };
      continue;
    }
    if (field.type === 'select') {
      const opt = (field.options || []).find((o) => o.value === v);
      if (!opt) return { extras, badges: [], error: MEETUP_ERRORS.badOption(field.label) };
      extras[field.key] = v;
      const custom = String(raw?.[`${field.key}Custom`] ?? '').trim().slice(0, 40);
      if (v === 'other' && field.allowCustom) {
        if (!custom && field.required) return { extras, badges: [], error: MEETUP_ERRORS.required(field.customLabel || field.label) };
        if (custom) extras[`${field.key}Custom`] = custom;
        addBadge(field, [opt.badge || opt.emoji || '', custom].filter(Boolean).join(' '));
      } else addBadge(field, opt.badge || opt.label);
    } else if (field.type === 'money') {
      if (v === 'free') {
        extras[field.key] = 'free';
        addBadge(field, field.freeBadge || field.freeLabel || '');
      } else {
        const n = Number(v.replace(',', '.'));
        if (!Number.isFinite(n) || n < 0 || n > 10000) return { extras, badges: [], error: MEETUP_ERRORS.badAmount };
        extras[field.key] = String(Math.round(n * 100) / 100);
        addBadge(field, (field.amountBadge || '').replace('{сумма}', extras[field.key].replace('.', ',')));
      }
    } else {
      extras[field.key] = v;
      if (field.badge) addBadge(field, field.badge.replace('{value}', v));
    }
  }

  const flat = badges.map((b) => (typeof b === 'string' ? b : groups.get(b.group)!.join(' · ')));
  return { extras, badges: flat };
}

/* ---------- Таблица для автора ---------- */

const CATEGORY_LABELS: Record<EventCategory, string> = {
  cafe_bar: 'Кофе/бар',
  walk: 'Прогулка',
  expo_cinema: 'Арт/кино',
  trip_outdoors: 'За город',
  boardgames: 'Настолки',
  sport: 'Спорт/вело',
  talk: 'Разговор',
  support: 'Поныть',
  other: 'Своя идея'
};
const TAG_LABELS: Record<EventTag, string> = {
  kids: 'Можно с детьми',
  couples: 'Удобно парами',
  dogs: 'Можно с собакой',
  empaths: 'Только эмпаты'
};

const COLUMNS = [
  ['key', 'Ключ'],
  ['order', 'Порядок'],
  ['active', 'Вкл'],
  ['emoji', 'Значок'],
  ['name', 'Название карточки'],
  ['category', 'Категория'],
  ['title', 'Название сходки'],
  ['fallbackTitle', 'Запасное название'],
  ['description', 'Описание'],
  ['seats', 'Мест'],
  ['duration', 'Длительность (ч)'],
  ['placeTypes', 'Типы мест'],
  ['tags', 'Метки'],
  ['paid', 'Платно'],
  ['wishPhrase', 'Желание'],
  ['fields', 'Доп. поля (JSON)']
] as const;
type ColumnKey = (typeof COLUMNS)[number][0];

const norm = (s: string) => s.toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();

export async function templatesCsv() {
  const list = await EventTemplate.find().sort({ order: 1 });
  const rows = list.map((t) =>
    [
      t.key,
      t.order,
      t.active ? 'да' : 'нет',
      t.emoji,
      t.name,
      t.category ? CATEGORY_LABELS[t.category] : '',
      t.title,
      t.fallbackTitle,
      t.description,
      t.seats || '',
      t.durationMinutes ? String(t.durationMinutes / 60).replace('.', ',') : '',
      (t.placeTypes || []).join('; '),
      (t.tags || []).map((tag) => TAG_LABELS[tag]).join('; '),
      t.paid ? 'да' : 'нет',
      t.wishPhrase || '',
      t.fields?.length ? JSON.stringify(t.fields) : ''
    ]
      .map(csvCell)
      .join(',')
  );
  return [COLUMNS.map((c) => c[1]).join(','), ...rows].join('\n');
}

// Это таблица шаблонов? — есть столбец «Ключ»
export const isTemplatesHeader = (header: string[]) => header.map(norm).includes('ключ');

interface TemplatesPlan {
  rows: { key: string; isNew: boolean; set: Record<string, any> }[];
  errors: string[];
  warnings: string[];
}

const tokensIn = (text: string) => [...text.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]);

export async function planTemplates(rows: string[][]): Promise<TemplatesPlan> {
  const plan: TemplatesPlan = { rows: [], errors: [], warnings: [] };
  const header = rows[0].map(norm);
  const idx = {} as Record<ColumnKey, number>;
  COLUMNS.forEach(([key, label]) => (idx[key] = header.indexOf(norm(label))));
  const existing = new Map((await EventTemplate.find()).map((t) => [t.key, t]));

  rows.slice(1).forEach((cells, i) => {
    const get = (k: ColumnKey) => (idx[k] >= 0 ? String(cells[idx[k]] ?? '').trim() : '');
    const key = get('key');
    if (!key) return plan.errors.push(T.noKey(i + 2));
    if (!/^[a-z0-9_]{1,30}$/.test(key)) return plan.errors.push(T.badKey(key));
    const old = existing.get(key);
    const set: Record<string, any> = {};

    if (get('order')) {
      const n = Number(get('order').replace(',', '.'));
      Number.isFinite(n) ? (set.order = n) : plan.warnings.push(T.badNumber(key, 'Порядок', get('order')));
    }
    if (get('active')) set.active = !/^(нет|no|0|выкл)$/i.test(get('active'));
    if (get('wishPhrase')) set.wishPhrase = /^(нет|-)$/i.test(get('wishPhrase')) ? '' : get('wishPhrase').slice(0, 60);
    if (get('paid')) set.paid = /^(да|yes|1|платно)$/i.test(get('paid'));
    if (get('emoji')) set.emoji = get('emoji').slice(0, 8);
    if (get('name')) set.name = get('name').slice(0, 40);
    if (get('category')) {
      const cat = (Object.keys(CATEGORY_LABELS) as EventCategory[]).find((c) => norm(CATEGORY_LABELS[c]) === norm(get('category')) || c === get('category'));
      cat ? (set.category = cat) : plan.warnings.push(T.badCategory(key, get('category')));
    }
    if (get('title')) set.title = get('title').slice(0, 100);
    if (get('fallbackTitle')) set.fallbackTitle = get('fallbackTitle').slice(0, 100);
    if (get('description')) set.description = get('description').slice(0, 600);
    if (get('seats')) {
      const n = Number(get('seats'));
      Number.isFinite(n) && n >= 0 ? (set.seats = Math.round(n)) : plan.warnings.push(T.badNumber(key, 'Мест', get('seats')));
    }
    if (get('duration')) {
      const h = Number(get('duration').replace(',', '.'));
      Number.isFinite(h) && h >= 0 ? (set.durationMinutes = Math.round(h * 60)) : plan.warnings.push(T.badNumber(key, 'Длительность', get('duration')));
    }
    if (get('placeTypes')) {
      const types = /^(нет|все|-)$/i.test(get('placeTypes')) ? [] : get('placeTypes').split(/[;,]/).map((s) => s.trim()).filter(Boolean);
      const known = types.map((t) => matchPlaceType(t)).filter(Boolean) as string[];
      types.filter((t) => !matchPlaceType(t)).forEach((t) => plan.warnings.push(T.badType(key, t)));
      set.placeTypes = known;
    }
    if (get('tags')) {
      const parts = /^(нет|-)$/i.test(get('tags')) ? [] : get('tags').split(/[;,]/).map((s) => s.trim()).filter(Boolean);
      const tags: EventTag[] = [];
      parts.forEach((p) => {
        const tag = EVENT_TAGS.find((t) => norm(TAG_LABELS[t]) === norm(p) || t === p);
        tag ? tags.push(tag) : plan.warnings.push(T.badTag(key, p));
      });
      set.tags = tags;
    }
    if (get('fields')) {
      if (/^(нет|-)$/i.test(get('fields'))) set.fields = [];
      else {
        try {
          const fields = JSON.parse(get('fields'));
          if (!Array.isArray(fields) || fields.some((f) => !f?.key || !f?.label || !['select', 'text', 'money'].includes(f?.type))) throw new Error();
          set.fields = fields;
        } catch {
          plan.warnings.push(T.badJson(key));
        }
      }
    }

    if (!old && !set.name) return plan.errors.push(T.needName(key));
    // {метки} в тексте должны быть среди доп. полей
    const fields: ITemplateField[] = set.fields || old?.fields || [];
    const tokens = new Set(fields.map((f) => f.token).filter(Boolean));
    [set.title ?? old?.title ?? '', set.description ?? old?.description ?? ''].flatMap(tokensIn).forEach((tok) => {
      if (!tokens.has(tok)) plan.warnings.push(T.unknownToken(key, tok));
    });
    if (Object.keys(set).length) plan.rows.push({ key, isNew: !old, set });
  });
  return plan;
}

/* ---------- Бот ---------- */

async function callBot(method: string, body: any) {
  const res = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return res.json().catch(() => ({}));
}

const say = (chatId: number, html: string, keyboard?: { text: string; callback_data: string }[][]) =>
  callBot('sendMessage', {
    chat_id: chatId,
    text: html,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {})
  });

const pending = new Map<number, TemplatesPlan>();

// /templates — прислать таблицу шаблонов
export async function handleTemplatesCommand(message: any): Promise<boolean> {
  const text: string = (message.text || '').trim();
  if (!/^\/templates\b/i.test(text)) return false;
  if (!isAdmin(message.from?.id)) return false;
  const form = new FormData();
  form.append('chat_id', String(message.chat.id));
  form.append('caption', T.csvCaption);
  form.append('parse_mode', 'HTML');
  form.append('document', new Blob(['﻿' + (await templatesCsv())], { type: 'text/csv' }), T.fileName);
  await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendDocument`, { method: 'POST', body: form }).catch(() => {});
  return true;
}

// Пришла таблица шаблонов: показываем, что изменится, и ждём «Загрузить»
export async function handleTemplatesRows(chatId: number, rows: string[][]) {
  const plan = await planTemplates(rows);
  const created = plan.rows.filter((r) => r.isNew);
  const updated = plan.rows.filter((r) => !r.isNew);
  const lines = [T.summaryTitle];
  if (created.length) lines.push(T.willCreate(created.length, created.map((r) => escapeHtml(r.key)).join(', ')));
  if (updated.length) lines.push(T.willUpdate(updated.length, updated.map((r) => escapeHtml(r.key)).join(', ')));
  if (plan.errors.length) lines.push('', T.cantDo, ...plan.errors.map((e) => `• ${escapeHtml(e)}`));
  if (plan.warnings.length) lines.push('', T.notice, ...plan.warnings.slice(0, 15).map((w) => `• ${escapeHtml(w)}`));
  if (!plan.rows.length) return say(chatId, `${lines.join('\n')}\n\n${T.nothing}`);
  pending.set(chatId, plan);
  return say(chatId, lines.join('\n'), [
    [
      { text: T.applyBtn, callback_data: 'tpl:apply' },
      { text: T.cancelBtn, callback_data: 'tpl:cancel' }
    ]
  ]);
}

export async function handleTemplatesCallback(query: any): Promise<boolean> {
  const data: string = query.data || '';
  if (!data.startsWith('tpl:')) return false;
  const chatId: number = query.message?.chat?.id;
  callBot('answerCallbackQuery', { callback_query_id: query.id });
  callBot('editMessageReplyMarkup', { chat_id: chatId, message_id: query.message.message_id, reply_markup: { inline_keyboard: [] } });
  if (!isAdmin(query.from?.id)) return true;
  const plan = pending.get(chatId);
  pending.delete(chatId);
  if (data === 'tpl:cancel') return say(chatId, T.cancelled), true;
  if (!plan) return say(chatId, T.expired), true;
  for (const row of plan.rows) {
    await EventTemplate.updateOne({ key: row.key }, { $set: row.set }, { upsert: true });
  }
  say(chatId, T.done(plan.rows.filter((r) => r.isNew).length, plan.rows.filter((r) => !r.isNew).length));
  return true;
}

