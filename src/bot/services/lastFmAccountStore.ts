import { openSecret, sealSecret, type SealedSecret } from '../../integrations/lastfm/secretBox.ts';
import type { LastFmScrobbleEntry } from '../../integrations/lastfm/LastFmClient.ts';
import type { LoggerLike } from '../../types/core.ts';

const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_MAX_SIZE = 5_000;
const RETRY_TTL_SECONDS = 14 * 24 * 60 * 60;
const MAX_RETRY_ATTEMPTS = 5;

export interface LastFmAccount {
  userId: string;
  username: string;
  scrobblingEnabled: boolean;
  scrobbleCount: number;
  lovedCount: number;
  streakDays: number;
  streakLastDay: string | null;
  lastScrobbleAt: Date | null;
  connectedAt: Date | null;
}

export interface LastFmScrobbleRecordResult {
  scrobbleCount: number;
  streakDays: number;
  streakExtended: boolean;
}

export interface LastFmLeaderboardEntry {
  userId: string;
  username: string;
  scrobbleCount: number;
}

interface AccountDoc {
  userId: string;
  username?: string | null;
  sessionKey?: SealedSecret | null;
  scrobblingEnabled?: boolean;
  scrobbleCount?: number;
  lovedCount?: number;
  streakDays?: number;
  streakLastDay?: string | null;
  lastScrobbleAt?: Date | null;
  connectedAt?: Date | null;
  updatedAt?: Date | null;
  [key: string]: unknown;
}

interface RetryDoc {
  userId: string;
  entry: LastFmScrobbleEntry;
  attempts: number;
  queuedAt: Date;
  nextAttemptAt: Date;
  [key: string]: unknown;
}

interface CursorLike<T> {
  sort(spec: Record<string, 1 | -1>): CursorLike<T>;
  limit(count: number): CursorLike<T>;
  toArray(): Promise<T[]>;
}

interface CollectionLike<T> {
  createIndex?: (index: Record<string, number>, options?: Record<string, unknown>) => Promise<unknown> | unknown;
  findOne(filter: Record<string, unknown>, options?: Record<string, unknown>): Promise<T | null>;
  updateOne(
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
    options?: Record<string, unknown>,
  ): Promise<unknown>;
  deleteOne?: (filter: Record<string, unknown>) => Promise<unknown>;
  deleteMany?: (filter: Record<string, unknown>) => Promise<unknown>;
  insertOne?: (document: T) => Promise<unknown>;
  find?: (filter: Record<string, unknown>, options?: Record<string, unknown>) => CursorLike<T>;
  countDocuments?: (filter: Record<string, unknown>) => Promise<number>;
}

interface LastFmAccountStoreOptions {
  collection: CollectionLike<AccountDoc>;
  retryCollection?: CollectionLike<RetryDoc> | null;
  encryptionKey: Buffer;
  logger?: LoggerLike | undefined;
  cacheTtlMs?: number;
  maxCacheSize?: number;
}

function normalizeUserId(value: unknown): string | null {
  const normalized = String(value ?? '').trim();
  return /^\d{6,}$/.test(normalized) ? normalized : null;
}

function toDateOrNull(value: unknown): Date | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date;
}

function toCount(value: unknown): number {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

export function toDayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function previousDayKey(dayKey: string): string {
  const parsed = new Date(`${dayKey}T00:00:00.000Z`);
  parsed.setUTCDate(parsed.getUTCDate() - 1);
  return toDayKey(parsed);
}

export class LastFmAccountStore {
  collection: CollectionLike<AccountDoc>;
  retryCollection: CollectionLike<RetryDoc> | null;
  logger: LoggerLike | undefined;
  cacheTtlMs: number;
  maxCacheSize: number;
  private encryptionKey: Buffer;
  private cache: Map<string, { value: LastFmAccount | null; expiresAt: number }>;

  constructor(options: LastFmAccountStoreOptions) {
    this.collection = options.collection;
    this.retryCollection = options.retryCollection ?? null;
    this.encryptionKey = options.encryptionKey;
    this.logger = options.logger ?? undefined;
    this.cacheTtlMs = options.cacheTtlMs ?? CACHE_TTL_MS;
    this.maxCacheSize = options.maxCacheSize ?? CACHE_MAX_SIZE;
    this.cache = new Map();
  }

  async init(): Promise<void> {
    await this.collection.createIndex?.({ userId: 1 }, { unique: true });
    await this.collection.createIndex?.({ scrobbleCount: -1 });
    await this.collection.createIndex?.({ lastScrobbleAt: -1 });

    if (this.retryCollection) {
      await this.retryCollection.createIndex?.({ userId: 1 });
      await this.retryCollection.createIndex?.({ nextAttemptAt: 1 });
      await this.retryCollection.createIndex?.({ queuedAt: 1 }, { expireAfterSeconds: RETRY_TTL_SECONDS });
    }

    this.logger?.info?.('Last.fm account store ready');
  }

  async get(userId: unknown): Promise<LastFmAccount | null> {
    const key = normalizeUserId(userId);
    if (!key) return null;

    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.value;

    let doc: AccountDoc | null = null;
    try {
      doc = await this.collection.findOne({ userId: key });
    } catch (err) {
      this.logger?.warn?.('Failed to read Last.fm account', {
        userId: key,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }

    const account = this._toAccount(doc);
    this._setCached(key, account);
    return account;
  }

  async getSessionKey(userId: unknown): Promise<string | null> {
    const key = normalizeUserId(userId);
    if (!key) return null;

    const doc = await this.collection.findOne({ userId: key }).catch(() => null);
    if (!doc?.sessionKey) return null;
    return openSecret(doc.sessionKey, this.encryptionKey);
  }

  async link(userId: unknown, username: string, sessionKey: string): Promise<LastFmAccount | null> {
    const key = normalizeUserId(userId);
    if (!key) return null;

    const now = new Date();
    await this.collection.updateOne(
      { userId: key },
      {
        $setOnInsert: {
          userId: key,
          scrobbleCount: 0,
          lovedCount: 0,
          streakDays: 0,
          streakLastDay: null,
          lastScrobbleAt: null,
          connectedAt: now,
        },
        $set: {
          username: String(username).trim(),
          sessionKey: sealSecret(sessionKey, this.encryptionKey),
          scrobblingEnabled: true,
          updatedAt: now,
        },
      },
      { upsert: true },
    );

    this.cache.delete(key);
    return this.get(key);
  }

  async unlink(userId: unknown): Promise<boolean> {
    const key = normalizeUserId(userId);
    if (!key) return false;

    this.cache.delete(key);
    if (this.retryCollection?.deleteMany) {
      await this.retryCollection.deleteMany({ userId: key }).catch(() => null);
    }

    const result = await this.collection.deleteOne?.({ userId: key }).catch(() => null);
    const deleted = Number((result as { deletedCount?: number } | null)?.deletedCount ?? 0);
    return deleted > 0;
  }

  async setScrobblingEnabled(userId: unknown, enabled: boolean): Promise<LastFmAccount | null> {
    const key = normalizeUserId(userId);
    if (!key) return null;

    await this.collection.updateOne(
      { userId: key },
      { $set: { scrobblingEnabled: Boolean(enabled), updatedAt: new Date() } },
    );

    this.cache.delete(key);
    return this.get(key);
  }

  async recordScrobble(userId: unknown, at: Date = new Date()): Promise<LastFmScrobbleRecordResult | null> {
    const key = normalizeUserId(userId);
    if (!key) return null;

    const current = await this.get(key);
    if (!current) return null;

    const dayKey = toDayKey(at);
    const sameDay = current.streakLastDay === dayKey;
    const continuesStreak = current.streakLastDay === previousDayKey(dayKey);
    const streakDays = sameDay
      ? Math.max(1, current.streakDays)
      : continuesStreak
        ? current.streakDays + 1
        : 1;

    await this.collection.updateOne(
      { userId: key },
      {
        $inc: { scrobbleCount: 1 },
        $set: {
          lastScrobbleAt: at,
          streakDays,
          streakLastDay: dayKey,
          updatedAt: at,
        },
      },
    );

    const scrobbleCount = current.scrobbleCount + 1;
    this._setCached(key, {
      ...current,
      scrobbleCount,
      streakDays,
      streakLastDay: dayKey,
      lastScrobbleAt: at,
    });

    return { scrobbleCount, streakDays, streakExtended: !sameDay };
  }

  async recordLove(userId: unknown, delta: number = 1): Promise<void> {
    const key = normalizeUserId(userId);
    if (!key) return;

    await this.collection.updateOne(
      { userId: key },
      { $inc: { lovedCount: delta }, $set: { updatedAt: new Date() } },
    );
    this.cache.delete(key);
  }

  async listTop(limit: number = 10, userIds: string[] | null = null): Promise<LastFmLeaderboardEntry[]> {
    if (!this.collection.find) return [];

    const filter: Record<string, unknown> = { scrobbleCount: { $gt: 0 } };
    if (userIds) {
      const allowed = userIds.map((id) => normalizeUserId(id)).filter((id): id is string => Boolean(id));
      if (!allowed.length) return [];
      filter.userId = { $in: allowed };
    }

    const docs = await this.collection
      .find(filter, { projection: { _id: 0, userId: 1, username: 1, scrobbleCount: 1 } })
      .sort({ scrobbleCount: -1 })
      .limit(Math.max(1, Math.min(50, limit)))
      .toArray()
      .catch(() => [] as AccountDoc[]);

    return docs.map((doc) => ({
      userId: String(doc.userId),
      username: String(doc.username ?? '').trim() || String(doc.userId),
      scrobbleCount: toCount(doc.scrobbleCount),
    }));
  }

  async countLinked(): Promise<number> {
    if (!this.collection.countDocuments) return 0;
    return this.collection.countDocuments({}).catch(() => 0);
  }

  async queueRetry(userId: unknown, entry: LastFmScrobbleEntry): Promise<void> {
    const key = normalizeUserId(userId);
    if (!key || !this.retryCollection?.insertOne) return;

    const now = new Date();
    await this.retryCollection.insertOne({
      userId: key,
      entry,
      attempts: 0,
      queuedAt: now,
      nextAttemptAt: new Date(now.getTime() + 5 * 60_000),
    }).catch((err: unknown) => {
      this.logger?.debug?.('Failed to queue Last.fm scrobble retry', {
        userId: key,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  async listDueRetries(limit: number = 50): Promise<Array<RetryDoc & { _id?: unknown }>> {
    if (!this.retryCollection?.find) return [];

    return this.retryCollection
      .find({ nextAttemptAt: { $lte: new Date() } })
      .sort({ nextAttemptAt: 1 })
      .limit(Math.max(1, Math.min(200, limit)))
      .toArray()
      .catch(() => [] as RetryDoc[]);
  }

  async resolveRetry(retry: RetryDoc & { _id?: unknown }, succeeded: boolean): Promise<void> {
    if (!this.retryCollection) return;

    const filter = retry._id != null
      ? { _id: retry._id }
      : { userId: retry.userId, 'entry.timestamp': retry.entry?.timestamp };

    if (succeeded || Number(retry.attempts ?? 0) + 1 >= MAX_RETRY_ATTEMPTS) {
      await this.retryCollection.deleteOne?.(filter).catch(() => null);
      return;
    }

    const attempts = Number(retry.attempts ?? 0) + 1;
    await this.retryCollection.updateOne(
      filter,
      {
        $set: {
          attempts,
          nextAttemptAt: new Date(Date.now() + attempts * 15 * 60_000),
        },
      },
    ).catch(() => null);
  }

  _toAccount(doc: AccountDoc | null | undefined): LastFmAccount | null {
    if (!doc?.userId || !doc.sessionKey) return null;

    return {
      userId: String(doc.userId),
      username: String(doc.username ?? '').trim(),
      scrobblingEnabled: doc.scrobblingEnabled !== false,
      scrobbleCount: toCount(doc.scrobbleCount),
      lovedCount: toCount(doc.lovedCount),
      streakDays: toCount(doc.streakDays),
      streakLastDay: doc.streakLastDay ? String(doc.streakLastDay) : null,
      lastScrobbleAt: toDateOrNull(doc.lastScrobbleAt),
      connectedAt: toDateOrNull(doc.connectedAt),
    };
  }

  _setCached(userId: string, value: LastFmAccount | null): void {
    this.cache.delete(userId);
    this.cache.set(userId, { value, expiresAt: Date.now() + this.cacheTtlMs });

    while (this.cache.size > this.maxCacheSize) {
      const oldest = this.cache.keys().next().value as string | undefined;
      if (!oldest) break;
      this.cache.delete(oldest);
    }
  }

  invalidate(userId: unknown): void {
    const key = normalizeUserId(userId);
    if (key) this.cache.delete(key);
  }
}
