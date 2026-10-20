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

export const PLACE_PRICES = { free: '💸 Бесплатно', cheap: '💸 Недорого', mid: '💸💸 Средне' } as const;
export type PlacePrice = keyof typeof PLACE_PRICES;

export interface IPlace extends Document {
  name: string;
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
  createdAt: Date;
}

const PlaceSchema = new Schema<IPlace>(
  {
    name: { type: String, required: true, maxlength: 80 },
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
    oneDay: { type: Boolean, default: false }
  },
  { timestamps: true }
);

export const Place = model<IPlace>('Place', PlaceSchema);

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
