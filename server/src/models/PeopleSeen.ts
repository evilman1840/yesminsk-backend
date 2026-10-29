import { Schema, model } from 'mongoose';

/**
 * Кого человек уже видел в «Людях» (карточка была на экране больше секунды) — таких опускаем ниже.
 * Записи старше 30 дней удаляются сами
 */
export interface IPeopleSeen {
  viewerId: number;
  userId: number;
  count: number;
  lastSeenAt: Date;
}

const PeopleSeenSchema = new Schema<IPeopleSeen>({
  viewerId: { type: Number, required: true },
  userId: { type: Number, required: true },
  count: { type: Number, default: 0 },
  lastSeenAt: { type: Date, default: Date.now }
});
PeopleSeenSchema.index({ viewerId: 1, userId: 1 }, { unique: true });
PeopleSeenSchema.index({ lastSeenAt: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 });

export const PeopleSeen = model<IPeopleSeen>('PeopleSeen', PeopleSeenSchema);
