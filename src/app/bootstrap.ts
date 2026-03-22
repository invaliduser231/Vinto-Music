import dns from 'node:dns';

import { loadConfig } from '../config.ts';
import { createLogger } from '../core/logger.ts';
import { Gateway } from '../gateway.ts';
import { RestClient } from '../rest.ts';
import { CommandRouter, SessionManager, VoiceStateStore } from '../commands.ts';
import { LyricsService } from '../bot/services/lyricsService.ts';
import { GuildConfigStore } from '../bot/services/guildConfigStore.ts';
import { MongoService } from '../storage/mongo.ts';
import { initializePlayDlAuth } from '../integrations/playDlAuth.ts';
import { MusicLibraryStore } from '../bot/services/musicLibraryStore.ts';
import { PermissionService } from '../bot/services/permissionService.ts';
import { GuildStateCache } from '../bot/services/guildStateCache.ts';
import { MonitoringServer } from '../monitoring/server.ts';
import { initializeSentry } from '../monitoring/sentry.ts';
import { sanitizeBrokenLocalProxyEnv } from './proxy.ts';
import { verifyApiConnectivity, resolveGatewayUrl } from './connectivity.ts';
import { bindGatewayMetrics, bindSessionMetrics, createAppMetrics } from './metrics.ts';
import type { SessionManagerOptions } from '../types/domain.ts';
const PRESENCE_ROTATION_INTERVAL_MS = 10 * 60 * 1000;
const PRESENCE_SLOGANS = [
  (guildCount: number) => `${guildCount} guilds tuned in`,
  () => 'always on beat',
  () => 'queueing the next banger',
  (guildCount: number) => `spinning for ${guildCount} guilds`,
  () => 'music around the clock',
];

type DnsWithDefaultOrder = typeof dns & {
  setDefaultResultOrder?: (order: string) => void;
};

type GuildSummary = { id?: string };
type GuildListRest = {
  listCurrentUserGuilds?: RestClient['listCurrentUserGuilds'];
};
type ConnectivityRest = Parameters<typeof resolveGatewayUrl>[0]['rest'];
type SessionManagerCtorOptions = ConstructorParameters<typeof SessionManager>[0];
type CommandRouterCtorOptions = ConstructorParameters<typeof CommandRouter>[0];
type PermissionServiceCtorOptions = ConstructorParameters<typeof PermissionService>[0];
type MongoServiceCtorOptions = ConstructorParameters<typeof MongoService>[0];

type GatewayPresence = {
  status: 'online';
  mobile: boolean;
  afk: boolean;
  custom_status: { text: string };
};

function buildGatewayPresence(statusText: string | null | undefined): GatewayPresence {
  return {
    status: 'online',
    mobile: false,
    afk: false,
    custom_status: {
      text: String(statusText ?? '').trim() || 'online',
    },
  };
}

async function fetchCurrentGuildCount(rest: GuildListRest): Promise<number | null> {
  if (!rest?.listCurrentUserGuilds) return null;

  const guildIds = new Set();
  let after: string | undefined;

  for (let page = 0; page < 100; page += 1) {
    const rawChunk = await rest.listCurrentUserGuilds({ limit: 200, ...(after ? { after } : {}) }).catch(() => null);
    const chunk: GuildSummary[] = Array.isArray(rawChunk) ? rawChunk as GuildSummary[] : [];
    if (chunk.length === 0) break;

    for (const guild of chunk) {
      const guildId = String(guild?.id ?? '').trim();
      if (guildId) guildIds.add(guildId);
    }

    if (chunk.length < 200) break;

    const lastGuild: GuildSummary | undefined = chunk[chunk.length - 1];
    const lastId: string = String(lastGuild?.id ?? '').trim();
    if (!lastId) break;
    after = lastId;
  }

  return guildIds.size;
}

function createPresenceText(guildCount: number | null, rotationIndex: number): string {
  const safeGuildCount = Number.isFinite(guildCount) && Number(guildCount) >= 0 ? Number(guildCount) : 0;
  const pick = PRESENCE_SLOGANS[rotationIndex % PRESENCE_SLOGANS.length] ?? PRESENCE_SLOGANS[0];
  return pick?.(safeGuildCount) ?? `${safeGuildCount} guilds tuned in`;
}

export async function startApp() {
  const startedAt = Date.now();
  const config = loadConfig();
  const logger = createLogger({ level: config.logLevel, name: 'fluxer-bot' });

  sanitizeBrokenLocalProxyEnv(logger);

  const metricSet = createAppMetrics();
  let gatewayConnected = false;
  let shuttingDown = false;

  (dns as DnsWithDefaultOrder).setDefaultResultOrder?.(config.dnsResultOrder);
  logger.info('DNS resolution order configured', { order: config.dnsResultOrder });

  await initializePlayDlAuth(config, logger.child('media-auth'));
  const errorReporter = await initializeSentry(config, logger.child('sentry'));

  const rest = new RestClient({
    token: config.token,
    base: config.apiBase,
    timeoutMs: config.restTimeoutMs,
    maxRetries: config.restMaxRetries,
      retryBaseDelayMs: config.restRetryBaseDelayMs ?? undefined,
    logger: logger.child('rest'),
    metrics: {
      restRetriesTotal: metricSet.restRetriesTotal,
      restRateLimitedTotal: metricSet.restRateLimitedTotal,
      restGlobalRateLimitWaitMs: metricSet.restGlobalRateLimitWaitMs,
    },
  });

  const mongo = new MongoService({
    uri: config.mongoUri ?? undefined,
    dbName: config.mongoDb,
    maxPoolSize: config.mongoMaxPoolSize,
    minPoolSize: config.mongoMinPoolSize,
    connectTimeoutMs: config.mongoConnectTimeoutMs,
    serverSelectionTimeoutMs: config.mongoServerSelectionTimeoutMs,
    logger: logger.child('mongo'),
  } satisfies MongoServiceCtorOptions);
  await mongo.connect();
  metricSet.mongoConnected.set(1);

  const pollMongoHealth = async () => {
    const started = Date.now();
    try {
      await mongo.ping();
      metricSet.mongoConnected.set(1);
      metricSet.mongoPingLatencyMs.set(Math.max(0, Date.now() - started));
    } catch (err) {
      metricSet.mongoConnected.set(0);
      metricSet.mongoPingFailuresTotal.inc(1);
      logger.warn('MongoDB ping failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  await pollMongoHealth();
  const mongoPingHandle = setInterval(() => {
    pollMongoHealth().catch(() => null);
  }, config.mongoPingIntervalMs);
  mongoPingHandle.unref?.();

  const guildConfigs = new GuildConfigStore({
    collection: mongo.collection('guild_configs'),
    logger: logger.child('guild-configs'),
    cacheTtlMs: config.guildConfigCacheTtlMs,
    maxCacheSize: config.guildConfigCacheMaxSize,
    defaults: {
      prefix: config.prefix,
      settings: {
        dedupeEnabled: config.defaultDedupeEnabled,
        stayInVoiceEnabled: config.defaultStayInVoiceEnabled,
        minimalMode: false,
        volumePercent: config.defaultVolumePercent,
        voteSkipRatio: config.voteSkipRatio,
        voteSkipMinVotes: config.voteSkipMinVotes,
        djRoleIds: [],
        musicLogChannelId: null,
      },
    },
  });
  await guildConfigs.init();

  const musicLibrary = new MusicLibraryStore({
    guildPlaylistsCollection: mongo.collection('guild_playlists'),
    userFavoritesCollection: mongo.collection('user_favorites'),
    guildHistoryCollection: mongo.collection('guild_history'),
    guildFeaturesCollection: mongo.collection('guild_features'),
    guildSessionSnapshotsCollection: mongo.collection('guild_session_snapshots'),
    userProfilesCollection: mongo.collection('user_profiles'),
    guildRecapsCollection: mongo.collection('guild_recaps'),
    logger: logger.child('music-library'),
    maxPlaylistsPerGuild: config.maxSavedPlaylistsPerGuild,
    maxTracksPerPlaylist: config.maxSavedTracksPerPlaylist,
    maxSavedTracksPerPlaylist: config.maxSavedTracksPerPlaylist,
    maxFavoritesPerUser: config.maxFavoritesPerUser,
    maxHistoryTracks: config.persistentHistorySize,
  });
  await musicLibrary.init();

  const connectivityRest = rest as ConnectivityRest;
  const gatewayUrl = await resolveGatewayUrl({ config, rest: connectivityRest, logger });
  const initialGuildCount = await fetchCurrentGuildCount(rest).catch(() => null);
  let presenceRotationIndex = 0;
  let presenceUpdateHandle: NodeJS.Timeout | null = null;
  let lastPresenceText = Number.isFinite(initialGuildCount)
    ? createPresenceText(initialGuildCount, presenceRotationIndex)
    : 'always on beat';
  if (Number.isFinite(initialGuildCount)) {
    presenceRotationIndex = (presenceRotationIndex + 1) % PRESENCE_SLOGANS.length;
  }
  const applyRotatingPresence = async (reason: string, guildCountOverride: number | null = null): Promise<boolean> => {
    const guildCount = Number.isFinite(guildCountOverride)
      ? guildCountOverride
      : await fetchCurrentGuildCount(rest).catch(() => null);
    if (!Number.isFinite(guildCount)) return false;

    const nextText = createPresenceText(guildCount, presenceRotationIndex);
    presenceRotationIndex = (presenceRotationIndex + 1) % PRESENCE_SLOGANS.length;
    if (!nextText || nextText === lastPresenceText) return false;

    const presence = buildGatewayPresence(nextText);
    const updated = gateway.updatePresence(presence);
    if (!updated) return false;

    lastPresenceText = nextText;
    logger.info('Gateway presence updated', { reason, guildCount, text: nextText });
    return true;
  };
  const initialPresence = buildGatewayPresence(lastPresenceText);
  const gateway = new Gateway({
    url: gatewayUrl,
    token: config.token,
    intents: config.gatewayIntents,
    initialPresence,
    logger: logger.child('gateway'),
  });

  const voiceStateStore = new VoiceStateStore(logger.child('voice-state'));
  voiceStateStore.register(gateway);
  const guildStateCache = new GuildStateCache(logger.child('guild-state'));
  guildStateCache.register(gateway);

  const sessionManagerOptions: SessionManagerOptions = {
    gateway,
    config,
    library: musicLibrary,
    rest,
    voiceStateStore: voiceStateStore ?? null,
    logger: logger.child('sessions'),
    ...(guildConfigs
      ? { guildConfigs: guildConfigs as unknown as NonNullable<SessionManagerOptions['guildConfigs']> }
      : {}),
  };
  const sessions = new SessionManager(sessionManagerOptions);

  const unbindGatewayMetrics = bindGatewayMetrics(gateway, metricSet, {
    onConnectedChange: (connected) => {
      gatewayConnected = connected;
    },
  });
  const unbindSessionMetrics = bindSessionMetrics(sessions, metricSet);

  const lyrics = new LyricsService(logger.child('lyrics'));
  const me = await verifyApiConnectivity({ config, rest: connectivityRest, logger });
  const permissionOptions = {
    rest,
    botUserId: me?.id ?? null,
    logger: logger.child('permissions'),
  } satisfies PermissionServiceCtorOptions;
  const permissions = new PermissionService(permissionOptions);

  const routerOptions = {
    config,
    logger: logger.child('commands'),
    rest: rest as CommandRouterCtorOptions['rest'],
    gateway,
    sessions,
    voiceStateStore,
    lyrics,
    library: musicLibrary,
    permissionService: permissions,
    guildStateCache,
    metrics: {
      commandsTotal: metricSet.commandsTotal,
    },
    errorReporter,
    botUserId: me?.id ?? null,
    startedAt,
    ...(guildConfigs
      ? { guildConfigs: guildConfigs as unknown as NonNullable<CommandRouterCtorOptions['guildConfigs']> }
      : {}),
  };
  const router = new CommandRouter(routerOptions);

  let resolvedBotUserId: string | null = null;
  let persistentRestoreStarted = false;
  const setBotUserId = (botUserId: string | null | undefined, source: string) => {
    const normalized = botUserId ? String(botUserId) : null;
    if (!normalized || normalized === resolvedBotUserId) return;

    resolvedBotUserId = normalized;
    sessions.setBotUserId(normalized);
    permissions.setBotUserId(normalized);
    router.setBotUserId(normalized);
    logger.info('Bot user id resolved', { source, botUserId: normalized });
  };

  setBotUserId(me?.id, 'rest');

  gateway.on('READY', (payload) => {
    setBotUserId(payload?.user?.id, 'gateway_ready');
    const readyGuildCount = Array.isArray(payload?.guilds) ? payload.guilds.length : null;
    applyRotatingPresence('ready', readyGuildCount).catch(() => null);

    if (!persistentRestoreStarted) {
      persistentRestoreStarted = true;
      sessions.restorePersistentVoiceSessions().catch((err) => {
        logger.warn('Persistent voice session restore failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }
  });

  gateway.on('RESUMED', () => {
    applyRotatingPresence('resumed').catch(() => null);
  });

  const monitoringServer = new MonitoringServer({
    enabled: config.monitoringEnabled,
    host: config.monitoringHost,
    port: config.monitoringPort,
    logger: logger.child('monitoring'),
    metrics: metricSet.registry,
    getHealth: () => ({
      ok: !shuttingDown && (gatewayConnected || Date.now() - startedAt < 60_000),
      gatewayConnected,
      shuttingDown,
      sessions: sessions.sessions.size,
      uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
    }),
  });
  await monitoringServer.start().catch((err) => {
    logger.warn('Monitoring server failed to start', {
      error: err instanceof Error ? err.message : String(err),
    });
  });

  gateway.on('MESSAGE_CREATE', (message) => {
    router.handleMessage(message).catch((err) => {
      logger.error('Unhandled MESSAGE_CREATE handler error', {
        error: err instanceof Error ? err.message : String(err),
      });
      errorReporter?.captureException?.(err, { source: 'message_create_handler' });
    });
  });

  gateway.on('MESSAGE_REACTION_ADD', (payload) => {
    router.handleReactionAdd(payload).catch((err) => {
      logger.warn('Unhandled MESSAGE_REACTION_ADD handler error', {
        error: err instanceof Error ? err.message : String(err),
      });
      errorReporter?.captureException?.(err, { source: 'message_reaction_add_handler' });
    });
  });

  gateway.connect();
  presenceUpdateHandle = setInterval(() => {
    applyRotatingPresence('interval').catch((err) => {
      logger.debug('Gateway presence refresh failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }, PRESENCE_ROTATION_INTERVAL_MS);
  presenceUpdateHandle.unref?.();

  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;

    logger.warn('Shutdown requested', { signal });

    await sessions.shutdown().catch((err) => {
      logger.error('Session shutdown failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    });

    unbindSessionMetrics();
    unbindGatewayMetrics();
    if (presenceUpdateHandle) {
      clearInterval(presenceUpdateHandle);
      presenceUpdateHandle = null;
    }

    gateway.disconnect();
    await monitoringServer.stop().catch((err) => {
      logger.error('Monitoring server shutdown failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
    await mongo.close().catch((err) => {
      logger.error('MongoDB shutdown failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
    clearInterval(mongoPingHandle);
    metricSet.mongoConnected.set(0);
    await errorReporter?.flush?.(1_500);

    setTimeout(() => {
      process.exit(0);
    }, 200).unref();
  };

  process.on('SIGINT', () => {
    shutdown('SIGINT').catch(() => process.exit(1));
  });

  process.on('SIGTERM', () => {
    shutdown('SIGTERM').catch(() => process.exit(1));
  });

  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled promise rejection', {
      error: reason instanceof Error ? reason.message : String(reason),
    });
    errorReporter?.captureException?.(reason instanceof Error ? reason : new Error(String(reason)), {
      source: 'unhandled_rejection',
    });
  });

  process.on('uncaughtException', (err) => {
    logger.error('Uncaught exception', {
      error: err instanceof Error ? err.message : String(err),
    });
    errorReporter?.captureException?.(err, { source: 'uncaught_exception' });
  });

  return { shutdown };
}




