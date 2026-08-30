import http from 'node:http';
import { timingSafeEqual, createHash } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import type { SessionManager } from '../bot/sessionManager.ts';
import type { VoiceStateStore } from '../bot/voiceStateStore.ts';
import type { LoggerLike } from '../types/core.ts';
import type { GuildConfig, Session, Track } from '../types/domain.ts';
import {
  buildGuildHistoryPayload,
  buildLyricsSearchQuery,
} from '../dashboard/historyLyrics.ts';
import { runDashboardAction, type DashboardAction } from '../dashboard/actions.ts';
import {
  applyGuildSettingsPatch,
  buildGuildSettingsPayload,
  type DashboardGuildSettingsPatch,
  type GuildConfigStoreLike,
} from '../dashboard/guildSettings.ts';
import {
  buildGuildDashboardSessionPayload,
  buildGuildOverviewPayload,
  serializeTrack,
  type DashboardSessionPayload,
} from '../dashboard/sessionSnapshot.ts';
import {
  applyRequesterProfiles,
  collectRequesterIds,
  parseMemberProfile,
  type DashboardMemberProfile,
} from '../dashboard/memberProfile.ts';
import { getUserVoiceChannelId, findUserVoiceBinding } from '../dashboard/viewerAccess.ts';
import { buildDashboardHubPayload, toggleUserFavorite } from '../dashboard/hub.ts';
import type { GuildStateCache } from '../bot/services/guildStateCache.ts';
import type { GuildConfigStore } from '../bot/services/guildConfigStore.ts';
import type { LyricsService } from '../bot/services/lyricsService.ts';
import type { MusicLibraryStore } from '../bot/services/musicLibraryStore.ts';
import type { LastFmAccountStore } from '../bot/services/lastFmAccountStore.ts';
import type { LastFmClient } from '../integrations/lastfm/LastFmClient.ts';
import { partyStateStore } from '../bot/services/partyStateStore.ts';
import { buildGuildDirectory, type DashboardGuildDirectory } from '../dashboard/guildDirectory.ts';

type DashboardServerOptions = {
  enabled?: boolean;
  host?: string;
  port?: number;
  secret?: string | null;
  allowedOrigins?: string[];
  progressIntervalMs?: number;
  logger?: LoggerLike | undefined;
  sessions: SessionManager;
  voiceStateStore: VoiceStateStore;
  botUserId?: string | null;
  resolveMemberRoleIds?: (guildId: string, userId: string) => Promise<string[]>;
  guildConfigs?: GuildConfigStore | null;
  library?: MusicLibraryStore | null;
  guildStateCache?: GuildStateCache | null;
  resolveChannelName?: (channelId: string) => Promise<string | null>;
  resolveGuildName?: (guildId: string) => Promise<string | null>;
  getGuildMember?: (guildId: string, userId: string) => Promise<unknown>;
  listGuildRoles?: (guildId: string) => Promise<unknown>;
  listGuildChannels?: (guildId: string) => Promise<unknown>;
  listGuildMembers?: (guildId: string, options: { limit: number; after?: string }) => Promise<unknown>;
  listBotGuildIds?: () => Promise<string[]>;
  isBotInGuild?: (guildId: string) => Promise<boolean>;
  lyrics?: LyricsService | null;
  lastfm?: { client: LastFmClient; accounts: LastFmAccountStore } | null;
};

type ClientSubscription = {
  guildId: string;
  voiceChannelId: string;
  userId: string;
  roleIds: string[];
};

type DashboardClient = {
  socket: WebSocket;
  authenticated: boolean;
  subscription: ClientSubscription | null;
};

function parseRoleIds(value: unknown): string[] {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value.map((entry) => String(entry).trim()).filter(Boolean);
  }
  return String(value)
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function readBearerToken(headerValue: string | undefined): string | null {
  const raw = String(headerValue ?? '').trim();
  if (!raw.toLowerCase().startsWith('bearer ')) return null;
  return raw.slice(7).trim() || null;
}

function isAuthorized(secret: string, provided: string | null | undefined): boolean {
  const expected = String(secret ?? '').trim();
  const actual = String(provided ?? '').trim();
  if (!expected || !actual) return false;
  const expectedBuffer = createHash('sha256').update(expected).digest();
  const actualBuffer = createHash('sha256').update(actual).digest();
  if (expectedBuffer.length !== actualBuffer.length) return false;
  return timingSafeEqual(expectedBuffer, actualBuffer);
}

type TtlCacheEntry<T> = { value: T; expiresAt: number };
type TtlCache<T> = Map<string, TtlCacheEntry<T>>;

const NAME_CACHE_TTL_MS = 10 * 60 * 1000;
const NAME_CACHE_MAX_ENTRIES = 2_000;
const MEMBER_PROFILE_CACHE_TTL_MS = 5 * 60 * 1000;
const MEMBER_PROFILE_CACHE_MAX_ENTRIES = 2_000;

function readTtlCache<T>(cache: TtlCache<T>, key: string): T | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    cache.delete(key);
    return null;
  }
  return entry.value;
}

function writeTtlCache<T>(cache: TtlCache<T>, key: string, value: T, ttlMs: number, maxEntries: number): void {
  cache.delete(key);
  while (cache.size >= maxEntries) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  cache.set(key, { value, expiresAt: Date.now() + ttlMs });
}

function parseJsonBody(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

export class DashboardServer {
  enabled: boolean;
  host: string;
  port: number;
  secret: string | null;
  allowedOrigins: Set<string>;
  progressIntervalMs: number;
  logger: LoggerLike | undefined;
  sessions: SessionManager;
  voiceStateStore: VoiceStateStore;
  botUserId: string | null;
  resolveMemberRoleIds: ((guildId: string, userId: string) => Promise<string[]>) | null;
  guildConfigs: GuildConfigStore | null;
  library: MusicLibraryStore | null;
  guildStateCache: GuildStateCache | null;
  resolveChannelName: ((channelId: string) => Promise<string | null>) | null;
  resolveGuildName: ((guildId: string) => Promise<string | null>) | null;
  channelNameCache: TtlCache<string>;
  guildNameCache: TtlCache<string>;
  getGuildMember: ((guildId: string, userId: string) => Promise<unknown>) | null;
  listGuildRoles: ((guildId: string) => Promise<unknown>) | null;
  listGuildChannels: ((guildId: string) => Promise<unknown>) | null;
  listGuildMembers: ((guildId: string, options: { limit: number; after?: string }) => Promise<unknown>) | null;
  listBotGuildIds: (() => Promise<string[]>) | null;
  isBotInGuild: ((guildId: string) => Promise<boolean>) | null;
  lyrics: LyricsService | null;
  lastfm: { client: LastFmClient; accounts: LastFmAccountStore } | null;
  pendingLastFmTokens: Map<string, string>;
  botGuildMembershipCache: Map<string, { present: boolean; expiresAt: number }>;
  memberProfileCache: TtlCache<DashboardMemberProfile>;
  server: http.Server | null;
  wss: WebSocketServer | null;
  clients: Set<DashboardClient>;
  progressHandle: ReturnType<typeof setInterval> | null;
  unbindSessionEvents: (() => void) | null;
  spectrumTaps: Map<string, { detach: () => void }>;

  constructor(options: DashboardServerOptions) {
    this.enabled = options.enabled !== false;
    this.host = options.host ?? '127.0.0.1';
    this.port = options.port ?? 9092;
    this.secret = options.secret ?? null;
    this.allowedOrigins = new Set(options.allowedOrigins ?? ['http://localhost:3000']);
    this.progressIntervalMs = Math.max(250, Number(options.progressIntervalMs ?? 2000));
    this.logger = options.logger ?? undefined;
    this.sessions = options.sessions;
    this.voiceStateStore = options.voiceStateStore;
    this.botUserId = options.botUserId ? String(options.botUserId) : null;
    this.resolveMemberRoleIds = options.resolveMemberRoleIds ?? null;
    this.guildConfigs = options.guildConfigs ?? null;
    this.library = options.library ?? null;
    this.guildStateCache = options.guildStateCache ?? null;
    this.resolveChannelName = options.resolveChannelName ?? null;
    this.resolveGuildName = options.resolveGuildName ?? null;
    this.channelNameCache = new Map();
    this.guildNameCache = new Map();
    this.getGuildMember = options.getGuildMember ?? null;
    this.listGuildRoles = options.listGuildRoles ?? null;
    this.listGuildChannels = options.listGuildChannels ?? null;
    this.listGuildMembers = options.listGuildMembers ?? null;
    this.listBotGuildIds = options.listBotGuildIds ?? null;
    this.isBotInGuild = options.isBotInGuild ?? null;
    this.lyrics = options.lyrics ?? null;
    this.lastfm = options.lastfm ?? null;
    this.pendingLastFmTokens = new Map();
    this.botGuildMembershipCache = new Map();
    this.memberProfileCache = new Map();
    this.server = null;
    this.wss = null;
    this.clients = new Set();
    this.progressHandle = null;
    this.unbindSessionEvents = null;
    this.spectrumTaps = new Map();
  }

  async start(): Promise<boolean> {
    if (!this.enabled) return false;
    if (!this.secret) {
      this.logger?.warn?.('Dashboard API disabled: DASHBOARD_API_SECRET is missing');
      return false;
    }
    if (this.server) return true;

    this.server = http.createServer((req, res) => this._handleHttp(req, res));
    this.wss = new WebSocketServer({ server: this.server });
    this.wss.on('connection', (socket: WebSocket) => this._handleSocket(socket));

    this._bindSessionEvents();
    this.progressHandle = setInterval(() => {
      this._broadcastProgressTicks();
    }, this.progressIntervalMs);
    this.progressHandle.unref?.();

    await new Promise<void>((resolve, reject) => {
      this.server?.once('error', reject);
      this.server?.listen(this.port, this.host, resolve);
    });

    this.logger?.info?.('Dashboard API listening', {
      host: this.host,
      port: this.port,
      progressIntervalMs: this.progressIntervalMs,
    });
    return true;
  }

  async stop(): Promise<void> {
    if (this.progressHandle) {
      clearInterval(this.progressHandle);
      this.progressHandle = null;
    }
    for (const tap of this.spectrumTaps.values()) {
      tap.detach();
    }
    this.spectrumTaps.clear();
    if (this.unbindSessionEvents) {
      this.unbindSessionEvents();
      this.unbindSessionEvents = null;
    }

    for (const client of this.clients) {
      client.socket.close();
    }
    this.clients.clear();

    if (this.wss) {
      await new Promise<void>((resolve) => {
        this.wss?.close(() => resolve());
      });
      this.wss = null;
    }

    if (this.server) {
      await new Promise<void>((resolve, reject) => {
        this.server?.close((err) => (err ? reject(err) : resolve()));
      });
      this.server = null;
    }
  }

  _bindSessionEvents(): void {
    const onSessionChange = (payload: { session?: Session | null }) => {
      const guildId = String(payload?.session?.guildId ?? '').trim();
      if (!guildId) return;
      this._syncSpectrumTaps();
      this._broadcastGuild(guildId);
    };

    const events = ['trackStart', 'trackEnd', 'tracksAdded', 'destroyed'] as const;
    for (const event of events) {
      this.sessions.on(event, onSessionChange);
    }

    this.unbindSessionEvents = () => {
      for (const event of events) {
        this.sessions.off(event, onSessionChange);
      }
    };
  }

  _handleHttp(req: http.IncomingMessage, res: http.ServerResponse): void {
    const origin = String(req.headers.origin ?? '').trim();
    if (origin && this.allowedOrigins.has(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-User-Id, X-User-Role-Ids');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
    }

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url ?? '/', 'http://dashboard.local');
    const path = url.pathname;

    if (path === '/api/v1/guild' && req.method === 'GET') {
      void this._handleGuildGet(req, res, url);
      return;
    }

    if (path === '/api/v1/user/voice' && req.method === 'GET') {
      void this._handleUserVoiceGet(req, res, url);
      return;
    }

    if (path === '/api/v1/session' && req.method === 'GET') {
      void this._handleSessionGet(req, res, url);
      return;
    }

    if (path === '/api/v1/session/action' && req.method === 'POST') {
      void this._handleSessionAction(req, res);
      return;
    }

    if (path === '/api/v1/guild/settings' && req.method === 'GET') {
      void this._handleGuildSettingsGet(req, res, url);
      return;
    }

    if (path === '/api/v1/guild/history' && req.method === 'GET') {
      void this._handleGuildHistoryGet(req, res, url);
      return;
    }

    if (path === '/api/v1/dashboard/hub' && req.method === 'GET') {
      void this._handleDashboardHubGet(req, res, url);
      return;
    }

    if (path === '/api/v1/track/lyrics' && req.method === 'GET') {
      void this._handleTrackLyricsGet(req, res, url);
      return;
    }

    if (path === '/api/v1/bot/guilds' && req.method === 'GET') {
      void this._handleBotGuildsGet(req, res, url);
      return;
    }

    if (path === '/api/v1/guild/settings' && req.method === 'PATCH') {
      void this._handleGuildSettingsPatch(req, res, url);
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'not found' }));
  }

  async _handleBotGuildsGet(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: URL,
  ): Promise<void> {
    if (!this._authorizeRequest(req, res)) return;

    const requestedGuildIds = String(url.searchParams.get('guildIds') ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean);

    let guildIds: string[];
    if (requestedGuildIds.length > 0) {
      guildIds = await this._filterBotGuildIds(requestedGuildIds);
    } else {
      guildIds = await this._listBotGuildIds();
    }

    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify({ guildIds, ts: Date.now() }));
  }

  async _filterBotGuildIds(guildIds: string[]): Promise<string[]> {
    const present: string[] = [];
    await Promise.all(guildIds.map(async (guildId) => {
      if (await this._isBotInGuild(guildId)) present.push(guildId);
    }));
    return present;
  }

  async _isBotInGuild(guildId: string): Promise<boolean> {
    const safeGuildId = String(guildId ?? '').trim();
    if (!safeGuildId) return false;

    const cached = this.botGuildMembershipCache.get(safeGuildId);
    if (cached && cached.expiresAt > Date.now()) return cached.present;
    if (cached) this.botGuildMembershipCache.delete(safeGuildId);

    if (!this.isBotInGuild) {
      const fallback = this.guildStateCache?.guilds.has(safeGuildId) ?? false;
      this.botGuildMembershipCache.set(safeGuildId, {
        present: fallback,
        expiresAt: Date.now() + (fallback ? 10 * 60_000 : 30_000),
      });
      return fallback;
    }

    try {
      const present = await this.isBotInGuild(safeGuildId);
      this.botGuildMembershipCache.set(safeGuildId, {
        present,
        expiresAt: Date.now() + (present ? 10 * 60_000 : 30_000),
      });
      return present;
    } catch (err) {
      this.logger?.warn?.('Dashboard bot guild membership check failed', {
        guildId: safeGuildId,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  async _listBotGuildIds(): Promise<string[]> {
    if (this.listBotGuildIds) {
      try {
        const ids = await this.listBotGuildIds();
        return [...new Set(ids.map((entry) => String(entry ?? '').trim()).filter(Boolean))];
      } catch (err) {
        this.logger?.warn?.('Dashboard bot guild list failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (!this.guildStateCache) return [];
    return [...this.guildStateCache.guilds.keys()].map((entry) => String(entry).trim()).filter(Boolean);
  }

  async _resolveMemberProfile(guildId: string, userId: string): Promise<DashboardMemberProfile | null> {
    const safeGuildId = String(guildId ?? '').trim();
    const safeUserId = String(userId ?? '').trim();
    if (!safeGuildId || !safeUserId) return null;

    const cacheKey = `${safeGuildId}:${safeUserId}`;
    const cached = readTtlCache(this.memberProfileCache, cacheKey);
    if (cached) return cached;

    if (!this.getGuildMember) return null;
    try {
      const member = await this.getGuildMember(safeGuildId, safeUserId);
      const profile = parseMemberProfile(member);
      if (profile) {
        writeTtlCache(
          this.memberProfileCache,
          cacheKey,
          profile,
          MEMBER_PROFILE_CACHE_TTL_MS,
          MEMBER_PROFILE_CACHE_MAX_ENTRIES,
        );
      }
      return profile;
    } catch (err) {
      this.logger?.warn?.('Dashboard member profile resolution failed', {
        guildId: safeGuildId,
        userId: safeUserId,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  async _resolveMemberProfiles(
    guildId: string,
    userIds: string[],
  ): Promise<Map<string, DashboardMemberProfile>> {
    const profiles = new Map<string, DashboardMemberProfile>();
    await Promise.all(userIds.map(async (userId) => {
      const profile = await this._resolveMemberProfile(guildId, userId);
      if (profile) profiles.set(userId, profile);
    }));
    return profiles;
  }

  async _enrichPayloadRequesters(
    guildId: string,
    payload: DashboardSessionPayload,
  ): Promise<void> {
    const requesterIds = collectRequesterIds(payload);
    if (!requesterIds.length) return;
    const profiles = await this._resolveMemberProfiles(guildId, requesterIds);
    applyRequesterProfiles(payload, profiles);
  }

  async _handleGuildGet(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: URL,
  ): Promise<void> {
    if (!this._authorizeRequest(req, res)) return;

    const guildId = String(url.searchParams.get('guildId') ?? '').trim();
    const userId = String(req.headers['x-user-id'] ?? '').trim();
    if (!guildId || !userId) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'guildId and X-User-Id are required' }));
      return;
    }

    const member = await this._resolveMemberProfile(guildId, userId);
    if (!member && this.getGuildMember) {
      res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'guild access denied' }));
      return;
    }

    const guildName = await this._resolveGuildName(guildId);
    const channelNames = await this._buildChannelNameMap(guildId);
    const payload = buildGuildOverviewPayload({
      guildId,
      guildName,
      sessions: this.sessions.listByGuild(guildId),
      voiceStateStore: this.voiceStateStore,
      botUserId: this.botUserId,
      userId,
      channelNames,
    });
    const roleIds = await this._resolveRoleIds(guildId, userId, []);
    const directory = this._canManageGuild(guildId, userId, roleIds)
      ? await this._buildGuildDirectory(guildId)
      : { roles: [], textChannels: [], voiceChannels: [], members: [] };

    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify({ guild: { ...payload, directory }, ts: Date.now() }));
  }

  async _buildGuildDirectory(guildId: string): Promise<DashboardGuildDirectory> {
    const members: unknown[] = [];
    let after: string | undefined;
    if (this.listGuildMembers) {
      for (let page = 0; page < 20; page += 1) {
        const value = await this.listGuildMembers(guildId, {
          limit: 200,
          ...(after ? { after } : {}),
        }).catch(() => []);
        const pageMembers = Array.isArray(value) ? value : [];
        members.push(...pageMembers);
        if (pageMembers.length < 200) break;
        const last = pageMembers[pageMembers.length - 1] as Record<string, unknown> | undefined;
        const user = last?.user && typeof last.user === 'object'
          ? last.user as Record<string, unknown>
          : {};
        after = String(user.id ?? last?.user_id ?? '').trim() || undefined;
        if (!after) break;
      }
    }
    const [roles, channels] = await Promise.all([
      this.listGuildRoles ? this.listGuildRoles(guildId).catch(() => []) : Promise.resolve([]),
      this.listGuildChannels ? this.listGuildChannels(guildId).catch(() => []) : Promise.resolve([]),
    ]);
    return buildGuildDirectory(roles, channels, members);
  }

  async _handleGuildHistoryGet(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: URL,
  ): Promise<void> {
    if (!this._authorizeRequest(req, res)) return;

    const guildId = String(url.searchParams.get('guildId') ?? '').trim();
    const voiceChannelId = String(url.searchParams.get('voiceChannelId') ?? '').trim();
    const userId = String(req.headers['x-user-id'] ?? '').trim();
    const page = Number.parseInt(String(url.searchParams.get('page') ?? '1'), 10);

    if (!guildId || !voiceChannelId || !userId) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'guildId, voiceChannelId and X-User-Id are required' }));
      return;
    }

    const userVoiceChannelId = getUserVoiceChannelId(this.voiceStateStore, guildId, userId);
    if (!userVoiceChannelId || userVoiceChannelId !== voiceChannelId) {
      res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'not_in_voice' }));
      return;
    }

    const session = this.sessions.get(guildId, voiceChannelId);
    const history = await buildGuildHistoryPayload({
      guildId,
      page,
      session,
      library: this.library,
    });

    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify({ history, ts: Date.now() }));
  }

  async _handleDashboardHubGet(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: URL,
  ): Promise<void> {
    if (!this._authorizeRequest(req, res)) return;
    if (!this.library) {
      res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'library unavailable' }));
      return;
    }

    const guildId = String(url.searchParams.get('guildId') ?? '').trim();
    const userId = String(req.headers['x-user-id'] ?? '').trim();
    if (!guildId || !userId) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'guildId and X-User-Id are required' }));
      return;
    }

    const member = await this._resolveMemberProfile(guildId, userId);
    if (!member && this.getGuildMember) {
      res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'guild access denied' }));
      return;
    }

    try {
      const hub = await buildDashboardHubPayload(this.library, guildId, userId);
      const recap = hub.recap as { topRequesters?: Array<{ userId?: unknown }> } | null;
      const requesterIds = (recap?.topRequesters ?? [])
        .map((entry) => String(entry?.userId ?? '').trim())
        .filter(Boolean);
      if (requesterIds.length) {
        const profiles = await this._resolveMemberProfiles(guildId, requesterIds);
        recap!.topRequesters = (recap!.topRequesters ?? []).map((entry) => {
          const profile = profiles.get(String(entry?.userId ?? '').trim());
          return profile
            ? { ...entry, name: profile.username, avatarUrl: profile.avatarUrl }
            : entry;
        });
      }
      let lastfm: Record<string, unknown> | null = null;
      if (this.lastfm) {
        const account = await this.lastfm.accounts.get(userId);
        if (account) {
          const [recent, topTracks] = await Promise.all([
            this.lastfm.client.userGetRecentTracks(account.username, 8).catch(() => []),
            this.lastfm.client.userGetTopTracks(account.username, '7day', 8).catch(() => []),
          ]);
          lastfm = { account, recent, topTracks };
        } else {
          lastfm = { account: null, recent: [], topTracks: [] };
        }
      }
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(JSON.stringify({
        hub: { ...hub, lastfm, party: partyStateStore.get(guildId) },
        ts: Date.now(),
      }));
    } catch (err) {
      this.logger?.warn?.('Dashboard hub load failed', {
        guildId,
        userId,
        error: err instanceof Error ? err.message : String(err),
      });
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'dashboard hub failed' }));
    }
  }

  async _handleTrackLyricsGet(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: URL,
  ): Promise<void> {
    if (!this._authorizeRequest(req, res)) return;

    const guildId = String(url.searchParams.get('guildId') ?? '').trim();
    const voiceChannelId = String(url.searchParams.get('voiceChannelId') ?? '').trim();
    const userId = String(req.headers['x-user-id'] ?? '').trim();
    const queryParam = String(url.searchParams.get('query') ?? '').trim();

    if (!guildId || !voiceChannelId || !userId) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'guildId, voiceChannelId and X-User-Id are required' }));
      return;
    }

    const userVoiceChannelId = getUserVoiceChannelId(this.voiceStateStore, guildId, userId);
    if (!userVoiceChannelId || userVoiceChannelId !== voiceChannelId) {
      res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'not_in_voice' }));
      return;
    }

    if (!this.lyrics) {
      res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'lyrics unavailable' }));
      return;
    }

    const session = this.sessions.get(guildId, voiceChannelId);
    const searchQuery = buildLyricsSearchQuery(session, queryParam);
    if (!searchQuery) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'query required' }));
      return;
    }

    const result = await this.lyrics.search(searchQuery);
    if (!result?.lyrics) {
      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'not found', query: searchQuery }));
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify({
      lyrics: {
        query: searchQuery,
        source: result.source,
        lyrics: result.lyrics,
        syncedLyrics: result.syncedLyrics ?? null,
      },
      ts: Date.now(),
    }));
  }

  async _handleUserVoiceGet(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: URL,
  ): Promise<void> {
    if (!this._authorizeRequest(req, res)) return;

    const userId = String(req.headers['x-user-id'] ?? '').trim();
    if (!userId) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'X-User-Id is required' }));
      return;
    }

    const rawGuildIds = String(url.searchParams.get('guildIds') ?? '').trim();
    const allowedGuildIds = rawGuildIds
      ? rawGuildIds.split(',').map((entry) => entry.trim()).filter(Boolean)
      : [];

    const binding = findUserVoiceBinding(this.voiceStateStore, userId, allowedGuildIds);

    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify({ voice: binding, ts: Date.now() }));
  }

  async _handleSessionGet(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: URL,
  ): Promise<void> {
    if (!this._authorizeRequest(req, res)) return;

    const guildId = String(url.searchParams.get('guildId') ?? '').trim();
    const voiceChannelId = String(url.searchParams.get('voiceChannelId') ?? '').trim();
    const userId = String(req.headers['x-user-id'] ?? '').trim();
    const roleIds = await this._resolveRoleIds(
      guildId,
      userId,
      parseRoleIds(req.headers['x-user-role-ids']),
    );

    if (!guildId || !voiceChannelId || !userId) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'guildId, voiceChannelId and X-User-Id are required' }));
      return;
    }

    const payload = await this._buildPayload(guildId, voiceChannelId, userId, roleIds);
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify({ session: payload, ts: Date.now() }));
  }

  async _handleSessionAction(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!this._authorizeRequest(req, res)) return;

    const body = await this._readJsonBody(req);
    if (!body) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'invalid json body' }));
      return;
    }

    const guildId = String(body.guildId ?? '').trim();
    const voiceChannelId = String(body.voiceChannelId ?? '').trim();
    const userId = String(body.userId ?? req.headers['x-user-id'] ?? '').trim();
    const roleIds = await this._resolveRoleIds(
      guildId,
      userId,
      parseRoleIds(body.roleIds ?? req.headers['x-user-role-ids']),
    );
    const action = this._parseAction(body, userId);

    if (!guildId || !voiceChannelId || !userId || !action) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'guildId, voiceChannelId, userId and action are required' }));
      return;
    }

    const session = this.sessions.get(guildId, voiceChannelId);
    if (!session) {
      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'session not found' }));
      return;
    }

    const payloadBefore = await this._buildPayload(guildId, voiceChannelId, userId, roleIds);
    if (!payloadBefore?.canControl) {
      res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'control not allowed' }));
      return;
    }

    const result = await runDashboardAction(session, action);
    if (!result.ok) {
      res.writeHead(409, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'action rejected' }));
      return;
    }

    const payload = await this._buildPayload(guildId, voiceChannelId, userId, roleIds);
    this._broadcastGuild(guildId);
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify({
      ok: true,
      added: result.added ?? null,
      session: payload,
      ts: Date.now(),
    }));
  }

  async _applyClientAction(client: DashboardClient, payload: Record<string, unknown>): Promise<void> {
    if (!client.subscription) {
      this._sendSocket(client, { op: 'error', message: 'not subscribed' });
      return;
    }

    const { guildId, voiceChannelId, userId, roleIds: clientRoleIds } = client.subscription;
    const action = this._parseAction(payload, userId);
    if (!action) {
      this._sendSocket(client, { op: 'error', message: 'invalid action' });
      return;
    }

    const requestId = String(payload.requestId ?? '').trim() || null;
    const userVoiceChannelId = getUserVoiceChannelId(this.voiceStateStore, guildId, userId);
    if (!userVoiceChannelId || userVoiceChannelId !== voiceChannelId) {
      this._sendSocket(client, { op: 'error', message: 'not_in_voice', requestId });
      return;
    }

    if (action.type === 'join') {
      try {
        const joined = await this.sessions.ensure(guildId, null, { voiceChannelId });
        await joined.connection.connect?.(voiceChannelId);
        this._broadcastGuild(guildId);
        this._sendSocket(client, { op: 'action_result', ok: true, action: action.type, requestId });
      } catch (err) {
        this.logger?.warn?.('Dashboard voice join failed', {
          guildId,
          voiceChannelId,
          error: err instanceof Error ? err.message : String(err),
        });
        this._sendSocket(client, { op: 'error', message: 'join_failed', requestId });
      }
      return;
    }

    const session = this.sessions.get(guildId, voiceChannelId);
    if (!session) {
      this._sendSocket(client, { op: 'error', message: 'session not found', requestId });
      return;
    }

    const roleIds = await this._resolveRoleIds(guildId, userId, clientRoleIds);
    const view = await this._buildPayload(guildId, voiceChannelId, userId, roleIds);
    if (action.type === 'lastFm') {
      if (!this.lastfm) {
        this._sendSocket(client, { op: 'error', message: 'lastfm unavailable', requestId });
        return;
      }

      if (action.operation === 'connect') {
        const token = await this.lastfm.client.getToken();
        this.pendingLastFmTokens.set(userId, token);
        const authUrl = this.lastfm.client.buildAuthUrl(token);
        this._sendSocket(client, { op: 'action_result', ok: true, action: action.type, operation: action.operation, authUrl, requestId });
        return;
      }

      if (action.operation === 'complete') {
        const token = this.pendingLastFmTokens.get(userId);
        if (!token) {
          this._sendSocket(client, { op: 'error', message: 'lastfm connection expired', requestId });
          return;
        }
        const lastFmSession = await this.lastfm.client.getSession(token);
        await this.lastfm.accounts.link(userId, lastFmSession.name, lastFmSession.key);
        this.pendingLastFmTokens.delete(userId);
        this._sendSocket(client, { op: 'action_result', ok: true, action: action.type, operation: action.operation, requestId });
        return;
      }

      if (action.operation === 'disconnect') {
        await this.lastfm.accounts.unlink(userId);
        this.pendingLastFmTokens.delete(userId);
        this._sendSocket(client, { op: 'action_result', ok: true, action: action.type, operation: action.operation, requestId });
        return;
      }

      if (action.operation === 'toggle') {
        await this.lastfm.accounts.setScrobblingEnabled(userId, Boolean(action.enabled));
        this._sendSocket(client, { op: 'action_result', ok: true, action: action.type, operation: action.operation, requestId });
        return;
      }

      const current = session.player.currentTrack as Track | null | undefined;
      const artist = String(current?.artist ?? '').trim();
      const title = String(current?.title ?? '').trim();
      const sessionKey = await this.lastfm.accounts.getSessionKey(userId);
      if (!artist || !title || !sessionKey) {
        this._sendSocket(client, { op: 'error', message: 'lastfm account or track unavailable', requestId });
        return;
      }
      if (action.operation === 'love') {
        await this.lastfm.client.loveTrack(sessionKey, artist, title);
        await this.lastfm.accounts.recordLove(userId, 1);
      } else {
        await this.lastfm.client.unloveTrack(sessionKey, artist, title);
        await this.lastfm.accounts.recordLove(userId, -1);
      }
      this._sendSocket(client, { op: 'action_result', ok: true, action: action.type, operation: action.operation, requestId });
      return;
    }

    if (action.type === 'handoff') {
      if (!this._canManageGuild(guildId, userId, roleIds)) {
        this._sendSocket(client, { op: 'error', message: 'manage guild required', requestId });
        return;
      }
      const mutableSession = session as Session & {
        tempDjHandoff?: { userId: string; expiresAt: number } | null;
      };
      mutableSession.tempDjHandoff = action.userId
        ? { userId: action.userId, expiresAt: Date.now() + action.minutes * 60_000 }
        : null;
      this._broadcastGuild(guildId);
      this._sendSocket(client, { op: 'action_result', ok: true, action: action.type, requestId });
      return;
    }
    if (action.type === 'party') {
      if ((action.operation === 'start' || action.operation === 'end') && !view?.canControl) {
        this._sendSocket(client, { op: 'error', message: 'control not allowed', requestId });
        return;
      }

      let party = partyStateStore.get(guildId);
      let alreadyVoted = false;
      if (action.operation === 'start') party = partyStateStore.start(guildId);
      if (action.operation === 'end') {
        partyStateStore.end(guildId);
        party = null;
      }
      if (action.operation === 'join' && action.team) {
        party = partyStateStore.join(guildId, userId, action.team);
      }
      if (action.operation === 'vote' && action.team) {
        const result = partyStateStore.vote(guildId, userId, action.team);
        party = result.snapshot;
        alreadyVoted = result.alreadyVoted;
      }
      if (!party && action.operation !== 'end') {
        this._sendSocket(client, { op: 'error', message: 'party not active', requestId });
        return;
      }
      this._sendSocket(client, {
        op: 'action_result',
        ok: true,
        action: action.type,
        operation: action.operation,
        party,
        alreadyVoted,
        requestId,
      });
      return;
    }
    if (action.type === 'voteSkip') {
      const vote = this.sessions.registerVoteSkip(guildId, userId, { voiceChannelId });
      if (!vote) {
        this._sendSocket(client, { op: 'error', message: 'nothing_playing', requestId });
        return;
      }
      const listenerCount = this.voiceStateStore.countUsersInChannel(
        guildId,
        voiceChannelId,
        this.botUserId ? [this.botUserId] : [],
      );
      const ratio = Math.max(0.1, Math.min(1, Number(session.settings?.voteSkipRatio ?? 0.5)));
      const minimum = Math.max(1, Number(session.settings?.voteSkipMinVotes ?? 2));
      const required = Math.max(minimum, Math.ceil(Math.max(1, listenerCount) * ratio));
      if (vote.votes >= required) {
        (session.player as Session['player'] & { skip?: () => unknown }).skip?.();
        this.sessions.clearVoteSkips(guildId, { voiceChannelId });
      }
      this._broadcastGuild(guildId);
      this._sendSocket(client, {
        op: 'action_result',
        ok: true,
        action: action.type,
        votes: vote.votes,
        required,
        requestId,
      });
      return;
    }
    if (action.type === 'favoriteCurrent') {
      if (!this.library || !session.player.currentTrack) {
        this._sendSocket(client, { op: 'error', message: 'nothing_playing', requestId });
        return;
      }
      const favorite = await toggleUserFavorite(
        this.library,
        userId,
        session.player.currentTrack as Track,
      );
      this._sendSocket(client, {
        op: 'action_result',
        ok: true,
        action: action.type,
        favorite,
        trackId: serializeTrack(session.player.currentTrack as Track, 0).id,
        requestId,
      });
      return;
    }
    if (action.type === 'favoriteRename' || action.type === 'favoriteRemove') {
      if (!this.library) {
        this._sendSocket(client, { op: 'error', message: 'library unavailable', requestId });
        return;
      }
      try {
        const result = action.type === 'favoriteRename'
          ? await this.library.renameUserFavorite(userId, action.index, action.alias)
          : await this.library.removeUserFavorite(userId, action.index);
        this._sendSocket(client, {
          op: 'action_result',
          ok: result != null,
          action: action.type,
          requestId,
        });
      } catch (err) {
        this._sendSocket(client, {
          op: 'error',
          message: err instanceof Error ? err.message : 'favorite update failed',
          requestId,
        });
      }
      return;
    }
    if (!view?.canControl) {
      this._sendSocket(client, { op: 'error', message: 'control not allowed', requestId });
      return;
    }

    if (
      action.type === 'playlistCreate'
      || action.type === 'playlistDelete'
      || action.type === 'playlistAddCurrent'
      || action.type === 'templateDelete'
      || action.type === 'stationCreate'
      || action.type === 'stationDelete'
    ) {
      if (!this.library) {
        this._sendSocket(client, { op: 'error', message: 'library unavailable', requestId });
        return;
      }
      try {
        let ok = true;
        if (action.type === 'playlistCreate') {
          await this.library.createGuildPlaylist(guildId, action.name, userId);
        } else if (action.type === 'playlistDelete') {
          ok = await this.library.deleteGuildPlaylist(guildId, action.name);
        } else if (action.type === 'templateDelete') {
          ok = Boolean(await this.library.deleteQueueTemplate(guildId, action.key));
        } else if (action.type === 'stationCreate') {
          await this.library.setGuildStation(guildId, action.name, { url: action.url }, userId);
        } else if (action.type === 'stationDelete') {
          ok = Boolean(await this.library.deleteGuildStation(guildId, action.key));
        } else {
          const current = session.player.currentTrack;
          if (!current) {
            this._sendSocket(client, { op: 'error', message: 'nothing_playing', requestId });
            return;
          }
          await this.library.addTracksToGuildPlaylist(guildId, action.name, [current], userId);
        }
        this._sendSocket(client, { op: 'action_result', ok, action: action.type, requestId });
      } catch (err) {
        this._sendSocket(client, {
          op: 'error',
          message: err instanceof Error ? err.message : 'library update failed',
          requestId,
        });
      }
      return;
    }

    if (action.type === 'autoplay') {
      if (!this.library) {
        this._sendSocket(client, { op: 'error', message: 'library unavailable', requestId });
        return;
      }
      await this.library.setVoiceProfile(guildId, voiceChannelId, { autoplayEnabled: action.enabled });
      await this.sessions.refreshVoiceProfileSettings(guildId, { voiceChannelId });
      this._broadcastGuild(guildId);
      this._sendSocket(client, {
        op: 'action_result',
        ok: true,
        action: action.type,
        enabled: action.enabled,
        requestId,
      });
      return;
    }

    if (action.type === 'search') {
      const player = session.player as Session['player'] & {
        searchCandidates?: (query: string, limit: number, options: { requestedBy: string }) => Promise<Track[]>;
      };
      if (typeof player.searchCandidates !== 'function' && typeof player.previewTracks !== 'function') {
        this._sendSocket(client, { op: 'error', message: 'search unavailable', requestId });
        return;
      }
      const tracks = (typeof player.searchCandidates === 'function'
        ? await player.searchCandidates(action.query, 8, { requestedBy: userId })
        : await player.previewTracks!(action.query, { requestedBy: userId, limit: 8 })) as Track[];
      this._sendSocket(client, {
        op: 'action_result',
        ok: true,
        action: action.type,
        query: action.query,
        results: tracks.map((track, index) => ({
          ...serializeTrack(track, index),
          url: String(track.url ?? '').trim() || null,
        })),
        requestId,
      });
      return;
    }

    if (action.type === 'saveTemplate') {
      if (!this.library) {
        this._sendSocket(client, { op: 'error', message: 'library unavailable', requestId });
        return;
      }
      const tracks = [session.player.currentTrack, ...(session.player.pendingTracks ?? [])].filter(Boolean);
      await this.library.setQueueTemplate(guildId, action.name, tracks, userId);
      this._sendSocket(client, { op: 'action_result', ok: true, action: action.type, requestId });
      return;
    }

    if (action.type === 'libraryPlay') {
      if (!this.library) {
        this._sendSocket(client, { op: 'error', message: 'library unavailable', requestId });
        return;
      }
      const player = session.player as Session['player'] & {
        enqueue?: (query: string, options: { requestedBy: string; playNext: boolean; dedupe: boolean }) => Promise<unknown[]>;
      };
      if (typeof player.enqueue !== 'function') {
        this._sendSocket(client, { op: 'error', message: 'player unavailable', requestId });
        return;
      }

      let tracks: Array<Record<string, unknown>> = [];
      if (action.kind === 'playlist') {
        const playlist = await this.library.getGuildPlaylist(guildId, action.key);
        tracks = Array.isArray(playlist?.tracks) ? playlist.tracks as Array<Record<string, unknown>> : [];
      } else if (action.kind === 'template') {
        const template = await this.library.getQueueTemplate(guildId, action.key);
        tracks = Array.isArray(template?.tracks) ? template.tracks as Array<Record<string, unknown>> : [];
      } else if (action.kind === 'station') {
        const station = await this.library.getGuildStation(guildId, action.key);
        if (station) tracks = [station as unknown as Record<string, unknown>];
      } else {
        const favorite = await this.library.getUserFavorite(userId, Number.parseInt(action.key, 10));
        if (favorite) tracks = [favorite as Record<string, unknown>];
      }

      let added = 0;
      for (const track of tracks) {
        const query = String(track.url ?? '').trim()
          || `${String(track.title ?? '').trim()} ${String(track.artist ?? '').trim()}`.trim();
        if (!query) continue;
        const result = await player.enqueue(query, {
          requestedBy: userId,
          playNext: false,
          dedupe: Boolean(session.settings?.dedupeEnabled),
        });
        added += result.length;
      }
      if (added > 0 && !session.player.playing && !session.player.currentTrack) {
        await session.player.play?.();
      }
      this._broadcastGuild(guildId);
      this._sendSocket(client, { op: 'action_result', ok: added > 0, action: action.type, added, requestId });
      return;
    }

    if (action.type === 'leave') {
      const removed = await this.sessions.destroy(guildId, 'dashboard', { voiceChannelId });
      this._broadcastGuild(guildId);
      this._sendSocket(client, { op: 'action_result', ok: removed, action: action.type, requestId });
      return;
    }

    const result = await runDashboardAction(session, action);
    if (!result.ok) {
      this._sendSocket(client, { op: 'error', message: 'action rejected', requestId });
      return;
    }

    this._broadcastGuild(guildId);
    this._sendSocket(client, {
      op: 'action_result',
      ok: true,
      action: action.type,
      added: result.added ?? null,
      requestId,
    });
  }

  async _handleGuildSettingsGet(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: URL,
  ): Promise<void> {
    if (!this._authorizeRequest(req, res)) return;
    if (!this.guildConfigs || !this.library) {
      res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'settings unavailable' }));
      return;
    }

    const guildId = String(url.searchParams.get('guildId') ?? '').trim();
    const userId = String(req.headers['x-user-id'] ?? '').trim();
    if (!guildId || !userId) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'guildId and X-User-Id are required' }));
      return;
    }

    const roleIds = await this._resolveRoleIds(
      guildId,
      userId,
      parseRoleIds(req.headers['x-user-role-ids']),
    );
    const canManage = this._canManageGuild(guildId, userId, roleIds);
    const guildConfig = await this.guildConfigs.get(guildId);
    const features = await this.library.getGuildFeatureConfig(guildId);
    const settings = buildGuildSettingsPayload(
      guildConfig,
      features,
      canManage,
    );

    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify({ settings, ts: Date.now() }));
  }

  async _handleGuildSettingsPatch(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: URL,
  ): Promise<void> {
    if (!this._authorizeRequest(req, res)) return;
    if (!this.guildConfigs || !this.library) {
      res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'settings unavailable' }));
      return;
    }

    const guildId = String(url.searchParams.get('guildId') ?? '').trim();
    const userId = String(req.headers['x-user-id'] ?? '').trim();
    if (!guildId || !userId) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'guildId and X-User-Id are required' }));
      return;
    }

    const roleIds = await this._resolveRoleIds(
      guildId,
      userId,
      parseRoleIds(req.headers['x-user-role-ids']),
    );
    if (!this._canManageGuild(guildId, userId, roleIds)) {
      res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'forbidden' }));
      return;
    }

    const body = await this._readJsonBody(req);
    if (!body) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'invalid json body' }));
      return;
    }

    const patch = body.patch as DashboardGuildSettingsPatch | undefined;
    if (!patch || typeof patch !== 'object') {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'patch object is required' }));
      return;
    }

    try {
      const settings = await applyGuildSettingsPatch(
        guildId,
        patch,
        this.guildConfigs as GuildConfigStoreLike,
        this.library,
      );
      const updatedGuildConfig = await this.guildConfigs.get(guildId);
      this.sessions.applyGuildConfig(guildId, updatedGuildConfig as GuildConfig);
      if (patch.voiceProfiles) {
        await Promise.all(this.sessions.listByGuild(guildId).map((session) => {
          const voiceChannelId = String(session.connection?.channelId ?? session.targetVoiceChannelId ?? '').trim();
          return voiceChannelId
            ? this.sessions.refreshVoiceProfileSettings(guildId, { voiceChannelId })
            : Promise.resolve();
        }));
      }
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(JSON.stringify({ settings, ts: Date.now() }));
    } catch (err) {
      this.logger?.warn?.('Dashboard guild settings patch failed', {
        guildId,
        userId,
        error: err instanceof Error ? err.message : String(err),
      });
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'invalid patch' }));
    }
  }

  _canManageGuild(guildId: string, userId: string, roleIds: string[]): boolean {
    const ownerId = this.guildStateCache?.resolveOwnerId(guildId) ?? null;
    if (ownerId && ownerId === userId) return true;
    const verdict = this.guildStateCache?.computeManageGuildPermission(guildId, roleIds, userId);
    return verdict === true;
  }

  _authorizeRequest(req: http.IncomingMessage, res: http.ServerResponse): boolean {
    const token = readBearerToken(req.headers.authorization)
      ?? (String(req.headers['x-dashboard-secret'] ?? '').trim() || null);
    if (!isAuthorized(this.secret ?? '', token)) {
      res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return false;
    }
    return true;
  }

  _parseAction(body: Record<string, unknown>, userId: string): DashboardAction | null {
    const type = String(body.action ?? body.type ?? '').trim().toLowerCase();
    switch (type) {
      case 'join':
        return { type: 'join' };
      case 'leave':
        return { type: 'leave' };
      case 'voteskip':
      case 'vote_skip':
        return { type: 'voteSkip' };
      case 'search': {
        const query = String(body.query ?? '').trim();
        if (!query || query.length > 500) return null;
        return { type: 'search', query };
      }
      case 'favoritecurrent':
      case 'favorite_current':
        return { type: 'favoriteCurrent' };
      case 'autoplay':
        return { type: 'autoplay', enabled: body.enabled === true };
      case 'savetemplate':
      case 'save_template': {
        const name = String(body.name ?? '').trim();
        if (!name || name.length > 80) return null;
        return { type: 'saveTemplate', name };
      }
      case 'libraryplay':
      case 'library_play': {
        const kind = String(body.kind ?? '').trim().toLowerCase();
        const key = String(body.key ?? '').trim();
        if (!key || !['playlist', 'template', 'favorite', 'station'].includes(kind)) return null;
        return { type: 'libraryPlay', kind: kind as 'playlist' | 'template' | 'favorite' | 'station', key };
      }
      case 'handoff': {
        const rawUserId = String(body.targetUserId ?? '').trim();
        const off = body.off === true || String(body.off ?? '').toLowerCase() === 'true';
        const minutes = Math.max(1, Math.min(240, Number.parseInt(String(body.minutes ?? 15), 10) || 15));
        if (!off && !rawUserId) return null;
        return { type: 'handoff', userId: off ? null : rawUserId, minutes };
      }
      case 'lastfm': {
        const operation = String(body.operation ?? '').trim().toLowerCase();
        if (!['connect', 'complete', 'disconnect', 'toggle', 'love', 'unlove'].includes(operation)) return null;
        return {
          type: 'lastFm',
          operation: operation as 'connect' | 'complete' | 'disconnect' | 'toggle' | 'love' | 'unlove',
          ...(operation === 'toggle' ? { enabled: Boolean(body.enabled) } : {}),
        };
      }
      case 'party': {
        const operation = String(body.operation ?? '').trim().toLowerCase();
        if (!['start', 'join', 'vote', 'end'].includes(operation)) return null;
        const team = String(body.team ?? '').trim().toLowerCase();
        if ((operation === 'join' || operation === 'vote') && team !== 'a' && team !== 'b') return null;
        return {
          type: 'party',
          operation: operation as 'start' | 'join' | 'vote' | 'end',
          ...(team === 'a' || team === 'b' ? { team } : {}),
        };
      }
      case 'favoriterename':
      case 'favorite_rename': {
        const index = Number.parseInt(String(body.index ?? ''), 10);
        const alias = String(body.alias ?? '').trim();
        if (!Number.isFinite(index) || index < 1 || !alias || alias.length > 80) return null;
        return { type: 'favoriteRename', index, alias };
      }
      case 'favoriteremove':
      case 'favorite_remove': {
        const index = Number.parseInt(String(body.index ?? ''), 10);
        if (!Number.isFinite(index) || index < 1) return null;
        return { type: 'favoriteRemove', index };
      }
      case 'playlistcreate':
      case 'playlist_create': {
        const name = String(body.name ?? '').trim();
        if (!name || name.length > 80) return null;
        return { type: 'playlistCreate', name };
      }
      case 'playlistdelete':
      case 'playlist_delete': {
        const name = String(body.name ?? '').trim();
        if (!name || name.length > 80) return null;
        return { type: 'playlistDelete', name };
      }
      case 'playlistaddcurrent':
      case 'playlist_add_current': {
        const name = String(body.name ?? '').trim();
        if (!name || name.length > 80) return null;
        return { type: 'playlistAddCurrent', name };
      }
      case 'stationcreate':
      case 'station_create': {
        const name = String(body.name ?? '').trim();
        const url = String(body.url ?? '').trim();
        if (!name || name.length > 80) return null;
        if (!/^https?:\/\//i.test(url) || url.length > 500) return null;
        return { type: 'stationCreate', name, url };
      }
      case 'stationdelete':
      case 'station_delete': {
        const key = String(body.key ?? '').trim();
        if (!key || key.length > 80) return null;
        return { type: 'stationDelete', key };
      }
      case 'templatedelete':
      case 'template_delete': {
        const key = String(body.key ?? '').trim();
        if (!key || key.length > 80) return null;
        return { type: 'templateDelete', key };
      }
      case 'pause':
        return { type: 'pause' };
      case 'resume':
        return { type: 'resume' };
      case 'skip':
        return { type: 'skip' };
      case 'enqueue':
      case 'play': {
        const query = String(body.query ?? '').trim();
        if (!query || query.length > 500) return null;
        const playNextRaw = body.playNext;
        const playNext = playNextRaw === true
          || String(playNextRaw ?? '').trim().toLowerCase() === 'true'
          || String(playNextRaw ?? '').trim() === '1';
        return {
          type: 'enqueue',
          query,
          playNext,
          requestedBy: String(userId ?? '').trim(),
        };
      }
      case 'volume': {
        const volumePercent = Number.parseInt(String(body.volumePercent ?? ''), 10);
        if (!Number.isFinite(volumePercent)) return null;
        return { type: 'volume', volumePercent };
      }
      case 'seek': {
        const positionSec = Number.parseInt(String(body.positionSec ?? ''), 10);
        if (!Number.isFinite(positionSec) || positionSec < 0) return null;
        return { type: 'seek', positionSec };
      }
      case 'remove': {
        const queueIndex = Number.parseInt(String(body.queueIndex ?? ''), 10);
        if (!Number.isFinite(queueIndex) || queueIndex < 1) return null;
        return { type: 'remove', queueIndex };
      }
      case 'reorder': {
        const fromIndex = Number.parseInt(String(body.fromIndex ?? ''), 10);
        const toIndex = Number.parseInt(String(body.toIndex ?? ''), 10);
        if (!Number.isFinite(fromIndex) || !Number.isFinite(toIndex) || fromIndex < 1 || toIndex < 1) return null;
        return { type: 'reorder', fromIndex, toIndex };
      }
      case 'shuffle':
        return { type: 'shuffle' };
      case 'loop': {
        const mode = String(body.mode ?? body.loopMode ?? '').trim().toLowerCase();
        if (mode !== 'off' && mode !== 'track' && mode !== 'queue') return null;
        return { type: 'loop', mode };
      }
      case 'previous':
        return { type: 'previous' };
      case 'clear':
        return { type: 'clear' };
      case 'replay':
        return { type: 'replay' };
      case 'effects': {
        return {
          type: 'effects',
          filterPreset: String(body.filterPreset ?? 'off').trim().toLowerCase(),
          eqPreset: String(body.eqPreset ?? 'flat').trim().toLowerCase(),
          tempoRatio: Number(body.tempoRatio ?? 1),
          pitchSemitones: Number(body.pitchSemitones ?? 0),
        };
      }
      case 'playhistory':
      case 'play_history': {
        const query = String(body.query ?? '').trim();
        if (!query || query.length > 500) return null;
        return { type: 'playHistory', query, requestedBy: String(userId ?? '').trim() };
      }
      case 'playqueueindex':
      case 'play_queue_index': {
        const queueIndex = Number.parseInt(String(body.queueIndex ?? ''), 10);
        if (!Number.isFinite(queueIndex) || queueIndex < 1) return null;
        return { type: 'playQueueIndex', queueIndex };
      }
      default:
        return null;
    }
  }

  _handleSocket(socket: WebSocket): void {
    const client: DashboardClient = {
      socket,
      authenticated: false,
      subscription: null,
    };
    this.clients.add(client);

    socket.on('message', (data: Buffer | ArrayBuffer | Buffer[]) => {
      const payload = parseJsonBody(Buffer.isBuffer(data) ? data.toString('utf8') : String(data));
      if (!payload) {
        this._sendSocket(client, { op: 'error', message: 'invalid json' });
        return;
      }

      const op = String(payload.op ?? '').trim().toLowerCase();
      if (op === 'auth') {
        const secret = String(payload.secret ?? '').trim();
        client.authenticated = isAuthorized(this.secret ?? '', secret);
        this._sendSocket(client, { op: client.authenticated ? 'auth_ok' : 'auth_fail' });
        return;
      }

      if (!client.authenticated) {
        this._sendSocket(client, { op: 'error', message: 'unauthorized' });
        return;
      }

      if (op === 'subscribe') {
        void this._handleSubscribe(client, payload).catch((err) => {
          this.logger?.warn?.('Dashboard websocket subscribe failed', {
            error: err instanceof Error ? err.message : String(err),
          });
          this._sendSocket(client, { op: 'error', message: 'subscribe failed' });
        });
        return;
      }

      if (op === 'action') {
        void this._applyClientAction(client, payload).catch((err) => {
          this.logger?.warn?.('Dashboard websocket action failed', {
            error: err instanceof Error ? err.message : String(err),
          });
          this._sendSocket(client, { op: 'error', message: 'action failed' });
        });
        return;
      }

      this._sendSocket(client, { op: 'error', message: 'unknown op' });
    });

    socket.on('close', () => {
      this.clients.delete(client);
      this._syncSpectrumTaps();
    });
  }

  async _resolveGuildName(guildId: string): Promise<string> {
    const safeGuildId = String(guildId ?? '').trim();
    if (!safeGuildId) return '';
    const cached = readTtlCache(this.guildNameCache, safeGuildId);
    if (cached) return cached;

    if (!this.resolveGuildName) return safeGuildId;
    try {
      const name = await this.resolveGuildName(safeGuildId);
      const resolved = String(name ?? '').trim();
      if (resolved) {
        writeTtlCache(this.guildNameCache, safeGuildId, resolved, NAME_CACHE_TTL_MS, NAME_CACHE_MAX_ENTRIES);
        return resolved;
      }
    } catch (err) {
      this.logger?.warn?.('Dashboard guild name resolution failed', {
        guildId: safeGuildId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return safeGuildId;
  }

  async _resolveChannelName(channelId: string): Promise<string> {
    const safeChannelId = String(channelId ?? '').trim();
    if (!safeChannelId) return '';
    const cached = readTtlCache(this.channelNameCache, safeChannelId);
    if (cached) return cached;

    if (!this.resolveChannelName) return safeChannelId;
    try {
      const name = await this.resolveChannelName(safeChannelId);
      const resolved = String(name ?? '').trim();
      if (resolved) {
        writeTtlCache(this.channelNameCache, safeChannelId, resolved, NAME_CACHE_TTL_MS, NAME_CACHE_MAX_ENTRIES);
        return resolved;
      }
    } catch (err) {
      this.logger?.warn?.('Dashboard channel name resolution failed', {
        channelId: safeChannelId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return safeChannelId;
  }

  _collectGuildChannelIds(guildId: string, extraChannelIds: string[] = []): string[] {
    const ids = new Set<string>();
    for (const session of this.sessions.listByGuild(guildId)) {
      const channelId = String(
        session.connection?.channelId ?? session.targetVoiceChannelId ?? '',
      ).trim();
      if (channelId) ids.add(channelId);
    }
    for (const channelId of extraChannelIds) {
      const safe = String(channelId ?? '').trim();
      if (safe) ids.add(safe);
    }
    return [...ids];
  }

  async _buildChannelNameMap(
    guildId: string,
    extraChannelIds: string[] = [],
  ): Promise<Map<string, string>> {
    const ids = this._collectGuildChannelIds(guildId, extraChannelIds);
    const map = new Map<string, string>();
    await Promise.all(ids.map(async (channelId) => {
      map.set(channelId, await this._resolveChannelName(channelId));
    }));
    return map;
  }

  async _buildPayloadBase(
    guildId: string,
    voiceChannelId: string,
    userId: string,
    roleIds: string[],
  ): Promise<DashboardSessionPayload | null> {
    const sessions = this.sessions.listByGuild(guildId);
    const guildName = await this._resolveGuildName(guildId);
    const channelNames = await this._buildChannelNameMap(guildId, [voiceChannelId]);
    return buildGuildDashboardSessionPayload({
      guildId,
      guildName,
      sessions,
      voiceChannelId,
      userId,
      roleIds,
      voiceStateStore: this.voiceStateStore,
      botUserId: this.botUserId,
      channelNames,
    });
  }

  async _buildPayload(
    guildId: string,
    voiceChannelId: string,
    userId: string,
    roleIds: string[],
  ): Promise<DashboardSessionPayload | null> {
    const payload = await this._buildPayloadBase(guildId, voiceChannelId, userId, roleIds);
    if (!payload) return null;
    await this._enrichPayloadRequesters(guildId, payload);
    return payload;
  }

  async _handleSubscribe(client: DashboardClient, payload: Record<string, unknown>): Promise<void> {
    const guildId = String(payload.guildId ?? '').trim();
    const voiceChannelId = String(payload.voiceChannelId ?? '').trim();
    const userId = String(payload.userId ?? '').trim();
    if (!guildId || !voiceChannelId || !userId) {
      this._sendSocket(client, { op: 'error', message: 'missing subscribe fields' });
      return;
    }

    const userVoiceChannelId = getUserVoiceChannelId(this.voiceStateStore, guildId, userId);
    if (!userVoiceChannelId) {
      this._sendSocket(client, { op: 'error', message: 'not_in_voice' });
      return;
    }
    if (voiceChannelId !== userVoiceChannelId) {
      this._sendSocket(client, { op: 'error', message: 'not_in_voice' });
      return;
    }

    const roleIds = await this._resolveRoleIds(guildId, userId, parseRoleIds(payload.roleIds));
    client.subscription = { guildId, voiceChannelId, userId, roleIds };
    this._syncSpectrumTaps();
    await this._pushSession(client);
  }

  _spectrumKey(guildId: string, voiceChannelId: string): string {
    return `${guildId}:${voiceChannelId}`;
  }

  _syncSpectrumTaps(): void {
    const wanted = new Set<string>();
    for (const client of this.clients) {
      if (!client.authenticated || !client.subscription) continue;
      const { guildId, voiceChannelId } = client.subscription;
      wanted.add(this._spectrumKey(guildId, voiceChannelId));
    }

    for (const [key, tap] of this.spectrumTaps) {
      if (wanted.has(key)) continue;
      tap.detach();
      this.spectrumTaps.delete(key);
    }

    for (const key of wanted) {
      if (this.spectrumTaps.has(key)) continue;
      const [guildId = '', voiceChannelId = ''] = key.split(':');
      const session = this.sessions.get(guildId, voiceChannelId);
      const player = session?.player as (Session['player'] & {
        setSpectrumEnabled?: (enabled: boolean) => boolean;
        on?: (event: string, listener: (bands: Uint8Array) => void) => unknown;
        off?: (event: string, listener: (bands: Uint8Array) => void) => unknown;
      }) | undefined;
      if (typeof player?.setSpectrumEnabled !== 'function' || typeof player.on !== 'function') continue;

      const listener = (bands: Uint8Array) => {
        this._broadcastSpectrum(guildId, voiceChannelId, bands);
      };
      player.on('spectrum', listener);
      player.setSpectrumEnabled(true);
      this.spectrumTaps.set(key, {
        detach: () => {
          try {
            player.off?.('spectrum', listener);
            player.setSpectrumEnabled?.(false);
          } catch {
          }
        },
      });
    }
  }

  _broadcastSpectrum(guildId: string, voiceChannelId: string, bands: Uint8Array): void {
    const payload = JSON.stringify({ op: 'spectrum', bands: Array.from(bands) });
    for (const client of this.clients) {
      if (!client.authenticated || !client.subscription) continue;
      if (client.subscription.guildId !== guildId) continue;
      if (client.subscription.voiceChannelId !== voiceChannelId) continue;
      if (client.socket.readyState !== WebSocket.OPEN) continue;
      client.socket.send(payload);
    }
  }

  async _resolveRoleIds(
    guildId: string,
    userId: string,
    clientRoleIds: string[],
  ): Promise<string[]> {
    if (!this.resolveMemberRoleIds) return clientRoleIds;
    try {
      return await this.resolveMemberRoleIds(guildId, userId);
    } catch (err) {
      this.logger?.warn?.('Dashboard role resolution failed', {
        guildId,
        userId,
        error: err instanceof Error ? err.message : String(err),
      });
      return clientRoleIds;
    }
  }

  async _pushSession(client: DashboardClient): Promise<void> {
    if (!client.subscription) return;
    const { guildId, voiceChannelId, userId, roleIds: clientRoleIds } = client.subscription;
    const roleIds = await this._resolveRoleIds(guildId, userId, clientRoleIds);
    const session = await this._buildPayload(guildId, voiceChannelId, userId, roleIds);
    this._sendSocket(client, { op: 'session', data: session, ts: Date.now() });
  }

  _broadcastGuild(guildId: string): void {
    for (const client of this.clients) {
      if (!client.authenticated || !client.subscription) continue;
      if (client.subscription.guildId !== guildId) continue;
      void this._pushSession(client);
    }
  }

  _broadcastProgressTicks(): void {
    const guildIds = new Set<string>();
    for (const client of this.clients) {
      if (!client.authenticated || !client.subscription) continue;
      guildIds.add(client.subscription.guildId);
    }
    for (const guildId of guildIds) {
      const sessions = this.sessions.listByGuild(guildId);
      const playing = sessions.some((session) => Boolean(session.player?.playing && !session.player?.paused));
      if (!playing) continue;
      this._broadcastGuild(guildId);
    }
  }

  _sendSocket(client: DashboardClient, payload: Record<string, unknown>): void {
    if (client.socket.readyState !== WebSocket.OPEN) return;
    client.socket.send(JSON.stringify(payload));
  }

  async _readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown> | null> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return parseJsonBody(Buffer.concat(chunks).toString('utf8'));
  }
}
