import { Express, Response } from 'express';
import mongoose, { Schema, model } from 'mongoose';
import { telegramAuthMiddleware, AuthenticatedRequest } from './middleware/telegramAuth';
import { Place, matchPlaceType, PLACE_TYPES, PLACE_MOODS, PlaceMood } from './models/Place';
import { User } from './models/User';
import { escapeHtml, sendTelegramMessage } from './utils/telegramNotify';
import { geocode, placeFromYandexLink, isYandexMapsLink } from './places';
import { sendWithButtons } from './wishes';
import { isAdmin, adminIds } from './news';
import { SUGGEST_TEXTS as T } from './texts';

/**
 * Люди предлагают места: ссылкой из Яндекс Карт или названием с адресом.
 * Автор получает карточку «✅ Добавить в Места / ❌ Нет», автор места — спасибо
 */

interface IPlaceSuggestion {
  telegramId: number;
  name: string;
  address: string;
  mapUrl: string;
  coords: [number, number]; // [lat, lng]
  category: string;         // тип: выбирает человек, или понятен из контекста (кофе → «Кофейня»)
  description: string;      // одна фраза, может дописать автор
  context: string;          // откуда: «Для группы … на кофе»
  status: 'pending' | 'approved' | 'rejected';
  placeId?: string;
  createdAt: Date;
}

export const PlaceSuggestion = model<IPlaceSuggestion>(
  'PlaceSuggestion',
  new Schema<IPlaceSuggestion>({
    telegramId: { type: Number, required: true },
    name: { type: String, required: true, maxlength: 80 },
    address: { type: String, default: '' },
    mapUrl: { type: String, default: '' },
    coords: { type: [Number], required: true },
    category: { type: String, default: '' },
    description: { type: String, default: '', maxlength: 300 },
    context: { type: String, default: '' },
    status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
    placeId: { type: String },
    createdAt: { type: Date, default: Date.now }
  })
);

const MAX_PER_DAY = 10;

// Ссылка или «название, адрес» → место в Минске.
// Яндекс копирует «Название\nАдрес\nссылка» — название и адрес берём из текста, точку из ссылки;
// не открылась ссылка — ищем по адресу из того же текста
export async function parsePlaceText(text: string): Promise<{ name: string; address: string; mapUrl: string; coords: [number, number] } | null> {
  const url = text.match(/https?:\/\/\S+/)?.[0];
  const lines = text
    .replace(/https?:\/\/\S+/g, '')
    .split(/\n/)
    .map((x) => x.trim())
    .filter(Boolean);
  const userName = lines[0]?.split(',')[0].trim().slice(0, 80) || '';
  const userAddress = lines.slice(1).join(', ').trim();

  if (url && isYandexMapsLink(url)) {
    const found = await placeFromYandexLink(url);
    if (found) {
      // «Художественный дом Угринович, магазин подарков…, Минск» → «Художественный дом Угринович»
      const fromPage = found.label.split(',')[0].trim();
      return { name: (userName || fromPage || 'Место').slice(0, 80), address: userAddress, mapUrl: url, coords: found.coords };
    }
  }
  if (!lines.length) return null;
  // Адрес может быть в любой части — пробуем целиком, потом части с конца
  const plain = lines.join(', ');
  const parts = plain.split(',').map((x) => x.trim()).filter(Boolean);
  for (const q of [userAddress, plain, ...parts.slice().reverse()].filter(Boolean)) {
    const found = await geocode(q);
    // Адрес — как написал человек (геокодер иногда подписывает точку чужим названием)
    const typed = userAddress || (lines.length === 1 ? parts.slice(1).join(', ') : '') || q;
    if (found) return { name: (userName || parts[0]).slice(0, 80), address: typed.slice(0, 120), mapUrl: url && isYandexMapsLink(url) ? url : '', coords: found.coords };
  }
  return null;
}

// Сохранить предложение и показать автору проекта
export async function suggestPlace(telegramId: number, parsed: { name: string; address: string; mapUrl: string; coords: [number, number] }, category = '', context = '') {
  const s = await PlaceSuggestion.create({ telegramId, ...parsed, category: matchPlaceType(category) || '', context });
  const user = await User.findOne({ telegramId }, { firstName: 1, username: 1 }).lean();
  for (const id of adminIds()) await sendSuggestionCard(id, s);
  return s;
}

const whoOf = async (telegramId: number) => {
  const user = await User.findOne({ telegramId }, { firstName: 1, username: 1 }).lean();
  return `${escapeHtml(user?.firstName || 'кто-то')}${user?.username ? ` (@${escapeHtml(user.username)})` : ''}`;
};

// Кнопки правки: s — предложение, p — опубликованное место
const editButtons = (kind: 's' | 'p', id: string) => [
  [
    { text: T.editName, data: `ed:${kind}:name:${id}` },
    { text: T.editCat, data: `ed:${kind}:cat:${id}` }
  ],
  [
    { text: T.editAddr, data: `ed:${kind}:addr:${id}` },
    { text: T.editDesc, data: `ed:${kind}:desc:${id}` }
  ],
  // Вайбы — у опубликованного места
  ...(kind === 'p' ? [[{ text: T.editMoods, data: `edm:${id}:open` }]] : [])
];

// Вайбы кнопками: ✅ выбранные, «Готово» — показать карточку
const moodButtons = (id: string, moods: string[]) => [
  ...(Object.keys(PLACE_MOODS) as PlaceMood[]).map((k) => [
    { text: `${moods.includes(k) ? '✅' : '▫️'} ${PLACE_MOODS[k].emoji} ${PLACE_MOODS[k].label}`, data: `edm:${id}:${k}` }
  ]),
  [{ text: T.moodsDone, data: `edm:${id}:done` }]
];

async function sendSuggestionCard(chatId: number, s: any) {
  await sendWithButtons(
    chatId,
    T.adminCard(escapeHtml(s.name), escapeHtml(s.category), escapeHtml(s.address), escapeHtml(s.description || ''), s.mapUrl, await whoOf(s.telegramId), escapeHtml(s.context)),
    [
      [
        { text: T.approveBtn, data: `sgp:ok:${s._id}` },
        { text: T.rejectBtn, data: `sgp:no:${s._id}` }
      ],
      ...editButtons('s', String(s._id))
    ]
  );
}

async function sendPlaceCard(chatId: number, p: any) {
  const moods = (p.moods || []).map((m: PlaceMood) => `${PLACE_MOODS[m]?.emoji} ${PLACE_MOODS[m]?.label}`).join(', ');
  await sendWithButtons(chatId, T.placeCard(escapeHtml(p.name), escapeHtml(p.category || ''), escapeHtml(p.address || ''), escapeHtml(p.description || ''), p.mapUrl || '', moods), editButtons('p', String(p._id)));
}

// Типы мест кнопками по два в ряд
const typeButtons = (kind: string, id: string) => {
  const rows: { text: string; data: string }[][] = [];
  PLACE_TYPES.forEach((t, i) => {
    if (i % 2 === 0) rows.push([]);
    rows[rows.length - 1].push({ text: t, data: `edc:${kind}:${id}:${i}` });
  });
  return rows;
};

// Подсказки автору — без кнопки «Открыть приложение»
const say = (chatId: number, html: string) => sendWithButtons(chatId, html, []);

// Автор правит поле: ждём следующее сообщение текстом
const editing = new Map<number, { kind: 's' | 'p'; field: 'name' | 'addr' | 'desc'; id: string }>();

const loadTarget = async (kind: string, id: string): Promise<any> =>
  !mongoose.Types.ObjectId.isValid(id) ? null : kind === 's' ? PlaceSuggestion.findById(id) : Place.findById(id);

const showCard = (chatId: number, kind: string, doc: any) => (kind === 's' ? sendSuggestionCard(chatId, doc) : sendPlaceCard(chatId, doc));

// Ответ автора при правке названия, адреса или описания. /placeedit номер — карточка правки любого места
export async function handleSuggestionEditMessage(message: any): Promise<boolean> {
  const chatId: number = message.chat?.id;
  const text: string = (message.text || '').trim();
  if (!isAdmin(message.from?.id)) return false;

  const cmd = text.match(/^\/placeedit(?:\s+(.+))?$/i);
  if (cmd) {
    if (!cmd[1]) return say(chatId, T.editUsage), true;
    const places = await Place.find({}).sort({ createdAt: 1 });
    const n = Number(cmd[1].trim());
    const q = cmd[1].trim().toLowerCase();
    const target = Number.isInteger(n) && n > 0 ? places[n - 1] : places.find((p) => p.name.toLowerCase().includes(q));
    if (!target) return say(chatId, T.editNoPlace), true;
    await sendPlaceCard(chatId, target);
    return true;
  }

  const state = editing.get(chatId);
  if (!state) return false;
  if (/^\/cancel\b/i.test(text)) {
    editing.delete(chatId);
    say(chatId, T.editCancelled);
    return true;
  }
  if (!text || text.startsWith('/')) return false;
  const doc = await loadTarget(state.kind, state.id);
  editing.delete(chatId);
  if (!doc) return true;

  if (state.field === 'name') doc.name = text.slice(0, 80);
  if (state.field === 'desc') doc.description = text === '-' ? '' : text.slice(0, 300);
  if (state.field === 'addr') {
    // Ссылка из Яндекс Карт или адрес: ищем точку
    const parsed = await parsePlaceText(text);
    if (!parsed) {
      editing.set(chatId, state);
      say(chatId, T.editAddrNotFound);
      return true;
    }
    doc.address = text.replace(/https?:\/\/\S+/g, '').trim().replace(/\s*\n\s*/g, ', ').slice(0, 120) || parsed.address;
    if (parsed.mapUrl) doc.mapUrl = parsed.mapUrl;
    if (state.kind === 's') doc.coords = parsed.coords;
    else doc.location = { type: 'Point', coordinates: [parsed.coords[1], parsed.coords[0]] };
  }
  await doc.save();
  await showCard(chatId, state.kind, doc);
  return true;
}

export function setupPlaceSuggestionRoutes(app: Express) {
  // Из приложения: { text, category? }
  app.post('/api/places/suggest', telegramAuthMiddleware as any, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const myId = req.telegramUser!.id;
      const text = String(req.body?.text || '').slice(0, 500);
      if (!text.trim()) return res.status(400).json({ error: T.needLink });
      const today = await PlaceSuggestion.countDocuments({ telegramId: myId, createdAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } });
      if (today >= MAX_PER_DAY) return res.status(429).json({ error: T.thanks });
      const parsed = await parsePlaceText(text);
      if (!parsed) return res.status(400).json({ error: T.notFound });
      await suggestPlace(myId, parsed, String(req.body?.category || ''), String(req.body?.context || '').slice(0, 100));
      res.json({ ok: true, name: parsed.name });
    } catch {
      res.status(500).json({ error: T.notFound });
    }
  });
}

// Кнопки автора: sgp:ok:<id> / sgp:no:<id>
export async function handleSuggestionCallback(query: any): Promise<boolean> {
  const data: string = query.data || '';
  if (!/^(sgp|ed|edc|edm):/.test(data)) return false;
  const call = (method: string, body: any) =>
    fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).catch(() => {});
  call('answerCallbackQuery', { callback_query_id: query.id });
  if (!isAdmin(query.from?.id)) return true;
  const chatId = query.message?.chat?.id;

  // ✏️ Правка: название, адрес, описание — следующим сообщением; тип — кнопкой
  if (data.startsWith('ed:')) {
    const [, kind, field, id] = data.split(':');
    const doc = await loadTarget(kind, id);
    if (!doc) return true;
    if (kind === 's' && doc.status !== 'pending') return say(chatId, T.editDone), true;
    if (field === 'cat') {
      await sendWithButtons(chatId, T.editAskCat(escapeHtml(doc.name)), typeButtons(kind, id));
      return true;
    }
    editing.set(chatId, { kind: kind as 's' | 'p', field: field as 'name' | 'addr' | 'desc', id });
    say(chatId, field === 'name' ? T.editAskName(escapeHtml(doc.name)) : field === 'addr' ? T.editAskAddr : T.editAskDesc);
    return true;
  }
  // 🌈 Вайбы места: переключаем прямо в этом сообщении
  if (data.startsWith('edm:')) {
    const [, id, key] = data.split(':');
    const place = mongoose.Types.ObjectId.isValid(id) ? await Place.findById(id) : null;
    if (!place) return true;
    if (key === 'open') {
      await sendWithButtons(chatId, T.editAskMoods(escapeHtml(place.name)), moodButtons(id, place.moods));
      return true;
    }
    if (key === 'done') {
      call('editMessageReplyMarkup', { chat_id: chatId, message_id: query.message?.message_id, reply_markup: { inline_keyboard: [] } });
      await sendPlaceCard(chatId, place);
      return true;
    }
    if (!(key in PLACE_MOODS)) return true;
    const k = key as PlaceMood;
    place.moods = place.moods.includes(k) ? place.moods.filter((m) => m !== k) : [...place.moods, k];
    await place.save();
    const kb = moodButtons(id, place.moods).map((row) => row.map((b) => ({ text: b.text, callback_data: b.data })));
    call('editMessageReplyMarkup', { chat_id: chatId, message_id: query.message?.message_id, reply_markup: { inline_keyboard: kb } });
    return true;
  }
  if (data.startsWith('edc:')) {
    const [, kind, id, idx] = data.split(':');
    const doc = await loadTarget(kind, id);
    const type = PLACE_TYPES[Number(idx)];
    if (!doc || !type) return true;
    call('editMessageReplyMarkup', { chat_id: chatId, message_id: query.message?.message_id, reply_markup: { inline_keyboard: [] } });
    doc.category = type;
    await doc.save();
    await showCard(chatId, kind, doc);
    return true;
  }

  call('editMessageReplyMarkup', { chat_id: query.message?.chat?.id, message_id: query.message?.message_id, reply_markup: { inline_keyboard: [] } });
  const [, action, id] = data.split(':');
  const s = mongoose.Types.ObjectId.isValid(id) ? await PlaceSuggestion.findById(id) : null;
  if (!s || s.status !== 'pending') return true;

  if (action === 'no') {
    s.status = 'rejected';
    await s.save();
    sendTelegramMessage(query.message.chat.id, T.rejected);
    return true;
  }
  // Уже есть такое место (по названию) — не дублируем
  const existing = await Place.findOne({ name: s.name });
  const place =
    existing ||
    (await Place.create({
      authorId: s.telegramId,
      name: s.name,
      category: s.category,
      address: s.address,
      description: s.description || '',
      mapUrl: s.mapUrl,
      location: { type: 'Point', coordinates: [s.coords[1], s.coords[0]] },
      photos: [],
      moods: []
    }));
  s.status = 'approved';
  s.placeId = String(place._id);
  await s.save();
  await sendWithButtons(query.message.chat.id, T.approved(escapeHtml(place.name), place.category), editButtons('p', String(place._id)));
  if (!isAdmin(s.telegramId)) sendTelegramMessage(s.telegramId, T.authorApproved(escapeHtml(place.name)), 'Открыть «Места»', `?place=${place._id}`);
  return true;
}

// Один раз: у мест, добавленных из предложений, автор — тот, кто предложил
export async function backfillPlaceAuthors() {
  try {
    const approved = await PlaceSuggestion.find({ status: 'approved', placeId: { $exists: true } }, { placeId: 1, telegramId: 1 }).lean();
    let n = 0;
    for (const s of approved) {
      if (!mongoose.Types.ObjectId.isValid(s.placeId!)) continue;
      const r = await Place.updateOne({ _id: s.placeId, authorId: { $exists: false } }, { $set: { authorId: s.telegramId } });
      n += r.modifiedCount;
    }
    if (n) console.log(`✅ Авторы мест из предложений: ${n}`);
  } catch (err: any) {
    console.warn('⚠️ Авторы мест:', err?.message || err);
  }
}
