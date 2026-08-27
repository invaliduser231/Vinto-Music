import { LASTFM_INVALID_SESSION_CODE, LastFmApiError } from '../../integrations/lastfm/LastFmClient.ts';
import { toLastFmTrack, type LastFmTrackMetadata } from '../../integrations/lastfm/trackMetadata.ts';
import { createTranslator, resolveLocale, type Locale } from '../../i18n/index.ts';
import type { LastFmClient, LastFmScrobbleEntry } from '../../integrations/lastfm/LastFmClient.ts';
import type { LastFmAccountStore } from './lastFmAccountStore.ts';
import type { LoggerLike, MessagePayload } from '../../types/core.ts';

const TICK_INTERVAL_MS = 15_000;
const NOW_PLAYING_REFRESH_MS = 60_000;
const RETRY_FLUSH_INTERVAL_MS = 5 * 60_000;
const MAX_PARALLEL_SCROBBLES = 5;
const SCROBBLE_AFTER_SECONDS = 240;
const MILESTONES = [100, 500, 1_000, 2_500, 5_000, 10_000, 25_000, 50_000];
const STREAK_MILESTONES = [7, 30, 100, 365];

type SessionLike = {
  guildId?: string | null;
  sessionId?: string | null;
  textChannelId?: string | null;
  settings?: { musicLogChannelId?: string | null; minimalMode?: boolean } | null;
  connection?: { channelId?: string | null } | null;
};

type SessionEventPayload = {
  session?: SessionLike | null;
  track?: Record<string, unknown> | null;
  seekRestart?: boolean;
  restoredFromPersistentSession?: boolean;
};

type SessionEmitterLike = {
  on: (event: string, listener: (payload?: SessionEventPayload) => void) => unknown;
  off: (event: string, listener: (payload?: SessionEventPayload) => void) => unknown;
};

type VoiceStateStoreLike = {
  getUsersInChannel: (guildId: string, channelId: string) => string[];
};

type RestLike = {
  sendMessage?: (channelId: string, payload: MessagePayload) => Promise<unknown>;
};

type GuildConfigsLike = {
  get: (guildId: string) => Promise<{ settings?: { language?: string | null | undefined } } | null>;
};

type CounterLike = { inc: (value?: number) => void };
type GaugeLike = { set: (value: number) => void };

interface ScrobbleMetrics {
  scrobblesTotal?: CounterLike;
  scrobbleFailuresTotal?: CounterLike;
  nowPlayingTotal?: CounterLike;
  accountsLinked?: GaugeLike;
}

interface ScrobbleServiceOptions {
  client: LastFmClient;
  accounts: LastFmAccountStore;
  voiceStateStore: VoiceStateStoreLike;
  rest?: RestLike | null;
  guildConfigs?: GuildConfigsLike | null;
  logger?: LoggerLike | undefined;
  metrics?: ScrobbleMetrics | null;
  botUserId?: string | null;
  minDurationSec?: number;
  fallbackLocale?: string | null;
}

interface ActivePlayback {
  guildId: string;
  channelId: string;
  textChannelId: string | null;
  minimalMode: boolean;
  meta: LastFmTrackMetadata;
  startedAtMs: number;
  lastTickMs: number;
  listenedMs: Map<string, number>;
  nowPlayingSent: Set<string>;
  notified: Set<string>;
}

export class ScrobbleService {
  client: LastFmClient;
  accounts: LastFmAccountStore;
  voiceStateStore: VoiceStateStoreLike;
  rest: RestLike | null;
  guildConfigs: GuildConfigsLike | null;
  logger: LoggerLike | undefined;
  metrics: ScrobbleMetrics | null;
  botUserId: string | null;
  minDurationSec: number;
  fallbackLocale: string | null;

  private active: Map<string, ActivePlayback>;
  private sessions: SessionEmitterLike | null;
  private listeners: Map<string, (payload?: SessionEventPayload) => void>;
  private tickHandle: NodeJS.Timeout | null;
  private retryHandle: NodeJS.Timeout | null;

  constructor(options: ScrobbleServiceOptions) {
    this.client = options.client;
    this.accounts = options.accounts;
    this.voiceStateStore = options.voiceStateStore;
    this.rest = options.rest ?? null;
    this.guildConfigs = options.guildConfigs ?? null;
    this.logger = options.logger ?? undefined;
    this.metrics = options.metrics ?? null;
    this.botUserId = options.botUserId ? String(options.botUserId) : null;
    this.minDurationSec = options.minDurationSec ?? 30;
    this.fallbackLocale = options.fallbackLocale ?? null;

    this.active = new Map();
    this.sessions = null;
    this.listeners = new Map();
    this.tickHandle = null;
    this.retryHandle = null;
  }

  setBotUserId(botUserId: string | null): void {
    this.botUserId = botUserId ? String(botUserId) : null;
  }

  bind(sessions: SessionEmitterLike): void {
    if (this.sessions) return;
    this.sessions = sessions;

    const onTrackStart = (payload?: SessionEventPayload) => {
      this._onTrackStart(payload).catch((err: unknown) => this._logFailure('track start', err));
    };
    const onTrackEnd = (payload?: SessionEventPayload) => {
      this._onTrackEnd(payload).catch((err: unknown) => this._logFailure('track end', err));
    };
    const onDestroyed = (payload?: SessionEventPayload) => {
      const sessionId = String(payload?.session?.sessionId ?? '').trim();
      if (sessionId) this.active.delete(sessionId);
    };

    this.listeners.set('trackStart', onTrackStart);
    this.listeners.set('trackEnd', onTrackEnd);
    this.listeners.set('destroyed', onDestroyed);

    sessions.on('trackStart', onTrackStart);
    sessions.on('trackEnd', onTrackEnd);
    sessions.on('destroyed', onDestroyed);
  }

  start(): void {
    if (!this.tickHandle) {
      this.tickHandle = setInterval(() => {
        this._tick().catch((err: unknown) => this._logFailure('listener tick', err));
      }, TICK_INTERVAL_MS);
      this.tickHandle.unref?.();
    }

    if (!this.retryHandle) {
      this.retryHandle = setInterval(() => {
        this._flushRetries().catch((err: unknown) => this._logFailure('retry flush', err));
      }, RETRY_FLUSH_INTERVAL_MS);
      this.retryHandle.unref?.();
    }

    this._refreshAccountGauge().catch(() => null);
  }

  stop(): void {
    if (this.tickHandle) {
      clearInterval(this.tickHandle);
      this.tickHandle = null;
    }
    if (this.retryHandle) {
      clearInterval(this.retryHandle);
      this.retryHandle = null;
    }

    if (this.sessions) {
      for (const [event, listener] of this.listeners.entries()) {
        this.sessions.off(event, listener);
      }
      this.sessions = null;
    }

    this.listeners.clear();
    this.active.clear();
  }

  async countLinkedListeners(guildId: unknown, channelId: unknown): Promise<number> {
    const listeners = this._listeners(guildId, channelId);
    if (!listeners.length) return 0;

    const accounts = await this._resolveAccounts(listeners);
    return accounts.length;
  }

  async _onTrackStart(payload?: SessionEventPayload): Promise<void> {
    const session = payload?.session ?? null;
    const sessionId = String(session?.sessionId ?? '').trim();
    const guildId = String(session?.guildId ?? '').trim();
    const channelId = String(session?.connection?.channelId ?? '').trim();
    if (!sessionId || !guildId || !channelId) return;

    this.active.delete(sessionId);

    const meta = toLastFmTrack(payload?.track ?? null, { minDurationSec: this.minDurationSec });
    if (!meta) return;

    const now = Date.now();
    const playback: ActivePlayback = {
      guildId,
      channelId,
      textChannelId: session?.settings?.musicLogChannelId ?? session?.textChannelId ?? null,
      minimalMode: session?.settings?.minimalMode === true,
      meta,
      startedAtMs: now,
      lastTickMs: now,
      listenedMs: new Map(),
      nowPlayingSent: new Set(),
      notified: new Set(),
    };

    for (const userId of this._listeners(guildId, channelId)) {
      playback.listenedMs.set(userId, 0);
    }

    this.active.set(sessionId, playback);
    await this._publishNowPlaying(playback, [...playback.listenedMs.keys()]);
  }

  async _onTrackEnd(payload?: SessionEventPayload): Promise<void> {
    const sessionId = String(payload?.session?.sessionId ?? '').trim();
    if (!sessionId) return;

    const playback = this.active.get(sessionId);
    if (!playback) return;
    if (payload?.seekRestart === true) return;

    this.active.delete(sessionId);
    this._accumulate(playback, Date.now());

    const threshold = Math.min(
      Math.floor(playback.meta.durationSec / 2),
      SCROBBLE_AFTER_SECONDS,
    ) * 1_000;

    const eligible = [...playback.listenedMs.entries()]
      .filter(([, listened]) => listened >= threshold)
      .map(([userId]) => userId);
    if (!eligible.length) return;

    const accounts = await this._resolveAccounts(eligible);
    if (!accounts.length) return;

    const entry: LastFmScrobbleEntry = {
      artist: playback.meta.artist,
      track: playback.meta.track,
      timestamp: Math.floor(playback.startedAtMs / 1_000),
      album: playback.meta.album,
      duration: playback.meta.durationSec,
    };

    await this._runBatched(accounts, async ({ userId, sessionKey }) => {
      await this._scrobbleFor(userId, sessionKey, entry, playback);
    });
  }

  async _tick(): Promise<void> {
    if (!this.active.size) return;

    const now = Date.now();
    for (const playback of this.active.values()) {
      this._accumulate(playback, now);

      const remaining = playback.meta.durationSec * 1_000 - (now - playback.startedAtMs);
      if (remaining < NOW_PLAYING_REFRESH_MS) continue;

      const fresh = [...playback.listenedMs.keys()].filter((userId) => !playback.nowPlayingSent.has(userId));
      if (fresh.length) {
        await this._publishNowPlaying(playback, fresh);
      }
    }
  }

  _accumulate(playback: ActivePlayback, now: number): void {
    const elapsed = Math.max(0, now - playback.lastTickMs);
    playback.lastTickMs = now;
    if (!elapsed) return;

    for (const userId of this._listeners(playback.guildId, playback.channelId)) {
      playback.listenedMs.set(userId, (playback.listenedMs.get(userId) ?? 0) + elapsed);
    }
  }

  _listeners(guildId: unknown, channelId: unknown): string[] {
    const guild = String(guildId ?? '').trim();
    const channel = String(channelId ?? '').trim();
    if (!guild || !channel) return [];

    return this.voiceStateStore
      .getUsersInChannel(guild, channel)
      .filter((userId) => userId && userId !== this.botUserId);
  }

  async _resolveAccounts(userIds: string[]): Promise<Array<{ userId: string; sessionKey: string }>> {
    const resolved: Array<{ userId: string; sessionKey: string }> = [];

    for (const userId of userIds) {
      const account = await this.accounts.get(userId).catch(() => null);
      if (!account || !account.scrobblingEnabled) continue;

      const sessionKey = await this.accounts.getSessionKey(userId).catch(() => null);
      if (!sessionKey) continue;

      resolved.push({ userId, sessionKey });
    }

    return resolved;
  }

  async _publishNowPlaying(playback: ActivePlayback, userIds: string[]): Promise<void> {
    for (const userId of userIds) {
      playback.nowPlayingSent.add(userId);
    }

    const accounts = await this._resolveAccounts(userIds);
    if (!accounts.length) return;

    await this._runBatched(accounts, async ({ userId, sessionKey }) => {
      try {
        await this.client.updateNowPlaying(sessionKey, {
          artist: playback.meta.artist,
          track: playback.meta.track,
          album: playback.meta.album,
          duration: playback.meta.durationSec,
        });
        this.metrics?.nowPlayingTotal?.inc(1);
      } catch (err: unknown) {
        await this._handleWriteError(userId, err, playback);
      }
    });
  }

  async _scrobbleFor(
    userId: string,
    sessionKey: string,
    entry: LastFmScrobbleEntry,
    playback: ActivePlayback,
  ): Promise<void> {
    try {
      await this.client.scrobble(sessionKey, [entry]);
      this.metrics?.scrobblesTotal?.inc(1);

      const result = await this.accounts.recordScrobble(userId, new Date(playback.startedAtMs));
      if (result) await this._announceMilestone(playback, userId, result.scrobbleCount, result.streakDays, result.streakExtended);
    } catch (err: unknown) {
      this.metrics?.scrobbleFailuresTotal?.inc(1);
      const handled = await this._handleWriteError(userId, err, playback);
      if (!handled) await this.accounts.queueRetry(userId, entry);
    }
  }

  async _handleWriteError(userId: string, err: unknown, playback: ActivePlayback | null): Promise<boolean> {
    if (err instanceof LastFmApiError && err.lastfmCode === LASTFM_INVALID_SESSION_CODE) {
      await this.accounts.unlink(userId).catch(() => null);
      this.logger?.info?.('Unlinked Last.fm account after invalid session key', { userId });

      if (playback && !playback.notified.has(userId)) {
        playback.notified.add(userId);
        const t = await this._translator(playback.guildId);
        await this._say(playback, t('lastfm.sessionExpired', { user: `<@${userId}>` }));
      }
      return true;
    }

    this.logger?.debug?.('Last.fm write failed', {
      userId,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }

  async _announceMilestone(
    playback: ActivePlayback,
    userId: string,
    scrobbleCount: number,
    streakDays: number,
    streakExtended: boolean,
  ): Promise<void> {
    if (playback.minimalMode) return;

    const hitCount = MILESTONES.includes(scrobbleCount);
    const hitStreak = streakExtended && STREAK_MILESTONES.includes(streakDays);
    if (!hitCount && !hitStreak) return;

    const t = await this._translator(playback.guildId);
    const text = hitCount
      ? t('lastfm.milestoneScrobbles', { user: `<@${userId}>`, count: scrobbleCount })
      : t('lastfm.milestoneStreak', { user: `<@${userId}>`, count: streakDays });

    await this._say(playback, text);
  }

  async _say(playback: ActivePlayback, content: string): Promise<void> {
    if (!playback.textChannelId || !this.rest?.sendMessage) return;

    await this.rest.sendMessage(playback.textChannelId, {
      content,
      allowed_mentions: { parse: [], users: [], roles: [], replied_user: false },
    }).catch(() => null);
  }

  async _translator(guildId: string) {
    let guildLocale: string | null = null;
    if (this.guildConfigs) {
      const config = await this.guildConfigs.get(guildId).catch(() => null);
      guildLocale = config?.settings?.language ?? null;
    }

    const locale: Locale = resolveLocale({ guildLocale, fallbackLocale: this.fallbackLocale });
    return createTranslator(locale);
  }

  async _flushRetries(): Promise<void> {
    const due = await this.accounts.listDueRetries(50);
    if (!due.length) return;

    for (const retry of due) {
      const sessionKey = await this.accounts.getSessionKey(retry.userId).catch(() => null);
      if (!sessionKey) {
        await this.accounts.resolveRetry(retry, true);
        continue;
      }

      try {
        await this.client.scrobble(sessionKey, [retry.entry]);
        this.metrics?.scrobblesTotal?.inc(1);
        await this.accounts.recordScrobble(retry.userId, new Date(retry.entry.timestamp * 1_000));
        await this.accounts.resolveRetry(retry, true);
      } catch (err: unknown) {
        const handled = await this._handleWriteError(retry.userId, err, null);
        await this.accounts.resolveRetry(retry, handled);
      }
    }
  }

  async _refreshAccountGauge(): Promise<void> {
    if (!this.metrics?.accountsLinked) return;
    const count = await this.accounts.countLinked().catch(() => 0);
    this.metrics.accountsLinked.set(count);
  }

  async _runBatched<T>(items: T[], worker: (item: T) => Promise<void>): Promise<void> {
    for (let index = 0; index < items.length; index += MAX_PARALLEL_SCROBBLES) {
      const slice = items.slice(index, index + MAX_PARALLEL_SCROBBLES);
      await Promise.all(slice.map((item) => worker(item).catch(() => undefined)));
    }
  }

  _logFailure(stage: string, err: unknown): void {
    this.logger?.warn?.('Scrobble service error', {
      stage,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
