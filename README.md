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
- MongoDB-backed guild configuration
  - persistent server-level settings (prefix, DJ roles, autoplay, dedupe, 24/7, vote-skip thresholds, language, music log channel)
  - in-memory TTL cache to reduce DB load at scale
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
  - lyrics lookup command
  - 24/7 mode (stay connected while idle)
  - playlist ingest (YouTube playlists, plus Spotify/SoundCloud/Deezer URL ingestion)
  - interactive search flow (`search` + `pick`)
- Voice/session lifecycle
  - guild session manager
  - idle auto-disconnect
  - clean process/stream teardown
- Command safety
  - per-user `play` cooldown to reduce spam bursts
- Built-in tests for parser, queue, session cleanup, and guild config store

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
- `language [en|de]` (`lang`)
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
  - services:
  - `guildConfigStore.js` (guild settings cache + persistence)
  - `musicLibraryStore.js` (persistent playlists/favorites/history)
  - `lyricsService.js`
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
