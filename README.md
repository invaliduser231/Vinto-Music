# Fluxer Music Bot

Production-oriented music bot for Fluxer with resilient gateway/REST handling, modular command architecture, and robust voice playback.

## Features

- Resilient Gateway client
  - heartbeat ACK watchdog
  - reconnect with backoff + jitter
  - session resume support
- Resilient REST client
  - request timeout
  - retry/backoff for transient failures
  - 429 retry-after handling
  - embed fallback to plain text when needed
- Modular command framework
  - command registry + aliases + usage metadata
  - centralized error handling
  - per-guild dynamic prefix parsing
  - command modules split by domain (`index`, `libraryCommands`, `configCommands`)
- Platform permission safety
  - preflight checks for bot text-channel send permission
  - preflight checks for bot voice connect/speak permission
  - config commands bound to server-manage permissions
- Global anti-spam rate limiting
  - per-user and per-guild command windows
  - configurable bypass list for low-risk commands
- MongoDB-backed guild configuration
  - persistent server-level settings (prefix, DJ roles, autoplay, dedupe, 24/7, vote-skip thresholds, music log channel)
  - in-memory TTL cache to reduce DB load at scale
  - configuration changes are permission-gated by server-level manage permissions (not DJ role)
- MongoDB-backed music library
  - persistent guild playlists
  - persistent user favorites
  - persistent guild playback history
- Music features
  - multi-source ingest: YouTube, SoundCloud, Spotify (matched to YouTube), Deezer (matched to YouTube)
  - source feature flags (YouTube search/playback, Spotify import, Deezer import)
  - queue + play-next
  - previous track replay
  - replay current/last track
  - playback history view
  - seek support for YouTube tracks
  - now playing progress bar, queue pagination + pending duration
  - remove, clear, shuffle
  - pause/resume/skip
  - vote-skip for non-DJ users
  - loop modes (`off`, `track`, `queue`)
  - volume control
  - filter presets (`bassboost`, `nightcore`, `vaporwave`, `8d`, `soft`, `karaoke`, `radio`)
  - EQ presets (`flat`, `pop`, `rock`, `edm`, `vocal`)
  - tempo/pitch controls
  - autoplay when queue is empty
  - dedupe mode (skip duplicate tracks)
- DJ role restrictions
  - DJ role controls playback actions only (skip/pause/volume/effects/etc.)
  - lyrics lookup command
  - 24/7 mode (stay connected while idle)
  - playlist ingest (YouTube playlists, plus Spotify/SoundCloud/Deezer URL ingestion)
  - interactive search flow (`search` + `pick`)
- Voice/session lifecycle
  - guild session manager
  - idle auto-disconnect
  - clean process/stream teardown
- Operations/monitoring
  - graceful shutdown on `SIGINT` / `SIGTERM`
  - health/readiness endpoint (`/healthz`, `/readyz`)
  - Prometheus metrics endpoint (`/metrics`)
  - optional Sentry exception reporting (`SENTRY_DSN`)
- Command safety
  - global per-user and per-guild command rate limiting
  - per-user `play` cooldown to reduce spam bursts
- Built-in tests for parser, queue, session cleanup, and guild config store
  - command-level tests for help output, permission gates, and rate limiting

## Commands

Prefix defaults to `!`.

- `help`
- `ping`
- `join [#voice-channel]`
- `leave` (`disconnect`, `dc`, `stop`)
- `play <query | url>`
- `playnext <query | url>`
- `search <query>`
- `pick <index>`
- `replay` (`restart`)
- `skip`
- `voteskip` (`vs`)
- `pause`
- `resume`
- `now` (`np`, `nowplaying`)
- `seek <seconds|mm:ss|hh:mm:ss>`
- `previous` (`prev`, `back`)
- `queue [page]`
- `history [page]` (`recent`)
- `remove <index>`
- `clear`
- `shuffle`
- `loop <off|track|queue>`
- `volume [0-200]`
- `filter [off|bassboost|nightcore|vaporwave|8d|soft|karaoke|radio]`
- `eq [flat|pop|rock|edm|vocal]`
- `tempo <0.5-2.0>`
- `pitch <-12..12>`
- `effects` (`fxstate`)
- `autoplay [on|off]`
- `dedupe [on|off]`
- `247 [on|off]`
- `playlist <create|add|remove|show|list|delete|play> ...` (`pl`)
- `fav [query|url]` (`favorite`)
- `favs [page]` (`favorites`)
- `ufav <index>` (`unfav`)
- `favplay <index>` (`fp`)
- `djrole [add|remove|clear|list] [@role|roleId]`
- `prefix [newPrefix]`
- `musiclog [off|#channel|channelId]` (`logchannel`)
- `voteskipcfg [ratio <0..1>|min <number>]` (`vscfg`)
- `settings` (`cfg`, `config`)
- `lyrics [artist - title]`
- `stats`

## Setup

1. Install dependencies:

```bash
npm install
```

2. Create `.env` from `.env.example` and set:
  - `BOT_TOKEN`
  - `MONGODB_URI`
  - `MONGODB_DB` (or keep default)
  - keep `DNS_RESULT_ORDER=ipv4first` unless your network requires `verbatim`
  - optional for full source support:
  - `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`, `SPOTIFY_REFRESH_TOKEN`
  - `SOUNDCLOUD_CLIENT_ID` (or keep `SOUNDCLOUD_AUTO_CLIENT_ID=1`)
  - optional scale/feature tuning:
  - `MAX_SAVED_PLAYLISTS_PER_GUILD`, `MAX_SAVED_TRACKS_PER_PLAYLIST`, `MAX_FAVORITES_PER_USER`
  - `PERSISTENT_HISTORY_SIZE`, `SEARCH_RESULT_LIMIT`, `SEARCH_PICK_TIMEOUT_MS`
  - anti-spam + monitoring:
  - `COMMAND_RATE_LIMIT_ENABLED`, `COMMAND_USER_WINDOW_MS`, `COMMAND_USER_MAX`
  - `COMMAND_GUILD_WINDOW_MS`, `COMMAND_GUILD_MAX`, `COMMAND_RATE_LIMIT_BYPASS`
  - `MONITORING_ENABLED`, `MONITORING_HOST`, `MONITORING_PORT`
  - optional error reporting:
  - `SENTRY_DSN`, `SENTRY_ENVIRONMENT`

3. Start bot:

```bash
npm start
```

## Development

Run in watch mode:

```bash
npm run dev
```

Run tests:

```bash
npm test
```

Generate Spotify refresh token (helper):

```bash
npm run spotify:token
```

Before running it, add `SPOTIFY_CLIENT_ID` and `SPOTIFY_CLIENT_SECRET` to `.env`,
and add `SPOTIFY_REDIRECT_URI` in your Spotify app dashboard.

## Architecture

- `src/index.js`
  - bootstraps config, REST, gateway, sessions, router
- `src/gateway.js`
  - websocket lifecycle + heartbeat/reconnect/resume
- `src/rest.js`
  - robust API transport wrapper
- `src/bot/`
  - `commandRouter.js`, command registry, session manager, voice state store
  - `commands/index.js` + domain modules (`configCommands.js`, `libraryCommands.js`)
  - services:
  - `guildConfigStore.js` (guild settings cache + persistence)
  - `musicLibraryStore.js` (persistent playlists/favorites/history)
  - `permissionService.js` (effective bot permission checks)
  - `lyricsService.js`
- `src/monitoring/`
  - `metrics.js` (Prometheus registry)
  - `server.js` (health/ready/metrics HTTP server)
  - `sentry.js` (optional Sentry integration)
- `src/player/`
  - queue + music playback pipeline
- `src/storage/`
  - MongoDB connection layer
- `src/voice/`
  - LiveKit room connection and PCM frame publishing

## Notes

- `ffmpeg` and `yt-dlp` should be available on the host (or set `FFMPEG_BIN` / `YTDLP_BIN`).
- Guild-specific settings are persisted in MongoDB collection `guild_configs`.
- Spotify direct support needs valid Spotify credentials in env.
- SoundCloud direct support needs a client id (env or auto-fetch at startup).
- The bot uses text commands intentionally for compatibility with currently documented Fluxer bot APIs.
- Legal docs for public operation are included:
  - `LICENSE`
  - `TERMS.md`
  - `PRIVACY.md`
- Voice state resolution includes REST + short event wait fallback so `!play` works after bot cold-start while users are already in voice.
