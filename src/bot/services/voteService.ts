import type { LoggerLike } from '../../types/core.ts';
import type { VoterStore } from './voterStore.ts';

const VOTER_ID_PATTERN = /"fluxerId"\s*:\s*"?(\d+)"?/g;
const MAX_TRACKED_CHECKS = 10_000;

export interface VoteServiceOptions {
  apiBase: string;
  apiKey: string | null;
  botId: string | null;
  logger?: LoggerLike | undefined;
  refreshIntervalMs?: number;
  requestTimeoutMs?: number;
  pageLimit?: number;
  maxPages?: number;
  pollApi?: boolean;
  store?: VoterStore | null;
  storeSyncIntervalMs?: number;
  checkCooldownMs?: number;
}

export class VoteService {
  apiBase: string;
  apiKey: string | null;
  botId: string | null;
  logger: LoggerLike | undefined;
  refreshIntervalMs: number;
  requestTimeoutMs: number;
  pageLimit: number;
  maxPages: number;
  pollApi: boolean;
  store: VoterStore | null;
  storeSyncIntervalMs: number;
  checkCooldownMs: number;

  voterIds: Set<string>;
  storeSyncedUntil: Date | null;
  lastCheckAt: Map<string, number>;
  lastRefreshAt: number | null;
  lastErrorAt: number | null;
  lastError: string | null;
  totalReported: number | null;
  refreshHandle: NodeJS.Timeout | null;
  inFlight: Promise<boolean> | null;

  constructor(options: VoteServiceOptions) {
    this.apiBase = String(options.apiBase ?? '').replace(/\/+$/, '');
    this.apiKey = options.apiKey ?? null;
    this.botId = options.botId ? String(options.botId) : null;
    this.logger = options.logger;
    this.refreshIntervalMs = options.refreshIntervalMs ?? 10 * 60 * 1000;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
    this.pageLimit = Math.min(100, Math.max(1, options.pageLimit ?? 100));
    this.maxPages = Math.max(1, options.maxPages ?? 100);
    this.pollApi = options.pollApi ?? true;
    this.store = options.store ?? null;
    this.storeSyncIntervalMs = options.storeSyncIntervalMs ?? 5 * 60 * 1000;
    this.checkCooldownMs = options.checkCooldownMs ?? 10 * 60 * 1000;

    this.voterIds = new Set();
    this.storeSyncedUntil = null;
    this.lastCheckAt = new Map();
    this.lastRefreshAt = null;
    this.lastErrorAt = null;
    this.lastError = null;
    this.totalReported = null;
    this.refreshHandle = null;
    this.inFlight = null;
  }

  get enabled(): boolean {
    return Boolean(this.apiKey && this.botId);
  }

  get ready(): boolean {
    return this.lastRefreshAt != null;
  }

  setBotId(botId: unknown): void {
    const next = botId ? String(botId) : null;
    if (next && next !== this.botId) {
      this.botId = next;
    }
  }

  hasVoted(userId: unknown): boolean {
    const safeUserId = String(userId ?? '').trim();
    if (!safeUserId) return false;
    return this.voterIds.has(safeUserId);
  }

  async checkVote(userId: unknown): Promise<boolean> {
    const safeUserId = String(userId ?? '').trim();
    if (!safeUserId) return false;
    if (this.hasVoted(safeUserId)) return true;
    if (!this.enabled) return false;

    const now = Date.now();
    const lastCheckAt = this.lastCheckAt.get(safeUserId);
    if (lastCheckAt != null && now - lastCheckAt < this.checkCooldownMs) return false;
    this._rememberCheck(safeUserId, now);

    try {
      if (!await this._fetchVoteCheck(safeUserId)) return false;
    } catch (err) {
      this.logger?.warn?.('Vote check failed', { error: err instanceof Error ? err.message : String(err) });
      return false;
    }

    await this._addVoters([safeUserId]);
    return true;
  }

  start(): void {
    if (!this.enabled || this.refreshHandle) return;

    void this.refresh();
    const intervalMs = this.pollApi || !this.store ? this.refreshIntervalMs : this.storeSyncIntervalMs;
    this.refreshHandle = setInterval(() => {
      void this.refresh();
    }, intervalMs);
    this.refreshHandle.unref?.();
  }

  stop(): void {
    if (!this.refreshHandle) return;
    clearInterval(this.refreshHandle);
    this.refreshHandle = null;
  }

  async refresh(): Promise<boolean> {
    if (!this.enabled) return false;
    if (this.inFlight) return this.inFlight;

    this.inFlight = this._refreshUncached().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  async _refreshUncached(): Promise<boolean> {
    if (this.store) {
      const synced = await this._syncFromStore();
      if (!this.pollApi) return synced;
    }

    const discovered = new Set<string>();
    let total: number | null = null;
    const hadKnownVoters = this.voterIds.size > 0;

    try {
      for (let page = 1; page <= this.maxPages; page += 1) {
        const payload = await this._fetchPage(page);
        for (const id of payload.voterIds) discovered.add(id);
        total = payload.total ?? total;

        const seenSoFar = page * this.pageLimit;
        if (!payload.voterIds.length) break;
        if (hadKnownVoters && payload.voterIds.some((id) => this.voterIds.has(id))) break;
        if (total != null && seenSoFar >= total) break;
        if (payload.voterIds.length < this.pageLimit) break;
      }
    } catch (err) {
      this.lastErrorAt = Date.now();
      this.lastError = err instanceof Error ? err.message : String(err);
      this.logger?.warn?.('Vote list refresh failed', {
        error: this.lastError,
        knownVoters: this.voterIds.size,
      });
      return false;
    }

    await this._addVoters([...discovered]);
    this.lastRefreshAt = Date.now();
    this.lastError = null;
    this.totalReported = total;

    this.logger?.debug?.('Vote list refreshed', {
      discovered: discovered.size,
      knownVoters: this.voterIds.size,
      reportedTotal: total,
    });
    return true;
  }

  async _syncFromStore(): Promise<boolean> {
    if (!this.store || !this.botId) return false;
    try {
      const batch = await this.store.load(this.botId, this.storeSyncedUntil);
      for (const id of batch.voterIds) this.voterIds.add(id);
      this.storeSyncedUntil = batch.latestSeenAt;
      this.lastRefreshAt = Date.now();
      return true;
    } catch (err) {
      this.lastErrorAt = Date.now();
      this.lastError = err instanceof Error ? err.message : String(err);
      this.logger?.warn?.('Vote store sync failed', { error: this.lastError });
      return false;
    }
  }

  async _addVoters(voterIds: string[]): Promise<void> {
    const fresh = voterIds.filter((id) => !this.voterIds.has(id));
    for (const id of fresh) this.voterIds.add(id);
    if (!fresh.length || !this.store || !this.botId) return;
    await this.store.add(this.botId, fresh).catch((err: unknown) => {
      this.logger?.warn?.('Vote store write failed', { error: err instanceof Error ? err.message : String(err) });
    });
  }

  _rememberCheck(userId: string, now: number): void {
    if (this.lastCheckAt.size >= MAX_TRACKED_CHECKS) {
      for (const [id, checkedAt] of this.lastCheckAt) {
        if (now - checkedAt >= this.checkCooldownMs) this.lastCheckAt.delete(id);
      }
      if (this.lastCheckAt.size >= MAX_TRACKED_CHECKS) this.lastCheckAt.clear();
    }
    this.lastCheckAt.set(userId, now);
  }

  async _fetchVoteCheck(userId: string): Promise<boolean> {
    const url = `${this.apiBase}/api/v1/bots/${encodeURIComponent(String(this.botId))}/check`
      + `?fluxerId=${encodeURIComponent(userId)}`;

    const res = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(this.requestTimeoutMs),
    });

    if (!res.ok) {
      throw new Error(`FluxerList vote check failed: ${res.status} ${res.statusText}`);
    }

    const body = await res.json().catch(() => null) as { voted?: unknown } | null;
    return body?.voted === true;
  }

  async _fetchPage(page: number): Promise<{ voterIds: string[]; total: number | null }> {
    const url = `${this.apiBase}/api/v1/bots/${encodeURIComponent(String(this.botId))}/voters`
      + `?page=${page}&limit=${this.pageLimit}`;

    const res = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(this.requestTimeoutMs),
    });

    if (!res.ok) {
      throw new Error(`FluxerList voters request failed: ${res.status} ${res.statusText}`);
    }

    const body = await res.text();
    return {
      voterIds: extractVoterIds(body),
      total: extractTotal(body),
    };
  }

  getDiagnostics(): Record<string, unknown> {
    return {
      enabled: this.enabled,
      ready: this.ready,
      knownVoters: this.voterIds.size,
      reportedTotal: this.totalReported,
      pollsApi: this.pollApi,
      lastRefreshAt: this.lastRefreshAt,
      lastErrorAt: this.lastErrorAt,
      lastError: this.lastError,
    };
  }
}

export function extractVoterIds(body: string): string[] {
  const ids: string[] = [];
  VOTER_ID_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = VOTER_ID_PATTERN.exec(body)) != null) {
    if (match[1]) ids.push(match[1]);
  }
  return ids;
}

export function extractTotal(body: string): number | null {
  const match = /"total"\s*:\s*(\d+)/.exec(body);
  if (!match?.[1]) return null;
  const parsed = Number.parseInt(match[1], 10);
  return Number.isFinite(parsed) ? parsed : null;
}
