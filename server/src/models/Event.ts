import { Schema, model, Document } from 'mongoose';

// «Кафе и бар» разделили на кафе, бар и ресторан, «Арт, кино» — на выставку, музей и кино.
// Прежние cafe_bar и expo_cinema оставлены для старых записей (их переносят миграции в eventTemplates.ts)
// и старых версий приложения
export const EVENT_CATEGORIES = [
  'walk', 'cafe', 'bar', 'restaurant', 'exhibition', 'museum', 'cinema', 'trip_outdoors', 'boardgames', 'sport',
  'relax', 'learn', 'talk', 'support', 'other', 'cafe_bar', 'expo_cinema'
] as const;
export type EventCategory = (typeof EVENT_CATEGORIES)[number];

// Прежний общий тип → на какие разделили (первый — куда переносим по умолчанию)
export const SPLIT_CATEGORIES: Partial<Record<EventCategory, EventCategory[]>> = {
  cafe_bar: ['cafe', 'bar', 'restaurant'],
  expo_cinema: ['exhibition', 'museum', 'cinema']
};

// Прежний общий тип от старого приложения записываем как первый из новых
export const normalizeCategory = (c: string): string => SPLIT_CATEGORIES[c as EventCategory]?.[0] || c;

export interface IEventParticipant {
  telegramId: number;
  name: string;
  username?: string;
  avatarUrl: string;
  joinedAt: Date;
  guests?: number;     // сколько человек ведёт с собой (+1, +2…)
  withKids?: boolean;  // идёт с детьми
  confirmedAt?: Date;  // нажал «Точно приду» (из напоминания или в приложении)
  approvedAt?: Date;   // «По записи»: организатор подтвердил запись (после этого отменить можно только через него)
  noShowAt?: Date;     // организатор отметил «Не пришёл(ла)» (внутренний рейтинг, человеку не сообщаем)
  buddyOf?: number;    // «👯 Пойдём вместе»: пришёл по приглашению этого человека (buddyInvites.ts)
  viaRecruit?: boolean; // записался по сообщению «Компания собирается» (recruitHelp.ts)
}

// Отменил участие: из списка убираем, а здесь остаётся след (кто, когда, откуда)
export interface IEventCancellation {
  telegramId: number;
  name: string;
  joinedAt?: Date;
  cancelledAt: Date;
  via: 'app' | 'bot' | 'host'; // сам из приложения, по кнопке «Отменить» в боте или отказал организатор
  reason?: string;             // host: что написал организатор
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
  payTo?: 'venue' | 'host'; // кому платят: кассе/заведению (кино, кафе) или организатору (настолка, мастер-класс). Нет поля — заведению
  donation?: boolean;       // взнос организатору — донат по желанию, а не фиксированная сумма
  payFor?: string;          // за что взнос: «аренда игр», «чай и печеньки»
  byRequest?: boolean;      // «По записи»: организатор подтверждает каждого и меняет, сколько человек; сам отменить подтверждённую запись нельзя
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
  photosHidden?: boolean;
  stopWordsHold?: boolean; // скрыта автобаном по стоп-словам — вернётся, если модератор нажмёт «Ошибка»
  audienceGender?: 'all' | 'female' | 'male'; // для кого: все / только девушки / только мужчины
  ageMin?: number | null;  // возраст «от» (пусто — любой)
  ageMax?: number | null;  // возраст «до»
  isActive: boolean;
  reminderDaySentAt?: Date;  // напоминание «завтра сходка» уже отправлено
  reminderHourSentAt?: Date; // напоминание «через час» уже отправлено
  // «Как прошло?» после сходки
  feedback?: { telegramId: number; name: string; score: number; comment?: string; wantsContact?: boolean; createdAt: Date }[];
  cancellations?: IEventCancellation[];
  feedbackAskedAt?: Date;        // участникам задан вопрос
  feedbackHostAskedAt?: Date;    // организатору задан вопрос (отдельно: раньше его не спрашивали)
  feedbackSummarySentAt?: Date;  // организатору отправлена сводка
  // «Помощь в наборе» (recruitHelp.ts): до начала меньше 48 часов, а идут меньше трёх
  recruitHelpAt?: Date;          // когда сходка впервые попала в помощь (для /stats)
  recruitHostTipAt?: Date;       // организатору подсказали позвать кого-то из «На связи»
  // «Все, кто записался, пришли?» после сходки: all — «Да, все», marked — отметил не пришедших в приложении
  attendanceAnswer?: 'all' | 'marked';
  attendanceAnsweredAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const EventSchema = new Schema<IEvent>(
  {
    title: { type: String, required: true, trim: true, maxlength: 100 },
    description: { type: String, required: true, trim: true, maxlength: 600 },
    category: {
      type: String,
      enum: EVENT_CATEGORIES,
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
    photosHidden: { type: Boolean, default: false }, // жалоба «неприличное фото» — не показываем до решения
    stopWordsHold: { type: Boolean },
    audienceGender: { type: String, enum: ['all', 'female', 'male'], default: 'all' },
    ageMin: { type: Number, min: 18, max: 99 },
    ageMax: { type: Number, min: 18, max: 99 },
    isPaid: { type: Boolean, default: false },
    price: { type: Number, min: 0 },
    payTo: { type: String, enum: ['venue', 'host'] },
    donation: { type: Boolean },
    payFor: { type: String, maxlength: 60 },
    byRequest: { type: Boolean, default: false },
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
        withKids: { type: Boolean, default: false },
        confirmedAt: { type: Date },
        approvedAt: { type: Date },
        noShowAt: { type: Date },
        buddyOf: { type: Number },
        viaRecruit: { type: Boolean }
      }
    ],
    cancellations: [
      {
        telegramId: { type: Number, required: true },
        name: { type: String, default: '' },
        joinedAt: { type: Date },
        cancelledAt: { type: Date, default: Date.now },
        via: { type: String, enum: ['app', 'bot', 'host'], default: 'app' },
        reason: { type: String, maxlength: 800 }
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
    feedbackHostAskedAt: { type: Date },
    feedbackSummarySentAt: { type: Date },
    recruitHelpAt: { type: Date, index: true },
    recruitHostTipAt: { type: Date },
    attendanceAnswer: { type: String, enum: ['all', 'marked'] },
    attendanceAnsweredAt: { type: Date }
  },
  { timestamps: true }
);

// Индекс для быстрого поиска событий на карте Минска
EventSchema.index({ location: '2dsphere' });
EventSchema.index({ photos: 1 });
EventSchema.index({ isActive: 1, dateTime: 1 });

export const Event = model<IEvent>('Event', EventSchema);
