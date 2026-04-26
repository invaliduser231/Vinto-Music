import { Readable } from 'node:stream';
import { ValidationError } from '../../core/errors.ts';
import type { Track } from '../../types/domain.ts';

export type NodeLinkTrackInfo = Record<string, unknown> & {
  identifier?: unknown;
  title?: unknown;
  author?: unknown;
  length?: unknown;
  isSeekable?: unknown;
  isStream?: unknown;
  uri?: unknown;
  artworkUrl?: unknown;
  sourceName?: unknown;
  isrc?: unknown;
};

export type NodeLinkTrackData = {
  encoded?: unknown;
  info?: NodeLinkTrackInfo | null;
  pluginInfo?: Record<string, unknown> | null;
  userData?: unknown;
};

export type NodeLinkLoadResult = {
  loadType?: unknown;
  data?: unknown;
  exception?: {
    message?: unknown;
    severity?: unknown;
  } | null;
};

export type NodeLinkInfo = Record<string, unknown> & {
  version?: {
    semver?: unknown;
  } | null;
  isNodelink?: unknown;
};

type NodeLinkClientOptions = {
  baseUrl?: string | null;
  password?: string | null;
  requestTimeoutMs?: number | null;
  streamStartTimeoutMs?: number | null;
  defaultSearchIdentifier?: string | null;
};

type LoadTracksOptions = {
  searchIdentifier?: string | null;
};

type StreamTrackOptions = {
  positionMs?: number;
  volume?: number;
  filters?: Record<string, unknown>;
  guildId?: string | null;
};

function parsePositiveInt(value: unknown, fallback: number): number {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeBaseUrl(value: unknown): string | null {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  try {
    return new URL(raw).toString().replace(/\/$/, '');
  } catch {
    return null;
  }
}

function normalizeSearchIdentifier(value: unknown): string {
  const normalized = String(value ?? '').trim();
  return normalized || 'search';
}

function getErrorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value ?? 'Unknown error');
}

export class NodeLinkClient {
  baseUrl: string | null;
  password: string | null;
  requestTimeoutMs: number;
  streamStartTimeoutMs: number;
  defaultSearchIdentifier: string;
  lastRequestAtMs: number;
  lastRequestType: 'loadtracks' | 'loadstream' | 'info' | null;
  lastError: string | null;
  lastInfo: NodeLinkInfo | null;

  constructor(options: NodeLinkClientOptions = {}) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl ?? process.env.NODELINK_BASE_URL ?? null);
    this.password = String(options.password ?? process.env.NODELINK_PASSWORD ?? '').trim() || null;
    this.requestTimeoutMs = parsePositiveInt(
      options.requestTimeoutMs ?? process.env.NODELINK_REQUEST_TIMEOUT_MS,
      15_000
    );
    this.streamStartTimeoutMs = parsePositiveInt(
      options.streamStartTimeoutMs ?? process.env.NODELINK_STREAM_START_TIMEOUT_MS,
      10_000
    );
    this.defaultSearchIdentifier = normalizeSearchIdentifier(
      options.defaultSearchIdentifier ?? process.env.NODELINK_DEFAULT_SEARCH
    );
    this.lastRequestAtMs = 0;
    this.lastRequestType = null;
    this.lastError = null;
    this.lastInfo = null;
  }

  get enabled(): boolean {
    return Boolean(this.baseUrl);
  }

  headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      ...(this.password ? { authorization: this.password } : {}),
      ...extra,
    };
  }

  getDiagnostics(): Record<string, unknown> {
    return {
      enabled: this.enabled,
      baseUrl: this.baseUrl,
      defaultSearchIdentifier: this.defaultSearchIdentifier,
      requestTimeoutMs: this.requestTimeoutMs,
      streamStartTimeoutMs: this.streamStartTimeoutMs,
      lastRequestAtMs: this.lastRequestAtMs || null,
      lastRequestType: this.lastRequestType,
      lastError: this.lastError,
      info: this.lastInfo
        ? {
            isNodelink: Boolean(this.lastInfo.isNodelink),
            version: String(this.lastInfo.version?.semver ?? '').trim() || null,
          }
        : null,
    };
  }

  buildIdentifier(query: string, options: LoadTracksOptions = {}): string {
    const raw = String(query ?? '').trim();
    if (/^https?:\/\//i.test(raw)) return raw;
    if (/^[A-Za-z0-9]+:.+/.test(raw)) return raw;
    const searchIdentifier = normalizeSearchIdentifier(options.searchIdentifier ?? this.defaultSearchIdentifier);
    return `${searchIdentifier}:${raw}`;
  }

  async loadTracks(query: string, options: LoadTracksOptions = {}): Promise<NodeLinkLoadResult> {
    if (!this.baseUrl) {
      throw new ValidationError('NodeLink is not configured.');
    }

    this.lastRequestAtMs = Date.now();
    this.lastRequestType = 'loadtracks';
    const endpoint = new URL('/v4/loadtracks', this.baseUrl);
    endpoint.searchParams.set('identifier', this.buildIdentifier(query, options));

    const response = await fetch(endpoint, {
      method: 'GET',
      headers: this.headers({ accept: 'application/json' }),
      signal: AbortSignal.timeout(this.requestTimeoutMs),
    }).catch((err) => {
      this.lastError = `NodeLink load failed: ${getErrorMessage(err)}`;
      throw new ValidationError(`NodeLink load failed: ${getErrorMessage(err)}`);
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      this.lastError = `NodeLink load failed (${response.status}): ${body.slice(0, 300) || response.statusText}`;
      throw new ValidationError(`NodeLink load failed (${response.status}): ${body.slice(0, 300) || response.statusText}`);
    }

    const payload = await response.json().catch((err) => {
      this.lastError = `NodeLink load returned invalid JSON: ${getErrorMessage(err)}`;
      throw new ValidationError(`NodeLink load returned invalid JSON: ${getErrorMessage(err)}`);
    }) as NodeLinkLoadResult;
    this.lastError = null;
    return payload;
  }

  async getInfo(timeoutMs = Math.min(this.requestTimeoutMs, 5_000)): Promise<NodeLinkInfo> {
    if (!this.baseUrl) {
      throw new ValidationError('NodeLink is not configured.');
    }

    this.lastRequestAtMs = Date.now();
    this.lastRequestType = 'info';
    const response = await fetch(new URL('/v4/info', this.baseUrl), {
      method: 'GET',
      headers: this.headers({ accept: 'application/json' }),
      signal: AbortSignal.timeout(timeoutMs),
    }).catch((err) => {
      this.lastError = `NodeLink info failed: ${getErrorMessage(err)}`;
      throw new ValidationError(`NodeLink info failed: ${getErrorMessage(err)}`);
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      this.lastError = `NodeLink info failed (${response.status}): ${body.slice(0, 300) || response.statusText}`;
      throw new ValidationError(`NodeLink info failed (${response.status}): ${body.slice(0, 300) || response.statusText}`);
    }

    const payload = await response.json().catch((err) => {
      this.lastError = `NodeLink info returned invalid JSON: ${getErrorMessage(err)}`;
      throw new ValidationError(`NodeLink info returned invalid JSON: ${getErrorMessage(err)}`);
    }) as NodeLinkInfo;
    this.lastInfo = payload;
    this.lastError = null;
    return payload;
  }

  async streamTrack(track: Track, options: StreamTrackOptions = {}): Promise<Readable> {
    const encodedTrack = String(track.nodelinkEncodedTrack ?? '').trim();
    if (!this.baseUrl || !encodedTrack) {
      throw new ValidationError('Track is missing a NodeLink encoded track.');
    }

    this.lastRequestAtMs = Date.now();
    this.lastRequestType = 'loadstream';
    const response = await fetch(new URL('/v4/loadstream', this.baseUrl), {
      method: 'POST',
      headers: this.headers({
        accept: 'audio/l16',
        'content-type': 'application/json',
      }),
      signal: AbortSignal.timeout(this.streamStartTimeoutMs),
      body: JSON.stringify({
        encodedTrack,
        volume: options.volume ?? 100,
        position: options.positionMs ?? 0,
        filters: options.filters ?? {},
        ...(options.guildId ? { guildId: options.guildId } : {}),
      }),
    }).catch((err) => {
      this.lastError = `NodeLink stream failed: ${getErrorMessage(err)}`;
      throw new ValidationError(`NodeLink stream failed: ${getErrorMessage(err)}`);
    });

    if (!response.ok || !response.body) {
      const body = await response.text().catch(() => '');
      this.lastError = `NodeLink stream failed (${response.status}): ${body.slice(0, 300) || response.statusText}`;
      throw new ValidationError(`NodeLink stream failed (${response.status}): ${body.slice(0, 300) || response.statusText}`);
    }

    this.lastError = null;
    return Readable.fromWeb(response.body as unknown as import('node:stream/web').ReadableStream);
  }
}
