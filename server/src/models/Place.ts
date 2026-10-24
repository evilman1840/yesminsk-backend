import { Schema, model, Document, Types } from 'mongoose';

/**
 * «Места по вайбу»: место в Минске с настроениями как в блоге yesminsk.com.
 * Автор добавляет места через бота (/place), любой человек может оставить совет.
 */

// Настроения — те же, что рубрики блога
export const PLACE_MOODS = {
  tosku: { label: 'Разогнать тоску', emoji: '🌤', blog: 'https://yesminsk.com/razognat-tosku-minsk/' },
  escape: { label: 'Сбежать от всех', emoji: '🤫', blog: 'https://yesminsk.com/sbezhat-ot-vseh-minsk/' },
  wow: { label: 'Поймать восторг', emoji: '🤩', blog: 'https://yesminsk.com/poymat-vostorg-minsk/' },
  love: { label: 'Влюбиться в Минск', emoji: '💛', blog: 'https://yesminsk.com/vlyubitsya-v-minsk/' },
  party: { label: 'Оторваться компанией', emoji: '🎉', blog: 'https://yesminsk.com/otorvatsya-kompaniey-minsk/' },
  solo: { label: 'Еду соло', emoji: '🎒', blog: 'https://yesminsk.com/edu-solo-minsk/' },
  food: { label: 'Накормить душу', emoji: '🥞', blog: 'https://yesminsk.com/nakormit-dushu-minsk/' }
} as const;
export type PlaceMood = keyof typeof PLACE_MOODS;

// Типы мест — автор выбирает из этого списка (в боте кнопками), в приложении по ним фильтр
export const PLACE_TYPES = [
  'Архитектура', 'Галерея', 'Достопримечательность', 'Зоопарк', 'Исторический', 'Культурный', 'Мемориал', 'Музей',
  'Памятник', 'Парк', 'Площадь', 'Развлечения', 'Скульптура', 'Смотровая', 'Театр', 'Храм',
  // Для шаблонов сходок: новые — только в конец, кнопки в боте идут по номерам
  'Кафе', 'Кофейня', 'Кинотеатр', 'Антикафе', 'Спорт', 'Сквер'
] as const;

// «парк» → «Парк»; не из списка — null
export const matchPlaceType = (text: string) =>
  PLACE_TYPES.find((t) => t.toLowerCase() === text.trim().toLowerCase().replace(/ё/g, 'е')) || null;

// Куда с детьми: top — ехать специально, age — с поправкой на возраст, nearby — если живёшь рядом
export const KIDS_LEVELS = ['top', 'age', 'nearby'] as const;
export type KidsLevel = (typeof KIDS_LEVELS)[number];

export const PLACE_PRICES = { free: '💸 Бесплатно', cheap: '💸 Недорого', mid: '💸💸 Средне' } as const;
export type PlacePrice = keyof typeof PLACE_PRICES;

export interface IPlace extends Document {
  name: string;
  category: string; // что это: достопримечательность, кафе, парк… (автор пишет сам)
  description: string;
  moods: PlaceMood[];
  photos: string[]; // file_id фото в Telegram (до 5)
  address: string;
  location: { type: 'Point'; coordinates: [number, number] }; // [lng, lat]
  mishaTip: string;
  blogUrl: string;
  mapUrl: string; // ссылка на место в Яндекс Картах (отзывы и фото)
  price?: PlacePrice;
  rainOk: boolean;   // ☔ ок в дождь
  evening: boolean;  // 🌙 лучше вечером
  oneDay: boolean;   // 🧳 за один день (туристам)
  // Из Яндекс Карт (таблицы автора)
  rating?: number;       // 4.8
  ratingCount?: number;  // сколько оценок
  hours: string;         // «24/7», «Вт-Вс 10:00-19:00, Пн выходной»
  phone: string;
  website: string;
  amenities: string[];   // «Собаки», «Карты, NFC», «Доступная среда (вход, парковка)»
  reviews: { rating?: number; text: string; source: string }[]; // отзывы из таблиц автора (с Яндекс Карт)
  kidsLevel?: KidsLevel;
  kidsNote: string;      // что там детям, с какого возраста, минусы
  createdAt: Date;
}

const PlaceSchema = new Schema<IPlace>(
  {
    name: { type: String, required: true, maxlength: 80 },
    category: { type: String, default: '', maxlength: 40 },
    description: { type: String, default: '', maxlength: 300 },
    moods: { type: [String], enum: Object.keys(PLACE_MOODS), default: [] },
    photos: { type: [String], default: [] },
    address: { type: String, default: '' },
    location: {
      type: { type: String, enum: ['Point'], default: 'Point' },
      coordinates: { type: [Number], required: true }
    },
    mishaTip: { type: String, default: '', maxlength: 400 },
    blogUrl: { type: String, default: '' },
    mapUrl: { type: String, default: '' },
    price: { type: String, enum: Object.keys(PLACE_PRICES) },
    rainOk: { type: Boolean, default: false },
    evening: { type: Boolean, default: false },
    oneDay: { type: Boolean, default: false },
    rating: { type: Number, min: 0, max: 5 },
    ratingCount: { type: Number, min: 0 },
    hours: { type: String, default: '', maxlength: 120 },
    phone: { type: String, default: '', maxlength: 40 },
    website: { type: String, default: '', maxlength: 300 },
    amenities: { type: [String], default: [] },
    kidsLevel: { type: String, enum: KIDS_LEVELS },
    kidsNote: { type: String, default: '', maxlength: 600 },
    reviews: {
      type: [{ rating: { type: Number, min: 1, max: 5 }, text: { type: String, maxlength: 600 }, source: { type: String, default: 'Яндекс Карты' } }],
      default: []
    }
  },
  { timestamps: true }
);

export const Place = model<IPlace>('Place', PlaceSchema);

// Какие таблицы с местами уже загружены (чтобы не применять повторно при каждом запуске)
const PlaceImportSchema = new Schema({ key: { type: String, required: true, unique: true }, appliedAt: { type: Date, default: Date.now } });
export const PlaceImport = model('PlaceImport', PlaceImportSchema);

// Совет к месту от любого человека
export interface IPlaceTip extends Document {
  placeId: Types.ObjectId;
  telegramId: number;
  name: string;
  avatarUrl: string;
  text: string;
  createdAt: Date;
}

const PlaceTipSchema = new Schema<IPlaceTip>(
  {
    placeId: { type: Schema.Types.ObjectId, ref: 'Place', required: true, index: true },
    telegramId: { type: Number, required: true },
    name: { type: String, required: true },
    avatarUrl: { type: String, default: '' },
    text: { type: String, required: true, maxlength: 300 }
  },
  { timestamps: true }
);

export const PlaceTip = model<IPlaceTip>('PlaceTip', PlaceTipSchema);
