import { Schema, model, Document } from 'mongoose';

export type ActivityGoal = 'walk' | 'cafe_bar' | 'expo_cinema' | 'trip_outdoors';
export type Gender = 'male' | 'female' | 'not_specified';
export type PreferredGender = 'all' | 'male' | 'female';

export interface IUser extends Document {
  telegramId: number;
  username?: string;
  firstName: string;
  lastName?: string;
  avatarUrl: string;
  bio: string;
  age: number;
  gender: Gender;
  preferredGender: PreferredGender;
  preferredAgeRange: {
    min: number;
    max: number;
  };
  goal: ActivityGoal;
  locationExact?: {
    type: 'Point';
    coordinates: [number, number]; // [lng, lat]
  };
  locationFuzzy: {
    type: 'Point';
    coordinates: [number, number]; // [lng, lat]
  };
  areaName?: string;
  isTourist: boolean;
  hasAgreedToRules: boolean;
  isProfileActive: boolean;
  blockedUsers: number[]; // Список telegramId заблокированных пользователей
  availableUntil?: Date;  // «⚡ Свободен сейчас» — до этого времени
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
    age: { type: Number, default: 25, min: 16, max: 99 },
    gender: {
      type: String,
      enum: ['male', 'female', 'not_specified'],
      default: 'not_specified'
    },
    preferredGender: {
      type: String,
      enum: ['all', 'male', 'female'],
      default: 'all'
    },
    preferredAgeRange: {
      min: { type: Number, default: 18, min: 16 },
      max: { type: Number, default: 99, max: 99 }
    },
    goal: {
      type: String,
      enum: ['walk', 'cafe_bar', 'expo_cinema', 'trip_outdoors'],
      default: 'walk',
      required: true
    },
    locationExact: {
      type: { type: String, enum: ['Point'], default: 'Point' },
      coordinates: { type: [Number] }
    },
    locationFuzzy: {
      type: { type: String, enum: ['Point'], default: 'Point' },
      coordinates: { type: [Number], required: true }
    },
    areaName: { type: String, default: 'Минск' },
    isTourist: { type: Boolean, default: false },
    hasAgreedToRules: { type: Boolean, default: false },
    isProfileActive: { type: Boolean, default: true },
    blockedUsers: { type: [Number], default: [] },
    availableUntil: { type: Date },
    lastActiveAt: { type: Date, default: Date.now }
  },
  { timestamps: true }
);

// Пространственный 2dsphere-индекс для гео-запросов
UserSchema.index({ locationFuzzy: '2dsphere' });
UserSchema.index({ blockedUsers: 1 });

export const User = model<IUser>('User', UserSchema);
