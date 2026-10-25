import { Express, Response } from 'express';
import mongoose, { Schema, model } from 'mongoose';
import { telegramAuthMiddleware, AuthenticatedRequest } from './middleware/telegramAuth';
import { Place, matchPlaceType } from './models/Place';
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
  category: string;         // тип, если понятен из контекста (кофе → «Кофейня»)
  context: string;          // откуда: «Для группы … на кофе»
  status: 'pending' | 'approved' | 'rejected';
  placeId?: string;
  createdAt: Date;
}

const PlaceSuggestion = model<IPlaceSuggestion>(
  'PlaceSuggestion',
  new Schema<IPlaceSuggestion>({
    telegramId: { type: Number, required: true },
    name: { type: String, required: true, maxlength: 80 },
    address: { type: String, default: '' },
    mapUrl: { type: String, default: '' },
    coords: { type: [Number], required: true },
    category: { type: String, default: '' },
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
    if (found) return { name: (userName || parts[0]).slice(0, 80), address: found.label, mapUrl: url && isYandexMapsLink(url) ? url : '', coords: found.coords };
  }
  return null;
}

// Сохранить предложение и показать автору проекта
export async function suggestPlace(telegramId: number, parsed: { name: string; address: string; mapUrl: string; coords: [number, number] }, category = '', context = '') {
  const s = await PlaceSuggestion.create({ telegramId, ...parsed, category: matchPlaceType(category) || '', context });
  const user = await User.findOne({ telegramId }, { firstName: 1, username: 1 }).lean();
  const who = `${escapeHtml(user?.firstName || 'кто-то')}${user?.username ? ` (@${escapeHtml(user.username)})` : ''}`;
  for (const id of adminIds()) {
    await sendWithButtons(id, T.adminCard(escapeHtml(s.name), escapeHtml(s.address), s.mapUrl, who, escapeHtml(context)), [
      [
        { text: T.approveBtn, data: `sgp:ok:${s._id}` },
        { text: T.rejectBtn, data: `sgp:no:${s._id}` }
      ]
    ]);
  }
  return s;
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
  if (!data.startsWith('sgp:')) return false;
  const call = (method: string, body: any) =>
    fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).catch(() => {});
  call('answerCallbackQuery', { callback_query_id: query.id });
  if (!isAdmin(query.from?.id)) return true;
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
      name: s.name,
      category: s.category,
      address: s.address,
      mapUrl: s.mapUrl,
      location: { type: 'Point', coordinates: [s.coords[1], s.coords[0]] },
      photos: [],
      moods: []
    }));
  s.status = 'approved';
  s.placeId = String(place._id);
  await s.save();
  sendTelegramMessage(query.message.chat.id, T.approved(escapeHtml(place.name), place.category));
  if (!isAdmin(s.telegramId)) sendTelegramMessage(s.telegramId, T.authorApproved(escapeHtml(place.name)), 'Открыть «Места»', `?place=${place._id}`);
  return true;
}
