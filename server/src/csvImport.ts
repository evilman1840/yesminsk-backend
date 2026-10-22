import { Place, PLACE_MOODS, PlaceMood, PlacePrice, KidsLevel, matchPlaceType, IPlace } from './models/Place';
import { escapeHtml } from './utils/telegramNotify';
import { isAdmin } from './news';
import { geocode, placeFromYandexLink } from './places';

/**
 * Загрузка таблиц в боте: автор присылает CSV — бот показывает, что изменится, и после «✅ Загрузить» применяет.
 * Таблица мест: новые места добавляются, у существующих (по названию) обновляются заполненные ячейки.
 * Таблица отзывов: отзывы этих мест заменяются целиком. /template — пришлёт шаблоны
 */

const MAX_ROWS = 300;
const MAX_PHOTOS = 10;

/* ---------- Шаблоны ---------- */

export const PLACES_TEMPLATE = [
  'Название,Тип,Описание,Адрес,Яндекс Карты,Настроения,Цена,Пометки,С детьми,Про детей,Рейтинг,Оценок,Часы,Телефон,Сайт,Удобства,Совет,Блог,Фото',
  '"ПРИМЕР — удали эту строку",Парк,"Знаковый парк: каток, летний театр, аттракционы","ул. Фрунзе, 2",https://yandex.by/maps/org/210583171094/,"Поймать восторг, Оторваться компанией",Бесплатно,"в дождь, вечером",топ,"Главный детский парк центра: аттракционы, колесо обозрения, белки","4,8",3442,24/7,+375 17 294-42-52,http://parki.by,"Собаки; Карты, NFC; Доступная среда","Приходи к колесу на закате","",""'
].join('\n');

export const REVIEWS_TEMPLATE = [
  'Место,Оценка,Текст,Источник',
  '"ПРИМЕР — удали эту строку",5,"Огромный, чистый и уютный парк, гулять приятно хоть днём, хоть ночью.",Яндекс Карты',
  '"ПРИМЕР — удали эту строку",2,"Очереди на аттракционы в солнечные выходные.",Яндекс Карты'
].join('\n');

/* ---------- CSV ---------- */

// Разбор CSV: кавычки, переносы строк в ячейках, разделитель «,» или «;» (Excel с русскими настройками)
export function parseCsv(raw: string): string[][] {
  const text = raw.replace(/^﻿/, '');
  const firstLine = text.split(/\r?\n/)[0] || '';
  const sep = (firstLine.match(/;/g) || []).length > (firstLine.match(/,/g) || []).length ? ';' : ',';
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') inQuotes = false;
      else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === sep) {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.some((f) => f.trim())) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f.trim())) rows.push(row);
  return rows;
}

const norm = (s: string) => s.toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();

// Названия столбцов: как в шаблоне и как бывало в таблицах автора
const PLACE_COLUMNS: Record<string, string[]> = {
  name: ['название', 'место'],
  type: ['тип', 'категория'],
  description: ['описание'],
  address: ['адрес'],
  mapUrl: ['яндекс карты', 'ссылка яндекс карты', 'на яндекс картах', 'ссылка'],
  moods: ['настроения', 'настроение'],
  price: ['цена', 'стоимость'],
  marks: ['пометки'],
  kids: ['с детьми', 'дети'],
  kidsNote: ['про детей', 'детям'],
  rating: ['рейтинг', 'рейтинг y', 'рейтинг яндекс'],
  ratingCount: ['оценок', 'отзывов', 'количество оценок'],
  hours: ['часы', 'часы работы'],
  phone: ['телефон'],
  website: ['сайт'],
  amenities: ['удобства'],
  tip: ['совет', 'совет миши'],
  blog: ['блог', 'статья'],
  photos: ['фото', 'фотографии']
};
const REVIEW_COLUMNS: Record<string, string[]> = {
  place: ['место', 'название'],
  rating: ['оценка'],
  text: ['текст', 'отзыв'],
  source: ['источник']
};

const mapColumns = (header: string[], columns: Record<string, string[]>) => {
  const idx: Record<string, number> = {};
  header.forEach((h, i) => {
    const key = Object.keys(columns).find((k) => columns[k].includes(norm(h)));
    if (key && idx[key] === undefined) idx[key] = i;
  });
  return idx;
};

// Строка-пример из шаблона: её не загружаем, даже если забыли удалить
const isExample = (name: string) => /^пример\b/i.test(name.trim());

const na = (v?: string) => {
  const t = (v || '').trim();
  return !t || /^(н\/д|нет данных|-|—)$/i.test(t) ? '' : t;
};

/* ---------- Значения ячеек ---------- */

const MOOD_BY_LABEL = new Map<string, PlaceMood>(
  (Object.keys(PLACE_MOODS) as PlaceMood[]).flatMap((k) => [
    [norm(PLACE_MOODS[k].label), k] as [string, PlaceMood],
    [PLACE_MOODS[k].emoji, k] as [string, PlaceMood]
  ])
);

const parseMoods = (v: string) => {
  const moods: PlaceMood[] = [];
  const unknown: string[] = [];
  v.split(/[,;]/).map((s) => s.trim()).filter(Boolean).forEach((s) => {
    const m = MOOD_BY_LABEL.get(norm(s));
    if (m) moods.includes(m) || moods.push(m);
    else unknown.push(s);
  });
  return { moods, unknown };
};

const parsePrice = (v: string): PlacePrice | null => {
  const t = norm(v);
  if (t.includes('бесплат')) return 'free';
  if (t.includes('недорог') || t.includes('дешев')) return 'cheap';
  if (t.includes('средн')) return 'mid';
  return null;
};

const parseKids = (v: string): KidsLevel | 'none' | null => {
  const t = norm(v);
  if (/^(нет|не подходит)$/.test(t)) return 'none';
  if (t.includes('топ') || t.includes('отлично') || t.includes('специально')) return 'top';
  if (t.includes('возраст') || t.includes('постарше')) return 'age';
  if (t.includes('рядом') || t.includes('можно')) return 'nearby';
  return null;
};

const parseNumber = (v: string) => {
  const n = Number(v.replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
};

/* ---------- План загрузки ---------- */

interface PlaceRow {
  line: number;
  name: string;
  existingId?: string;
  set: Partial<IPlace> & Record<string, any>;
  photoUrls: string[];
  coords?: [number, number];
}

interface Plan {
  kind: 'places' | 'reviews';
  places: PlaceRow[];
  reviews: Map<string, { placeId: string; name: string; items: { rating?: number; text: string; source: string }[] }>;
  warnings: string[];
  errors: string[];
}

const pending = new Map<number, Plan>();

async function planPlaces(rows: string[][]): Promise<Plan> {
  const [header, ...data] = rows;
  const col = mapColumns(header, PLACE_COLUMNS);
  const plan: Plan = { kind: 'places', places: [], reviews: new Map(), warnings: [], errors: [] };
  if (col.name === undefined) {
    plan.errors.push('Нет столбца «Название».');
    return plan;
  }
  const all = await Place.find({}, { name: 1 }).lean();
  const byName = new Map(all.map((p) => [norm(p.name), p._id.toString()]));
  const seen = new Set<string>();

  for (let r = 0; r < data.length && r < MAX_ROWS; r++) {
    const cells = data[r];
    const line = r + 2;
    const get = (key: string) => (col[key] === undefined ? '' : na(cells[col[key]]));
    const name = get('name');
    if (!name || isExample(name)) continue;
    if (seen.has(norm(name))) {
      plan.warnings.push(`Строка ${line}: «${name}» уже было выше — пропускаю`);
      continue;
    }
    seen.add(norm(name));

    const set: Record<string, any> = {};
    const row: PlaceRow = { line, name, existingId: byName.get(norm(name)), set, photoUrls: [] };

    if (get('type')) {
      const type = matchPlaceType(get('type'));
      if (type) set.category = type;
      else plan.warnings.push(`«${name}»: тип «${get('type')}» не из списка — не меняю`);
    }
    if (get('description')) set.description = get('description').slice(0, 300);
    if (get('moods')) {
      const { moods, unknown } = parseMoods(get('moods'));
      if (moods.length) set.moods = moods;
      if (unknown.length) plan.warnings.push(`«${name}»: не знаю настроения ${unknown.map((u) => `«${u}»`).join(', ')}`);
    }
    if (get('price')) {
      const price = parsePrice(get('price'));
      if (price) set.price = price;
      else plan.warnings.push(`«${name}»: цена «${get('price')}» — нужно «Бесплатно», «Недорого» или «Средне»`);
    }
    if (get('marks')) {
      const t = norm(get('marks'));
      set.rainOk = t.includes('дожд');
      set.evening = t.includes('вечер');
      set.oneDay = t.includes('один день') || t.includes('турист');
    }
    if (get('kids')) {
      const kids = parseKids(get('kids'));
      if (kids === 'none') set.kidsLevel = undefined;
      else if (kids) set.kidsLevel = kids;
      else plan.warnings.push(`«${name}»: «С детьми» = «${get('kids')}» — нужно «топ», «постарше», «рядом» или «нет»`);
    }
    if (get('kidsNote')) set.kidsNote = get('kidsNote').slice(0, 600);
    if (get('rating')) {
      const n = parseNumber(get('rating'));
      if (n !== null && n >= 0 && n <= 5) set.rating = n;
    }
    if (get('ratingCount')) {
      const n = parseNumber(get('ratingCount'));
      if (n !== null && n >= 0) set.ratingCount = Math.round(n);
    }
    if (get('hours')) set.hours = get('hours').slice(0, 120);
    if (get('phone')) set.phone = get('phone').slice(0, 40);
    if (get('website')) set.website = get('website').slice(0, 300);
    if (get('amenities')) {
      set.amenities = get('amenities')
        .split(';')
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => s.charAt(0).toUpperCase() + s.slice(1));
    }
    if (get('tip')) set.mishaTip = get('tip').slice(0, 400);
    if (get('blog')) set.blogUrl = get('blog');
    if (get('photos')) row.photoUrls = get('photos').split(/[\s,;]+/).filter((u) => /^https?:\/\//i.test(u)).slice(0, MAX_PHOTOS);
    if (get('address')) set.address = get('address').replace(/\s+/g, ' ').slice(0, 200);

    // Точка на карте: из ссылки Яндекс Карт, иначе по адресу. Для существующего места — только если дали новую ссылку/адрес
    const mapUrl = get('mapUrl');
    if (mapUrl) set.mapUrl = mapUrl;
    if (mapUrl || get('address') || !row.existingId) {
      const found = (mapUrl ? await placeFromYandexLink(mapUrl) : null) || (get('address') ? await geocode(get('address')) : null);
      if (found) row.coords = found.coords;
      else if (!row.existingId) {
        plan.errors.push(`«${name}»: не нашёл, где это. Добавь ссылку на Яндекс Карты или точный адрес`);
        continue;
      } else if (mapUrl || get('address')) plan.warnings.push(`«${name}»: не нашёл точку по новой ссылке/адресу — оставляю старую`);
    }
    plan.places.push(row);
  }
  if (data.length > MAX_ROWS) plan.warnings.push(`Беру первые ${MAX_ROWS} строк`);
  return plan;
}

async function planReviews(rows: string[][]): Promise<Plan> {
  const [header, ...data] = rows;
  const col = mapColumns(header, REVIEW_COLUMNS);
  const plan: Plan = { kind: 'reviews', places: [], reviews: new Map(), warnings: [], errors: [] };
  if (col.place === undefined || col.text === undefined) {
    plan.errors.push('Нужны столбцы «Место» и «Текст».');
    return plan;
  }
  const all = await Place.find({}, { name: 1 }).lean();
  const byName = new Map(all.map((p) => [norm(p.name), { id: p._id.toString(), name: p.name }]));
  const missing = new Set<string>();
  data.slice(0, MAX_ROWS * 5).forEach((cells) => {
    const placeName = na(cells[col.place]);
    const text = na(cells[col.text]);
    if (!placeName || !text || isExample(placeName)) return;
    const place = byName.get(norm(placeName));
    if (!place) {
      missing.add(placeName);
      return;
    }
    const rating = col.rating !== undefined ? parseNumber(na(cells[col.rating])) : null;
    const entry = plan.reviews.get(place.id) || { placeId: place.id, name: place.name, items: [] };
    entry.items.push({
      rating: rating && rating >= 1 && rating <= 5 ? Math.round(rating) : undefined,
      text: text.slice(0, 600),
      source: (col.source !== undefined && na(cells[col.source])) || 'Яндекс Карты'
    });
    plan.reviews.set(place.id, entry);
  });
  if (missing.size) plan.errors.push(`Нет таких мест: ${[...missing].map((m) => `«${m}»`).join(', ')} — сначала загрузи их таблицей мест`);
  return plan;
}

const summary = (plan: Plan) => {
  const lines: string[] = [];
  if (plan.kind === 'places') {
    const created = plan.places.filter((p) => !p.existingId);
    const updated = plan.places.filter((p) => p.existingId);
    const photos = plan.places.reduce((n, p) => n + p.photoUrls.length, 0);
    lines.push('📍 <b>Таблица мест</b>');
    if (created.length) lines.push(`➕ Добавлю: ${created.length} — ${created.map((p) => escapeHtml(p.name)).join(', ')}`);
    if (updated.length) lines.push(`✏️ Обновлю: ${updated.length} — ${updated.map((p) => escapeHtml(p.name)).join(', ')}`);
    if (photos) lines.push(`🖼 Фото по ссылкам: ${photos} (заменят фото этих мест)`);
  } else {
    const total = [...plan.reviews.values()].reduce((n, r) => n + r.items.length, 0);
    lines.push('💬 <b>Таблица отзывов</b>');
    if (total) lines.push(`Загружу ${total} отзывов к ${plan.reviews.size} местам — у этих мест отзывы заменятся`);
  }
  if (plan.errors.length) lines.push('', '❌ <b>Не получится:</b>', ...plan.errors.map((e) => `• ${escapeHtml(e)}`));
  if (plan.warnings.length) lines.push('', '⚠️ <b>Обрати внимание:</b>', ...plan.warnings.slice(0, 15).map((w) => `• ${escapeHtml(w)}`));
  return lines.join('\n');
};

const hasChanges = (plan: Plan) => (plan.kind === 'places' ? plan.places.length > 0 : plan.reviews.size > 0);

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

// Файл-шаблон в чат (с BOM — чтобы Excel открыл кириллицу без «кракозябр»)
async function sendCsv(chatId: number, filename: string, content: string, caption: string) {
  const form = new FormData();
  form.append('chat_id', String(chatId));
  form.append('caption', caption);
  form.append('parse_mode', 'HTML');
  form.append('document', new Blob(['﻿' + content], { type: 'text/csv' }), filename);
  await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendDocument`, { method: 'POST', body: form }).catch(() => {});
}

// Фото по ссылке → file_id Telegram: отправляем себе и сразу удаляем сообщение
async function photoFromUrl(chatId: number, url: string): Promise<string | null> {
  const res: any = await callBot('sendPhoto', { chat_id: chatId, photo: url, disable_notification: true });
  if (!res?.ok) return null;
  const sizes = res.result.photo || [];
  callBot('deleteMessage', { chat_id: chatId, message_id: res.result.message_id });
  return sizes.length ? sizes[sizes.length - 1].file_id : null;
}

async function applyPlan(chatId: number, plan: Plan) {
  if (plan.kind === 'reviews') {
    let n = 0;
    for (const r of plan.reviews.values()) {
      await Place.updateOne({ _id: r.placeId }, { $set: { reviews: r.items } });
      n += r.items.length;
    }
    return say(chatId, `✅ Отзывы загружены: ${n} к ${plan.reviews.size} местам.`);
  }

  let created = 0;
  let updated = 0;
  const badPhotos: string[] = [];
  for (const row of plan.places) {
    const set: Record<string, any> = { ...row.set };
    if (row.coords) set.location = { type: 'Point', coordinates: [row.coords[1], row.coords[0]] };
    if (row.photoUrls.length) {
      const ids: string[] = [];
      for (const url of row.photoUrls) {
        const id = await photoFromUrl(chatId, url);
        if (id) ids.push(id);
        else badPhotos.push(`${row.name}: ${url}`);
      }
      if (ids.length) set.photos = ids;
    }
    const unset: Record<string, 1> = {};
    if ('kidsLevel' in set && set.kidsLevel === undefined) {
      delete set.kidsLevel;
      unset.kidsLevel = 1;
    }
    if (row.existingId) {
      await Place.updateOne({ _id: row.existingId }, { $set: set, ...(Object.keys(unset).length ? { $unset: unset } : {}) });
      updated++;
    } else {
      await Place.create({ name: row.name.slice(0, 80), photos: [], moods: [], ...set });
      created++;
    }
  }
  const lines = [`✅ Готово: добавлено ${created}, обновлено ${updated}.`];
  if (badPhotos.length) {
    lines.push('', `🖼 Не открылись фото (${badPhotos.length}) — нужна прямая ссылка на картинку, или пришли фото боту с подписью-названием:`);
    lines.push(...badPhotos.slice(0, 10).map((b) => `• ${escapeHtml(b)}`));
  }
  return say(chatId, lines.join('\n'));
}

/**
 * Сообщения автора: CSV-файл или /template. Возвращает true, если обработано
 */
export async function handleCsvMessage(message: any): Promise<boolean> {
  const chatId: number = message.chat.id;
  const text: string = (message.text || '').trim();
  const doc = message.document;
  const isCsv = doc && (/\.csv$/i.test(doc.file_name || '') || /csv/i.test(doc.mime_type || ''));
  const isTemplate = /^\/template\b/i.test(text);
  if (!isCsv && !isTemplate) return false;
  if (!isAdmin(message.from?.id)) return isTemplate;

  if (isTemplate) {
    await sendCsv(
      chatId,
      'Шаблон — места.csv',
      PLACES_TEMPLATE,
      '📍 <b>Места.</b> Обязательно: «Название» и «Яндекс Карты» или «Адрес». Остальное — по желанию: пустая ячейка ничего не меняет.\n\nТип — из списка. Настроения — через запятую, как в приложении. С детьми: топ / постарше / рядом / нет. Удобства — через «;». Фото — прямые ссылки на картинки через пробел.'
    );
    await sendCsv(chatId, 'Шаблон — отзывы.csv', REVIEWS_TEMPLATE, '💬 <b>Отзывы.</b> Место — как в таблице мест, оценка 1–5, текст. Отзывы места заменяются целиком.');
    return true;
  }

  if (doc.file_size > 2_000_000) {
    say(chatId, 'Файл слишком большой — до 2 МБ.');
    return true;
  }
  say(chatId, '⏳ Читаю таблицу — для новых мест ищу точки на карте, это может занять минуту…');
  try {
    const info: any = await callBot('getFile', { file_id: doc.file_id });
    const file = await fetch(`https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${info.result.file_path}`);
    const rows = parseCsv(await file.text());
    if (rows.length < 2) {
      say(chatId, 'В таблице нет строк с данными.');
      return true;
    }
    const header = rows[0].map(norm);
    const isReviews = header.some((h) => REVIEW_COLUMNS.text.includes(h));
    const plan = isReviews ? await planReviews(rows) : await planPlaces(rows);
    if (!hasChanges(plan)) {
      say(chatId, `${summary(plan)}\n\nЗагружать нечего.`);
      return true;
    }
    pending.set(chatId, plan);
    say(chatId, summary(plan), [
      [
        { text: '✅ Загрузить', callback_data: 'csv:apply' },
        { text: '❌ Отмена', callback_data: 'csv:cancel' }
      ]
    ]);
  } catch (err: any) {
    say(chatId, `Не получилось прочитать таблицу: ${escapeHtml(err?.message || String(err))}`);
  }
  return true;
}

export async function handleCsvCallback(query: any): Promise<boolean> {
  const data: string = query.data || '';
  if (!data.startsWith('csv:')) return false;
  const chatId: number = query.message?.chat?.id;
  callBot('answerCallbackQuery', { callback_query_id: query.id });
  callBot('editMessageReplyMarkup', { chat_id: chatId, message_id: query.message.message_id, reply_markup: { inline_keyboard: [] } });
  if (!isAdmin(query.from?.id)) return true;

  const plan = pending.get(chatId);
  pending.delete(chatId);
  if (data === 'csv:cancel') {
    say(chatId, 'Отменено, ничего не загружал.');
    return true;
  }
  if (!plan) {
    say(chatId, 'Таблица устарела — пришли файл ещё раз.');
    return true;
  }
  if (plan.places.some((p) => p.photoUrls.length)) say(chatId, '⏳ Загружаю фото…');
  try {
    await applyPlan(chatId, plan);
  } catch (err: any) {
    say(chatId, `Не получилось загрузить: ${escapeHtml(err?.message || String(err))}`);
  }
  return true;
}

