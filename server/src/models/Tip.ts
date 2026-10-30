import { Schema, model, Document } from 'mongoose';

// Короткая запись автора в строке подсказок (команда /tip): одна на всех, висит сутки или до следующей
export interface ITip extends Document {
  text: string;
  expiresAt: Date;
  createdAt: Date;
}

const TipSchema = new Schema<ITip>(
  {
    text: { type: String, required: true, maxlength: 200 },
    expiresAt: { type: Date, required: true, index: true }
  },
  { timestamps: true }
);

export const Tip = model<ITip>('Tip', TipSchema);
