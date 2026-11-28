import { Schema, model, Types } from 'mongoose';

export interface IDirectMessageReply {
  messageId: Types.ObjectId;
  senderId: number;
  senderName: string;
  text: string;
}

export interface IDirectMessageReaction {
  emoji: string;
  userIds: number[];
}

export interface IDirectMessage {
  _id: Types.ObjectId;
  pairKey: string;
  senderId: number;
  recipientId: number;
  clientId: string;
  text: string;
  replyTo?: IDirectMessageReply;
  reactions?: IDirectMessageReaction[];
  createdAt: Date;
  expiresAt: Date;
}

const schema = new Schema<IDirectMessage>({
  pairKey: { type: String, required: true },
  senderId: { type: Number, required: true },
  recipientId: { type: Number, required: true },
  clientId: { type: String, required: true },
  text: { type: String, required: true, maxlength: 1000 },
  replyTo: {
    messageId: { type: Schema.Types.ObjectId },
    senderId: { type: Number },
    senderName: { type: String, maxlength: 80 },
    text: { type: String, maxlength: 140 }
  },
  reactions: {
    type: [
      {
        emoji: { type: String, required: true, maxlength: 16 },
        userIds: { type: [Number], default: [] }
      }
    ],
    default: []
  },
  createdAt: { type: Date, required: true },
  expiresAt: { type: Date, required: true }
});

schema.index({ pairKey: 1, _id: -1 });
schema.index({ pairKey: 1, senderId: 1, clientId: 1 }, { unique: true });
schema.index({ recipientId: 1, expiresAt: 1, createdAt: -1 });
schema.index({ senderId: 1, expiresAt: 1, createdAt: -1 });
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const DirectMessage = model<IDirectMessage>('DirectMessage', schema);
