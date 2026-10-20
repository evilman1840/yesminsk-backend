import { Schema, model, Document } from 'mongoose';

// Пост в «Новостях проекта». Автор пишет его боту командой /news (можно с фото или альбомом)
export interface INews extends Document {
  text: string;
  photos: string[];       // file_id фотографий в Telegram
  mediaGroupId?: string;  // альбом: несколько фото приходят отдельными сообщениями
  isPublished: boolean;   // альбом публикуется, когда пришла подпись с /news
  createdAt: Date;
  updatedAt: Date;
}

const NewsSchema = new Schema<INews>(
  {
    text: { type: String, default: '', maxlength: 4000 },
    photos: { type: [String], default: [] },
    mediaGroupId: { type: String, index: true },
    isPublished: { type: Boolean, default: false, index: true }
  },
  { timestamps: true }
);

export const News = model<INews>('News', NewsSchema);
