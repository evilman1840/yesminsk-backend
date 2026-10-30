import { Schema, model, Document } from 'mongoose';

// Короткая запись автора в строке подсказок (команда /tip): одна на всех, висит сутки или до следующей
export interface ITip extends Document {
  text: string;
  first: boolean; // /tiptop — первой карточкой, иначе в конце
  expiresAt: Date;
  createdAt: Date;
}

const TipSchema = new Schema<ITip>(
  {
    text: { type: String, required: true, maxlength: 200 },
    first: { type: Boolean, default: false },
    expiresAt: { type: Date, required: true, index: true }
  },
  { timestamps: true }
);

export const Tip = model<ITip>('Tip', TipSchema);
