import type { LoggerLike } from '../../types/core.ts';

interface CommandRateLimiterOptions {
  logger?: LoggerLike | undefined;
  enabled?: boolean;
  userWindowMs?: number;
  userMaxCommands?: number;
  guildWindowMs?: number;
  guildMaxCommands?: number;
  cleanupIntervalMs?: number;
  bypassCommands?: string[];
}

interface CommandRateLimiterInput {
  commandName?: string | null;
  guildId?: string | null;
  userId?: string | null;
}

interface ConsumeBucketInput {
  map: Map<string, number[]>;
  key: string | null;
  now: number;
  windowMs: number;
  limit: number;
}

interface ConsumeBucketResult {
  allowed: boolean;
  retryAfterMs?: number | undefined;
}

export class CommandRateLimiter {
  logger: LoggerLike | undefined;
  enabled: boolean;
  userWindowMs: number;
  userMaxCommands: number;
  guildWindowMs: number;
  guildMaxCommands: number;
  cleanupIntervalMs: number;
  bypassCommands: Set<string>;
  userBuckets: Map<string, number[]>;
  guildBuckets: Map<string, number[]>;
  lastCleanupAt: number;

  constructor(options: CommandRateLimiterOptions = {}) {
    this.logger = options.logger ?? undefined;
    this.enabled = options.enabled !== false;
    this.userWindowMs = options.userWindowMs ?? 10_000;
    this.userMaxCommands = options.userMaxCommands ?? 8;
    this.guildWindowMs = options.guildWindowMs ?? 10_000;
    this.guildMaxCommands = options.guildMaxCommands ?? 40;
    this.cleanupIntervalMs = options.cleanupIntervalMs ?? 60_000;
    this.bypassCommands = new Set(
      (options.bypassCommands ?? [])
        .map((name) => String(name ?? '').trim().toLowerCase())
        .filter(Boolean)
    );

    this.userBuckets = new Map();
    this.guildBuckets = new Map();
    this.lastCleanupAt = 0;
  }

  consume(input: CommandRateLimiterInput = {}): ConsumeBucketResult & { scope?: 'guild' | 'user' } {
    if (!this.enabled) return { allowed: true };

    const commandName = String(input.commandName ?? '').trim().toLowerCase();
    if (this.bypassCommands.has(commandName)) {
      return { allowed: true };
    }

    const now = Date.now();
    this._cleanup(now);

    const guildId = input.guildId ? String(input.guildId) : null;
    const userId = input.userId ? String(input.userId) : null;

    if (guildId) {
      const guildCheck = this._consumeBucket({
        map: this.guildBuckets,
        key: guildId,
        now,
        windowMs: this.guildWindowMs,
        limit: this.guildMaxCommands,
      });
      if (!guildCheck.allowed) {
        return {
          allowed: false,
          scope: 'guild',
          retryAfterMs: guildCheck.retryAfterMs,
        };
      }
    }

    if (guildId && userId) {
      const key = `${guildId}:${userId}`;
      const userCheck = this._consumeBucket({
        map: this.userBuckets,
        key,
        now,
        windowMs: this.userWindowMs,
        limit: this.userMaxCommands,
      });
      if (!userCheck.allowed) {
        return {
          allowed: false,
          scope: 'user',
          retryAfterMs: userCheck.retryAfterMs,
        };
      }
    }

    return { allowed: true };
  }

  _consumeBucket({ map, key, now, windowMs, limit }: ConsumeBucketInput): ConsumeBucketResult {
    if (!key || limit <= 0 || windowMs <= 0) {
      return { allowed: true };
    }

    const bucket = map.get(key) ?? [];
    const cutoff = now - windowMs;
    const next = bucket.filter((ts: number) => ts > cutoff);

    if (next.length >= limit) {
      const oldestInWindow = next[0] ?? now;
      const retryAfterMs = Math.max(100, windowMs - (now - oldestInWindow));
      map.set(key, next);
      return { allowed: false, retryAfterMs };
    }

    next.push(now);
    map.set(key, next);
    return { allowed: true };
  }

  _cleanup(now: number): void {
    if (now - this.lastCleanupAt < this.cleanupIntervalMs) return;
    this.lastCleanupAt = now;

    this._cleanupMap(this.userBuckets, now - this.userWindowMs);
    this._cleanupMap(this.guildBuckets, now - this.guildWindowMs);
  }

  _cleanupMap(map: Map<string, number[]>, cutoff: number): void {
    for (const [key, list] of map.entries()) {
      const next = list.filter((ts: number) => ts > cutoff);
      if (next.length) {
        map.set(key, next);
      } else {
        map.delete(key);
      }
    }
  }
}




