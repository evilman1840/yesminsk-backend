import { Schema, model, Document } from 'mongoose';

// unmatch — был 👋, потом передумал общаться (из «На связи»)
export type ReactionType = 'like' | 'dislike' | 'unmatch';

export interface IReaction extends Document {
  fromTelegramId: number; // Кто поставил реакцию
  toTelegramId: number;   // Кому поставили
  type: ReactionType;
  likedAt?: Date;     // когда нажат 👋 (новый, не повторный) — для дневного лимита
  likeFree?: boolean; // 👋 не в счёт лимита: ответ на чужой 👋 или привет участникам после сходки
  // Жребий «кто пишет первым» (одинаково у обеих записей пары)
  firstMove?: number;    // telegramId того, кому монетка выпала писать первым
  firstMoveAt?: Date;    // когда бросили монетку (= когда стали «На связи»)
  helloNudgeAt?: Date;   // через сутки тишины пара разобрана: второму «{имя} стесняется» (если можно писать)
  helloNudgeSent?: boolean; // сообщение дошло
  // «✍️ Что написать» — у записи того, кто открыл шторку (fromTelegramId)
  helloOpenedAt?: Date;  // открыл шторку с фразами
  helloPickedAt?: Date;  // выбрал фразу и ушёл в чат
  createdAt: Date;
  updatedAt: Date;
}

const ReactionSchema = new Schema<IReaction>(
  {
    fromTelegramId: { type: Number, required: true, index: true },
    toTelegramId: { type: Number, required: true, index: true },
    type: { type: String, enum: ['like', 'dislike', 'unmatch'], required: true },
    likedAt: { type: Date },
    likeFree: { type: Boolean },
    firstMove: { type: Number },
    firstMoveAt: { type: Date },
    helloNudgeAt: { type: Date },
    helloNudgeSent: { type: Boolean },
    helloOpenedAt: { type: Date },
    helloPickedAt: { type: Date }
  },
  { timestamps: true }
);

// Один человек — одна реакция на другого (повторная реакция перезаписывает старую)
ReactionSchema.index({ fromTelegramId: 1, toTelegramId: 1 }, { unique: true });
// Напоминание через сутки: свежие жребии без ответа
ReactionSchema.index({ firstMoveAt: 1 }, { sparse: true });

export const Reaction = model<IReaction>('Reaction', ReactionSchema);
