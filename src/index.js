import 'dotenv/config';
import dns from 'node:dns';

import { loadConfig } from './config.js';
import { createLogger } from './core/logger.js';
import { Gateway } from './gateway.js';
import { RestClient } from './rest.js';
import { CommandRouter, SessionManager, VoiceStateStore } from './commands.js';
import { LyricsService } from './bot/services/lyricsService.js';
import { GuildConfigStore } from './bot/services/guildConfigStore.js';
import { MongoService } from './storage/mongo.js';
import { initializePlayDlAuth } from './integrations/playDlAuth.js';
import { sleep } from './utils/retry.js';
import { MusicLibraryStore } from './bot/services/musicLibraryStore.js';

const startedAt = Date.now();
const config = loadConfig();
const logger = createLogger({ level: config.logLevel, name: 'fluxer-bot' });
dns.setDefaultResultOrder(config.dnsResultOrder);
logger.info('DNS resolution order configured', { order: config.dnsResultOrder });
await initializePlayDlAuth(config, logger.child('media-auth'));

const rest = new RestClient({
  token: config.token,
  base: config.apiBase,
  timeoutMs: config.restTimeoutMs,
  maxRetries: config.restMaxRetries,
  retryBaseDelayMs: config.restRetryBaseDelayMs,
  logger: logger.child('rest'),
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

const guildConfigs = new GuildConfigStore({
  collection: mongo.collection('guild_configs'),
  logger: logger.child('guild-configs'),
  cacheTtlMs: config.guildConfigCacheTtlMs,
  maxCacheSize: config.guildConfigCacheMaxSize,
  defaults: {
    prefix: config.prefix,
    settings: {
      autoplayEnabled: config.defaultAutoplayEnabled,
      dedupeEnabled: config.defaultDedupeEnabled,
      stayInVoiceEnabled: config.defaultStayInVoiceEnabled,
      voteSkipRatio: config.voteSkipRatio,
      voteSkipMinVotes: config.voteSkipMinVotes,
      djRoleIds: [],
      musicLogChannelId: null,
      language: 'en',
    },
  },
});
await guildConfigs.init();

const musicLibrary = new MusicLibraryStore({
  guildPlaylistsCollection: mongo.collection('guild_playlists'),
  userFavoritesCollection: mongo.collection('user_favorites'),
  guildHistoryCollection: mongo.collection('guild_history'),
  logger: logger.child('music-library'),
  maxPlaylistsPerGuild: config.maxSavedPlaylistsPerGuild,
  maxTracksPerPlaylist: config.maxSavedTracksPerPlaylist,
  maxFavoritesPerUser: config.maxFavoritesPerUser,
  maxHistoryTracks: config.persistentHistorySize,
});
await musicLibrary.init();

const gatewayUrl = await resolveGatewayUrl();
const gateway = new Gateway({
  url: gatewayUrl,
  token: config.token,
  intents: 0,
  logger: logger.child('gateway'),
});

const voiceStateStore = new VoiceStateStore(logger.child('voice-state'));
voiceStateStore.register(gateway);

const sessions = new SessionManager({
  gateway,
  config,
  guildConfigs,
  logger: logger.child('sessions'),
});

const lyrics = new LyricsService(logger.child('lyrics'));
const me = await verifyApiConnectivity();

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
  botUserId: me?.id ?? null,
  startedAt,
});

gateway.on('MESSAGE_CREATE', (message) => {
  router.handleMessage(message).catch((err) => {
    logger.error('Unhandled MESSAGE_CREATE handler error', {
      error: err instanceof Error ? err.message : String(err),
    });
  });
});

gateway.connect();

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;

  logger.warn('Shutdown requested', { signal });

  await sessions.shutdown().catch((err) => {
    logger.error('Session shutdown failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  });

  gateway.disconnect();
  await mongo.close().catch((err) => {
    logger.error('MongoDB shutdown failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  });

  setTimeout(() => {
    process.exit(0);
  }, 200).unref();
}

process.on('SIGINT', () => {
  shutdown('SIGINT').catch(() => process.exit(1));
});

process.on('SIGTERM', () => {
  shutdown('SIGTERM').catch(() => process.exit(1));
});

async function verifyApiConnectivity() {
  let lastError = null;

  for (let attempt = 1; attempt <= config.apiCheckRetries; attempt += 1) {
    try {
      const me = await rest.getCurrentUser();
      logger.info('REST API check succeeded', {
        apiBase: config.apiBase,
        user: me?.username ?? 'unknown',
      });
      return me;
    } catch (err) {
      lastError = err;
      const detail = err instanceof Error ? err.message : String(err);
      logger.warn('REST API check failed', {
        attempt,
        totalAttempts: config.apiCheckRetries,
        error: detail,
      });

      if (attempt < config.apiCheckRetries) {
        await sleep(config.apiCheckDelayMs * attempt);
      }
    }
  }

  const finalDetail = lastError instanceof Error ? lastError.message : String(lastError);
  const message = `REST API check failed after ${config.apiCheckRetries} attempt(s): ${finalDetail}`;

  if (config.strictStartupCheck) {
    throw new Error(message);
  }

  logger.warn(`${message}. Continuing startup due to non-strict mode.`);
  return null;
}

async function resolveGatewayUrl() {
  if (!config.autoGatewayUrl) {
    return config.gatewayUrl;
  }

  try {
    const data = await rest.getGatewayBot();
    if (typeof data?.url === 'string' && data.url.startsWith('ws')) {
      logger.info('Gateway URL resolved from API', { url: data.url });
      return data.url;
    }
  } catch (err) {
    logger.warn('Failed to resolve gateway URL from API, using configured fallback', {
      error: err instanceof Error ? err.message : String(err),
      fallback: config.gatewayUrl,
    });
  }

  return config.gatewayUrl;
}
