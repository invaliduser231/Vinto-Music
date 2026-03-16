import dns from 'node:dns';

import { loadConfig } from '../config.js';
import { createLogger } from '../core/logger.js';
import { Gateway } from '../gateway.js';
import { RestClient } from '../rest.js';
import { CommandRouter, SessionManager, VoiceStateStore } from '../commands.js';
import { LyricsService } from '../bot/services/lyricsService.js';
import { GuildConfigStore } from '../bot/services/guildConfigStore.js';
import { MongoService } from '../storage/mongo.js';
import { initializePlayDlAuth } from '../integrations/playDlAuth.js';
import { MusicLibraryStore } from '../bot/services/musicLibraryStore.js';
import { PermissionService } from '../bot/services/permissionService.js';
import { MonitoringServer } from '../monitoring/server.js';
import { initializeSentry } from '../monitoring/sentry.js';
import { sanitizeBrokenLocalProxyEnv } from './proxy.js';
import { verifyApiConnectivity, resolveGatewayUrl } from './connectivity.js';
import { bindGatewayMetrics, bindSessionMetrics, createAppMetrics } from './metrics.js';

const PRESENCE_ROTATION_INTERVAL_MS = 10 * 60 * 1000;
const PRESENCE_SLOGANS = [
  (guildCount) => `${guildCount} guilds tuned in`,
  () => 'always on beat',
  () => 'queueing the next banger',
  (guildCount) => `spinning for ${guildCount} guilds`,
  () => 'music around the clock',
];

function buildGatewayPresence(statusText) {
  return {
    status: 'online',
    mobile: false,
    afk: false,
    custom_status: {
      text: String(statusText ?? '').trim() || 'online',
    },
  };
}

async function fetchCurrentGuildCount(rest) {
  if (!rest?.listCurrentUserGuilds) return null;

  const guildIds = new Set();
  let after = null;

  for (let page = 0; page < 100; page += 1) {
    const chunk = await rest.listCurrentUserGuilds({ limit: 200, after }).catch(() => null);
    if (!Array.isArray(chunk) || chunk.length === 0) break;

    for (const guild of chunk) {
      const guildId = String(guild?.id ?? '').trim();
      if (guildId) guildIds.add(guildId);
    }

    if (chunk.length < 200) break;

    const lastId = String(chunk[chunk.length - 1]?.id ?? '').trim();
    if (!lastId) break;
    after = lastId;
  }

  return guildIds.size;
}

function createPresenceText(guildCount, rotationIndex) {
  const safeGuildCount = Number.isFinite(guildCount) && guildCount >= 0 ? guildCount : 0;
  const pick = PRESENCE_SLOGANS[rotationIndex % PRESENCE_SLOGANS.length] ?? PRESENCE_SLOGANS[0];
  return pick(safeGuildCount);
}

export async function startApp() {
  const startedAt = Date.now();
  const config = loadConfig();
  const logger = createLogger({ level: config.logLevel, name: 'fluxer-bot' });

  sanitizeBrokenLocalProxyEnv(logger);

  const metricSet = createAppMetrics();
  let gatewayConnected = false;
  let shuttingDown = false;

  dns.setDefaultResultOrder(config.dnsResultOrder);
  logger.info('DNS resolution order configured', { order: config.dnsResultOrder });

  await initializePlayDlAuth(config, logger.child('media-auth'));
  const errorReporter = await initializeSentry(config, logger.child('sentry'));

  const rest = new RestClient({
    token: config.token,
    base: config.apiBase,
    timeoutMs: config.restTimeoutMs,
    maxRetries: config.restMaxRetries,
    retryBaseDelayMs: config.restRetryBaseDelayMs,
    logger: logger.child('rest'),
    metrics: {
      restRetriesTotal: metricSet.restRetriesTotal,
      restRateLimitedTotal: metricSet.restRateLimitedTotal,
      restGlobalRateLimitWaitMs: metricSet.restGlobalRateLimitWaitMs,
    },
  });

  const mongo = new MongoService({
    uri: config.mongoUri,
    dbName: config.mongoDb,
    maxPoolSize: config.mongoMaxPoolSize,
    minPoolSize: config.mongoMinPoolSize,
    connectTimeoutMs: config.mongoConnectTimeoutMs,
    serverSelectionTimeoutMs: config.mongoServerSelectionTimeoutMs,
    logger: logger.child('mongo'),
  });
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

  const gatewayUrl = await resolveGatewayUrl({ config, rest, logger });
  const initialGuildCount = await fetchCurrentGuildCount(rest).catch(() => null);
  let presenceRotationIndex = 0;
  let presenceUpdateHandle = null;
  let lastPresenceText = Number.isFinite(initialGuildCount)
    ? createPresenceText(initialGuildCount, presenceRotationIndex)
    : 'always on beat';
  if (Number.isFinite(initialGuildCount)) {
    presenceRotationIndex = (presenceRotationIndex + 1) % PRESENCE_SLOGANS.length;
  }
  const applyRotatingPresence = async (reason, guildCountOverride = null) => {
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

  const sessions = new SessionManager({
    gateway,
    config,
    guildConfigs,
    voiceStateStore,
    logger: logger.child('sessions'),
  });

  const unbindGatewayMetrics = bindGatewayMetrics(gateway, metricSet, {
    onConnectedChange: (connected) => {
      gatewayConnected = connected;
    },
  });
  const unbindSessionMetrics = bindSessionMetrics(sessions, metricSet);

  const lyrics = new LyricsService(logger.child('lyrics'));
  const me = await verifyApiConnectivity({ config, rest, logger });
  const permissions = new PermissionService({
    rest,
    botUserId: me?.id ?? null,
    logger: logger.child('permissions'),
  });

  const router = new CommandRouter({
    config,
    logger: logger.child('commands'),
    rest,
    gateway,
    sessions,
    guildConfigs,
    voiceStateStore,
    lyrics,
    library: musicLibrary,
    permissionService: permissions,
    metrics: {
      commandsTotal: metricSet.commandsTotal,
    },
    errorReporter,
    botUserId: me?.id ?? null,
    startedAt,
  });

  let resolvedBotUserId = null;
  const setBotUserId = (botUserId, source) => {
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

  const shutdown = async (signal) => {
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
