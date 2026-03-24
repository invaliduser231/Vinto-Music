import { ConfigurationError } from './core/errors.ts';

function parsePositiveInt(value: unknown, fallback: number): number {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseNonNegativeInt(value: unknown, fallback: number): number {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function parseBool(value: unknown, fallback = false): boolean {
  if (value == null) return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function parseRatio(value: unknown, fallback: number): number {
  const parsed = Number.parseFloat(String(value ?? ''));
  if (!Number.isFinite(parsed)) return fallback;
  if (parsed <= 0 || parsed > 1) return fallback;
  return parsed;
}

function ensureUrlScheme(value: unknown, fallbackScheme: string): string {
  const trimmed = String(value ?? '').trim();
  if (!trimmed) return '';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return trimmed;
  return `${fallbackScheme}://${trimmed.replace(/^\/+/, '')}`;
}

function stripTrailingSlashes(pathname: string): string {
  if (!pathname || pathname === '/') return '/';
  const normalized = pathname.replace(/\/+$/g, '');
  return normalized || '/';
}

function normalizeApiBase(value: unknown): string {
  const fallback = 'https://api.fluxer.app/v1';
  if (!value) return fallback;

  const candidate = ensureUrlScheme(value, 'https');
  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    return fallback;
  }

  const host = parsed.hostname.toLowerCase();
  if (host === 'app.fluxer.app' || host === 'web.fluxer.app') {
    return fallback;
  }

  parsed.hash = '';
  const path = stripTrailingSlashes(parsed.pathname);
  if (host === 'api.fluxer.app') {
    if (path === '/' || path.toLowerCase() === '/api' || path.toLowerCase() === '/api/v1') {
      parsed.pathname = '/v1';
    } else {
      parsed.pathname = path;
    }
  } else {
    parsed.pathname = path === '/' ? '' : path;
  }

  return parsed.toString().replace(/\/$/, '');
}

function normalizeGatewayUrl(value: unknown): string {
  const fallback = 'wss://gateway.fluxer.app';
  if (!value) return fallback;

  const candidate = ensureUrlScheme(value, 'wss');
  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    return fallback;
  }

  const host = parsed.hostname.toLowerCase();
  if (host === 'app.fluxer.app' || host === 'api.fluxer.app' || host === 'web.fluxer.app') {
    return fallback;
  }

  if (parsed.protocol === 'https:') parsed.protocol = 'wss:';
  if (parsed.protocol === 'http:') parsed.protocol = 'ws:';

  parsed.hash = '';
  parsed.pathname = stripTrailingSlashes(parsed.pathname);

  return parsed.toString().replace(/\/$/, '');
}

function normalizeDnsResultOrder(value: unknown): 'ipv4first' | 'verbatim' {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!normalized) return 'ipv4first';
  if (normalized === 'ipv4first' || normalized === 'verbatim') return normalized;
  throw new ConfigurationError('DNS_RESULT_ORDER must be one of: ipv4first, verbatim');
}

function normalizeYouTubePlaylistResolver(value: unknown): 'ytdlp' | 'playdl' {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!normalized || normalized === 'auto') return 'ytdlp';
  if (normalized === 'ytdlp' || normalized === 'playdl') return normalized;
  throw new ConfigurationError('YOUTUBE_PLAYLIST_RESOLVER must be one of: ytdlp, playdl, auto');
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
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
    gatewayIntents: parseNonNegativeInt(env.GATEWAY_INTENTS, 0),
    dnsResultOrder: normalizeDnsResultOrder(env.DNS_RESULT_ORDER),
    autoGatewayUrl: parseBool(env.AUTO_GATEWAY_URL, true),
    gatewayOnlyMode: parseBool(env.GATEWAY_ONLY_MODE, false),
    strictStartupCheck: parseBool(env.STRICT_STARTUP_CHECK, false),
    enableEmbeds: parseBool(env.ENABLE_EMBEDS, true),
    allowDefaultPrefixFallback: parseBool(env.ALLOW_DEFAULT_PREFIX_FALLBACK, false),

    apiCheckRetries: parsePositiveInt(env.API_CHECK_RETRIES, 5),
    apiCheckDelayMs: parsePositiveInt(env.API_CHECK_DELAY_MS, 1_000),

    restTimeoutMs: parsePositiveInt(env.REST_TIMEOUT_MS, 10_000),
    restMaxRetries: parsePositiveInt(env.REST_MAX_RETRIES, 4),
    restRetryBaseDelayMs: parsePositiveInt(env.REST_RETRY_BASE_DELAY_MS, 300),

    sessionIdleMs: parsePositiveInt(env.SESSION_IDLE_MS, 5 * 60_000),
    maxConcurrentVoiceChannelsPerGuild: parsePositiveInt(env.MAX_CONCURRENT_VOICE_CHANNELS_PER_GUILD, 5),
    sessionSnapshotMinWriteIntervalMs: parsePositiveInt(env.SESSION_SNAPSHOT_MIN_WRITE_INTERVAL_MS, 10_000),
    sessionSnapshotFlushIntervalMs: parsePositiveInt(env.SESSION_SNAPSHOT_FLUSH_INTERVAL_MS, 30_000),
    maxQueueSize: parsePositiveInt(env.MAX_QUEUE_SIZE, 100),
    maxPlaylistTracks: parsePositiveInt(env.MAX_PLAYLIST_TRACKS, 25),
    maxSavedPlaylistsPerGuild: parsePositiveInt(env.MAX_SAVED_PLAYLISTS_PER_GUILD, 100),
    maxSavedTracksPerPlaylist: parsePositiveInt(env.MAX_SAVED_TRACKS_PER_PLAYLIST, 500),
    maxFavoritesPerUser: parsePositiveInt(env.MAX_FAVORITES_PER_USER, 500),
    persistentHistorySize: parsePositiveInt(env.PERSISTENT_HISTORY_SIZE, 200),
    defaultVolumePercent: parsePositiveInt(env.DEFAULT_VOLUME_PERCENT, 100),
    maxVolumePercent: parsePositiveInt(env.MAX_VOLUME_PERCENT, 200),
    minVolumePercent: parseNonNegativeInt(env.MIN_VOLUME_PERCENT, 0),
    voiceMaxBitrate: parsePositiveInt(env.VOICE_MAX_BITRATE, 192_000),

    mongoUri: env.MONGODB_URI?.trim() || null,
    mongoDb: env.MONGODB_DB?.trim() || 'fluxer_music_bot',
    mongoMaxPoolSize: parsePositiveInt(env.MONGODB_MAX_POOL_SIZE, 20),
    mongoMinPoolSize: parseNonNegativeInt(env.MONGODB_MIN_POOL_SIZE, 5),
    mongoConnectTimeoutMs: parsePositiveInt(env.MONGODB_CONNECT_TIMEOUT_MS, 10_000),
    mongoServerSelectionTimeoutMs: parsePositiveInt(env.MONGODB_SERVER_SELECTION_TIMEOUT_MS, 10_000),
    mongoPingIntervalMs: parsePositiveInt(env.MONGODB_PING_INTERVAL_MS, 15_000),
    guildConfigCacheTtlMs: parsePositiveInt(env.GUILD_CONFIG_CACHE_TTL_MS, 60_000),
    guildConfigCacheMaxSize: parsePositiveInt(env.GUILD_CONFIG_CACHE_MAX_SIZE, 5_000),

    spotifyClientId: env.SPOTIFY_CLIENT_ID?.trim() || null,
    spotifyClientSecret: env.SPOTIFY_CLIENT_SECRET?.trim() || null,
    spotifyRefreshToken: env.SPOTIFY_REFRESH_TOKEN?.trim() || null,
    spotifyMarket: (env.SPOTIFY_MARKET?.trim() || 'US').toUpperCase(),
    tidalToken: env.TIDAL_TOKEN?.trim() || null,
    tidalCountryCode: (env.TIDAL_COUNTRY_CODE?.trim() || 'US').toUpperCase(),
    soundcloudClientId: env.SOUNDCLOUD_CLIENT_ID?.trim() || null,
    soundcloudAutoClientId: parseBool(env.SOUNDCLOUD_AUTO_CLIENT_ID, true),
    deezerArl: env.DEEZER_ARL?.trim() || null,
    strictMediaAuth: parseBool(env.STRICT_MEDIA_AUTH, false),

    ffmpegBin: env.FFMPEG_BIN?.trim() || null,
    ytdlpBin: env.YTDLP_BIN?.trim() || null,
    ytdlpCookiesFile: env.YTDLP_COOKIES_FILE?.trim() || null,
    ytdlpCookiesFromBrowser: env.YTDLP_COOKIES_FROM_BROWSER?.trim() || null,
    ytdlpYoutubeClient: env.YTDLP_YOUTUBE_CLIENT?.trim() || null,
    ytdlpExtraArgs: env.YTDLP_EXTRA_ARGS?.trim() || null,
    youtubePlaylistResolver: normalizeYouTubePlaylistResolver(env.YOUTUBE_PLAYLIST_RESOLVER),

    defaultDedupeEnabled: parseBool(env.DEFAULT_DEDUPE_ENABLED, false),
    defaultStayInVoiceEnabled: parseBool(env.DEFAULT_247_ENABLED, false),
    voteSkipRatio: parseRatio(env.VOTE_SKIP_RATIO, 0.5),
    voteSkipMinVotes: parsePositiveInt(env.VOTE_SKIP_MIN_VOTES, 2),

    enableYtSearch: parseBool(env.ENABLE_YT_SEARCH, true),
    enableYtPlayback: parseBool(env.ENABLE_YT_PLAYBACK, true),
    enableSpotifyImport: parseBool(env.ENABLE_SPOTIFY_IMPORT, true),
    enableDeezerImport: parseBool(env.ENABLE_DEEZER_IMPORT, true),
    enableTidalImport: parseBool(env.ENABLE_TIDAL_IMPORT, true),
    playCommandCooldownMs: parseNonNegativeInt(env.PLAY_COMMAND_COOLDOWN_MS, 2_000),
    searchResultLimit: parsePositiveInt(env.SEARCH_RESULT_LIMIT, 5),
    searchPickTimeoutMs: parsePositiveInt(env.SEARCH_PICK_TIMEOUT_MS, 45_000),
    playbackDiagnosticsEnabled: parseBool(env.PLAYBACK_DIAGNOSTICS_ENABLED, false),
    playbackDiagnosticsIntervalMs: parsePositiveInt(env.PLAYBACK_DIAGNOSTICS_INTERVAL_MS, 1_000),
    auddApiToken: env.AUDD_API_TOKEN?.trim() || null,

    commandRateLimitEnabled: parseBool(env.COMMAND_RATE_LIMIT_ENABLED, true),
    commandUserWindowMs: parsePositiveInt(env.COMMAND_USER_WINDOW_MS, 10_000),
    commandUserMax: parsePositiveInt(env.COMMAND_USER_MAX, 8),
    commandGuildWindowMs: parsePositiveInt(env.COMMAND_GUILD_WINDOW_MS, 10_000),
    commandGuildMax: parsePositiveInt(env.COMMAND_GUILD_MAX, 40),
    commandRateLimitBypass: String(env.COMMAND_RATE_LIMIT_BYPASS ?? 'help,ping')
      .split(',')
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean),

    monitoringEnabled: parseBool(env.MONITORING_ENABLED, true),
    monitoringHost: (env.MONITORING_HOST ?? '0.0.0.0').trim() || '0.0.0.0',
    monitoringPort: parsePositiveInt(env.MONITORING_PORT, 9091),
    unhealthyExitEnabled: parseBool(env.UNHEALTHY_EXIT_ENABLED, true),
    unhealthyExitAfterMs: parsePositiveInt(env.UNHEALTHY_EXIT_AFTER_MS, 180_000),
    unhealthyCheckIntervalMs: parsePositiveInt(env.UNHEALTHY_CHECK_INTERVAL_MS, 5_000),

    sentryDsn: env.SENTRY_DSN?.trim() || null,
    sentryEnvironment: (env.SENTRY_ENVIRONMENT?.trim() || env.NODE_ENV?.trim() || 'production'),
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

  if (!/^[A-Z]{2}$/.test(config.tidalCountryCode)) {
    throw new ConfigurationError('TIDAL_COUNTRY_CODE must be a 2-letter country code, e.g. US');
  }

  return Object.freeze(config);
}

export type AppConfig = ReturnType<typeof loadConfig>;


