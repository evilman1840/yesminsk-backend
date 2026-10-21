import { Express, Request, Response } from 'express';
import mongoose from 'mongoose';
import { telegramAuthMiddleware, AuthenticatedRequest } from './middleware/telegramAuth';
import { Place, PlaceTip, PLACE_MOODS, PLACE_PRICES, PLACE_TYPES, matchPlaceType, PlaceMood, PlacePrice, IPlace } from './models/Place';
import { User } from './models/User';
import { escapeHtml, sendTelegramMessage } from './utils/telegramNotify';
import { sendTelegramPhoto } from './utils/telegramFile';
import { isAdmin } from './news';

/* ======================================================================
 * Адреса для приложения
 * ==================================================================== */

const formatPlace = (p: IPlace, tipsCount = 0, isSaved = false) => ({
  id: p._id.toString(),
  name: p.name,
  category: p.category || '',
  description: p.description,
  moods: p.moods,
  photos: p.photos.map((f) => `/api/places/photo/${encodeURIComponent(f)}`),
  address: p.address,
  coordinates: [p.location.coordinates[1], p.location.coordinates[0]], // [lat, lng]
  mishaTip: p.mishaTip,
  blogUrl: p.blogUrl,
  mapUrl: p.mapUrl || '',
  isSaved,
  price: p.price || null,
  rainOk: p.rainOk,
  evening: p.evening,
  oneDay: p.oneDay,
  rating: p.rating ?? null,
  ratingCount: p.ratingCount ?? null,
  hours: p.hours || '',
  phone: p.phone || '',
  website: p.website || '',
  amenities: p.amenities || [],
  kidsLevel: p.kidsLevel || null,
  kidsNote: p.kidsNote || '',
  reviews: (p.reviews || []).map((r) => ({ rating: r.rating ?? null, text: r.text, source: r.source || 'Яндекс Карты' })),
  tipsCount
});

export function setupPlacesRoutes(app: Express) {
  app.get('/api/places', telegramAuthMiddleware as any, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const [places, counts, me] = await Promise.all([
        Place.find({}).sort({ createdAt: -1 }).limit(300),
        PlaceTip.aggregate([{ $group: { _id: '$placeId', n: { $sum: 1 } } }]),
        User.findOne({ telegramId: req.telegramUser!.id }, { savedPlaces: 1, hiddenPlaces: 1 }).lean()
      ]);
      const countById = new Map(counts.map((c) => [String(c._id), c.n]));
      const saved = new Set(me?.savedPlaces || []);
      // «Неинтересно» не показываем; сохранённые — всегда
      const hidden = new Set(me?.hiddenPlaces || []);
      res.json(
        places
          .filter((p) => !hidden.has(p._id.toString()) || saved.has(p._id.toString()))
          .map((p) => formatPlace(p, countById.get(p._id.toString()) || 0, saved.has(p._id.toString())))
      );
    } catch (err) {
      res.status(500).json({ error: 'Ошибка загрузки мест' });
    }
  });

  // Скрытые места — список в анкете, чтобы можно было вернуть
  app.get('/api/places/hidden', telegramAuthMiddleware as any, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const me = await User.findOne({ telegramId: req.telegramUser!.id }, { hiddenPlaces: 1 }).lean();
      const ids = (me?.hiddenPlaces || []).filter((id) => mongoose.Types.ObjectId.isValid(id));
      const places = ids.length ? await Place.find({ _id: { $in: ids } }) : [];
      res.json(places.map((p) => formatPlace(p)));
    } catch {
      res.status(500).json({ error: 'Ошибка загрузки скрытых мест' });
    }
  });

  // «Неинтересно»: скрыть место из ленты ({ hidden: false } — вернуть)
  app.post('/api/places/:id/hide', telegramAuthMiddleware as any, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const id = String(req.params.id);
      if (!mongoose.Types.ObjectId.isValid(id)) return res.status(404).json({ error: 'Место не найдено' });
      const hidden = req.body?.hidden !== false;
      await User.updateOne({ telegramId: req.telegramUser!.id }, hidden ? { $addToSet: { hiddenPlaces: id } } : { $pull: { hiddenPlaces: id } });
      res.json({ hidden });
    } catch {
      res.status(500).json({ error: 'Не удалось скрыть место' });
    }
  });

  // 🔖 Сохранить место / убрать из сохранённых
  app.post('/api/places/:id/save', telegramAuthMiddleware as any, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const id = String(req.params.id);
      if (!mongoose.Types.ObjectId.isValid(id) || !(await Place.exists({ _id: id }))) {
        return res.status(404).json({ error: 'Место не найдено' });
      }
      const me = await User.findOne({ telegramId: req.telegramUser!.id }, { savedPlaces: 1 });
      const isSaved = Boolean(me?.savedPlaces?.includes(id));
      await User.updateOne({ telegramId: req.telegramUser!.id }, isSaved ? { $pull: { savedPlaces: id } } : { $addToSet: { savedPlaces: id } });
      res.json({ saved: !isSaved });
    } catch {
      res.status(500).json({ error: 'Не удалось сохранить место' });
    }
  });

  // Фото места — только те, что принадлежат местам
  app.get('/api/places/photo/:fileId', async (req: Request, res: Response) => {
    try {
      const fileId = String(req.params.fileId);
      if (!(await Place.exists({ photos: fileId }))) return res.sendStatus(404);
      await sendTelegramPhoto(res, fileId);
    } catch {
      res.sendStatus(500);
    }
  });

  // Советы людей к месту
  app.get('/api/places/:id/tips', telegramAuthMiddleware as any, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const id = String(req.params.id);
      if (!mongoose.Types.ObjectId.isValid(id)) return res.json([]);
      const tips = await PlaceTip.find({ placeId: id }).sort({ createdAt: -1 }).limit(50).lean();
      res.json(
        tips.map((t) => ({
          id: t._id.toString(),
          name: t.name,
          avatarUrl: t.avatarUrl,
          text: t.text,
          createdAt: t.createdAt,
          isMine: t.telegramId === req.telegramUser!.id
        }))
      );
    } catch {
      res.status(500).json({ error: 'Ошибка загрузки советов' });
    }
  });

  app.post('/api/places/:id/tips', telegramAuthMiddleware as any, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const id = String(req.params.id);
      const text = String(req.body.text || '').trim().slice(0, 300);
      if (!text) return res.status(400).json({ error: 'Напиши совет' });
      const place = mongoose.Types.ObjectId.isValid(id) ? await Place.findById(id) : null;
      if (!place) return res.status(404).json({ error: 'Место не найдено' });

      const tgUser = req.telegramUser!;
      // Один человек — не больше 3 советов к одному месту (защита от спама)
      if ((await PlaceTip.countDocuments({ placeId: id, telegramId: tgUser.id })) >= 3) {
        return res.status(429).json({ error: 'Можно оставить не больше 3 советов к одному месту' });
      }

      const me = await User.findOne({ telegramId: tgUser.id });
      const tip = await PlaceTip.create({
        placeId: place._id,
        telegramId: tgUser.id,
        name: me?.firstName || tgUser.first_name,
        avatarUrl: me?.avatarUrl?.startsWith('http') ? me.avatarUrl : '',
        text
      });

      // Автору проекта — на проверку, с кнопкой удаления
      notifyAdmins(
        `💡 <b>Новый совет к месту «${escapeHtml(place.name)}»</b>\n\n«${escapeHtml(text)}»\n\n— ${escapeHtml(tip.name)} · ID ${tgUser.id}`,
        [[{ text: '🗑 Удалить совет', callback_data: `tipdel:${tip._id}` }]]
      );

      res.json({ success: true, tip: { id: tip._id.toString(), name: tip.name, avatarUrl: tip.avatarUrl, text, createdAt: tip.createdAt, isMine: true } });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Не удалось сохранить совет' });
    }
  });

  // Автор совета может удалить свой совет
  app.post('/api/places/tips/:tipId/delete', telegramAuthMiddleware as any, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const tipId = String(req.params.tipId);
      if (!mongoose.Types.ObjectId.isValid(tipId)) return res.status(404).json({ error: 'Совет не найден' });
      await PlaceTip.deleteOne({ _id: tipId, telegramId: req.telegramUser!.id });
      res.json({ success: true });
    } catch {
      res.status(500).json({ error: 'Не удалось удалить совет' });
    }
  });
}

/* ======================================================================
 * Бот: добавление мест (/place), список (/places), удаление (/delplace)
 * ==================================================================== */

type Step = 'photos' | 'name' | 'category' | 'desc' | 'moods' | 'address' | 'address_confirm' | 'maplink' | 'price' | 'marks' | 'tip' | 'blog' | 'preview';

interface Draft {
  step: Step;
  photos: string[];
  name: string;
  category: string;
  description: string;
  moods: PlaceMood[];
  address: string;
  coords?: [number, number]; // [lat, lng]
  foundLabel?: string;
  price?: PlacePrice;
  rainOk: boolean;
  evening: boolean;
  oneDay: boolean;
  mishaTip: string;
  blogUrl: string;
  mapUrl: string;
  photoTimer?: NodeJS.Timeout;
}

// Черновики живут в памяти сервера (если сервер перезапустится — начни /place заново)
const drafts = new Map<number, Draft>();

type Keyboard = { text: string; callback_data: string }[][];

async function callBot(method: string, body: any) {
  const res = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return res.json().catch(() => ({}));
}

const say = (chatId: number, html: string, keyboard?: Keyboard) =>
  callBot('sendMessage', {
    chat_id: chatId,
    text: html,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {})
  }).catch(() => {});

function notifyAdmins(html: string, keyboard: Keyboard) {
  for (const id of (process.env.ADMIN_TELEGRAM_IDS || '').split(',').map((s) => Number(s.trim())).filter(Boolean)) {
    say(id, html, keyboard);
  }
}

const SKIP_BTN: Keyboard = [[{ text: 'Пропустить ⏭', callback_data: 'pl:skip' }]];

// Типы мест кнопками по два в ряд; prefix — что вернётся в callback (+ номер типа)
const typesKeyboard = (prefix: string): Keyboard => {
  const rows: Keyboard = [];
  PLACE_TYPES.forEach((t, i) => {
    if (i % 2 === 0) rows.push([]);
    rows[rows.length - 1].push({ text: t, callback_data: `${prefix}${i}` });
  });
  return rows;
};

const MAX_PHOTOS = 10;

// Фото к уже опубликованному месту: /placephoto номер → дальше просто шли фото
const photoTargets = new Map<number, { placeId: string; until: number; added: number; timer?: NodeJS.Timeout }>();

// Чей альбом: фото альбома приходят отдельными сообщениями (подпись — у одного), обрабатываются параллельно
const albumOwners = new Map<string, { kind: 'news' | 'place'; placeId?: string }>();
const rememberAlbum = (groupId: string, owner: { kind: 'news' | 'place'; placeId?: string }) => {
  albumOwners.set(groupId, owner);
  setTimeout(() => albumOwners.delete(groupId), 5 * 60 * 1000);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Номер из /places или название — найти место
async function findPlaceByRef(ref: string) {
  const places = await Place.find({}).sort({ createdAt: 1 });
  const n = Number(ref.trim());
  if (Number.isInteger(n) && n > 0) return places[n - 1] || null;
  const q = ref.trim().toLowerCase().replace(/ё/g, 'е');
  return places.find((p) => p.name.toLowerCase().replace(/ё/g, 'е') === q) || places.find((p) => p.name.toLowerCase().replace(/ё/g, 'е').includes(q)) || null;
}

const moodsKeyboard = (d: Draft): Keyboard => [
  ...(Object.keys(PLACE_MOODS) as PlaceMood[]).map((k) => [
    { text: `${d.moods.includes(k) ? '✅' : '▫️'} ${PLACE_MOODS[k].emoji} ${PLACE_MOODS[k].label}`, callback_data: `pl:mood:${k}` }
  ]),
  [{ text: 'Готово →', callback_data: 'pl:moods_done' }]
];

const marksKeyboard = (d: Draft): Keyboard => [
  [{ text: `${d.rainOk ? '✅' : '▫️'} ☔ Ок в дождь`, callback_data: 'pl:mark:rain' }],
  [{ text: `${d.evening ? '✅' : '▫️'} 🌙 Лучше вечером`, callback_data: 'pl:mark:evening' }],
  [{ text: `${d.oneDay ? '✅' : '▫️'} 🧳 Туристам за один день`, callback_data: 'pl:mark:oneday' }],
  [{ text: 'Готово →', callback_data: 'pl:marks_done' }]
];

const previewHtml = (d: Draft) =>
  [
    `<b>${escapeHtml(d.name)}</b>${d.category ? ` · ${escapeHtml(d.category)}` : ''}`,
    escapeHtml(d.description),
    '',
    d.moods.map((m) => `${PLACE_MOODS[m].emoji} ${PLACE_MOODS[m].label}`).join(' · '),
    [d.price ? PLACE_PRICES[d.price] : '', d.rainOk ? '☔ ок в дождь' : '', d.evening ? '🌙 лучше вечером' : '', d.oneDay ? '🧳 за один день' : '']
      .filter(Boolean)
      .join(' · '),
    `📍 ${escapeHtml(d.foundLabel || d.address)}`,
    d.mishaTip ? `💡 ${escapeHtml(d.mishaTip)}` : '',
    d.blogUrl ? `📖 ${escapeHtml(d.blogUrl)}` : '',
    d.mapUrl ? `🗺 Яндекс Карты: ссылка есть` : '',
    `🖼 Фото: ${d.photos.length}`
  ]
    .filter((line) => line !== undefined)
    .join('\n');

/* ---------- Поиск адреса (OpenStreetMap) ---------- */

const FILLER_RE = /(?:^|[\s,]+)(у|возле|около|напротив|рядом\s+с|за|перед|во\s+дворе|вход|подъезд|этаж)(?=[\s,.]|$).*$/i;
const inMinskArea = (lat: number, lng: number) => lat > 53.3 && lat < 54.6 && lng > 26.8 && lng < 28.6;

async function geocode(address: string): Promise<{ coords: [number, number]; label: string } | null> {
  const variants = [address, address.replace(FILLER_RE, '').trim(), address.split(',')[0].trim()].filter(
    (v, i, a) => v && a.indexOf(v) === i
  );
  for (const v of variants) {
    const q = v.toLowerCase().includes('минск') || v.toLowerCase().includes('беларусь') ? v : `Беларусь, Минск, ${v}`;
    try {
      const res = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(q)}`, {
        headers: { 'User-Agent': 'YesMinskApp/1.0 (https://yesminsk.com)', 'Accept-Language': 'ru' }
      });
      const data: any = await res.json();
      if (data?.[0]) {
        const lat = parseFloat(data[0].lat);
        const lng = parseFloat(data[0].lon);
        if (inMinskArea(lat, lng)) {
          const [first, second] = String(data[0].display_name).split(',').map((s: string) => s.trim());
          return { coords: [lat, lng], label: /^\d/.test(first) && second ? `${second}, ${first}` : `${first}${second ? `, ${second}` : ''}` };
        }
      }
    } catch {
      // пробуем следующий вариант
    }
  }
  return null;
}

/* ---------- Ссылки Яндекс Карт ---------- */

const isYandexMapsLink = (url: string) => /^https?:\/\/([\w-]+\.)*(yandex\.(by|ru|com|kz)|ya\.ru)\/(maps|-\/)/i.test(url.trim());

// Точка из ссылки Яндекс Карт: из параметров адреса или со страницы места
export async function placeFromYandexLink(url: string): Promise<{ coords: [number, number]; label: string } | null> {
  try {
    const res = await fetch(url.trim(), {
      redirect: 'follow',
      headers: { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148', 'Accept-Language': 'ru' }
    });
    const finalUrl = decodeURIComponent(res.url || url);
    const html = await res.text();

    let lng: number | null = null;
    let lat: number | null = null;
    const fromParams = finalUrl.match(/[?&](?:pt|ll|whatshere\[point\])=([0-9.]+),([0-9.]+)/);
    const fromPage = html.match(/"displayCoordinates":\[([0-9.]+),([0-9.]+)\]/) || html.match(/"coordinates":\[([0-9.]+),([0-9.]+)\]/);
    // У страницы места свои координаты точнее, чем центр карты в ссылке
    const m = finalUrl.includes('/org/') && fromPage ? fromPage : fromParams || fromPage;
    if (m) {
      lng = parseFloat(m[1]);
      lat = parseFloat(m[2]);
    }
    if (lat === null || lng === null || !inMinskArea(lat, lng)) return null;

    const title = html.match(/<meta property="og:title" content="([^"]+)"/)?.[1] || '';
    const label = title.replace(/\s+—\s+Яндекс\s*Карты.*$/i, '').replace(/&quot;/g, '"').trim();
    // «Карта Минска с улицами…» — это просто карта, а не место; подпись не нужна
    return { coords: [lat, lng], label: /^Карта\s/i.test(label) ? '' : label };
  } catch {
    return null;
  }
}

/* ---------- Шаги диалога ---------- */

async function ask(chatId: number, d: Draft) {
  switch (d.step) {
    case 'photos':
      return say(chatId, '📍 <b>Новое место</b>\n\nШаг 1/8. Пришли от 1 до 5 фото (можно альбомом).\n\n<i>Отменить — /cancel</i>');
    case 'name':
      return say(chatId, 'Шаг 2/8. Как называется место?');
    case 'category':
      return say(chatId, 'Какой это тип места?', [...typesKeyboard('pl:cat:'), [{ text: 'Пропустить ⏭', callback_data: 'pl:cat:' }]]);
    case 'desc':
      return say(chatId, 'Шаг 3/8. Одна фраза о месте — почему туда стоит сходить?');
    case 'moods':
      return say(chatId, 'Шаг 4/8. Какие настроения? Можно несколько:', moodsKeyboard(d));
    case 'address':
      return say(
        chatId,
        'Шаг 5/8. Где это? Пришли одно из трёх:\n• адрес — <code>Зыбицкая 6</code>\n• ссылку на место в Яндекс Картах (так в карточке появятся отзывы и фото)\n• геоточку: 📎 → Геопозиция'
      );
    case 'maplink':
      return say(chatId, '🗺 Есть ссылка на это место в Яндекс Картах? Люди смогут почитать отзывы и посмотреть фото.', SKIP_BTN);
    case 'price':
      return say(chatId, 'Шаг 6/8. Сколько стоит?', [
        [
          { text: PLACE_PRICES.free, callback_data: 'pl:price:free' },
          { text: PLACE_PRICES.cheap, callback_data: 'pl:price:cheap' },
          { text: PLACE_PRICES.mid, callback_data: 'pl:price:mid' }
        ],
        [{ text: 'Не указывать ⏭', callback_data: 'pl:price:skip' }]
      ]);
    case 'marks':
      return say(chatId, 'Пометки (по желанию):', marksKeyboard(d));
    case 'tip':
      return say(chatId, 'Шаг 7/8. 💡 Твой совет — фишка, которую знают только местные:', SKIP_BTN);
    case 'blog':
      return say(chatId, 'Шаг 8/8. Ссылка на статью в блоге (если есть):', SKIP_BTN);
    case 'preview':
      return say(chatId, `Проверь карточку:\n\n${previewHtml(d)}`, [
        [{ text: '✅ Опубликовать', callback_data: 'pl:publish' }],
        [{ text: '❌ Отменить', callback_data: 'pl:cancel' }]
      ]);
  }
}

const newDraft = (): Draft => ({
  step: 'photos',
  photos: [],
  name: '',
  category: '',
  description: '',
  moods: [],
  address: '',
  rainOk: false,
  evening: false,
  oneDay: false,
  mishaTip: '',
  blogUrl: '',
  mapUrl: ''
});

/**
 * Сообщения автора боту, связанные с местами. Возвращает true, если сообщение обработано
 */
export async function handlePlaceMessage(message: any): Promise<boolean> {
  const chatId: number = message.chat.id;
  const fromId: number = message.from?.id;
  const text: string = (message.text || '').trim();
  const draft = drafts.get(chatId);

  const isPlaceCommand = /^\/(place|places|delplace|placelink|placecat|placephoto|delphotos|cancel)\b/i.test(text);
  const caption: string = (message.caption || '').trim();
  const groupId: string | undefined = message.media_group_id;

  // Фото без черновика: к месту из /placephoto или с подписью «номер / название».
  // Подпись с командой (/news …) — не наше; такой альбом целиком отдаём новостям
  let photoPlaceId: string | null = null;
  if (!draft && message.photo && isAdmin(fromId)) {
    if (caption.startsWith('/')) {
      if (groupId) rememberAlbum(groupId, { kind: 'news' });
    } else if (caption) {
      const target = await findPlaceByRef(caption);
      if (!target) {
        if (groupId) rememberAlbum(groupId, { kind: 'news' });
        say(chatId, `Не нашёл место «${escapeHtml(caption)}». Подпиши фото номером из /places или точным названием.`);
        return true;
      }
      photoPlaceId = target._id.toString();
      if (groupId) rememberAlbum(groupId, { kind: 'place', placeId: photoPlaceId });
    } else {
      // Без подписи: часть альбома — ждём подписанное фото этого альбома; иначе — место из /placephoto
      if (groupId) {
        for (let i = 0; i < 8 && !albumOwners.has(groupId); i++) await sleep(250);
        const owner = albumOwners.get(groupId);
        if (owner?.kind === 'place') photoPlaceId = owner.placeId || null;
        else if (owner?.kind === 'news') photoPlaceId = null;
        else {
          const t = photoTargets.get(chatId);
          if (t && t.until > Date.now()) photoPlaceId = t.placeId;
        }
      } else {
        const t = photoTargets.get(chatId);
        if (t && t.until > Date.now()) photoPlaceId = t.placeId;
      }
    }
  }
  const isPlacePhoto = Boolean(photoPlaceId);
  if (!draft && !isPlaceCommand && !isPlacePhoto) return false;
  if (!isAdmin(fromId)) {
    if (isPlaceCommand) say(chatId, 'Добавлять места может только автор проекта 🙂');
    return isPlaceCommand;
  }

  if (/^\/cancel\b/i.test(text)) {
    drafts.delete(chatId);
    photoTargets.delete(chatId);
    say(chatId, 'Отменено.');
    return true;
  }

  // Фото к опубликованному месту
  if (isPlacePhoto && photoPlaceId) {
    const fileId = message.photo[message.photo.length - 1].file_id;
    // $push атомарный — фото альбома, пришедшие одновременно, не затрут друг друга
    const before = await Place.findById(photoPlaceId, { photos: 1, name: 1 });
    if (!before) return true;
    if (before.photos.length >= MAX_PHOTOS) {
      say(chatId, `У «${escapeHtml(before.name)}» уже ${MAX_PHOTOS} фото — это максимум. Убрать все: <code>/delphotos номер</code>`);
      return true;
    }
    const fresh = await Place.findByIdAndUpdate(photoPlaceId, { $push: { photos: fileId } }, { new: true });
    if (!fresh) return true;
    // Альбом приходит пачкой: отвечаем один раз, когда все фото пришли. Подписан обычно только первый
    const t = photoTargets.get(chatId);
    const state = t && t.placeId === fresh._id.toString() ? t : { placeId: fresh._id.toString(), until: 0, added: 0 };
    state.until = Date.now() + 10 * 60 * 1000;
    state.added += 1;
    if (state.timer) clearTimeout(state.timer);
    state.timer = setTimeout(() => {
      Place.findById(fresh._id, { photos: 1 }).then((p) =>
        say(chatId, `🖼 К «${escapeHtml(fresh.name)}» добавлено фото: ${state.added} (всего ${p?.photos.length ?? fresh.photos.length}). Можно слать ещё или /cancel.`)
      );
      state.added = 0;
    }, 1500);
    photoTargets.set(chatId, state);
    return true;
  }

  const photoCmd = text.match(/^\/placephoto\s+(.+)$/i);
  if (photoCmd) {
    const target = await findPlaceByRef(photoCmd[1]);
    if (!target) say(chatId, 'Нет такого места. Список — /places');
    else {
      photoTargets.set(chatId, { placeId: target._id.toString(), until: Date.now() + 10 * 60 * 1000, added: 0 });
      say(chatId, `🖼 Шли фото для «${escapeHtml(target.name)}» — можно альбомом, до ${MAX_PHOTOS} всего (сейчас ${target.photos.length}). Закончить — /cancel`);
    }
    return true;
  }
  if (/^\/placephoto\b/i.test(text)) {
    say(chatId, 'Так: <code>/placephoto номер</code> (из /places) или <code>/placephoto Парк Горького</code>, а потом просто шли фото.\n\nИли сразу пришли фото с подписью — номером или названием места.');
    return true;
  }
  const delPhotos = text.match(/^\/delphotos\s+(.+)$/i);
  if (delPhotos) {
    const target = await findPlaceByRef(delPhotos[1]);
    if (!target) say(chatId, 'Нет такого места. Список — /places');
    else {
      const n = target.photos.length;
      target.photos = [];
      await target.save();
      say(chatId, `🗑 У «${escapeHtml(target.name)}» убраны все фото (${n}).`);
    }
    return true;
  }

  if (/^\/place\b/i.test(text)) {
    const d = newDraft();
    drafts.set(chatId, d);
    await ask(chatId, d);
    return true;
  }

  if (/^\/places\b/i.test(text)) {
    const places = await Place.find({}).sort({ createdAt: 1 });
    say(
      chatId,
      places.length
        ? `📍 <b>Места (${places.length})</b>\n\n${places.map((p, i) => `${i + 1}. ${escapeHtml(p.name)}${p.category ? ` · ${escapeHtml(p.category)}` : ''} · 🖼 ${p.photos.length}`).join('\n')}\n\nФото: <code>/placephoto номер</code> · удалить место: <code>/delplace номер</code>`
        : 'Мест пока нет. Добавь первое: /place'
    );
    return true;
  }

  // Добавить ссылку на Яндекс Карты к уже опубликованному месту: /placelink 2 https://yandex.by/maps/...
  const link = text.match(/^\/placelink\s+(\d+)\s+(\S+)/i);
  if (link) {
    const places = await Place.find({}).sort({ createdAt: 1 });
    const target = places[Number(link[1]) - 1];
    if (!target) say(chatId, 'Нет места с таким номером. Список — /places');
    else if (!isYandexMapsLink(link[2])) say(chatId, 'Это не похоже на ссылку Яндекс Карт.');
    else {
      target.mapUrl = link[2];
      await target.save();
      say(chatId, `🗺 Ссылка добавлена к «${escapeHtml(target.name)}».`);
    }
    return true;
  }
  // Категория для уже опубликованного места: /placecat 2 Кафе
  const cat = text.match(/^\/placecat\s+(\d+)(?:\s+(.+))?$/i);
  if (cat) {
    const places = await Place.find({}).sort({ createdAt: 1 });
    const target = places[Number(cat[1]) - 1];
    if (!target) say(chatId, 'Нет места с таким номером. Список — /places');
    else if (!cat[2]) say(chatId, `Какой тип у «${escapeHtml(target.name)}»?`, typesKeyboard(`plcat:${target._id}:`));
    else {
      const type = matchPlaceType(cat[2]);
      if (!type) say(chatId, `Такого типа нет. Выбери кнопкой:`, typesKeyboard(`plcat:${target._id}:`));
      else {
        target.category = type;
        await target.save();
        say(chatId, `🏷 «${escapeHtml(target.name)}» — ${escapeHtml(type)}.`);
      }
    }
    return true;
  }
  if (/^\/placecat\b/i.test(text)) {
    say(chatId, 'Так: <code>/placecat номер</code> — и выбери тип кнопкой. Номер — из /places');
    return true;
  }

  if (/^\/placelink\b/i.test(text)) {
    say(chatId, 'Так: <code>/placelink номер ссылка</code>. Номер — из /places');
    return true;
  }

  const del = text.match(/^\/delplace\s+(\d+)/i);
  if (del) {
    const places = await Place.find({}).sort({ createdAt: 1 });
    const target = places[Number(del[1]) - 1];
    if (!target) {
      say(chatId, 'Нет места с таким номером. Посмотри список: /places');
    } else {
      await PlaceTip.deleteMany({ placeId: target._id });
      await target.deleteOne();
      say(chatId, `🗑 «${escapeHtml(target.name)}» удалено.`);
    }
    return true;
  }
  if (/^\/delplace\b/i.test(text)) {
    say(chatId, 'Напиши номер места: <code>/delplace 3</code>. Список — /places');
    return true;
  }

  if (!draft) return false;

  switch (draft.step) {
    case 'photos': {
      if (!message.photo) {
        say(chatId, 'Жду фото 🖼 (или /cancel)');
        return true;
      }
      if (draft.photos.length < 5) draft.photos.push(message.photo[message.photo.length - 1].file_id);
      // Альбом приходит несколькими сообщениями — отвечаем один раз, когда все фото пришли
      if (draft.photoTimer) clearTimeout(draft.photoTimer);
      draft.photoTimer = setTimeout(() => {
        const full = draft.photos.length >= 5;
        say(
          chatId,
          `🖼 Фото: ${draft.photos.length}/5${full ? ' — максимум.' : '. Можно прислать ещё.'}`,
          [[{ text: 'Фото готовы →', callback_data: 'pl:photos_done' }]]
        );
      }, 1500);
      return true;
    }
    case 'name':
      if (!text) return say(chatId, 'Напиши название текстом'), true;
      draft.name = text.slice(0, 80);
      draft.step = 'category';
      await ask(chatId, draft);
      return true;
    case 'category': {
      const type = matchPlaceType(text);
      if (!type) return say(chatId, 'Выбери тип кнопкой 👆 — так места попадут в фильтры', typesKeyboard('pl:cat:')), true;
      draft.category = type;
      draft.step = 'desc';
      await ask(chatId, draft);
      return true;
    }
    case 'desc':
      if (!text) return say(chatId, 'Напиши одну фразу текстом'), true;
      draft.description = text.slice(0, 300);
      draft.step = 'moods';
      await ask(chatId, draft);
      return true;
    case 'address':
    case 'address_confirm': {
      if (message.location) {
        draft.coords = [message.location.latitude, message.location.longitude];
        draft.foundLabel = draft.address || draft.name || 'Точка на карте';
        draft.step = draft.mapUrl ? 'price' : 'maplink';
        await say(chatId, '📍 Точку получил.');
        await ask(chatId, draft);
        return true;
      }
      if (!text) return say(chatId, 'Напиши адрес или пришли геоточку'), true;

      // Ссылка на Яндекс Карты — берём точку прямо из неё
      if (isYandexMapsLink(text)) {
        draft.mapUrl = text;
        const fromLink = await placeFromYandexLink(text);
        if (!fromLink) {
          say(chatId, 'Ссылку сохранил для кнопки «Отзывы», но точку из неё прочитать не получилось 😔 Пришли адрес или геоточку: 📎 → Геопозиция.');
          return true;
        }
        draft.coords = fromLink.coords;
        draft.foundLabel = fromLink.label || draft.name;
        draft.step = 'address_confirm';
        say(chatId, `Нашёл по ссылке: <b>${escapeHtml(draft.foundLabel)}</b>\nВерно?`, [
          [
            { text: '✅ Да', callback_data: 'pl:addr_ok' },
            { text: '✏️ Ввести иначе', callback_data: 'pl:addr_retry' }
          ]
        ]);
        return true;
      }

      draft.address = text.slice(0, 120);
      const found = await geocode(draft.address);
      if (!found) {
        say(chatId, 'Не нашёл такой адрес 😔 Попробуй иначе (улица и дом) или пришли геоточку: 📎 → Геопозиция.');
        draft.step = 'address';
        return true;
      }
      draft.coords = found.coords;
      draft.foundLabel = found.label;
      draft.step = 'address_confirm';
      say(chatId, `Нашёл: <b>${escapeHtml(found.label)}</b>\nВерно?`, [
        [
          { text: '✅ Да', callback_data: 'pl:addr_ok' },
          { text: '✏️ Ввести иначе', callback_data: 'pl:addr_retry' }
        ]
      ]);
      return true;
    }
    case 'maplink':
      if (!isYandexMapsLink(text)) return say(chatId, 'Нужна ссылка на Яндекс Карты (или «Пропустить»)', SKIP_BTN), true;
      draft.mapUrl = text;
      draft.step = 'price';
      await ask(chatId, draft);
      return true;
    case 'tip':
      draft.mishaTip = text.slice(0, 400);
      draft.step = 'blog';
      await ask(chatId, draft);
      return true;
    case 'blog':
      if (text && !/^https?:\/\//i.test(text)) return say(chatId, 'Нужна ссылка, начинающаяся с https://  (или «Пропустить»)', SKIP_BTN), true;
      draft.blogUrl = text;
      draft.step = 'preview';
      await ask(chatId, draft);
      return true;
    default:
      say(chatId, 'Нажми одну из кнопок выше 👆 (или /cancel)');
      return true;
  }
}

/**
 * Нажатия кнопок в диалоге добавления места и удаление советов
 */
export async function handlePlaceCallback(query: any): Promise<boolean> {
  const data: string = query.data || '';
  if (!data.startsWith('pl:') && !data.startsWith('tipdel:') && !data.startsWith('plcat:')) return false;

  const chatId: number = query.message?.chat?.id;
  const answer = (text = '') => callBot('answerCallbackQuery', { callback_query_id: query.id, text });

  if (!isAdmin(query.from?.id)) {
    answer('Только для автора проекта');
    return true;
  }

  // Тип для опубликованного места: plcat:<id места>:<номер типа>
  if (data.startsWith('plcat:')) {
    const [, id, i] = data.split(':');
    const type = PLACE_TYPES[Number(i)];
    if (type && mongoose.Types.ObjectId.isValid(id)) {
      const place = await Place.findByIdAndUpdate(id, { category: type }, { new: true });
      if (place) {
        callBot('editMessageText', { chat_id: chatId, message_id: query.message.message_id, text: `🏷 «${place.name}» — ${type}.` });
        answer(type);
        return true;
      }
    }
    answer('Не получилось');
    return true;
  }

  if (data.startsWith('tipdel:')) {
    const id = data.slice(7);
    if (mongoose.Types.ObjectId.isValid(id)) await PlaceTip.deleteOne({ _id: id });
    answer('Совет удалён');
    callBot('editMessageText', { chat_id: chatId, message_id: query.message.message_id, text: `${query.message.text}\n\n🗑 Удалён` });
    return true;
  }

  const d = drafts.get(chatId);
  if (!d) {
    answer('Черновик не найден — начни заново: /place');
    return true;
  }
  const [, action, value] = data.split(':');
  const editKeyboard = (keyboard: Keyboard) =>
    callBot('editMessageReplyMarkup', { chat_id: chatId, message_id: query.message.message_id, reply_markup: { inline_keyboard: keyboard } });
  const removeKeyboard = () => callBot('editMessageReplyMarkup', { chat_id: chatId, message_id: query.message.message_id, reply_markup: { inline_keyboard: [] } });

  switch (action) {
    case 'photos_done':
      if (!d.photos.length) return answer('Сначала пришли хотя бы одно фото'), true;
      d.step = 'name';
      removeKeyboard();
      await ask(chatId, d);
      break;
    case 'cat':
      d.category = value ? PLACE_TYPES[Number(value)] || '' : '';
      d.step = 'desc';
      removeKeyboard();
      await ask(chatId, d);
      break;
    case 'mood': {
      const m = value as PlaceMood;
      d.moods = d.moods.includes(m) ? d.moods.filter((x) => x !== m) : [...d.moods, m];
      editKeyboard(moodsKeyboard(d));
      break;
    }
    case 'moods_done':
      if (!d.moods.length) return answer('Выбери хотя бы одно настроение'), true;
      d.step = 'address';
      removeKeyboard();
      await ask(chatId, d);
      break;
    case 'addr_ok':
      d.step = d.mapUrl ? 'price' : 'maplink';
      removeKeyboard();
      await ask(chatId, d);
      break;
    case 'addr_retry':
      d.step = 'address';
      removeKeyboard();
      await ask(chatId, d);
      break;
    case 'price':
      d.price = value === 'skip' ? undefined : (value as PlacePrice);
      d.step = 'marks';
      removeKeyboard();
      await ask(chatId, d);
      break;
    case 'mark':
      if (value === 'rain') d.rainOk = !d.rainOk;
      if (value === 'evening') d.evening = !d.evening;
      if (value === 'oneday') d.oneDay = !d.oneDay;
      editKeyboard(marksKeyboard(d));
      break;
    case 'marks_done':
      d.step = 'tip';
      removeKeyboard();
      await ask(chatId, d);
      break;
    case 'skip':
      removeKeyboard();
      if (d.step === 'maplink') d.step = 'price';
      else if (d.step === 'tip') d.step = 'blog';
      else if (d.step === 'blog') d.step = 'preview';
      await ask(chatId, d);
      break;
    case 'publish':
      if (!d.coords) return answer('Нет адреса'), true;
      await Place.create({
        name: d.name,
        category: d.category,
        description: d.description,
        moods: d.moods,
        photos: d.photos,
        address: d.foundLabel || d.address,
        location: { type: 'Point', coordinates: [d.coords[1], d.coords[0]] },
        mishaTip: d.mishaTip,
        blogUrl: d.blogUrl,
        mapUrl: d.mapUrl,
        price: d.price,
        rainOk: d.rainOk,
        evening: d.evening,
        oneDay: d.oneDay
      });
      drafts.delete(chatId);
      removeKeyboard();
      sendTelegramMessage(chatId, `✅ Место «${escapeHtml(d.name)}» опубликовано! Добавить ещё — /place`, 'Открыть ДА! МИНСК', '?tab=places');
      break;
    case 'cancel':
      drafts.delete(chatId);
      removeKeyboard();
      say(chatId, 'Отменено.');
      break;
  }
  answer();
  return true;
}
