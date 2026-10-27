import mongoose, { Schema, model } from 'mongoose';
import { User } from './models/User';
import { Event } from './models/Event';
import { isAdmin } from './news';
import { escapeHtml, sendTelegramMessage } from './utils/telegramNotify';
import { purgePhoto } from './utils/telegramFile';
import { deleteAvatar, syncEventAvatars } from './avatars';
import { PHOTO_MOD_TEXTS as T } from './texts';

/**
 * Модерация фото после публикации: каждое загруженное фото (доп. фото анкеты, фото сходки, главное фото анкеты)
 * лежит в приватном канале PHOTO_CHANNEL_ID с подписью «кто» и кнопками «🗑 Удалить» / «🚫 Удалить и заблокировать».
 * Плюс жалоба «неприличное фото»: фото человека или сходки скрываются сразу, до решения автора
 */

const PhotoUpload = model(
  'PhotoUpload',
  new Schema({
    kind: { type: String, enum: ['photo', 'avatar'], required: true },
    telegramId: { type: Number, required: true },
    fileId: String,      // photo: file_id в Telegram
    avatarV: String,     // avatar: версия фото профиля
    status: { type: String, enum: ['ok', 'deleted'], default: 'ok' },
    createdAt: { type: Date, default: Date.now }
  })
);

const tg = (method: string, body: any) =>
  fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
    .then((r) => r.json())
    .catch(() => ({}));

const who = async (telegramId: number) => {
  const u = await User.findOne({ telegramId }, { firstName: 1, username: 1 }).lean();
  return `${escapeHtml(u?.firstName || 'кто-то')}${u?.username ? ` (@${escapeHtml(u.username)})` : ''} · ID ${telegramId}`;
};

const buttons = (uploadId: string) => ({
  inline_keyboard: [[{ text: T.deleteBtn, callback_data: `phm:del:${uploadId}` }, { text: T.banBtn, callback_data: `phm:ban:${uploadId}` }]]
});

// Фото уже лежит в канале (так хранятся доп. фото и фото сходок) — подписываем и добавляем кнопки
export async function registerChannelPhoto(fileId: string, telegramId: number, chatId: number | string, messageId: number) {
  try {
    const up = await PhotoUpload.create({ kind: 'photo', telegramId, fileId });
    await tg('editMessageCaption', { chat_id: chatId, message_id: messageId, caption: T.caption(await who(telegramId)), parse_mode: 'HTML', reply_markup: buttons(String(up._id)) });
  } catch {
    // без подписи фото всё равно сохранено
  }
}

// Новое главное фото анкеты (хранится в базе) — кладём копию в канал для просмотра
export async function registerAvatarUpload(telegramId: number, dataUrl: string, avatarV: string) {
  const channel = process.env.PHOTO_CHANNEL_ID;
  const m = dataUrl.match(/^data:(image\/[\w.+-]+);base64,(.+)$/s);
  if (!channel || !m || !process.env.TELEGRAM_BOT_TOKEN) return;
  try {
    const up = await PhotoUpload.create({ kind: 'avatar', telegramId, avatarV });
    const form = new FormData();
    form.append('chat_id', channel);
    form.append('disable_notification', 'true');
    form.append('caption', T.avatarCaption(await who(telegramId)));
    form.append('parse_mode', 'HTML');
    form.append('reply_markup', JSON.stringify(buttons(String(up._id))));
    form.append('photo', new Blob([new Uint8Array(Buffer.from(m[2], 'base64'))], { type: m[1] }), 'avatar.jpg');
    await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendPhoto`, { method: 'POST', body: form });
  } catch {
    // не страшно: фото уже сохранено
  }
}

// Убрать одно загруженное фото отовсюду
async function removeUpload(up: any) {
  if (up.kind === 'photo' && up.fileId) {
    await User.updateMany({ photos: up.fileId }, { $pull: { photos: up.fileId } });
    await Event.updateMany({ photos: up.fileId }, { $pull: { photos: up.fileId } });
    await purgePhoto(up.fileId);
  } else if (up.kind === 'avatar') {
    // Удаляем, только если это фото всё ещё стоит в анкете
    const r = await User.updateOne({ telegramId: up.telegramId, avatarUrl: `avatar:${up.avatarV}` }, { $set: { avatarUrl: '' } });
    if (r.modifiedCount) {
      await deleteAvatar(up.telegramId);
      await syncEventAvatars(up.telegramId, '');
    }
  }
  up.status = 'deleted';
  await up.save();
}

// Все фото человека (жалоба «неприличное фото» → «🗑 Удалить фото»)
export async function removeUserPhotos(telegramId: number) {
  const u = await User.findOne({ telegramId }, { photos: 1, avatarUrl: 1 }).lean();
  for (const id of u?.photos || []) await purgePhoto(id);
  await User.updateOne({ telegramId }, { $set: { photos: [], avatarUrl: '', photosHidden: false } });
  await deleteAvatar(telegramId);
  await syncEventAvatars(telegramId, '');
}

export async function removeEventPhotos(eventId: string) {
  if (!mongoose.Types.ObjectId.isValid(eventId)) return;
  const ev = await Event.findById(eventId, { photos: 1 }).lean();
  for (const id of ev?.photos || []) await purgePhoto(id);
  await Event.updateOne({ _id: eventId }, { $set: { photos: [], photosHidden: false } });
}

// Кнопки под фото в канале: phm:del:<id> / phm:ban:<id>
export async function handlePhotoModerationCallback(query: any, banUser: (id: number) => Promise<void>): Promise<boolean> {
  const data: string = query.data || '';
  if (!data.startsWith('phm:')) return false;
  const [, action, id] = data.split(':');
  if (!isAdmin(query.from?.id)) {
    tg('answerCallbackQuery', { callback_query_id: query.id, text: T.onlyAdmin });
    return true;
  }
  const up = mongoose.Types.ObjectId.isValid(id) ? await PhotoUpload.findById(id) : null;
  if (!up) {
    tg('answerCallbackQuery', { callback_query_id: query.id, text: T.notFound });
    return true;
  }
  if (up.status !== 'deleted') await removeUpload(up);
  let result = T.deleted;
  if (action === 'ban') {
    await banUser(up.telegramId);
    result = T.deletedBanned;
  } else {
    sendTelegramMessage(up.telegramId, T.ownerNotice, 'Открыть «ГУЛЯЙ!»', '?tab=profile');
  }
  tg('answerCallbackQuery', { callback_query_id: query.id, text: result });
  if (query.message) {
    tg('editMessageCaption', {
      chat_id: query.message.chat.id,
      message_id: query.message.message_id,
      caption: `${query.message.caption || ''}\n\n${result}`,
      reply_markup: { inline_keyboard: [] }
    });
  }
  return true;
}

// /photos 123 — фото человека; /photos ev:<id> — фото сходки (посмотреть перед решением по жалобе)
export async function handlePhotosCommand(message: any): Promise<boolean> {
  const text: string = (message.text || '').trim();
  const m = text.match(/^\/photos\s+(ev:)?([\w]+)/i);
  if (!m || !isAdmin(message.from?.id)) return false;
  const chatId = message.chat.id;
  const sendFile = (photo: string) => tg('sendPhoto', { chat_id: chatId, photo });
  if (m[1]) {
    const ev = mongoose.Types.ObjectId.isValid(m[2]) ? await Event.findById(m[2], { photos: 1, title: 1 }).lean() : null;
    if (!ev?.photos?.length) return sendTelegramMessage(chatId, T.noPhotos), true;
    for (const id of ev.photos) await sendFile(id);
    return true;
  }
  const telegramId = Number(m[2]);
  const u = await User.findOne({ telegramId }, { photos: 1, avatarUrl: 1 }).lean();
  if (!u) return sendTelegramMessage(chatId, T.noPhotos), true;
  let sent = 0;
  // Главное фото: из базы (avatar:) — файлом, по ссылке — ссылкой
  if (u.avatarUrl?.startsWith('avatar:')) {
    const a = await mongoose.connection.db!.collection('avatars').findOne({ telegramId });
    const mm = String(a?.data || '').match(/^data:(image\/[\w.+-]+);base64,(.+)$/s);
    if (mm) {
      const form = new FormData();
      form.append('chat_id', String(chatId));
      form.append('photo', new Blob([new Uint8Array(Buffer.from(mm[2], 'base64'))], { type: mm[1] }), 'avatar.jpg');
      await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendPhoto`, { method: 'POST', body: form }).catch(() => {});
      sent++;
    }
  } else if (u.avatarUrl?.startsWith('http')) {
    await sendFile(u.avatarUrl);
    sent++;
  }
  for (const id of u.photos || []) {
    await sendFile(id);
    sent++;
  }
  if (!sent) sendTelegramMessage(chatId, T.noPhotos);
  return true;
}
