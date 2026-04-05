# Configuration Reference

Most runtime environment variables are parsed in `src/config.ts`. `.env.example` is the template to copy from. A small number of values are read directly outside `src/config.ts`, mainly owner-only or script-only helpers.

## Required

| Variable | Description |
| --- | --- |
| `BOT_TOKEN` | Bot token used for REST and Gateway authentication. |
| `MONGODB_URI` | MongoDB connection string. |

## Self-Hosting Notes

- The intended deployment target is Fluxer. The default `API_BASE` and `GATEWAY_URL` already point to the official Fluxer services.
- Most operators should leave `API_BASE` and `GATEWAY_URL` unchanged unless they know they need different Fluxer endpoints.
- `GATEWAY_ONLY_MODE=1` skips the startup REST probe and gateway auto-discovery, but normal bot operation still depends on the Fluxer REST API.
- Spotify credentials are optional as a group. If you set one of `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`, or `SPOTIFY_REFRESH_TOKEN`, you must set all three.
- `DEEZER_ARL` is optional, but it enables Deezer-first text resolution and the best direct Deezer playback path.
- `TIDAL_TOKEN` is optional. If it is unset, the bot will best-effort bootstrap a public client token from Tidal's web app for metadata lookups.
- Bandcamp, Audiomack, Mixcloud, and JioSaavn URL imports do not need separate API keys in the current codebase. They resolve metadata and then mirror to Deezer or YouTube.

## Core Runtime

| Variable | Default | Notes |
| --- | --- | --- |
| `PREFIX` | `!` | Default command prefix for new guilds. |
| `LOG_LEVEL` | `info` | Logger verbosity. |
| `API_BASE` | `https://api.fluxer.app/v1` | REST API base URL. |
| `GATEWAY_URL` | `wss://gateway.fluxer.app` | Gateway websocket URL. |
| `GATEWAY_INTENTS` | `0` | Gateway identify intents bitset. |
| `DNS_RESULT_ORDER` | `ipv4first` | `ipv4first` or `verbatim`. |
| `AUTO_GATEWAY_URL` | `1` | Resolve gateway URL from REST `/gateway` or `/gateway/bot` when possible. |
| `GATEWAY_ONLY_MODE` | `0` | Skip startup REST connectivity check and use configured gateway directly. |
| `ENABLE_EMBEDS` | `1` | Use embeds for replies where supported. |
| `ALLOW_DEFAULT_PREFIX_FALLBACK` | `0` | Allow fallback to global default prefix if guild prefix is unknown. |

## Direct-Read / Helper Environment Variables

| Variable | Default | Notes |
| --- | --- | --- |
| `BOT_OWNER_USER_ID` | empty | Directly read by the owner-only `diag` and hidden `eval` commands. Leave empty to disable those commands for everyone. |
| `DEEZER_TRACK_FORMATS` | `MP3_128,MP3_64` | Read directly by `MusicPlayer` as an optional Deezer format preference override rather than through `loadConfig()`. |

## Startup and API Health

| Variable | Default | Notes |
| --- | --- | --- |
| `STRICT_STARTUP_CHECK` | `0` | Exit on failed startup REST check instead of warning and continuing. |
| `API_CHECK_RETRIES` | `5` | Startup REST retry attempts. |
| `API_CHECK_DELAY_MS` | `1000` | Base delay between startup REST checks. Later attempts wait longer. |

## REST Client

| Variable | Default | Notes |
| --- | --- | --- |
| `REST_TIMEOUT_MS` | `10000` | Per-request timeout. |
| `REST_MAX_RETRIES` | `4` | Retry attempts for retryable REST failures. |
| `REST_RETRY_BASE_DELAY_MS` | `300` | Base backoff used for REST retries. |

## MongoDB

| Variable | Default | Notes |
| --- | --- | --- |
| `MONGODB_DB` | `fluxer_music_bot` | Database name. |
| `MONGODB_MAX_POOL_SIZE` | `20` | Max Mongo connection pool size. |
| `MONGODB_MIN_POOL_SIZE` | `5` | Min Mongo connection pool size. |
| `MONGODB_CONNECT_TIMEOUT_MS` | `10000` | Mongo connect timeout. |
| `MONGODB_SERVER_SELECTION_TIMEOUT_MS` | `10000` | Mongo server selection timeout. |
| `MONGODB_PING_INTERVAL_MS` | `15000` | Background DB health ping interval. |
| `GUILD_CONFIG_CACHE_TTL_MS` | `60000` | Guild config cache TTL. |
| `GUILD_CONFIG_CACHE_MAX_SIZE` | `5000` | Max cached guild config entries. |

## Playback and Queue

| Variable | Default | Notes |
| --- | --- | --- |
| `SESSION_IDLE_MS` | `300000` | Idle timeout before disconnect when the active voice-channel session does not have 24/7 enabled. |
| `MAX_CONCURRENT_VOICE_CHANNELS_PER_GUILD` | `5` | Max simultaneously active voice-channel sessions per guild. New sessions above this limit are rejected. |
| `SESSION_SNAPSHOT_MIN_WRITE_INTERVAL_MS` | `10000` | Minimum time between persisted session-snapshot writes for the same voice-channel session. Used for 24/7 resume and restart recovery. |
| `SESSION_SNAPSHOT_FLUSH_INTERVAL_MS` | `30000` | Background flush interval for dirty persistent session snapshots. |
| `SESSION_SNAPSHOT_MAX_PENDING_TRACKS` | `25` | Max queued tracks copied into each persisted session snapshot. Lower this on memory-constrained hosts to reduce periodic clone/write overhead. |
| `MAX_QUEUE_SIZE` | `100` | Max pending queue size per voice-channel session. |
| `MAX_PLAYLIST_TRACKS` | `25` | Max tracks pulled from a single external playlist/import resolution. |
| `MAX_SAVED_PLAYLISTS_PER_GUILD` | `100` | Max persisted guild playlists. |
| `MAX_SAVED_TRACKS_PER_PLAYLIST` | `500` | Max tracks per saved playlist or queue template. |
| `MAX_FAVORITES_PER_USER` | `500` | Max favorites per user. |
| `PERSISTENT_HISTORY_SIZE` | `200` | Max stored guild history entries. |
| `PLAY_COMMAND_COOLDOWN_MS` | `2000` | Per-user cooldown for `play`, `playnext`, and `search`. |
| `SEARCH_RESULT_LIMIT` | `5` | Interactive search result count, must be `<= 10`. |
| `SEARCH_PICK_TIMEOUT_MS` | `45000` | Time window for search result picking. |
| `PLAYBACK_DIAGNOSTICS_ENABLED` | `0` | Emit periodic playback diagnostics logs while audio is active. |
| `PLAYBACK_DIAGNOSTICS_INTERVAL_MS` | `1000` | Diagnostics interval. |
| `AUDD_API_TOKEN` | empty | Optional Audd token for radio now-playing recognition fallback. |
| `DEFAULT_VOLUME_PERCENT` | `100` | Initial playback volume. |
| `MIN_VOLUME_PERCENT` | `0` | Lower volume bound. |
| `MAX_VOLUME_PERCENT` | `200` | Upper volume bound. |
| `VOICE_MAX_BITRATE` | `192000` | Max outbound voice track bitrate in bps. Lower this on multi-stream hosts to cut CPU and network pressure. |
| `MEMORY_TELEMETRY_INTERVAL_MS` | `15000` | Sampling interval for runtime memory telemetry collection. |
| `MEMORY_TELEMETRY_LOG_INTERVAL_MS` | `300000` | Log interval for aggregated runtime memory telemetry. Set `0` to disable periodic memory log emission. |
| `HEAP_SNAPSHOT_SIGNAL_ENABLED` | `1` | Allow runtime heap snapshot signal handling. |
| `HEAP_SNAPSHOT_DIR` | `.heap-snapshots` | Directory used for heap snapshot output. |

## Guild Defaults

| Variable | Default | Notes |
| --- | --- | --- |
| `DEFAULT_DEDUPE_ENABLED` | `0` | Default dedupe state for new guilds. |
| `DEFAULT_247_ENABLED` | `0` | Fallback default 24/7 state when a voice channel has no explicit `voiceProfiles[channelId].stayInVoiceEnabled` override. |
| `VOTE_SKIP_RATIO` | `0.5` | Default required fraction of listeners for vote-skip. |
| `VOTE_SKIP_MIN_VOTES` | `2` | Default minimum number of vote-skip votes. |

## Import and Source Flags

| Variable | Default | Notes |
| --- | --- | --- |
| `ENABLE_YT_SEARCH` | `1` | Enable text search resolution through YouTube fallback paths. |
| `ENABLE_YT_PLAYBACK` | `1` | Enable YouTube playback paths. |
| `ENABLE_SPOTIFY_IMPORT` | `1` | Enable Spotify URL metadata resolution and mirroring. |
| `ENABLE_DEEZER_IMPORT` | `1` | Enable Deezer URL ingestion. |
| `ENABLE_TIDAL_IMPORT` | `1` | Enable Tidal URL metadata resolution and Deezer-first/YouTube fallback mirroring. |
| `ENABLE_YOUTUBE_PREFETCHED_PLAYBACK` | `0` | Opportunistically prefetch direct YouTube stream URLs for faster startup. Usually lowers startup latency, but can be less robust than the default path. |

## Provider Credentials

| Variable | Default | Notes |
| --- | --- | --- |
| `SPOTIFY_CLIENT_ID` | empty | Optional. Must be set together with secret and refresh token. |
| `SPOTIFY_CLIENT_SECRET` | empty | Optional. Must be set together with client id and refresh token. |
| `SPOTIFY_REFRESH_TOKEN` | empty | Optional. Must be set together with client id and secret. |
| `SPOTIFY_MARKET` | `US` | Two-letter market code. |
| `TIDAL_TOKEN` | empty | Optional Tidal client token. If empty, the bot tries to bootstrap one from Tidal web assets. |
| `TIDAL_COUNTRY_CODE` | `US` | Two-letter Tidal market code used for metadata requests. |
| `SOUNDCLOUD_CLIENT_ID` | empty | Optional fixed SoundCloud client id. |
| `SOUNDCLOUD_AUTO_CLIENT_ID` | `1` | Auto-resolve a SoundCloud client id via `play-dl` on startup. |
| `DEEZER_ARL` | empty | Optional Deezer ARL cookie for direct Deezer playback and search preference. |
| `DEEZER_TRACK_FORMATS` | `MP3_128,MP3_64` | Optional comma-separated Deezer format preference order. Allowed values are `FLAC`, `MP3_320`, `MP3_256`, `MP3_128`, `MP3_64`, `AAC_64`. Invalid entries are ignored. This override is read directly by `MusicPlayer`. |
| `STRICT_MEDIA_AUTH` | `0` | Treat provider auth/bootstrap failures as fatal. |

## Spotify Token Helper

These are used only by `pnpm spotify:token`.

| Variable | Default | Notes |
| --- | --- | --- |
| `SPOTIFY_REDIRECT_URI` | `http://127.0.0.1:9876/spotify/callback` | Local OAuth callback for helper script. |
| `SPOTIFY_SCOPE` | `user-read-email` | OAuth scope requested by helper script. |
| `SPOTIFY_ALLOW_MISSING_STATE` | `1` | Allows local callback flow without state when needed. |

## Binaries and yt-dlp

| Variable | Default | Notes |
| --- | --- | --- |
| `FFMPEG_BIN` | auto | Override ffmpeg binary path. |
| `YTDLP_BIN` | auto | Override yt-dlp binary path. |
| `YTDLP_COOKIES_FILE` | empty | Cookies file for YouTube bot-check mitigation. |
| `YTDLP_COOKIES_FROM_BROWSER` | empty | Import cookies from a local browser profile. |
| `YTDLP_YOUTUBE_CLIENT` | empty | Optional YouTube extractor profile(s). Comma-separated values are tried as a strategy list before fallback. |
| `YTDLP_EXTRA_ARGS` | empty | Comma-separated extra yt-dlp args. |
| `YOUTUBE_PLAYLIST_RESOLVER` | `ytdlp` | Playlist resolver order. Single-track YouTube metadata and startup also prefer hardened `yt-dlp`, with `play-dl` fallback when needed. |

Notes:

- `.env.example` intentionally keeps some example values conservative for self-hosting. The table above reflects the actual fallback defaults from [`src/config.ts`](../src/config.ts).
- `.env.example` also includes helper-only variables such as `BOT_OWNER_USER_ID` that are intentionally not parsed through `loadConfig()`.

## Command Rate Limits

| Variable | Default | Notes |
| --- | --- | --- |
| `COMMAND_RATE_LIMIT_ENABLED` | `1` | Enable command rate limiting. |
| `COMMAND_USER_WINDOW_MS` | `10000` | Per-user rate-limit window. |
| `COMMAND_USER_MAX` | `8` | Max commands per user/window. |
| `COMMAND_GUILD_WINDOW_MS` | `10000` | Per-guild rate-limit window. |
| `COMMAND_GUILD_MAX` | `40` | Max commands per guild/window. |
| `COMMAND_RATE_LIMIT_BYPASS` | `help,ping` | Comma-separated command names that bypass limits. |

## Monitoring and Error Reporting

| Variable | Default | Notes |
| --- | --- | --- |
| `MONITORING_ENABLED` | `1` | Start monitoring HTTP server. |
| `MONITORING_HOST` | `0.0.0.0` | Monitoring bind host. Restrict this in untrusted environments. |
| `MONITORING_PORT` | `9091` | Monitoring bind port. |
| `UNHEALTHY_EXIT_ENABLED` | `1` | Exit the process when runtime readiness stays unhealthy long enough, so Docker restart policies can recover it. |
| `UNHEALTHY_EXIT_AFTER_MS` | `180000` | How long `/readyz` may stay unhealthy before the process exits with code `1`. |
| `UNHEALTHY_CHECK_INTERVAL_MS` | `5000` | How often the runtime checks whether unhealthy state should trigger a forced exit. |
| `SENTRY_DSN` | empty | Optional Sentry DSN. |
| `SENTRY_ENVIRONMENT` | `production` | Sentry environment label. |

## Practical Presets

### Simple Fluxer setup

Use this if you want the easiest normal Fluxer self-hosted setup.

- required: `BOT_TOKEN`, `MONGODB_URI`
- recommended: install `ffmpeg` and `yt-dlp`
- leave Spotify, SoundCloud, Deezer, and Tidal credentials empty

This still allows direct YouTube/SoundCloud/Audius/radio playback and URL imports from Bandcamp, Audiomack, Mixcloud, and JioSaavn through metadata mirroring.

## Runtime Notes

- 24/7 is voice-channel-scoped. The `247` command writes to the active voice channel profile, not to a guild-wide switch.
- Active non-24/7 sessions still write restart-recovery snapshots so playback can come back after a bot restart.
- Empty non-24/7 sessions are not persisted across restarts.
- Direct YouTube startup can optionally use `ENABLE_YOUTUBE_PREFETCHED_PLAYBACK=1` to resolve a direct stream URL before the normal playback path begins.

### Spotify URL support

Use this if Spotify links should work.

- set `SPOTIFY_CLIENT_ID`
- set `SPOTIFY_CLIENT_SECRET`
- set `SPOTIFY_REFRESH_TOKEN`

Spotify URLs resolve metadata only. Playback is mirrored to Deezer or YouTube.

### Tidal URL support

Use this if Tidal links should work.

- leave `TIDAL_TOKEN` empty for best-effort automatic bootstrap, or set it explicitly
- optionally set `TIDAL_COUNTRY_CODE`

Tidal URLs resolve metadata only. Playback is mirrored to Deezer first, then YouTube.

### Additional mirror-only URL sources

The current codebase also accepts these keyless metadata sources:

- Bandcamp track and album URLs
- Audiomack song URLs
- Mixcloud cloudcast and playlist-style URLs
- JioSaavn song and collection-style URLs

These sources do not stream directly. They resolve metadata and then mirror to Deezer first, with YouTube as fallback.

### Deezer-first resolution

Use this if you want better Deezer coverage.

- set `DEEZER_ARL`

That enables Deezer-first text search and direct Deezer media resolution when possible.
