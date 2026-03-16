# Configuration Reference

All environment variables are parsed in `src/config.js`. `.env.example` is the template to copy from.

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
| `MONGODB_MAX_POOL_SIZE` | `120` | Max Mongo connection pool size. |
| `MONGODB_MIN_POOL_SIZE` | `5` | Min Mongo connection pool size. |
| `MONGODB_CONNECT_TIMEOUT_MS` | `10000` | Mongo connect timeout. |
| `MONGODB_SERVER_SELECTION_TIMEOUT_MS` | `10000` | Mongo server selection timeout. |
| `MONGODB_PING_INTERVAL_MS` | `15000` | Background DB health ping interval. |
| `GUILD_CONFIG_CACHE_TTL_MS` | `60000` | Guild config cache TTL. |
| `GUILD_CONFIG_CACHE_MAX_SIZE` | `5000` | Max cached guild config entries. |

## Playback and Queue

| Variable | Default | Notes |
| --- | --- | --- |
| `SESSION_IDLE_MS` | `300000` | Idle timeout before disconnect when 24/7 mode is off. |
| `MAX_QUEUE_SIZE` | `100` | Max pending queue size per guild. |
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
| `VOICE_MAX_BITRATE` | `192000` | Max outbound voice track bitrate in bps. |

## Guild Defaults

| Variable | Default | Notes |
| --- | --- | --- |
| `DEFAULT_DEDUPE_ENABLED` | `0` | Default dedupe state for new guilds. |
| `DEFAULT_247_ENABLED` | `0` | Default 24/7 state for new guilds. |
| `VOTE_SKIP_RATIO` | `0.5` | Default required fraction of listeners for vote-skip. |
| `VOTE_SKIP_MIN_VOTES` | `2` | Default minimum number of vote-skip votes. |

## Import and Source Flags

| Variable | Default | Notes |
| --- | --- | --- |
| `ENABLE_YT_SEARCH` | `1` | Enable text search resolution through YouTube fallback paths. |
| `ENABLE_YT_PLAYBACK` | `1` | Enable YouTube playback paths. |
| `ENABLE_SPOTIFY_IMPORT` | `1` | Enable Spotify URL metadata resolution and mirroring. |
| `ENABLE_DEEZER_IMPORT` | `1` | Enable Deezer URL ingestion. |

## Provider Credentials

| Variable | Default | Notes |
| --- | --- | --- |
| `SPOTIFY_CLIENT_ID` | empty | Optional. Must be set together with secret and refresh token. |
| `SPOTIFY_CLIENT_SECRET` | empty | Optional. Must be set together with client id and refresh token. |
| `SPOTIFY_REFRESH_TOKEN` | empty | Optional. Must be set together with client id and secret. |
| `SPOTIFY_MARKET` | `US` | Two-letter market code. |
| `SOUNDCLOUD_CLIENT_ID` | empty | Optional fixed SoundCloud client id. |
| `SOUNDCLOUD_AUTO_CLIENT_ID` | `1` | Auto-resolve a SoundCloud client id via `play-dl` on startup. |
| `DEEZER_ARL` | empty | Optional Deezer ARL cookie for direct Deezer playback and search preference. |
| `STRICT_MEDIA_AUTH` | `0` | Treat provider auth/bootstrap failures as fatal. |

## Spotify Token Helper

These are used only by `npm run spotify:token`.

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
| `YTDLP_YOUTUBE_CLIENT` | empty | Optional YouTube extractor profile(s). |
| `YTDLP_EXTRA_ARGS` | empty | Comma-separated extra yt-dlp args. |
| `YOUTUBE_PLAYLIST_RESOLVER` | `ytdlp` | Playlist resolver order. Single-track YouTube metadata and text search also prefer `yt-dlp`, with `play-dl` only as fallback. |

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
| `SENTRY_DSN` | empty | Optional Sentry DSN. |
| `SENTRY_ENVIRONMENT` | `production` | Sentry environment label. |

## Practical Presets

### Simple Fluxer setup

Use this if you want the easiest normal Fluxer self-hosted setup.

- required: `BOT_TOKEN`, `MONGODB_URI`
- recommended: install `ffmpeg` and `yt-dlp`
- leave Spotify, SoundCloud, and Deezer credentials empty

### Spotify URL support

Use this if Spotify links should work.

- set `SPOTIFY_CLIENT_ID`
- set `SPOTIFY_CLIENT_SECRET`
- set `SPOTIFY_REFRESH_TOKEN`

Spotify URLs resolve metadata only. Playback is mirrored to Deezer or YouTube.

### Deezer-first resolution

Use this if you want better Deezer coverage.

- set `DEEZER_ARL`

That enables Deezer-first text search and direct Deezer media resolution when possible.
