import type { LoggerLike } from '../../types/core.ts';

const VOTER_ID_PATTERN = /"fluxerId"\s*:\s*"?(\d+)"?/g;

export interface VoteServiceOptions {
  apiBase: string;
  apiKey: string | null;
  botId: string | null;
  logger?: LoggerLike | undefined;
  refreshIntervalMs?: number;
  requestTimeoutMs?: number;
  pageLimit?: number;
  maxPages?: number;
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

  voterIds: Set<string>;
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

    this.voterIds = new Set();
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

  start(): void {
    if (!this.enabled || this.refreshHandle) return;

    void this.refresh();
    this.refreshHandle = setInterval(() => {
      void this.refresh();
    }, this.refreshIntervalMs);
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
    const discovered = new Set<string>();
    let total: number | null = null;

    try {
      for (let page = 1; page <= this.maxPages; page += 1) {
        const payload = await this._fetchPage(page);
        for (const id of payload.voterIds) discovered.add(id);
        total = payload.total ?? total;

        const seenSoFar = page * this.pageLimit;
        if (!payload.voterIds.length) break;
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

    for (const id of discovered) this.voterIds.add(id);
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
