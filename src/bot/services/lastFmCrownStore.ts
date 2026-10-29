import type { LoggerLike } from '../../types/core.ts';

export const CROWN_MIN_PLAYS = 30;

export interface LastFmCrown {
  guildId: string;
  artist: string;
  userId: string;
  username: string;
  playcount: number;
  claimedAt: Date;
}

export interface CrownHolder {
  userId: string;
  username: string;
  playcount: number;
}

export type CrownOutcome =
  | { status: 'none' }
  | { status: 'kept'; crown: LastFmCrown }
  | { status: 'claimed'; crown: LastFmCrown }
  | { status: 'stolen'; crown: LastFmCrown; previousUserId: string };

interface CrownDoc {
  guildId: string;
  artistKey: string;
  artist: string;
  userId: string;
  username: string;
  playcount: number;
  claimedAt: Date;
  updatedAt: Date;
}

interface CursorLike<T> {
  sort(spec: Record<string, 1 | -1>): CursorLike<T>;
  limit(count: number): CursorLike<T>;
  toArray(): Promise<T[]>;
}

interface CrownCollectionLike {
  createIndex?: (index: Record<string, number>, options?: Record<string, unknown>) => Promise<unknown> | unknown;
  findOne(filter: Record<string, unknown>): Promise<CrownDoc | null>;
  updateOne(filter: Record<string, unknown>, update: Record<string, unknown>, options?: Record<string, unknown>): Promise<unknown>;
  find(filter: Record<string, unknown>, options?: Record<string, unknown>): CursorLike<CrownDoc>;
  countDocuments(filter: Record<string, unknown>): Promise<number>;
}

function artistKey(artist: string): string {
  return artist.trim().toLowerCase();
}

function toCrown(doc: CrownDoc): LastFmCrown {
  return {
    guildId: doc.guildId,
    artist: doc.artist,
    userId: doc.userId,
    username: doc.username,
    playcount: doc.playcount,
    claimedAt: doc.claimedAt,
  };
}

export class LastFmCrownStore {
  collection: CrownCollectionLike;
  logger: LoggerLike | undefined;

  constructor(options: { collection: CrownCollectionLike; logger?: LoggerLike | undefined }) {
    this.collection = options.collection;
    this.logger = options.logger;
  }

  async init(): Promise<void> {
    await this.collection.createIndex?.({ guildId: 1, artistKey: 1 }, { unique: true });
    await this.collection.createIndex?.({ guildId: 1, userId: 1, playcount: -1 });
  }

  async get(guildId: string, artist: string): Promise<LastFmCrown | null> {
    const doc = await this.collection.findOne({ guildId, artistKey: artistKey(artist) });
    return doc ? toCrown(doc) : null;
  }

  async record(guildId: string, artist: string, holder: CrownHolder | null, now: Date = new Date()): Promise<CrownOutcome> {
    const key = artistKey(artist);
    if (!guildId || !key) return { status: 'none' };

    const existing = await this.collection.findOne({ guildId, artistKey: key });
    if (!holder || holder.playcount < CROWN_MIN_PLAYS) {
      return existing ? { status: 'kept', crown: toCrown(existing) } : { status: 'none' };
    }

    const previousUserId = existing?.userId ?? null;
    const sameHolder = previousUserId === holder.userId;
    const doc: CrownDoc = {
      guildId,
      artistKey: key,
      artist,
      userId: holder.userId,
      username: holder.username,
      playcount: holder.playcount,
      claimedAt: sameHolder && existing ? existing.claimedAt : now,
      updatedAt: now,
    };
    await this.collection.updateOne({ guildId, artistKey: key }, { $set: doc }, { upsert: true });

    const crown = toCrown(doc);
    if (!previousUserId) return { status: 'claimed', crown };
    if (sameHolder) return { status: 'kept', crown };
    return { status: 'stolen', crown, previousUserId };
  }

  async listForUser(guildId: string, userId: string, limit: number = 15): Promise<LastFmCrown[]> {
    const docs = await this.collection
      .find({ guildId, userId })
      .sort({ playcount: -1 })
      .limit(Math.max(1, limit))
      .toArray();
    return docs.map(toCrown);
  }

  async countForUser(guildId: string, userId: string): Promise<number> {
    return this.collection.countDocuments({ guildId, userId });
  }
}
