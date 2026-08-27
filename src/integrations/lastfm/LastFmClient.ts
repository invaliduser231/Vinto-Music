import { createHash } from 'node:crypto';
import { AppError } from '../../core/errors.ts';
import { withRetry, sleep } from '../../utils/retry.ts';
import type { LoggerLike } from '../../types/core.ts';

const API_BASE = 'https://ws.audioscrobbler.com/2.0/';
const AUTH_BASE = 'https://www.last.fm/api/auth/';
const UNSIGNED_PARAMS = new Set(['format', 'callback']);
const RETRYABLE_CODES = new Set([8, 11, 16, 29]);

export const LASTFM_INVALID_SESSION_CODE = 9;

export type LastFmPeriod = 'overall' | '7day' | '1month' | '3month' | '6month' | '12month';

export interface LastFmScrobbleEntry {
  artist: string;
  track: string;
  timestamp: number;
  album?: string | null;
  duration?: number | null;
}

export interface LastFmSession {
  name: string;
  key: string;
}

export interface LastFmUserInfo {
  name: string;
  realname: string | null;
  url: string | null;
  playcount: number;
  registeredAt: Date | null;
  imageUrl: string | null;
  country: string | null;
}

export interface LastFmRecentTrack {
  artist: string;
  track: string;
  album: string | null;
  url: string | null;
  imageUrl: string | null;
  nowPlaying: boolean;
  playedAt: Date | null;
}

export interface LastFmRankedEntry {
  name: string;
  artist: string | null;
  url: string | null;
  playcount: number;
}

export interface LastFmSimilarTrack {
  artist: string;
  track: string;
  match: number;
}

export class LastFmApiError extends AppError {
  lastfmCode: number;

  constructor(message: string, lastfmCode: number, status: number | null = null) {
    super(message, { code: 'LASTFM_API_ERROR', status });
    this.name = 'LastFmApiError';
    this.lastfmCode = lastfmCode;
  }
}

interface LastFmClientOptions {
  apiKey: string;
  apiSecret: string;
  requestTimeoutMs?: number;
  requestsPerSecond?: number;
  logger?: LoggerLike | undefined;
}

type ParamValue = string | number | null | undefined;
type Params = Record<string, ParamValue>;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function readText(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number') return String(value);
  const record = asRecord(value);
  if (typeof record['#text'] === 'string') return String(record['#text']).trim();
  if (typeof record.name === 'string') return String(record.name).trim();
  return '';
}

function readCount(value: unknown): number {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function readImage(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  const sizes = ['extralarge', 'large', 'medium', 'small'];
  for (const size of sizes) {
    const match = value.find((entry) => readText(asRecord(entry).size) === size);
    const url = readText(asRecord(match)['#text']);
    if (url) return url;
  }
  return null;
}

function toArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value == null) return [];
  return [value];
}

export class LastFmClient {
  apiKey: string;
  apiSecret: string;
  requestTimeoutMs: number;
  minRequestGapMs: number;
  logger: LoggerLike | undefined;
  private nextSlotAt: number;

  constructor(options: LastFmClientOptions) {
    this.apiKey = options.apiKey;
    this.apiSecret = options.apiSecret;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
    this.minRequestGapMs = Math.max(1, Math.floor(1_000 / (options.requestsPerSecond ?? 5)));
    this.logger = options.logger ?? undefined;
    this.nextSlotAt = 0;
  }

  buildAuthUrl(token: string): string {
    const url = new URL(AUTH_BASE);
    url.searchParams.set('api_key', this.apiKey);
    url.searchParams.set('token', token);
    return url.toString();
  }

  signature(params: Params): string {
    const entries = Object.entries(params)
      .filter(([name, value]) => !UNSIGNED_PARAMS.has(name) && value != null && String(value) !== '')
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));

    const payload = entries.map(([name, value]) => `${name}${String(value)}`).join('');
    return createHash('md5').update(`${payload}${this.apiSecret}`, 'utf8').digest('hex');
  }

  async _throttle(): Promise<void> {
    const now = Date.now();
    const waitMs = this.nextSlotAt - now;
    this.nextSlotAt = Math.max(now, this.nextSlotAt) + this.minRequestGapMs;
    if (waitMs > 0) await sleep(waitMs);
  }

  async _call(
    method: string,
    params: Params = {},
    options: { signed?: boolean; write?: boolean } = {},
  ): Promise<Record<string, unknown>> {
    const signed = options.signed === true;
    const write = options.write === true;

    const base: Params = { ...params, method, api_key: this.apiKey };
    for (const key of Object.keys(base)) {
      if (base[key] == null || String(base[key]) === '') delete base[key];
    }
    if (signed) base.api_sig = this.signature(base);
    base.format = 'json';

    const body = new URLSearchParams();
    for (const [name, value] of Object.entries(base)) {
      if (value == null) continue;
      body.append(name, String(value));
    }

    return withRetry(async () => {
      await this._throttle();

      const response = await fetch(write ? API_BASE : `${API_BASE}?${body.toString()}`, {
        method: write ? 'POST' : 'GET',
        headers: write ? { 'content-type': 'application/x-www-form-urlencoded' } : {},
        ...(write ? { body: body.toString() } : {}),
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });

      const text = await response.text();
      let payload: Record<string, unknown> = {};
      if (text) {
        try {
          payload = JSON.parse(text) as Record<string, unknown>;
        } catch {
          payload = {};
        }
      }

      const errorCode = Number.parseInt(String(payload.error ?? ''), 10);
      if (Number.isFinite(errorCode) && errorCode > 0) {
        throw new LastFmApiError(
          String(payload.message ?? `Last.fm error ${errorCode}`),
          errorCode,
          response.status,
        );
      }

      if (!response.ok) {
        throw new LastFmApiError(`Last.fm request failed with HTTP ${response.status}`, 0, response.status);
      }

      return payload;
    }, {
      maxAttempts: 3,
      baseDelayMs: 500,
      maxDelayMs: 4_000,
      shouldRetry: (error) => {
        if (error instanceof LastFmApiError) {
          if (RETRYABLE_CODES.has(error.lastfmCode)) return true;
          return error.lastfmCode === 0 && Number(error.status ?? 0) >= 500;
        }
        return true;
      },
      onRetry: ({ attempt, delayMs, error }) => {
        this.logger?.debug?.('Retrying Last.fm request', {
          method,
          attempt,
          delayMs,
          error: error instanceof Error ? error.message : String(error),
        });
      },
    });
  }

  async getToken(): Promise<string> {
    const payload = await this._call('auth.getToken', {}, { signed: true });
    const token = String(payload.token ?? '').trim();
    if (!token) throw new LastFmApiError('Last.fm did not return an auth token', 0);
    return token;
  }

  async getSession(token: string): Promise<LastFmSession> {
    const payload = await this._call('auth.getSession', { token }, { signed: true });
    const session = asRecord(payload.session);
    const name = String(session.name ?? '').trim();
    const key = String(session.key ?? '').trim();
    if (!name || !key) throw new LastFmApiError('Last.fm did not return a session', 0);
    return { name, key };
  }

  async updateNowPlaying(sessionKey: string, entry: Omit<LastFmScrobbleEntry, 'timestamp'>): Promise<void> {
    await this._call('track.updateNowPlaying', {
      artist: entry.artist,
      track: entry.track,
      album: entry.album ?? null,
      duration: entry.duration ?? null,
      sk: sessionKey,
    }, { signed: true, write: true });
  }

  async scrobble(sessionKey: string, entries: LastFmScrobbleEntry[]): Promise<number> {
    const batch = entries.slice(0, 50);
    if (!batch.length) return 0;

    const params: Params = { sk: sessionKey };
    batch.forEach((entry, index) => {
      params[`artist[${index}]`] = entry.artist;
      params[`track[${index}]`] = entry.track;
      params[`timestamp[${index}]`] = entry.timestamp;
      if (entry.album) params[`album[${index}]`] = entry.album;
      if (entry.duration) params[`duration[${index}]`] = entry.duration;
    });

    const payload = await this._call('track.scrobble', params, { signed: true, write: true });
    const accepted = asRecord(asRecord(payload.scrobbles)['@attr']).accepted;
    const count = Number.parseInt(String(accepted ?? ''), 10);
    return Number.isFinite(count) ? count : batch.length;
  }

  async loveTrack(sessionKey: string, artist: string, track: string): Promise<void> {
    await this._call('track.love', { artist, track, sk: sessionKey }, { signed: true, write: true });
  }

  async unloveTrack(sessionKey: string, artist: string, track: string): Promise<void> {
    await this._call('track.unlove', { artist, track, sk: sessionKey }, { signed: true, write: true });
  }

  async userGetInfo(user: string): Promise<LastFmUserInfo> {
    const payload = await this._call('user.getInfo', { user });
    const info = asRecord(payload.user);
    const registered = Number.parseInt(String(asRecord(info.registered).unixtime ?? ''), 10);

    return {
      name: readText(info.name) || user,
      realname: readText(info.realname) || null,
      url: readText(info.url) || null,
      playcount: readCount(info.playcount),
      registeredAt: Number.isFinite(registered) && registered > 0 ? new Date(registered * 1000) : null,
      imageUrl: readImage(info.image),
      country: readText(info.country) || null,
    };
  }

  async userGetRecentTracks(user: string, limit: number = 10): Promise<LastFmRecentTrack[]> {
    const payload = await this._call('user.getRecentTracks', { user, limit: Math.max(1, Math.min(200, limit)) });
    const entries = toArray(asRecord(payload.recenttracks).track);

    return entries.map((raw) => {
      const record = asRecord(raw);
      const playedAtUnix = Number.parseInt(String(asRecord(record.date).uts ?? ''), 10);
      return {
        artist: readText(record.artist),
        track: readText(record.name),
        album: readText(record.album) || null,
        url: readText(record.url) || null,
        imageUrl: readImage(record.image),
        nowPlaying: String(asRecord(record['@attr']).nowplaying ?? '') === 'true',
        playedAt: Number.isFinite(playedAtUnix) && playedAtUnix > 0 ? new Date(playedAtUnix * 1000) : null,
      };
    }).filter((entry) => entry.artist && entry.track);
  }

  async userGetTopArtists(user: string, period: LastFmPeriod = 'overall', limit: number = 10): Promise<LastFmRankedEntry[]> {
    const payload = await this._call('user.getTopArtists', { user, period, limit: Math.max(1, Math.min(1000, limit)) });
    return toArray(asRecord(payload.topartists).artist).map((raw) => {
      const record = asRecord(raw);
      return {
        name: readText(record.name),
        artist: null,
        url: readText(record.url) || null,
        playcount: readCount(record.playcount),
      };
    }).filter((entry) => entry.name);
  }

  async userGetTopTracks(user: string, period: LastFmPeriod = 'overall', limit: number = 10): Promise<LastFmRankedEntry[]> {
    const payload = await this._call('user.getTopTracks', { user, period, limit: Math.max(1, Math.min(1000, limit)) });
    return toArray(asRecord(payload.toptracks).track).map((raw) => {
      const record = asRecord(raw);
      return {
        name: readText(record.name),
        artist: readText(record.artist) || null,
        url: readText(record.url) || null,
        playcount: readCount(record.playcount),
      };
    }).filter((entry) => entry.name);
  }

  async userGetTopAlbums(user: string, period: LastFmPeriod = 'overall', limit: number = 10): Promise<LastFmRankedEntry[]> {
    const payload = await this._call('user.getTopAlbums', { user, period, limit: Math.max(1, Math.min(1000, limit)) });
    return toArray(asRecord(payload.topalbums).album).map((raw) => {
      const record = asRecord(raw);
      return {
        name: readText(record.name),
        artist: readText(record.artist) || null,
        url: readText(record.url) || null,
        playcount: readCount(record.playcount),
      };
    }).filter((entry) => entry.name);
  }

  async trackGetSimilar(artist: string, track: string, limit: number = 20): Promise<LastFmSimilarTrack[]> {
    const payload = await this._call('track.getSimilar', {
      artist,
      track,
      autocorrect: 1,
      limit: Math.max(1, Math.min(100, limit)),
    });

    return toArray(asRecord(payload.similartracks).track).map((raw) => {
      const record = asRecord(raw);
      const match = Number.parseFloat(String(record.match ?? ''));
      return {
        artist: readText(record.artist),
        track: readText(record.name),
        match: Number.isFinite(match) ? match : 0,
      };
    }).filter((entry) => entry.artist && entry.track);
  }

  async artistGetTopTracks(artist: string, limit: number = 10): Promise<LastFmSimilarTrack[]> {
    const payload = await this._call('artist.getTopTracks', {
      artist,
      autocorrect: 1,
      limit: Math.max(1, Math.min(100, limit)),
    });

    return toArray(asRecord(payload.toptracks).track).map((raw) => {
      const record = asRecord(raw);
      return {
        artist: readText(record.artist) || artist,
        track: readText(record.name),
        match: readCount(record.playcount),
      };
    }).filter((entry) => entry.track);
  }
}
