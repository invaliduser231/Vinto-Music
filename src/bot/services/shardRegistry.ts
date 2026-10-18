import { randomUUID } from 'node:crypto';
import type { ShardAssignment } from '../../core/sharding.ts';
import type { LoggerLike } from '../../types/core.ts';
import { asRecord } from '../../utils/unknownData.ts';

export interface ShardStats {
  guildCount: number;
  memberCount: number;
  uncountedGuildCount: number;
}

export interface ShardRecord {
  shardId: number;
  shardCount: number;
  dashboardUrl: string | null;
  instanceId: string;
  startedAt: Date;
  heartbeatAt: Date;
  stats: ShardStats | null;
}

export interface ShardTotals extends ShardStats {
  shardCount: number;
}

type Doc = Record<string, unknown>;

interface CursorLike {
  sort(spec: Record<string, 1 | -1>): CursorLike;
  toArray(): Promise<Doc[]>;
}

export interface ShardRegistryCollection {
  createIndex(index: Record<string, number>, options?: Doc): Promise<unknown> | unknown;
  findOne(filter: Doc): Promise<Doc | null>;
  find(filter: Doc): CursorLike;
  updateOne(filter: Doc, update: Doc, options?: Doc): Promise<unknown>;
  deleteOne(filter: Doc): Promise<unknown>;
}

export interface ShardRegistryOptions {
  collection: ShardRegistryCollection;
  assignment: ShardAssignment;
  dashboardUrl: string | null;
  stats?: (() => ShardStats | null) | undefined;
  logger?: LoggerLike | undefined;
  heartbeatIntervalMs?: number;
  staleAfterMs?: number;
  now?: () => Date;
}

const DEFAULT_HEARTBEAT_INTERVAL_MS = 10_000;
const DEFAULT_STALE_AFTER_MS = 30_000;
const EXPIRE_AFTER_SECONDS = 300;

function readCount(value: unknown): number | null {
  const count = Number(value);
  return value != null && Number.isInteger(count) && count >= 0 ? count : null;
}

function toStats(value: unknown): ShardStats | null {
  const stats = asRecord(value);
  const guildCount = readCount(stats?.guildCount);
  const memberCount = readCount(stats?.memberCount);
  const uncountedGuildCount = readCount(stats?.uncountedGuildCount);
  if (guildCount == null || memberCount == null || uncountedGuildCount == null) return null;
  return { guildCount, memberCount, uncountedGuildCount };
}

function toRecord(doc: Doc | null): ShardRecord | null {
  const record = asRecord(doc);
  if (!record) return null;
  const shardId = Number(record.shardId);
  const shardCount = Number(record.shardCount);
  const dashboardUrl = String(record.dashboardUrl ?? '').trim() || null;
  if (!Number.isInteger(shardId) || !Number.isInteger(shardCount) || shardCount < 1) return null;
  if (!(record.heartbeatAt instanceof Date)) return null;
  return {
    shardId,
    shardCount,
    dashboardUrl,
    instanceId: String(record.instanceId ?? ''),
    startedAt: record.startedAt instanceof Date ? record.startedAt : record.heartbeatAt,
    heartbeatAt: record.heartbeatAt,
    stats: toStats(record.stats),
  };
}

export class ShardRegistry {
  readonly instanceId: string;
  private readonly collection: ShardRegistryCollection;
  private readonly assignment: ShardAssignment;
  private readonly dashboardUrl: string | null;
  private readonly stats: (() => ShardStats | null) | undefined;
  private readonly logger: LoggerLike | undefined;
  private readonly heartbeatIntervalMs: number;
  private readonly staleAfterMs: number;
  private readonly now: () => Date;
  private readonly startedAt: Date;
  private heartbeatHandle: NodeJS.Timeout | null = null;
  private hasWritten = false;
  private reportedConflictInstanceId: string | null = null;

  constructor(options: ShardRegistryOptions) {
    this.instanceId = randomUUID();
    this.collection = options.collection;
    this.assignment = options.assignment;
    this.dashboardUrl = options.dashboardUrl;
    this.stats = options.stats;
    this.logger = options.logger;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    this.staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
    this.now = options.now ?? (() => new Date());
    this.startedAt = this.now();
  }

  async init(): Promise<void> {
    await this.collection.createIndex({ heartbeatAt: 1 }, { expireAfterSeconds: EXPIRE_AFTER_SECONDS });
  }

  start(): void {
    if (this.heartbeatHandle) return;
    this.heartbeat().catch((err: unknown) => this.logHeartbeatFailure(err));
    this.heartbeatHandle = setInterval(() => {
      this.heartbeat().catch((err: unknown) => this.logHeartbeatFailure(err));
    }, this.heartbeatIntervalMs);
    this.heartbeatHandle.unref?.();
  }

  async stop(): Promise<void> {
    if (this.heartbeatHandle) {
      clearInterval(this.heartbeatHandle);
      this.heartbeatHandle = null;
    }
    await this.collection.deleteOne({ _id: this.assignment.shardId, instanceId: this.instanceId });
  }

  async heartbeat(): Promise<void> {
    const now = this.now();
    const existing = toRecord(await this.collection.findOne({ _id: this.assignment.shardId }));
    if (this.hasWritten && existing && existing.instanceId !== this.instanceId && this.isFresh(existing, now)) {
      this.reportConflict(existing);
    }

    await this.collection.updateOne(
      { _id: this.assignment.shardId },
      {
        $set: {
          shardId: this.assignment.shardId,
          shardCount: this.assignment.shardCount,
          dashboardUrl: this.dashboardUrl,
          instanceId: this.instanceId,
          startedAt: this.startedAt,
          heartbeatAt: now,
          stats: this.stats?.() ?? null,
        },
      },
      { upsert: true },
    );
    this.hasWritten = true;
  }

  async list(): Promise<ShardRecord[]> {
    const freshSince = new Date(this.now().getTime() - this.staleAfterMs);
    const docs = await this.collection.find({ heartbeatAt: { $gte: freshSince } }).sort({ shardId: 1 }).toArray();
    return docs.map((doc) => toRecord(doc)).filter((record): record is ShardRecord => record !== null);
  }

  async totals(): Promise<ShardTotals | null> {
    const { shardCount } = this.assignment;
    const statsByShard = new Map<number, ShardStats>();
    for (const record of await this.list()) {
      if (record.shardCount === shardCount && record.stats) statsByShard.set(record.shardId, record.stats);
    }
    if (statsByShard.size !== shardCount) return null;

    const totals: ShardTotals = { shardCount, guildCount: 0, memberCount: 0, uncountedGuildCount: 0 };
    for (const stats of statsByShard.values()) {
      totals.guildCount += stats.guildCount;
      totals.memberCount += stats.memberCount;
      totals.uncountedGuildCount += stats.uncountedGuildCount;
    }
    return totals;
  }

  private isFresh(record: ShardRecord, now: Date): boolean {
    return now.getTime() - record.heartbeatAt.getTime() < this.staleAfterMs;
  }

  private reportConflict(existing: ShardRecord): void {
    if (this.reportedConflictInstanceId === existing.instanceId) return;
    this.reportedConflictInstanceId = existing.instanceId;
    this.logger?.error?.('Another process is running with the same shard id', {
      shardId: this.assignment.shardId,
      shardCount: this.assignment.shardCount,
      otherDashboardUrl: existing.dashboardUrl,
      otherStartedAt: existing.startedAt.toISOString(),
    });
  }

  private logHeartbeatFailure(err: unknown): void {
    this.logger?.warn?.('Shard registry heartbeat failed', {
      shardId: this.assignment.shardId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
