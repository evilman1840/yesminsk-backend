import { Schema, model, Document } from 'mongoose';

export type ActivityGoal = 'walk' | 'cafe_bar' | 'expo_cinema' | 'trip_outdoors' | 'boardgames' | 'sport' | 'other';
// Подборки от бота: как часто присылать
export type DigestFrequency = 'daily' | 'weekend' | 'weekly' | 'off';
export const DIGEST_FREQUENCIES: DigestFrequency[] = ['daily', 'weekend', 'weekly', 'off'];
export type GoesWith = 'solo' | 'couple' | 'friends' | 'kids';
export const GOES_WITH: GoesWith[] = ['solo', 'couple', 'friends', 'kids'];
export const ACTIVITY_GOALS: ActivityGoal[] = ['walk', 'cafe_bar', 'expo_cinema', 'trip_outdoors', 'boardgames', 'sport', 'other'];
export type Gender = 'male' | 'female' | 'not_specified';
export type PreferredGender = 'all' | 'male' | 'female';

export interface IUser extends Document {
  telegramId: number;
  username?: string;
  firstName: string;
  lastName?: string;
  avatarUrl: string;
  photos?: string[]; // ещё до 5 фото в анкете (file_id в Telegram)
  bio: string;
  age: number;
  ageConfirmed?: boolean; // человек сам указал возраст (по умолчанию стоит 25)
  skipped?: { telegramId: number; until: Date }[]; // «Пропустить» свайпом: не показываем до until
  canMessage?: boolean;   // бот может писать: человек нажал «Старт» в боте или разрешил сообщения
  botBlockedAt?: Date;    // сообщение не дошло: не разрешал писать или заблокировал бота
  profileCompleted?: boolean; // сам указал возраст и интересы — только тогда анкету видят другие
  gender: Gender;
  preferredGender: PreferredGender;
  preferredAgeRange: {
    min: number;
    max: number;
  };
  goal: ActivityGoal;      // главная цель (первая из выбранных)
  goals: ActivityGoal[];   // все цели «Что тебе интересно?»
  customGoal?: string;     // своя идея, когда среди целей есть 'other'
  goesWith?: GoesWith;     // «Обычно хожу»: один, парой, компанией, с детьми
  digest?: DigestFrequency; // подборки от бота; не выбрано — «на выходные»
  isEmpath?: boolean;      // «🫶 Эмпат» — человек отметил сам в анкете
  ventUntil?: Date;        // «🫂 Хочется поныть» — до этого времени (видят только эмпаты)
  lastDigestAt?: Date;
  locationExact?: {
    type: 'Point';
    coordinates: [number, number]; // [lng, lat]
  };
  locationFuzzy: {
    type: 'Point';
    coordinates: [number, number]; // [lng, lat]
  };
  locationManual?: boolean; // метку на карте человек поставил сам
  areaName?: string;
  isTourist: boolean;
  hasAgreedToRules: boolean;
  genderConfirmed?: boolean; // пол выбран самим человеком (по умолчанию стоит «Не скажу»)
  legalVersion?: string;    // принятая редакция Пользовательского соглашения и Политики
  legalAcceptedAt?: Date;   // когда принял(а) — доказательство согласия на обработку данных
  isProfileActive: boolean;
  blockedUsers: number[]; // Список telegramId заблокированных пользователей
  availableUntil?: Date;  // «⚡ Есть время» — до этого времени
  isGuide: boolean;       // «🧭 Покажу город» — местный, готов показать город туристам
  isBanned?: boolean;        // забанен модератором
  invitedBy?: number;        // кто позвал в приложение
  savedPlaces?: string[];    // 🔖 места, которые человек хочет посетить
  nudge1SentAt?: Date;       // приветственный толчок: первое сообщение (через сутки)
  nudge2SentAt?: Date;       // второе, последнее (через 4 дня)
  nudgeOptedOut?: boolean;   // нажал «Не сейчас» — больше не пишем
  profileNudgeSentAt?: Date; // разовое напоминание «заполни анкету подробнее»
  hiddenPlaces?: string[];   // места, смахнутые «Неинтересно»
  hiddenEvents?: string[];   // сходки, смахнутые «Неинтересно»
  hiddenByReports?: boolean; // скрыт после 3 жалоб до решения модератора
  guideAbout?: string;    // что может показать
  lastActiveAt: Date;
}

const UserSchema = new Schema<IUser>(
  {
    telegramId: { type: Number, required: true, unique: true, index: true },
    username: { type: String, trim: true },
    firstName: { type: String, required: true, trim: true },
    lastName: { type: String, trim: true },
    avatarUrl: { type: String, required: true },
    photos: { type: [String], default: undefined },
    bio: { type: String, maxlength: 200, default: '' },
    age: { type: Number, default: 25, min: 16, max: 99 },
    ageConfirmed: { type: Boolean },
    profileCompleted: { type: Boolean, index: true },
    canMessage: { type: Boolean },
    botBlockedAt: { type: Date },
    skipped: { type: [{ telegramId: Number, until: Date, _id: false }], default: undefined }, // в приложении — только 18+ (проверка при сохранении анкеты)
    gender: {
      type: String,
      enum: ['male', 'female', 'not_specified'],
      default: 'not_specified'
    },
    preferredGender: {
      type: String,
      enum: ['all', 'male', 'female'],
      default: 'all'
    },
    preferredAgeRange: {
      min: { type: Number, default: 18, min: 16 },
      max: { type: Number, default: 99, max: 99 }
    },
    goal: {
      type: String,
      enum: ACTIVITY_GOALS,
      default: 'walk',
      required: true
    },
    goals: { type: [{ type: String, enum: ACTIVITY_GOALS }], default: undefined },
    customGoal: { type: String, trim: true, maxlength: 30, default: '' },
    goesWith: { type: String, enum: GOES_WITH },
    digest: { type: String, enum: DIGEST_FREQUENCIES },
    isEmpath: { type: Boolean, default: false },
    ventUntil: { type: Date },
    lastDigestAt: { type: Date },
    locationExact: {
      type: { type: String, enum: ['Point'], default: 'Point' },
      coordinates: { type: [Number] }
    },
    locationFuzzy: {
      type: { type: String, enum: ['Point'], default: 'Point' },
      coordinates: { type: [Number], required: true }
    },
    locationManual: { type: Boolean, default: false },
    areaName: { type: String, default: 'Минск' },
    isTourist: { type: Boolean, default: false },
    hasAgreedToRules: { type: Boolean, default: false },
    genderConfirmed: { type: Boolean, default: false },
    legalVersion: { type: String },
    legalAcceptedAt: { type: Date },
    isProfileActive: { type: Boolean, default: true },
    blockedUsers: { type: [Number], default: [] },
    availableUntil: { type: Date },
    isGuide: { type: Boolean, default: false },
    isBanned: { type: Boolean, default: false },
    invitedBy: { type: Number },
    savedPlaces: { type: [String], default: [] },
    nudge1SentAt: { type: Date },
    nudge2SentAt: { type: Date },
    nudgeOptedOut: { type: Boolean },
    profileNudgeSentAt: { type: Date },
    hiddenPlaces: { type: [String], default: [] },
    hiddenEvents: { type: [String], default: [] },
    hiddenByReports: { type: Boolean, default: false },
    guideAbout: { type: String, maxlength: 140, default: '' },
    lastActiveAt: { type: Date, default: Date.now }
  },
  { timestamps: true }
);

// Пространственный 2dsphere-индекс для гео-запросов
UserSchema.index({ locationFuzzy: '2dsphere' });
UserSchema.index({ blockedUsers: 1 });
// Проверка «это фото из анкеты?» и лента людей без перебора всей коллекции
UserSchema.index({ photos: 1 });
UserSchema.index({ lastActiveAt: -1 });
UserSchema.index({ savedPlaces: 1 });

export const User = model<IUser>('User', UserSchema);
