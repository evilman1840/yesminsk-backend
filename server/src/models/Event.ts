import { Schema, model, Document } from 'mongoose';

export type EventCategory = 'walk' | 'cafe_bar' | 'expo_cinema' | 'trip_outdoors' | 'boardgames' | 'sport' | 'talk' | 'support' | 'other';

export interface IEventParticipant {
  telegramId: number;
  name: string;
  username?: string;
  avatarUrl: string;
  joinedAt: Date;
  guests?: number;     // сколько человек ведёт с собой (+1, +2…)
  withKids?: boolean;  // идёт с детьми
}

// Пометки организатора: для кого сходка
export type EventTag = 'kids' | 'couples' | 'dogs' | 'empaths';
export const EVENT_TAGS: EventTag[] = ['kids', 'couples', 'dogs', 'empaths'];

export interface IEvent extends Document {
  title: string;
  description: string;
  category: EventCategory;
  customCategory?: string; // своя идея, когда category = 'other' («Караоке», «Йога»…)
  tags?: EventTag[];
  placeId?: string; // сходка в место из «Мест» — тогда пишем тем, кто его сохранил
  templateId?: string;      // по какому шаблону собрана (custom — «Своя идея»)
  durationMinutes?: number; // примерно сколько длится
  extras?: Record<string, string>; // доп. поля шаблона: фильм, вид спорта, уровень, что взять, стоимость
  badges?: string[];        // метки из доп. полей: «🏓 Настольный теннис · любой уровень»
  photos?: string[];        // до 5 фото (file_id в Telegram)
  isPaid?: boolean;         // платная сходка (по умолчанию бесплатная)
  price?: number;           // примерно сколько, BYN с человека
  location: {
    type: 'Point';
    coordinates: [number, number]; // [lng, lat]
  };
  locationName: string;
  dateTime: Date;
  creator: {
    telegramId: number;
    name: string;
    username?: string;
    avatarUrl: string;
  };
  participants: IEventParticipant[];
  maxParticipants?: number;
  isActive: boolean;
  reminderDaySentAt?: Date;  // напоминание «завтра сходка» уже отправлено
  reminderHourSentAt?: Date; // напоминание «через час» уже отправлено
  // «Как прошло?» после сходки
  feedback?: { telegramId: number; name: string; score: number; comment?: string; wantsContact?: boolean; createdAt: Date }[];
  feedbackAskedAt?: Date;        // участникам задан вопрос
  feedbackSummarySentAt?: Date;  // организатору отправлена сводка
  createdAt: Date;
  updatedAt: Date;
}

const EventSchema = new Schema<IEvent>(
  {
    title: { type: String, required: true, trim: true, maxlength: 100 },
    description: { type: String, required: true, trim: true, maxlength: 600 },
    category: {
      type: String,
      enum: ['walk', 'cafe_bar', 'expo_cinema', 'trip_outdoors', 'boardgames', 'sport', 'talk', 'support', 'other'],
      default: 'walk',
      required: true
    },
    customCategory: { type: String, trim: true, maxlength: 30 },
    tags: { type: [{ type: String, enum: EVENT_TAGS }], default: [] },
    placeId: { type: String },
    templateId: { type: String, index: true },
    durationMinutes: { type: Number, default: 0 },
    extras: { type: Schema.Types.Mixed },
    badges: { type: [String], default: [] },
    photos: { type: [String], default: [] },
    isPaid: { type: Boolean, default: false },
    price: { type: Number, min: 0 },
    location: {
      type: { type: String, enum: ['Point'], default: 'Point' },
      coordinates: { type: [Number], required: true } // [lng, lat]
    },
    locationName: { type: String, required: true, trim: true },
    dateTime: { type: Date, required: true, index: true },
    creator: {
      telegramId: { type: Number, required: true, index: true },
      name: { type: String, required: true },
      username: { type: String },
      avatarUrl: { type: String, required: true }
    },
    participants: [
      {
        telegramId: { type: Number, required: true },
        name: { type: String, required: true },
        username: { type: String },
        avatarUrl: { type: String, required: true },
        joinedAt: { type: Date, default: Date.now },
        guests: { type: Number, default: 0, min: 0 },
        withKids: { type: Boolean, default: false }
      }
    ],
    maxParticipants: { type: Number, default: 0 }, // 0 = без ограничений
    isActive: { type: Boolean, default: true, index: true },
    reminderDaySentAt: { type: Date },
    reminderHourSentAt: { type: Date },
    feedback: [
      {
        telegramId: { type: Number, required: true },
        name: { type: String, default: '' },
        score: { type: Number, min: 1, max: 3, required: true }, // 3 — отлично, 2 — нормально, 1 — не очень
        comment: { type: String, maxlength: 300 },
        wantsContact: { type: Boolean },
        createdAt: { type: Date, default: Date.now }
      }
    ],
    feedbackAskedAt: { type: Date },
    feedbackSummarySentAt: { type: Date }
  },
  { timestamps: true }
);

// Индекс для быстрого поиска событий на карте Минска
EventSchema.index({ location: '2dsphere' });

export const Event = model<IEvent>('Event', EventSchema);
