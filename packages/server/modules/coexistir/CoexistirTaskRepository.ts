/**
 * CoexistirTaskRepository — sole Mongo access point for household tasks.
 *
 * Mirrors AgentRepository's shape: routes never touch the model directly, and
 * tests can pass a fake repository into the route factory.
 */

import mongoose from 'mongoose';
import { CoexistirTaskModel, ICoexistirTask, CoexistirTaskStatus } from '../../models/CoexistirTask';

export const COEXISTIR_TASK_ZONE = 'coexistir';
const MAX_TITLE_LENGTH = 200;

export interface CoexistirTaskView {
  id: string;
  title: string;
  status: CoexistirTaskStatus;
  createdBy?: string;
  createdAt: string;
  doneAt?: string;
}

export interface CreateCoexistirTaskData {
  title: string;
  createdBy?: string;
  createdByVoiceKey?: string;
  zoneId?: string;
}

export interface TaskRepositoryLike {
  list(zoneId?: string): Promise<CoexistirTaskView[]>;
  create(data: CreateCoexistirTaskData): Promise<CoexistirTaskView>;
  setStatus(id: string, status: CoexistirTaskStatus, zoneId?: string): Promise<CoexistirTaskView | null>;
  /** Optional: remove one task (used by the delete route and e2e hygiene). */
  remove?(id: string, zoneId?: string): Promise<boolean>;
  /** Test/e2e hygiene: remove every task in a zone. */
  clear(zoneId?: string): Promise<number>;
}

/** Normalise a raw title: trim + collapse whitespace, reject empties. */
export function normaliseTaskTitle(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const title = raw.replace(/\s+/g, ' ').trim();
  if (!title) return null;
  return title.slice(0, MAX_TITLE_LENGTH);
}

export function toTaskView(doc: ICoexistirTask): CoexistirTaskView {
  return {
    id: String(doc._id),
    title: doc.title,
    status: doc.status,
    createdBy: doc.createdBy,
    createdAt: doc.createdAt instanceof Date ? doc.createdAt.toISOString() : String(doc.createdAt),
    doneAt: doc.doneAt instanceof Date ? doc.doneAt.toISOString() : undefined,
  };
}

export class CoexistirTaskRepository implements TaskRepositoryLike {
  async list(zoneId: string = COEXISTIR_TASK_ZONE): Promise<CoexistirTaskView[]> {
    const docs = await CoexistirTaskModel.find({ zoneId })
      .sort({ status: 1, createdAt: 1 })
      .exec();
    return docs.map(toTaskView);
  }

  async create(data: CreateCoexistirTaskData): Promise<CoexistirTaskView> {
    const title = normaliseTaskTitle(data.title);
    if (!title) throw new Error('Task title is required');
    const doc = await CoexistirTaskModel.create({
      zoneId: data.zoneId ?? COEXISTIR_TASK_ZONE,
      title,
      status: 'open',
      createdBy: data.createdBy,
      createdByVoiceKey: data.createdByVoiceKey,
    });
    return toTaskView(doc);
  }

  async setStatus(
    id: string,
    status: CoexistirTaskStatus,
    zoneId: string = COEXISTIR_TASK_ZONE,
  ): Promise<CoexistirTaskView | null> {
    if (!mongoose.Types.ObjectId.isValid(id)) return null;
    const update: Record<string, unknown> =
      status === 'done'
        ? { $set: { status, doneAt: new Date() } }
        : { $set: { status }, $unset: { doneAt: 1 } };
    const doc = await CoexistirTaskModel.findOneAndUpdate({ _id: id, zoneId }, update, {
      new: true,
    }).exec();
    return doc ? toTaskView(doc) : null;
  }

  async remove(id: string, zoneId: string = COEXISTIR_TASK_ZONE): Promise<boolean> {
    if (!mongoose.Types.ObjectId.isValid(id)) return false;
    const result = await CoexistirTaskModel.deleteOne({ _id: id, zoneId }).exec();
    return (result.deletedCount ?? 0) > 0;
  }

  async clear(zoneId: string = COEXISTIR_TASK_ZONE): Promise<number> {
    const result = await CoexistirTaskModel.deleteMany({ zoneId }).exec();
    return result.deletedCount ?? 0;
  }
}
