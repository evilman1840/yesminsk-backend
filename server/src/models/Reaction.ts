import { Schema, model, Document } from 'mongoose';

// unmatch — был 👋, потом передумал общаться (из «На связи»)
export type ReactionType = 'like' | 'dislike' | 'unmatch';

export interface IReaction extends Document {
  fromTelegramId: number; // Кто поставил реакцию
  toTelegramId: number;   // Кому поставили
  type: ReactionType;
  likedAt?: Date;     // когда нажат 👋 (новый, не повторный) — для дневного лимита
  likeFree?: boolean; // 👋 не в счёт лимита: ответ на чужой 👋 или привет участникам после сходки
  createdAt: Date;
  updatedAt: Date;
}

const ReactionSchema = new Schema<IReaction>(
  {
    fromTelegramId: { type: Number, required: true, index: true },
    toTelegramId: { type: Number, required: true, index: true },
    type: { type: String, enum: ['like', 'dislike', 'unmatch'], required: true },
    likedAt: { type: Date },
    likeFree: { type: Boolean }
  },
  { timestamps: true }
);

// Один человек — одна реакция на другого (повторная реакция перезаписывает старую)
ReactionSchema.index({ fromTelegramId: 1, toTelegramId: 1 }, { unique: true });

export const Reaction = model<IReaction>('Reaction', ReactionSchema);
