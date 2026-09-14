import { ConfigurationError } from './errors.ts';

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
