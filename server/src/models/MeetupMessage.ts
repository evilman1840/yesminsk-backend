import { Schema, model, Types } from 'mongoose';

export interface IMeetupMessageReply {
  messageId: Types.ObjectId;
  senderId: number;
  senderName: string;
  text: string;
}

export interface IMeetupMessageReaction {
  emoji: string;
  userIds: number[];
}

export interface IMeetupMessage {
  _id: Types.ObjectId;
  eventId: Types.ObjectId;
  // Нули обозначают общий чат. Личная ветка привязана к организатору, которому написали.
  hostId: number;
  askerId: number;
  senderId: number;
  clientId: string;
  text: string;
  replyTo?: IMeetupMessageReply;
  reactions?: IMeetupMessageReaction[];
  createdAt: Date;
  expiresAt: Date;
}

const schema = new Schema<IMeetupMessage>({
  eventId: { type: Schema.Types.ObjectId, required: true },
  hostId: { type: Number, required: true },
  askerId: { type: Number, required: true },
  senderId: { type: Number, required: true },
  clientId: { type: String, required: true },
  text: { type: String, required: true, maxlength: 600 },
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

schema.index({ eventId: 1, hostId: 1, askerId: 1, _id: -1 });
schema.index({ eventId: 1, hostId: 1, askerId: 1, senderId: 1, clientId: 1 }, { unique: true });
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const MeetupMessage = model<IMeetupMessage>('MeetupMessage', schema);
