# Configuration Reference

All environment variables are read in `src/config.js`. Defaults come from parsing logic or `.env.example`.

## Required Variables

| Variable | Description |
| --- | --- |
| `BOT_TOKEN` | Bot token used for API and gateway authentication. |
| `MONGODB_URI` | MongoDB connection string. |

## Core Runtime

| Variable | Default | Notes |
| --- | --- | --- |
| `PREFIX` | `!` | Command prefix. |
| `API_BASE` | `https://api.fluxer.app/v1` | API base URL. |
| `GATEWAY_URL` | `wss://gateway.fluxer.app` | Gateway websocket URL. |
| `GATEWAY_INTENTS` | `0` | Gateway intents bitset used during IDENTIFY. |
| `AUTO_GATEWAY_URL` | `1` | Auto-discover gateway URL if supported. |
| `GATEWAY_ONLY_MODE` | `0` | Skip startup REST checks and use configured `GATEWAY_URL` directly. |
| `DNS_RESULT_ORDER` | `ipv4first` | `ipv4first` or `verbatim`. |
| `LOG_LEVEL` | `info` | Logger verbosity. |
| `ENABLE_EMBEDS` | `1` | Disable to force plain-text replies. |
| `ALLOW_DEFAULT_PREFIX_FALLBACK` | `0` | Permit fallback to default prefix if guild prefix is unknown. |

## Startup and API Health

| Variable | Default | Notes |
| --- | --- | --- |
| `STRICT_STARTUP_CHECK` | `0` | Fail hard on startup check failures. |
| `API_CHECK_RETRIES` | `5` | API readiness retries at startup. |
| `API_CHECK_DELAY_MS` | `1000` | Delay between API readiness retries. |

## REST Client

| Variable | Default | Notes |
| --- | --- | --- |
| `REST_TIMEOUT_MS` | `10000` | Per-request timeout. |
| `REST_MAX_RETRIES` | `4` | Retries for transient failures. |
| `REST_RETRY_BASE_DELAY_MS` | `300` | Backoff base delay. |

## MongoDB

| Variable | Default | Notes |
| --- | --- | --- |
| `MONGODB_DB` | `fluxer_music_bot` | Database name. |
| `MONGODB_MAX_POOL_SIZE` | `120` | Max connection pool size. |
| `MONGODB_MIN_POOL_SIZE` | `5` | Min connection pool size. |
| `MONGODB_CONNECT_TIMEOUT_MS` | `10000` | Connect timeout. |
| `MONGODB_SERVER_SELECTION_TIMEOUT_MS` | `10000` | Server selection timeout. |
| `GUILD_CONFIG_CACHE_TTL_MS` | `60000` | Guild config cache TTL. |
| `GUILD_CONFIG_CACHE_MAX_SIZE` | `5000` | Guild config cache capacity. |

## Playback and Queue

| Variable | Default | Notes |
| --- | --- | --- |
| `SESSION_IDLE_MS` | `300000` | Auto-disconnect idle timeout. |
| `MAX_QUEUE_SIZE` | `100` | Max queued tracks per guild. |
| `MAX_PLAYLIST_TRACKS` | `25` | Max tracks pulled from external playlist import. |
| `PERSISTENT_HISTORY_SIZE` | `200` | Saved history depth. |
| `DEFAULT_VOLUME_PERCENT` | `100` | Initial playback volume. |
| `MIN_VOLUME_PERCENT` | `0` | Lower volume bound. |
| `MAX_VOLUME_PERCENT` | `200` | Upper volume bound. |
| `PLAY_COMMAND_COOLDOWN_MS` | `2000` | Per-user cooldown for `play`. |
| `SEARCH_RESULT_LIMIT` | `5` | Max results for interactive search (`<=10`). |
| `SEARCH_PICK_TIMEOUT_MS` | `45000` | Timeout for `pick` follow-up. |

## Guild Defaults

| Variable | Default | Notes |
| --- | --- | --- |
| `DEFAULT_AUTOPLAY_ENABLED` | `0` | New guild default. |
| `DEFAULT_DEDUPE_ENABLED` | `0` | New guild default. |
| `DEFAULT_247_ENABLED` | `0` | New guild default. |
| `VOTE_SKIP_RATIO` | `0.5` | Fraction required for vote-skip. |
| `VOTE_SKIP_MIN_VOTES` | `2` | Minimum votes required. |

## Import/Source Feature Flags

| Variable | Default | Notes |
| --- | --- | --- |
| `ENABLE_YT_SEARCH` | `1` | Toggle YouTube search resolution. |
| `ENABLE_YT_PLAYBACK` | `1` | Toggle YouTube playback pipeline. |
| `ENABLE_SPOTIFY_IMPORT` | `1` | Toggle Spotify URL ingestion. |
| `ENABLE_DEEZER_IMPORT` | `1` | Toggle Deezer URL ingestion. |

## Provider Credentials

| Variable | Default | Notes |
| --- | --- | --- |
| `SPOTIFY_CLIENT_ID` | empty | Required together with secret and refresh token. |
| `SPOTIFY_CLIENT_SECRET` | empty | Required together with client id and refresh token. |
| `SPOTIFY_REFRESH_TOKEN` | empty | Required together with client id and secret. |
| `SPOTIFY_MARKET` | `US` | Two-letter country code. |
| `SPOTIFY_REDIRECT_URI` | `http://127.0.0.1:9876/spotify/callback` | Used by helper script. |
| `SPOTIFY_SCOPE` | `user-read-email` | Used by helper script. |
| `SPOTIFY_ALLOW_MISSING_STATE` | `1` | Helper script compatibility flag. |
| `SOUNDCLOUD_CLIENT_ID` | empty | Optional explicit SoundCloud client id. |
| `SOUNDCLOUD_AUTO_CLIENT_ID` | `1` | Auto-fetch SoundCloud client id on startup. |
| `STRICT_MEDIA_AUTH` | `0` | Treat provider auth setup failures as fatal. |

## Binary and yt-dlp Options

| Variable | Default | Notes |
| --- | --- | --- |
| `FFMPEG_BIN` | auto | Override ffmpeg binary path. |
| `YTDLP_BIN` | auto | Override yt-dlp binary path. |
| `YTDLP_COOKIES_FILE` | empty | Cookies file for YouTube bot-check mitigation. |
| `YTDLP_COOKIES_FROM_BROWSER` | empty | Read cookies from browser profile. |
| `YTDLP_YOUTUBE_CLIENT` | empty | Optional YouTube extractor profile. |
| `YTDLP_EXTRA_ARGS` | empty | Comma-separated extra yt-dlp args. |

## Command Rate Limits

| Variable | Default | Notes |
| --- | --- | --- |
| `COMMAND_RATE_LIMIT_ENABLED` | `1` | Global command limiter. |
| `COMMAND_USER_WINDOW_MS` | `10000` | User rate-limit window. |
| `COMMAND_USER_MAX` | `8` | Max commands per user/window. |
| `COMMAND_GUILD_WINDOW_MS` | `10000` | Guild rate-limit window. |
| `COMMAND_GUILD_MAX` | `40` | Max commands per guild/window. |
| `COMMAND_RATE_LIMIT_BYPASS` | `help,ping` | Comma-separated bypass commands. |

## Monitoring and Error Reporting

| Variable | Default | Notes |
| --- | --- | --- |
| `MONITORING_ENABLED` | `1` | Enable monitoring HTTP server. |
| `MONITORING_HOST` | `0.0.0.0` | Monitoring bind host. |
| `MONITORING_PORT` | `9091` | Monitoring bind port. |
| `SENTRY_DSN` | empty | Optional Sentry DSN. |
| `SENTRY_ENVIRONMENT` | `production` | Sentry environment value. |

