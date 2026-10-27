import { Schema, model, Document } from 'mongoose';

// unmatch — был 👋, потом передумал общаться (из «На связи»)
export type ReactionType = 'like' | 'dislike' | 'unmatch';

export interface IReaction extends Document {
  fromTelegramId: number; // Кто поставил реакцию
  toTelegramId: number;   // Кому поставили
  type: ReactionType;
  createdAt: Date;
  updatedAt: Date;
}

const ReactionSchema = new Schema<IReaction>(
  {
    fromTelegramId: { type: Number, required: true, index: true },
    toTelegramId: { type: Number, required: true, index: true },
    type: { type: String, enum: ['like', 'dislike', 'unmatch'], required: true }
  },
  { timestamps: true }
);

// Один человек — одна реакция на другого (повторная реакция перезаписывает старую)
ReactionSchema.index({ fromTelegramId: 1, toTelegramId: 1 }, { unique: true });

export const Reaction = model<IReaction>('Reaction', ReactionSchema);
