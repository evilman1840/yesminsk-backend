import { Schema, model, Document } from 'mongoose';
import { EventCategory, EventTag, EVENT_TAGS } from './Event';

/**
 * Шаблон сходки: заполняет форму за человека («Кофе и поболтать», «Кино», «Поиграем?»…).
 * Хранится в базе, автор правит таблицей через бота (/templates)
 */

// Вариант в поле-выборе («Настольный теннис», «Любой уровень»)
export interface ITemplateOption {
  value: string;      // латиницей, для ссылок и «Хочу сходить»: tabletennis
  label: string;      // как в форме: «Настольный теннис»
  emoji?: string;
  badge?: string;     // как в метке сходки: «🏓 Настольный теннис», «любой уровень»
  say?: string;       // что подставить в описание вместо {метки поля}
  seatsHint?: boolean; // показать подсказку «Для пары достаточно 2 мест…»
}

// Дополнительное поле шаблона: фильм, вид спорта, уровень, «Что взять?», «Сколько стоит?»
export interface ITemplateField {
  key: string;        // латиницей: movie, sport, level, bring, cost
  token?: string;     // метка в названии и описании: {фильм}, {спорт}, {уровень}
  label: string;      // «Во что играем?»
  type: 'select' | 'text' | 'money';
  required?: boolean;
  placeholder?: string;
  default?: string;
  options?: ITemplateOption[];
  allowCustom?: boolean;   // у варианта other — своё название
  customLabel?: string;    // подсказка для своего варианта
  badge?: string;          // метка сходки для text: «🎒 {value}»; для money: см. freeBadge/amountBadge
  badgeGroup?: string;     // поля с одной группой — одной меткой через « · »
  freeLabel?: string;      // money: «Бесплатно»
  amountLabel?: string;    // money: «Делим аренду, примерно {сумма} BYN с человека»
  freeBadge?: string;
  amountBadge?: string;
}

export interface IEventTemplate extends Document {
  key: string;
  order: number;
  active: boolean;
  emoji: string;
  name: string;          // на карточке выбора: «Кофе и поболтать»
  category?: EventCategory;
  title: string;         // «Идём в кино: {фильм}»
  fallbackTitle: string; // если поле не заполнено: «Идём в кино»
  description: string;
  seats: number;         // 0 — без ограничений
  durationMinutes: number;
  placeTypes: string[];  // для каких типов мест показывать
  tags: EventTag[];      // метки по умолчанию
  paid: boolean;         // по умолчанию «Платно» (кино, спорт)
  fields: ITemplateField[];
}

const EventTemplateSchema = new Schema<IEventTemplate>(
  {
    key: { type: String, required: true, unique: true, trim: true },
    order: { type: Number, default: 100 },
    active: { type: Boolean, default: true },
    emoji: { type: String, default: '✨' },
    name: { type: String, required: true, trim: true, maxlength: 40 },
    category: { type: String, enum: ['walk', 'cafe_bar', 'expo_cinema', 'trip_outdoors', 'boardgames', 'sport', 'talk', 'support', 'other'] },
    title: { type: String, default: '', maxlength: 100 },
    fallbackTitle: { type: String, default: '', maxlength: 100 },
    description: { type: String, default: '', maxlength: 600 },
    seats: { type: Number, default: 0 },
    durationMinutes: { type: Number, default: 0 },
    placeTypes: { type: [String], default: [] },
    tags: { type: [{ type: String, enum: EVENT_TAGS }], default: [] },
    paid: { type: Boolean, default: false },
    fields: { type: Schema.Types.Mixed, default: [] }
  },
  { timestamps: true }
);

export const EventTemplate = model<IEventTemplate>('EventTemplate', EventTemplateSchema);

// «Своя идея» — пустая форма, всегда последней
export const CUSTOM_TEMPLATE_KEY = 'custom';
