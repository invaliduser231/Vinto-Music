import { ConfigurationError } from './errors.ts';
import { asRecord } from '../utils/unknownData.ts';

export type ShardAssignment = {
  shardId: number;
  shardCount: number;
};

export function parseShardAssignment(shardId: unknown, shardCount: unknown): ShardAssignment {
  const count = Number.parseInt(String(shardCount ?? 1), 10);
  const id = Number.parseInt(String(shardId ?? 0), 10);

  if (!Number.isFinite(count) || count < 1) {
    throw new ConfigurationError('SHARD_COUNT must be a positive integer');
  }
  if (!Number.isFinite(id) || id < 0) {
    throw new ConfigurationError('SHARD_ID must be zero or a positive integer');
  }
  if (id >= count) {
    throw new ConfigurationError(`SHARD_ID must be lower than SHARD_COUNT (got ${id} of ${count})`);
  }

  return { shardId: id, shardCount: count };
}

export function shardForGuild(guildId: unknown, shardCount: number): number | null {
  const raw = String(guildId ?? '').trim();
  if (!/^\d+$/.test(raw)) return null;
  if (!Number.isFinite(shardCount) || shardCount < 1) return null;

  try {
    return Number((BigInt(raw) >> 22n) % BigInt(shardCount));
  } catch {
    return null;
  }
}

export function guildBelongsToShard(guildId: unknown, assignment: ShardAssignment): boolean {
  if (assignment.shardCount <= 1) return true;

  const owner = shardForGuild(guildId, assignment.shardCount);
  if (owner == null) return true;
  return owner === assignment.shardId;
}

export function isPrimaryShard(assignment: ShardAssignment): boolean {
  return assignment.shardId === 0;
}

export function shardAssignmentFromConfig(
  config: { shardId?: unknown; shardCount?: unknown } | null | undefined,
): ShardAssignment {
  const shardCount = Math.max(1, Number.parseInt(String(config?.shardCount ?? 1), 10) || 1);
  const shardId = Math.max(0, Math.min(shardCount - 1, Number.parseInt(String(config?.shardId ?? 0), 10) || 0));
  return { shardId, shardCount };
}

const EVENTS_NAMING_GUILD_AS_ID = new Set(['GUILD_CREATE', 'GUILD_UPDATE', 'GUILD_DELETE', 'GUILD_SYNC']);
const SESSION_LIFECYCLE_EVENTS = new Set(['READY', 'RESUMED']);

export function dispatchGuildId(eventName: string, data: unknown): string | null {
  const record = asRecord(data);
  if (!record) return null;
  const candidate = record.guild_id ?? (EVENTS_NAMING_GUILD_AS_ID.has(eventName) ? record.id : null);
  const guildId = String(candidate ?? '').trim();
  return guildId || null;
}

export function shouldDeliverDispatch(eventName: string, data: unknown, assignment: ShardAssignment): boolean {
  if (assignment.shardCount <= 1) return true;
  if (SESSION_LIFECYCLE_EVENTS.has(eventName)) return true;

  const guildId = dispatchGuildId(eventName, data);
  if (guildId) return guildBelongsToShard(guildId, assignment);
  return isPrimaryShard(assignment);
}
