import { Schema, model } from 'mongoose';
import { User } from './models/User';
import { escapeHtml, sendTelegramMessage } from './utils/telegramNotify';

/**
 * Приглашения в приложение: t.me/<бот>?start=invite_<telegramId пригласившего>.
 * Бот запоминает, кто кого позвал; когда друг впервые открывает приложение — благодарим пригласившего.
 */

const InviteSchema = new Schema(
  {
    inviteeId: { type: Number, required: true, unique: true }, // кого позвали (первое приглашение — главное)
    inviterId: { type: Number, required: true, index: true },
    joined: { type: Boolean, default: false }
  },
  { timestamps: true }
);
export const Invite = model('Invite', InviteSchema);

// Друг нажал «Старт» по приглашению
export async function handleInviteStart(chatId: number, inviteeId: number, inviterId: number, firstName?: string) {
  const inviter = inviterId !== inviteeId ? await User.findOne({ telegramId: inviterId }) : null;
  if (inviter) {
    // Запоминаем только для новых людей
    const alreadyUser = await User.exists({ telegramId: inviteeId, hasAgreedToRules: true });
    if (!alreadyUser) {
      await Invite.updateOne({ inviteeId }, { $setOnInsert: { inviteeId, inviterId } }, { upsert: true }).catch(() => {});
    }
  }

  const who = inviter ? `<b>${escapeHtml(inviter.firstName)}</b> зовёт тебя в ДА! МИНСК` : 'Тебя зовут в ДА! МИНСК';
  sendTelegramMessage(
    chatId,
    `👋 Привет${firstName ? `, ${escapeHtml(firstName)}` : ''}! ${who} — компанию для прогулок, кофе и общения в Минске.\n\n` +
      `Без дейтинга, только дружеское общение. Жми кнопку ниже 👇`,
    'Открыть ДА! МИНСК'
  );
}

// Друг впервые открыл приложение — отмечаем и благодарим пригласившего
export async function markInviteJoined(inviteeId: number, inviteeName: string) {
  const invite = await Invite.findOneAndUpdate({ inviteeId, joined: false }, { $set: { joined: true } });
  if (!invite) return;
  await User.updateOne({ telegramId: inviteeId }, { $set: { invitedBy: invite.inviterId } });
  sendTelegramMessage(
    invite.inviterId,
    `🎉 <b>${escapeHtml(inviteeName)}</b> теперь в ДА! МИНСК по твоему приглашению. Спасибо, что зовёшь друзей!`
  );
}
