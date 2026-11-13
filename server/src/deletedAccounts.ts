import { Schema, model, Document } from 'mongoose';
import { Reaction } from './models/Reaction';

/**
 * Память об удалённых аккаунтах. Удаление стирает анкету, реакции и жалобы, и раньше этим можно было
 * обнулить свою историю: удалиться и тут же зайти снова с чистым счётчиком и лимитом новичка.
 * Теперь при удалении остаётся короткая запись без анкеты и фото: номер аккаунта в Telegram, даты,
 * сколько 👋 отправлено и сколько взаимных, сколько было жалоб и по каким причинам (без текста и авторов).
 * Запись живёт год после последнего удаления (об этом сказано в Политике, раздел «Сколько хранятся»).
 * Кто скрыл человека, помнят чёрные списки (blockedUsers) — они и так переживают удаление.
 */

const KEEP_DAYS = 365;

export interface IDeletedAccount extends Document {
  telegramId: number;
  times: number;        // сколько раз удалял(а) аккаунт
  sent: number;         // 👋, отправленные с прежних анкет
  mutual: number;       // из них взаимных
  reports: number;      // жалобы на прежние анкеты (без отклонённых модератором)
  reasons: string[];    // причины этих жалоб
  firstCreatedAt?: Date; // когда появилась самая первая анкета
  lastDeletedAt: Date;
  expireAt: Date;
}

const DeletedAccountSchema = new Schema<IDeletedAccount>({
  telegramId: { type: Number, required: true, unique: true },
  times: { type: Number, default: 0 },
  sent: { type: Number, default: 0 },
  mutual: { type: Number, default: 0 },
  reports: { type: Number, default: 0 },
  reasons: { type: [String], default: [] },
  firstCreatedAt: { type: Date },
  lastDeletedAt: { type: Date, required: true },
  expireAt: { type: Date, required: true, index: { expires: 0 } }
});

export const DeletedAccount = model<IDeletedAccount>('DeletedAccount', DeletedAccountSchema);

/** Вызывать перед удалением реакций и жалоб: считает итоги анкеты и прибавляет их к записи */
export async function rememberDeletedAccount(
  me: { telegramId: number; createdAt?: Date },
  reportsOnMe: { reason: string; status: string }[]
): Promise<void> {
  const id = me.telegramId;
  const sent = await Reaction.find({ fromTelegramId: id, type: { $in: ['like', 'unmatch'] } }, { toTelegramId: 1 }).lean();
  const mutual = sent.length ? await Reaction.countDocuments({ fromTelegramId: { $in: sent.map((r) => r.toTelegramId) }, toTelegramId: id, type: 'like' }) : 0;
  const counted = reportsOnMe.filter((r) => r.status !== 'dismissed');
  const now = new Date();
  await DeletedAccount.updateOne(
    { telegramId: id },
    {
      $inc: { times: 1, sent: sent.length, mutual, reports: counted.length },
      $addToSet: { reasons: { $each: [...new Set(counted.map((r) => r.reason))] } },
      $set: { lastDeletedAt: now, expireAt: new Date(now.getTime() + KEEP_DAYS * 24 * 60 * 60 * 1000) },
      ...(me.createdAt ? { $setOnInsert: { firstCreatedAt: me.createdAt } } : {})
    },
    { upsert: true }
  );
}

export const pastAccount = (telegramId: number) => DeletedAccount.findOne({ telegramId }).lean();
