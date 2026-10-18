import { randomUUID } from 'node:crypto';
import type { ShardAssignment } from '../../core/sharding.ts';
import type { LoggerLike } from '../../types/core.ts';
import { asRecord } from '../../utils/unknownData.ts';

export interface ShardRecord {
  shardId: number;
  shardCount: number;
  dashboardUrl: string;
  instanceId: string;
  startedAt: Date;
  heartbeatAt: Date;
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
  dashboardUrl: string;
  logger?: LoggerLike | undefined;
  heartbeatIntervalMs?: number;
  staleAfterMs?: number;
  now?: () => Date;
}

const DEFAULT_HEARTBEAT_INTERVAL_MS = 10_000;
const DEFAULT_STALE_AFTER_MS = 30_000;
const EXPIRE_AFTER_SECONDS = 300;

function toRecord(doc: Doc | null): ShardRecord | null {
  const record = asRecord(doc);
  if (!record) return null;
  const shardId = Number(record.shardId);
  const shardCount = Number(record.shardCount);
  const dashboardUrl = String(record.dashboardUrl ?? '').trim();
  if (!Number.isInteger(shardId) || !Number.isInteger(shardCount) || shardCount < 1 || !dashboardUrl) return null;
  if (!(record.heartbeatAt instanceof Date)) return null;
  return {
    shardId,
    shardCount,
    dashboardUrl,
    instanceId: String(record.instanceId ?? ''),
    startedAt: record.startedAt instanceof Date ? record.startedAt : record.heartbeatAt,
    heartbeatAt: record.heartbeatAt,
  };
}

export class ShardRegistry {
  readonly instanceId: string;
  private readonly collection: ShardRegistryCollection;
  private readonly assignment: ShardAssignment;
  private readonly dashboardUrl: string;
  private readonly logger: LoggerLike | undefined;
  private readonly heartbeatIntervalMs: number;
  private readonly staleAfterMs: number;
  private readonly now: () => Date;
  private readonly startedAt: Date;
  private heartbeatHandle: NodeJS.Timeout | null = null;
  private reportedConflictInstanceId: string | null = null;

  constructor(options: ShardRegistryOptions) {
    this.instanceId = randomUUID();
    this.collection = options.collection;
    this.assignment = options.assignment;
    this.dashboardUrl = options.dashboardUrl;
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
    if (existing && existing.instanceId !== this.instanceId && this.isFresh(existing, now)) {
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
        },
      },
      { upsert: true },
    );
  }

  async list(): Promise<ShardRecord[]> {
    const freshSince = new Date(this.now().getTime() - this.staleAfterMs);
    const docs = await this.collection.find({ heartbeatAt: { $gte: freshSince } }).sort({ shardId: 1 }).toArray();
    return docs.map((doc) => toRecord(doc)).filter((record): record is ShardRecord => record !== null);
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
