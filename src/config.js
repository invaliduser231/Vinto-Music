import { ConfigurationError } from './core/errors.js';

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseNonNegativeInt(value, fallback) {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function parseBool(value, fallback = false) {
  if (value == null) return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function parseRatio(value, fallback) {
  const parsed = Number.parseFloat(value ?? '');
  if (!Number.isFinite(parsed)) return fallback;
  if (parsed <= 0 || parsed > 1) return fallback;
  return parsed;
}

function normalizeApiBase(value) {
  const fallback = 'https://api.fluxer.app/v1';
  if (!value) return fallback;

  if (value.includes('app.fluxer.app') || value.includes('web.fluxer.app/api')) {
    return fallback;
  }

  return value;
}

function normalizeGatewayUrl(value) {
  const fallback = 'wss://gateway.fluxer.app';
  if (!value) return fallback;

  if (value.includes('app.fluxer.app')) {
    return fallback;
  }

  return value;
}

function normalizeDnsResultOrder(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!normalized) return 'ipv4first';
  if (['ipv4first', 'verbatim'].includes(normalized)) return normalized;
  throw new ConfigurationError('DNS_RESULT_ORDER must be one of: ipv4first, verbatim');
}

export function loadConfig(env = process.env) {
  const token = env.BOT_TOKEN?.trim();
  if (!token) {
    throw new ConfigurationError('Missing environment variable BOT_TOKEN');
  }

  const prefix = (env.PREFIX ?? '!').trim() || '!';
  const logLevel = (env.LOG_LEVEL ?? 'info').toLowerCase();

  const config = {
    token,
    prefix,
    logLevel,
    apiBase: normalizeApiBase(env.API_BASE),
    gatewayUrl: normalizeGatewayUrl(env.GATEWAY_URL),
    dnsResultOrder: normalizeDnsResultOrder(env.DNS_RESULT_ORDER),
    autoGatewayUrl: parseBool(env.AUTO_GATEWAY_URL, true),
    strictStartupCheck: parseBool(env.STRICT_STARTUP_CHECK, false),
    enableEmbeds: parseBool(env.ENABLE_EMBEDS, true),

    apiCheckRetries: parsePositiveInt(env.API_CHECK_RETRIES, 5),
    apiCheckDelayMs: parsePositiveInt(env.API_CHECK_DELAY_MS, 1_000),

    restTimeoutMs: parsePositiveInt(env.REST_TIMEOUT_MS, 10_000),
    restMaxRetries: parsePositiveInt(env.REST_MAX_RETRIES, 4),
    restRetryBaseDelayMs: parsePositiveInt(env.REST_RETRY_BASE_DELAY_MS, 300),

    sessionIdleMs: parsePositiveInt(env.SESSION_IDLE_MS, 5 * 60_000),
    maxQueueSize: parsePositiveInt(env.MAX_QUEUE_SIZE, 100),
    maxPlaylistTracks: parsePositiveInt(env.MAX_PLAYLIST_TRACKS, 25),
    maxSavedPlaylistsPerGuild: parsePositiveInt(env.MAX_SAVED_PLAYLISTS_PER_GUILD, 100),
    maxSavedTracksPerPlaylist: parsePositiveInt(env.MAX_SAVED_TRACKS_PER_PLAYLIST, 500),
    maxFavoritesPerUser: parsePositiveInt(env.MAX_FAVORITES_PER_USER, 500),
    persistentHistorySize: parsePositiveInt(env.PERSISTENT_HISTORY_SIZE, 200),
    defaultVolumePercent: parsePositiveInt(env.DEFAULT_VOLUME_PERCENT, 100),
    maxVolumePercent: parsePositiveInt(env.MAX_VOLUME_PERCENT, 200),
    minVolumePercent: parseNonNegativeInt(env.MIN_VOLUME_PERCENT, 0),

    mongoUri: env.MONGODB_URI?.trim() || null,
    mongoDb: env.MONGODB_DB?.trim() || 'fluxer_music_bot',
    mongoMaxPoolSize: parsePositiveInt(env.MONGODB_MAX_POOL_SIZE, 120),
    mongoMinPoolSize: parseNonNegativeInt(env.MONGODB_MIN_POOL_SIZE, 5),
    mongoConnectTimeoutMs: parsePositiveInt(env.MONGODB_CONNECT_TIMEOUT_MS, 10_000),
    mongoServerSelectionTimeoutMs: parsePositiveInt(env.MONGODB_SERVER_SELECTION_TIMEOUT_MS, 10_000),
    guildConfigCacheTtlMs: parsePositiveInt(env.GUILD_CONFIG_CACHE_TTL_MS, 60_000),
    guildConfigCacheMaxSize: parsePositiveInt(env.GUILD_CONFIG_CACHE_MAX_SIZE, 5_000),

    spotifyClientId: env.SPOTIFY_CLIENT_ID?.trim() || null,
    spotifyClientSecret: env.SPOTIFY_CLIENT_SECRET?.trim() || null,
    spotifyRefreshToken: env.SPOTIFY_REFRESH_TOKEN?.trim() || null,
    spotifyMarket: (env.SPOTIFY_MARKET?.trim() || 'US').toUpperCase(),
    soundcloudClientId: env.SOUNDCLOUD_CLIENT_ID?.trim() || null,
    soundcloudAutoClientId: parseBool(env.SOUNDCLOUD_AUTO_CLIENT_ID, true),
    strictMediaAuth: parseBool(env.STRICT_MEDIA_AUTH, false),

    ffmpegBin: env.FFMPEG_BIN?.trim() || null,
    ytdlpBin: env.YTDLP_BIN?.trim() || null,

    defaultAutoplayEnabled: parseBool(env.DEFAULT_AUTOPLAY_ENABLED, false),
    defaultDedupeEnabled: parseBool(env.DEFAULT_DEDUPE_ENABLED, false),
    defaultStayInVoiceEnabled: parseBool(env.DEFAULT_247_ENABLED, false),
    voteSkipRatio: parseRatio(env.VOTE_SKIP_RATIO, 0.5),
    voteSkipMinVotes: parsePositiveInt(env.VOTE_SKIP_MIN_VOTES, 2),

    enableYtSearch: parseBool(env.ENABLE_YT_SEARCH, true),
    enableYtPlayback: parseBool(env.ENABLE_YT_PLAYBACK, true),
    enableSpotifyImport: parseBool(env.ENABLE_SPOTIFY_IMPORT, true),
    enableDeezerImport: parseBool(env.ENABLE_DEEZER_IMPORT, true),
    playCommandCooldownMs: parseNonNegativeInt(env.PLAY_COMMAND_COOLDOWN_MS, 2_000),
    searchResultLimit: parsePositiveInt(env.SEARCH_RESULT_LIMIT, 5),
    searchPickTimeoutMs: parsePositiveInt(env.SEARCH_PICK_TIMEOUT_MS, 45_000),
  };

  if (!config.mongoUri) {
    throw new ConfigurationError('Missing environment variable MONGODB_URI');
  }

  if (config.minVolumePercent > config.maxVolumePercent) {
    throw new ConfigurationError('MIN_VOLUME_PERCENT cannot be greater than MAX_VOLUME_PERCENT');
  }

  if (config.defaultVolumePercent < config.minVolumePercent || config.defaultVolumePercent > config.maxVolumePercent) {
    throw new ConfigurationError('DEFAULT_VOLUME_PERCENT is out of configured volume bounds');
  }

  if (config.searchResultLimit > 10) {
    throw new ConfigurationError('SEARCH_RESULT_LIMIT must be <= 10');
  }

  const spotifyFields = [
    ['SPOTIFY_CLIENT_ID', config.spotifyClientId],
    ['SPOTIFY_CLIENT_SECRET', config.spotifyClientSecret],
    ['SPOTIFY_REFRESH_TOKEN', config.spotifyRefreshToken],
  ];
  const spotifySetCount = spotifyFields.filter(([, value]) => Boolean(value)).length;
  if (spotifySetCount > 0 && spotifySetCount < spotifyFields.length) {
    const missing = spotifyFields
      .filter(([, value]) => !value)
      .map(([name]) => name);
    throw new ConfigurationError(`Incomplete Spotify config. Missing: ${missing.join(', ')}`);
  }

  if (!/^[A-Z]{2}$/.test(config.spotifyMarket)) {
    throw new ConfigurationError('SPOTIFY_MARKET must be a 2-letter country code, e.g. US');
  }

  return Object.freeze(config);
}
