import { Schema, model, Document } from 'mongoose';

export type ActivityGoal = 'walk' | 'cafe_bar' | 'expo_cinema' | 'trip_outdoors';

export interface IUser extends Document {
  telegramId: number;
  username?: string;
  firstName: string;
  lastName?: string;
  avatarUrl: string;
  bio: string;
  goal: ActivityGoal;
  locationExact?: {
    type: 'Point';
    coordinates: [number, number]; // [lng, lat] — формат GeoJSON
  };
  locationFuzzy: {
    type: 'Point';
    coordinates: [number, number]; // [lng, lat]
  };
  areaName?: string;
  hasAgreedToRules: boolean;
  isProfileActive: boolean;
  lastActiveAt: Date;
}

const UserSchema = new Schema<IUser>(
  {
    telegramId: { type: Number, required: true, unique: true, index: true },
    username: { type: String, trim: true },
    firstName: { type: String, required: true, trim: true },
    lastName: { type: String, trim: true },
    avatarUrl: { type: String, required: true },
    bio: { type: String, maxlength: 200, default: '' },
    goal: {
      type: String,
      enum: ['walk', 'cafe_bar', 'expo_cinema', 'trip_outdoors'],
      default: 'walk',
      required: true
    },
    // Реальные точные координаты (никогда не отдаются наружу клиентам)
    locationExact: {
      type: { type: String, enum: ['Point'], default: 'Point' },
      coordinates: { type: [Number] }
    },
    // Размытые координаты (смещение 300-500м для карты)
    locationFuzzy: {
      type: { type: String, enum: ['Point'], default: 'Point' },
      coordinates: { type: [Number], required: true }
    },
    areaName: { type: String, default: 'Минск' },
    hasAgreedToRules: { type: Boolean, default: false },
    isProfileActive: { type: Boolean, default: true },
    lastActiveAt: { type: Date, default: Date.now }
  },
  { timestamps: true }
);

// Пространственный 2dsphere-индекс для быстрого поиска ближайших людей
UserSchema.index({ locationFuzzy: '2dsphere' });

export const User = model<IUser>('User', UserSchema);
