/**
 * CoexistirTask — persisted household task rows for the Coexistir room.
 *
 * Slice-3: the Tasks tab and the front-door manager agent both read the same
 * list, so it lives server-side (Mongo) instead of localStorage: two people in
 * the room see the same tasks, and a reload never loses them.
 */

import mongoose, { Schema, Document } from 'mongoose';

export type CoexistirTaskStatus = 'open' | 'done';

export interface ICoexistirTask extends Document {
  zoneId: string;
  title: string;
  status: CoexistirTaskStatus;
  createdBy?: string;
  createdByVoiceKey?: string;
  doneAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const CoexistirTaskSchema = new Schema<ICoexistirTask>(
  {
    zoneId: { type: String, required: true, index: true },
    title: { type: String, required: true, trim: true, maxlength: 200 },
    status: { type: String, enum: ['open', 'done'], default: 'open', index: true },
    createdBy: { type: String },
    createdByVoiceKey: { type: String },
    doneAt: { type: Date },
  },
  { timestamps: true },
);

CoexistirTaskSchema.index({ zoneId: 1, status: 1, createdAt: 1 });

export const CoexistirTaskModel = mongoose.model<ICoexistirTask>(
  'CoexistirTask',
  CoexistirTaskSchema,
);
