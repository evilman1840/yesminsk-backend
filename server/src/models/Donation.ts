import { Schema, model, Document } from 'mongoose';

// Донат звёздами Telegram — храним, чтобы видеть поддержку и при необходимости сделать возврат
export interface IDonation extends Document {
  telegramId: number;
  stars: number;
  chargeId: string; // telegram_payment_charge_id — нужен для возврата
  createdAt: Date;
}

const DonationSchema = new Schema<IDonation>(
  {
    telegramId: { type: Number, required: true, index: true },
    stars: { type: Number, required: true },
    chargeId: { type: String, required: true, unique: true }
  },
  { timestamps: true }
);

export const Donation = model<IDonation>('Donation', DonationSchema);
