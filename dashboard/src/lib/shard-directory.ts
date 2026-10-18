export type ShardDirectorySnapshot = {
  shardCount: number;
  endpoints: ReadonlyMap<number, string>;
};

type FetchLike = (input: string, init: { headers: Record<string, string>; cache: 'no-store'; signal: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}>;

export type ShardDirectoryOptions = {
  bootstrapUrl: string;
  secret: string;
  ttlMs?: number;
  requestTimeoutMs?: number;
  fetchImpl?: FetchLike;
  now?: () => number;
};

type ShardEntry = { shardId: number; shardCount: number; url: string; heartbeatAt: number };

const DEFAULT_TTL_MS = 10_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 3_000;

export function shardForGuild(guildId: string | null | undefined, shardCount: number): number {
  if (!Number.isInteger(shardCount) || shardCount <= 1) return 0;
  const id = String(guildId ?? '').trim();
  if (!/^\d+$/.test(id)) return 0;
  return Number((BigInt(id) >> 22n) % BigInt(shardCount));
}

function readEntries(payload: unknown): ShardEntry[] {
  if (!payload || typeof payload !== 'object' || !('shards' in payload) || !Array.isArray(payload.shards)) return [];
  const entries: ShardEntry[] = [];
  for (const raw of payload.shards) {
    if (!raw || typeof raw !== 'object') continue;
    const field = (key: string): unknown => Reflect.get(raw, key);
    const shardId = Number(field('shardId'));
    const shardCount = Number(field('shardCount'));
    const url = String(field('url') ?? '').trim().replace(/\/+$/, '');
    const heartbeatAt = Date.parse(String(field('heartbeatAt') ?? ''));
    if (!Number.isInteger(shardId) || !Number.isInteger(shardCount) || shardCount < 1 || shardId < 0 || shardId >= shardCount) continue;
    if (!/^https?:\/\//i.test(url) || !Number.isFinite(heartbeatAt)) continue;
    entries.push({ shardId, shardCount, url, heartbeatAt });
  }
  return entries;
}

export function buildShardDirectorySnapshot(payload: unknown, bootstrapUrl: string): ShardDirectorySnapshot {
  const single: ShardDirectorySnapshot = { shardCount: 1, endpoints: new Map([[0, bootstrapUrl]]) };
  const entries = readEntries(payload);
  if (!entries.length) return single;

  const newest = entries.reduce((latest, entry) => (entry.heartbeatAt > latest.heartbeatAt ? entry : latest));
  if (newest.shardCount === 1) return single;

  const endpoints = new Map<number, string>();
  for (const entry of entries) {
    if (entry.shardCount !== newest.shardCount) continue;
    const known = endpoints.get(entry.shardId);
    if (!known) endpoints.set(entry.shardId, entry.url);
  }
  return { shardCount: newest.shardCount, endpoints };
}

export class ShardDirectory {
  private readonly bootstrapUrl: string;
  private readonly secret: string;
  private readonly ttlMs: number;
  private readonly requestTimeoutMs: number;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;
  private cached: ShardDirectorySnapshot | null = null;
  private cachedAt = 0;
  private pending: Promise<ShardDirectorySnapshot> | null = null;

  constructor(options: ShardDirectoryOptions) {
    this.bootstrapUrl = options.bootstrapUrl.replace(/\/+$/, '');
    this.secret = options.secret;
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.now = options.now ?? (() => Date.now());
  }

  get bootstrap(): string {
    return this.bootstrapUrl;
  }

  async snapshot(): Promise<ShardDirectorySnapshot> {
    if (this.cached && this.now() - this.cachedAt < this.ttlMs) return this.cached;
    this.pending ??= this.refresh().finally(() => {
      this.pending = null;
    });
    return this.pending;
  }

  async urlForGuild(guildId: string | null | undefined): Promise<string | null> {
    const snapshot = await this.snapshot();
    return snapshot.endpoints.get(shardForGuild(guildId, snapshot.shardCount)) ?? null;
  }

  async allUrls(): Promise<string[]> {
    const snapshot = await this.snapshot();
    return [...snapshot.endpoints.values()];
  }

  private async refresh(): Promise<ShardDirectorySnapshot> {
    try {
      const response = await this.fetchImpl(`${this.bootstrapUrl}/api/v1/shards`, {
        headers: { authorization: `Bearer ${this.secret}` },
        cache: 'no-store',
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });
      if (!response.ok && response.status !== 404) {
        return this.cached ?? buildShardDirectorySnapshot(null, this.bootstrapUrl);
      }
      const snapshot = buildShardDirectorySnapshot(response.ok ? await response.json() : null, this.bootstrapUrl);
      this.cached = snapshot;
      this.cachedAt = this.now();
      return snapshot;
    } catch {
      return this.cached ?? buildShardDirectorySnapshot(null, this.bootstrapUrl);
    }
  }
}

let sharedDirectory: ShardDirectory | null = null;

export function getShardDirectory(): ShardDirectory | null {
  const bootstrapUrl = String(process.env.DASHBOARD_API_URL ?? 'http://127.0.0.1:9092').trim();
  const secret = String(process.env.DASHBOARD_API_SECRET ?? '').trim();
  if (!bootstrapUrl || !secret) return null;
  if (!sharedDirectory || sharedDirectory.bootstrap !== bootstrapUrl.replace(/\/+$/, '')) {
    sharedDirectory = new ShardDirectory({ bootstrapUrl, secret });
  }
  return sharedDirectory;
}
