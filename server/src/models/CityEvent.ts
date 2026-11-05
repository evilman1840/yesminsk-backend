import { Schema, model, Document } from 'mongoose';

// Событие города из минских Telegram-каналов: Claude разбирает пост, автор одобряет в боте
export const CITY_EVENT_CATEGORIES = ['concert', 'expo', 'cinema', 'lecture', 'market', 'festival', 'theatre', 'sport', 'kids', 'other'] as const;
export type CityEventCategory = (typeof CITY_EVENT_CATEGORIES)[number];

export interface ICityEvent extends Document {
  postKey: string;         // «minsk_kuda/1234» — один пост разбираем один раз
  channel: string;
  sourceUrl: string;       // ссылка на пост: показываем источник, текст не копируем
  postedAt: Date;
  isEvent: boolean;        // false — реклама, новость, розыгрыш: не показываем
  title: string;
  summary: string;         // своими словами, одна-две фразы
  category: CityEventCategory;
  startDate?: Date;        // первый день
  endDate?: Date;          // последний день (выставка «по 14 декабря»); у разовых = startDate
  when: string;            // «25 октября (вс), 17:00» или «по 14 декабря, пн-чт 12–20»
  venue: string;
  address: string;
  coords?: [number, number]; // [lat, lng]
  price: string;           // «Вход свободный», «любая купюра», «от 75 BYN»
  isFree: boolean;
  indoor: boolean;         // под крышей — для подборок в дождь
  kidsOk: boolean;
  photoUrl: string;
  dupOf?: string;          // то же событие уже есть из другого канала
  status: 'pending' | 'approved' | 'rejected' | 'skipped';
  createdAt: Date;
  updatedAt: Date;
}

const CityEventSchema = new Schema<ICityEvent>(
  {
    postKey: { type: String, required: true, unique: true },
    channel: { type: String, required: true },
    sourceUrl: { type: String, required: true },
    postedAt: { type: Date, required: true },
    isEvent: { type: Boolean, default: false },
    title: { type: String, default: '', maxlength: 200 },
    summary: { type: String, default: '', maxlength: 400 },
    category: { type: String, enum: CITY_EVENT_CATEGORIES, default: 'other' },
    startDate: { type: Date },
    endDate: { type: Date, index: true },
    when: { type: String, default: '', maxlength: 200 },
    venue: { type: String, default: '', maxlength: 200 },
    address: { type: String, default: '', maxlength: 200 },
    coords: { type: [Number], default: undefined },
    price: { type: String, default: '', maxlength: 100 },
    isFree: { type: Boolean, default: false },
    indoor: { type: Boolean, default: true },
    kidsOk: { type: Boolean, default: false },
    photoUrl: { type: String, default: '' },
    dupOf: { type: String },
    status: { type: String, enum: ['pending', 'approved', 'rejected', 'skipped'], default: 'pending', index: true }
  },
  { timestamps: true }
);

export const CityEvent = model<ICityEvent>('CityEvent', CityEventSchema);
