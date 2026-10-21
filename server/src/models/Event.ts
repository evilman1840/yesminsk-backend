import { Schema, model, Document } from 'mongoose';

export type EventCategory = 'walk' | 'cafe_bar' | 'expo_cinema' | 'trip_outdoors' | 'boardgames' | 'sport' | 'talk' | 'other';

export interface IEventParticipant {
  telegramId: number;
  name: string;
  username?: string;
  avatarUrl: string;
  joinedAt: Date;
}

export interface IEvent extends Document {
  title: string;
  description: string;
  category: EventCategory;
  customCategory?: string; // своя идея, когда category = 'other' («Караоке», «Йога»…)
  location: {
    type: 'Point';
    coordinates: [number, number]; // [lng, lat]
  };
  locationName: string;
  dateTime: Date;
  creator: {
    telegramId: number;
    name: string;
    username?: string;
    avatarUrl: string;
  };
  participants: IEventParticipant[];
  maxParticipants?: number;
  isActive: boolean;
  reminderDaySentAt?: Date;  // напоминание «завтра сходка» уже отправлено
  reminderHourSentAt?: Date; // напоминание «через час» уже отправлено
  createdAt: Date;
  updatedAt: Date;
}

const EventSchema = new Schema<IEvent>(
  {
    title: { type: String, required: true, trim: true, maxlength: 100 },
    description: { type: String, required: true, trim: true, maxlength: 600 },
    category: {
      type: String,
      enum: ['walk', 'cafe_bar', 'expo_cinema', 'trip_outdoors', 'boardgames', 'sport', 'talk', 'other'],
      default: 'walk',
      required: true
    },
    customCategory: { type: String, trim: true, maxlength: 30 },
    location: {
      type: { type: String, enum: ['Point'], default: 'Point' },
      coordinates: { type: [Number], required: true } // [lng, lat]
    },
    locationName: { type: String, required: true, trim: true },
    dateTime: { type: Date, required: true, index: true },
    creator: {
      telegramId: { type: Number, required: true, index: true },
      name: { type: String, required: true },
      username: { type: String },
      avatarUrl: { type: String, required: true }
    },
    participants: [
      {
        telegramId: { type: Number, required: true },
        name: { type: String, required: true },
        username: { type: String },
        avatarUrl: { type: String, required: true },
        joinedAt: { type: Date, default: Date.now }
      }
    ],
    maxParticipants: { type: Number, default: 0 }, // 0 = без ограничений
    isActive: { type: Boolean, default: true, index: true },
    reminderDaySentAt: { type: Date },
    reminderHourSentAt: { type: Date }
  },
  { timestamps: true }
);

// Индекс для быстрого поиска событий на карте Минска
EventSchema.index({ location: '2dsphere' });

export const Event = model<IEvent>('Event', EventSchema);
