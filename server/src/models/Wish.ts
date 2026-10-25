import { Schema, model, Document, Types } from 'mongoose';

/**
 * «Хочу сходить»: желание без обязательств («хочу в кино на выходных»).
 * Когда набирается несколько похожих, бот сводит их в группу и предлагает собрать сходку
 */

export const WISH_WINDOWS = ['today', 'tomorrow', 'weekend', 'week'] as const;
export type WishWindow = (typeof WISH_WINDOWS)[number];
export const WISH_STATUSES = ['active', 'matched', 'fulfilled', 'expired', 'cancelled'] as const;
export type WishStatus = (typeof WISH_STATUSES)[number];

// Что ждёт отправки ботом (днём, с учётом «не больше одного сообщения о совпадении в день»)
export type WishPending = 'match' | 'built' | 'proposal' | 'askplace' | null;

export interface IWish extends Document {
  telegramId: number;
  kind: string;          // ключ шаблона: coffee, cinema, sport…
  sport?: string;        // для «Поиграем?»: tabletennis, squash…
  timeWindow: WishWindow;
  windowStart: Date;
  windowEnd: Date;
  placeId?: string;      // пусто — где угодно
  status: WishStatus;
  source: 'app' | 'link'; // из приложения или по ссылке из поста
  groupId?: Types.ObjectId;
  matchedAt?: Date;
  meetupId?: string;
  pending?: WishPending;
  notifiedAt?: Date;     // когда бот последний раз писал о совпадении
  createdAt: Date;
}

const WishSchema = new Schema<IWish>(
  {
    telegramId: { type: Number, required: true, index: true },
    kind: { type: String, required: true },
    sport: { type: String },
    timeWindow: { type: String, enum: WISH_WINDOWS, required: true },
    windowStart: { type: Date, required: true },
    windowEnd: { type: Date, required: true, index: true },
    placeId: { type: String },
    status: { type: String, enum: WISH_STATUSES, default: 'active', index: true },
    source: { type: String, enum: ['app', 'link'], default: 'app' },
    groupId: { type: Schema.Types.ObjectId, index: true },
    matchedAt: { type: Date },
    meetupId: { type: String },
    pending: { type: String, enum: ['match', 'built', 'proposal', 'askplace', null], default: null },
    notifiedAt: { type: Date }
  },
  { timestamps: true }
);

export const Wish = model<IWish>('Wish', WishSchema);

// Группа совпавших желаний: общее окно времени и место (если кто-то указал)
export interface IWishGroup extends Document {
  kind: string;
  sport?: string;
  placeId?: string;
  windowStart: Date;
  windowEnd: Date;
  status: 'open' | 'fulfilled' | 'expired';
  meetupId?: string;
  reminderSentAt?: Date;
  // Предложение бота: место и 2–3 варианта времени; на какое время первым наберётся 3 «Пойду» — та сходка и создаётся
  proposal?: {
    options: { at: Date; yes: number[] }[];
    placeId?: string;
    placeName: string;
    coords: [number, number]; // [lat, lng]
    note?: string;
    no: number[]; // «Не смогу» ни в один вариант
    createdAt: Date;
  };
  noPlaceNotifiedAt?: Date; // автору уже написали, что нет подходящего места
  askPlaceAt?: Date;        // места нет — спросили группу, ждём ссылку
  createdAt: Date;
}

const WishGroupSchema = new Schema<IWishGroup>(
  {
    kind: { type: String, required: true },
    sport: { type: String },
    placeId: { type: String },
    windowStart: { type: Date, required: true },
    windowEnd: { type: Date, required: true },
    status: { type: String, enum: ['open', 'fulfilled', 'expired'], default: 'open', index: true },
    meetupId: { type: String },
    reminderSentAt: { type: Date },
    proposal: { type: Schema.Types.Mixed },
    noPlaceNotifiedAt: { type: Date },
    askPlaceAt: { type: Date }
  },
  { timestamps: true }
);

export const WishGroup = model<IWishGroup>('WishGroup', WishGroupSchema);
