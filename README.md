<div align="center">

<img src="assets/logo.png" alt="Vinto Music Bot logo" width="140" />

# Vinto Music Bot

Resilient, self-hosted music bot for Fluxer with persistent music data, queue safety, and operational monitoring.

[![Node.js](https://img.shields.io/badge/Node.js-24%2B-339933?style=for-the-badge&logo=node.js&logoColor=white)](#requirements)
[![MongoDB](https://img.shields.io/badge/MongoDB-Required-47A248?style=for-the-badge&logo=mongodb&logoColor=white)](#requirements)
[![yt-dlp](https://img.shields.io/badge/yt--dlp-Recommended-ffcc00?style=for-the-badge)](#requirements)
[![Monitoring](https://img.shields.io/badge/Monitoring-healthz%20%7C%20readyz%20%7C%20metrics-0A66C2?style=for-the-badge)](#what-it-does)

[![Invite Bot](https://img.shields.io/badge/Invite-Hosted%20Bot-ff2d78?style=for-the-badge)](https://web.fluxer.app/oauth2/authorize?client_id=1474774210677452817&scope=bot&permissions=3525696)
[![Support Server](https://img.shields.io/badge/Support-Vinto%20Server-2ea44f?style=for-the-badge)](https://fluxer.gg/qDoq4Tf0)
[![Website](https://img.shields.io/badge/Website-vinto.music-f54b8a?style=for-the-badge)](https://vinto.music)

[![ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/Q5Q31VDH1Z)

</div>

---

## Overview

| Area | Highlights |
| --- | --- |
| Playback | YouTube, SoundCloud, Deezer, Audius, radio streams, and mirrored imports from Spotify, Apple Music, Amazon Music, Tidal, Bandcamp, Audiomack, Mixcloud, and JioSaavn |
| Reliability | reconnect, playback resume, heartbeat watchdogs, REST retries, graceful shutdown |
| Persistence | playlists, favorites, history, templates, recap state, reputation/taste signals |
| Operations | `/healthz`, `/readyz`, `/metrics`, structured logging, optional Sentry |

## Jump To

- [Quick Start](#quick-start)
- [Self-Hosting On Fluxer](#self-hosting-on-fluxer)
- [Configuration](#configuration)
- [Commands](#commands)
- [Troubleshooting](#troubleshooting)
- [Architecture](#architecture)

## What It Does

- Reliable gateway handling with reconnect, resume, heartbeat watchdogs, and REST retry logic.
- Playback from YouTube, SoundCloud, Deezer, Audius, radio streams, and mirrored imports from Spotify, Apple Music, Amazon Music, Tidal, Bandcamp, Audiomack, Mixcloud, and JioSaavn URLs.
- Independent multi-voice playback sessions per guild, with separate queues per voice channel.
- Voice-channel-scoped 24/7 mode plus one-shot restart recovery for active non-24/7 sessions.
- Fast playlist UX with first-track start plus background queueing for large external playlists and mixes.
- Optional opportunistic YouTube startup prefetch to reduce time-to-audio for direct video playback.
- Persistent guild playlists, favorites, history, queue templates, recap data, and lightweight user taste/reputation signals in MongoDB.
- Built-in `/healthz`, `/readyz`, and Prometheus `/metrics` endpoints.
- Optional Sentry reporting, opt-in runtime playback diagnostics, and memory telemetry / heap snapshot controls.

## Self-Hosting On Fluxer

> This project is intended to be self-hosted for Fluxer.

The defaults already point at the official Fluxer services:

| Variable | Default |
| --- | --- |
| `API_BASE` | `https://api.fluxer.app/v1` |
| `GATEWAY_URL` | `wss://gateway.fluxer.app` |

For most operators, the practical requirements are:

- a valid Fluxer bot token
- MongoDB
- `ffmpeg`
- ideally `yt-dlp`

`GATEWAY_ONLY_MODE=1` only skips the startup REST health check and gateway discovery. During normal Fluxer operation the bot still talks to the Fluxer REST API.

## Requirements

| Requirement | Notes |
| --- | --- |
| Node.js | `>= 24` |
| MongoDB | local or managed |
| `ffmpeg` | on `PATH` or via `FFMPEG_BIN` |
| `yt-dlp` | strongly recommended for YouTube playback |

## Quick Start

### 1. Install pnpm, then copy env

If `pnpm` is not installed yet, enable it through Corepack first:

```bash
corepack enable
```

Then install dependencies and create your env file:

```bash
pnpm install --frozen-lockfile
cp .env.example .env
```

Windows PowerShell:

```powershell
Copy-Item .env.example .env
```

### 2. Fill the minimum env values

```env
BOT_TOKEN=your_fluxer_bot_token
MONGODB_URI=mongodb://127.0.0.1:27017
```

### 3. Start the bot

```bash
pnpm start
```

Useful commands:

| Action | Command |
| --- | --- |
| Start | `pnpm start` |
| Dev mode | `pnpm dev` |
| Build | `pnpm run build` |
| Typecheck | `pnpm run typecheck` |
| Tests | `pnpm test` |
| Spotify token helper | `pnpm spotify:token` |

## Deploy On Coolify

This repo now includes [`docker-compose.yml`](docker-compose.yml) and a production [`Dockerfile`](Dockerfile) for Coolify.

### Recommended Coolify setup

- Use the Docker Compose deployment type.
- Set at least `BOT_TOKEN` in Coolify.
- Leave `MONGODB_URI` unset if you want to use the bundled `mongo` service from `docker-compose.yml`.
- Expose port `9091` if you want Coolify or external monitoring to reach `/healthz`, `/readyz`, and `/metrics`.
- Add any optional provider secrets such as `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`, `SPOTIFY_REFRESH_TOKEN`, `DEEZER_ARL`, or `SENTRY_DSN` directly in Coolify as environment variables.
- The bundled Docker defaults already set conservative memory values: `NODE_OPTIONS=--max-old-space-size=1024 --openssl-legacy-provider`, `MONGODB_MAX_POOL_SIZE=20`, and `MONGODB_MIN_POOL_SIZE=2`. Override them in Coolify only if you want different limits.
- The app now exits with code `1` if it stays unhealthy for too long, so `restart: unless-stopped` can actually restart the container. Tune this with `UNHEALTHY_EXIT_AFTER_MS` if needed.

If you use an external MongoDB instead of the bundled container, set:

```env
MONGODB_URI=mongodb://user:password@your-mongo-host:27017
```

The container image already installs `ffmpeg`, the standalone `yt-dlp` package, and the `bgutil-ytdlp-pot-provider` plugin. The bundled Compose file also starts the matching PO-token provider sidecar for harder YouTube hosts.

## Recommended Setups

<details>
<summary><strong>Minimal setup</strong></summary>

Good for the simplest Fluxer self-hosted deployment.

- keep `ENABLE_YT_SEARCH=1`
- keep `ENABLE_YT_PLAYBACK=1`
- leave Spotify, Deezer, and Tidal credentials empty
- install `ffmpeg`
- install `yt-dlp`

This still supports YouTube, SoundCloud, Audius, radio streams, and keyless metadata mirroring from Bandcamp, Audiomack, Mixcloud, and JioSaavn URLs.

</details>

<details>
<summary><strong>Spotify import setup</strong></summary>

Use this if users should be able to paste Spotify URLs.

- set `SPOTIFY_CLIENT_ID`
- set `SPOTIFY_CLIENT_SECRET`
- set `SPOTIFY_REFRESH_TOKEN`
- optionally set `SPOTIFY_MARKET`

Spotify is metadata resolution only. Playback is mirrored to Deezer first when `DEEZER_ARL` is configured, otherwise to YouTube.

</details>

<details>
<summary><strong>Deezer-first setup</strong></summary>

Use this if you want Deezer-first text search and the best direct Deezer playback path.

- set `DEEZER_ARL`
- keep `ENABLE_DEEZER_IMPORT=1`

With `DEEZER_ARL` configured, plain text `play` resolution prefers Deezer before falling back to YouTube.

</details>

## Troubleshooting

| Problem | What to check |
| --- | --- |
| YouTube playback fails | `ffmpeg`, `yt-dlp`, `YTDLP_COOKIES_FILE`, `YTDLP_COOKIES_FROM_BROWSER`, `YTDLP_YOUTUBE_CLIENT`, `YTDLP_EXTRA_ARGS`, `bgutil-pot` |
| Commands fail but gateway connects | `API_BASE`, token validity, runtime REST access |
| Voice joins but no audio | Fluxer voice-side setup, `VOICE_MAX_BITRATE`, LiveKit-based publisher flow, and whether a restart recovery snapshot existed before reboot |
| Container becomes `unhealthy` and just sits there | Docker does not restart a process only because the healthcheck failed. Keep `UNHEALTHY_EXIT_ENABLED=1` so prolonged `/readyz` failure forces a real restart, and inspect gateway/API reachability |

<details>
<summary><strong>More detail</strong></summary>

### Bot starts but cannot play YouTube

- make sure `ffmpeg` works on the host
- install `yt-dlp`
- if YouTube returns bot checks, set `YTDLP_COOKIES_FILE` or `YTDLP_COOKIES_FROM_BROWSER`
- for Docker, keep the default `bgutil-pot` sidecar, `YTDLP_YOUTUBE_CLIENT=mweb`, and `YTDLP_EXTRA_ARGS` with the `youtubepot-bgutilhttp` provider URL
- if a specific YouTube extractor profile is unstable outside Docker, try `YTDLP_YOUTUBE_CLIENT=mweb,android_vr,web_safari`
- the runtime now retries multiple `yt-dlp` client strategies and can fall back to `play-dl`, so outright startup failures usually point to host binaries or provider-side blocking
- `ENABLE_YOUTUBE_PREFETCHED_PLAYBACK=1` can improve startup latency for direct YouTube playback, but trades some robustness for speed

### Bot connects to gateway but commands fail

- check that `API_BASE` still points to the Fluxer API
- verify the token works against both Fluxer Gateway and REST
- remember that `GATEWAY_ONLY_MODE` does not remove the runtime REST dependency

### Bot joins voice but no audio is heard

- check the voice-side setup on Fluxer first
- the bot uses the LiveKit-based publisher in `src/voice/VoiceConnection.ts`
- lower `VOICE_MAX_BITRATE` if your voice environment is bandwidth-constrained

</details>

## Configuration

`src/config.ts` is the main source of truth for runtime env parsing and validation. A few direct-read env vars also exist outside it, such as `BOT_OWNER_USER_ID` for owner-only maintenance commands and the script-only Spotify helper vars.

- Full env reference: [docs/CONFIGURATION.md](docs/CONFIGURATION.md)
- Architecture notes: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- Env template: [.env.example](.env.example)

## Commands

Default prefix: `!`

### Core Playback

- `help [command|page_number]`, `support`, `ping`
- `join`, `leave`
- `radio <station|random|url>`, `stations [filter] [page]`
- `play <query|url>`, `playnext <query|url>`, `search <query>`, `pick <index>`
- `skip`, `voteskip`, `pause`, `resume`, `seek <time>`
- `now`, `queue [page]`, `history [page]`, `previous`, `replay`
- `remove <index>`, `clear`, `shuffle`, `loop <off|track|queue>`, `volume [0-200]`
- `filter`, `eq`, `tempo`, `pitch`, `effects`, `lyrics`, `stats`

### Library

- `playlist <create|add|remove|show|list|delete|play> ...`
- `station <list|show|save|delete> ...`
- `fav`, `favs`, `ufav`, `favplay`

### Guild Config

- `prefix`
- `settings`
- `minimalmode [on|off]` / `minimal [on|off]`
- `volumedefault [0-200]`
- `djrole`
- `musiclog`
- `voteskipcfg`
- `247`
- `dedupe`

### Extended Features

- `mood`
- `musicwebhook`
- `queueguard`
- `template`
- `charts`
- `recap`
- `voiceprofile`
- `reputation`
- `taste`
- `handoff`
- `party`
- `import`
- `diag [now|last|track|cancel]` (owner-only)
- `eval <code>` (owner-only, hidden)

Notes:

- `247` is voice-channel-scoped, not guild-wide.
- Owner-only commands use `BOT_OWNER_USER_ID`.

## Architecture

High-level runtime notes are in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

| Area | Files |
| --- | --- |
| Bootstrap | `src/app/bootstrap.ts`, `src/index.ts` |
| Gateway | `src/gateway.ts` |
| REST | `src/rest.ts` |
| Commands and sessions | `src/bot/` |
| Playback | `src/player/` |
| Voice | `src/voice/` |
| Storage | `src/storage/` |
| Monitoring | `src/monitoring/` |

## Project Standards

- Website: [vinto.music](https://vinto.music)
- Contributing: [CONTRIBUTING.md](CONTRIBUTING.md)
- Security: [SECURITY.md](SECURITY.md)
- Code of conduct: [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)
- Support: [SUPPORT.md](SUPPORT.md)
- Changelog: [CHANGELOG.md](CHANGELOG.md)

## Legal

- Code license: [LICENSE](LICENSE)
- License model: source-available, private-use-only
- Operator policy templates: [TERMS.md](TERMS.md), [PRIVACY.md](PRIVACY.md)

If you operate a public instance, you are responsible for complying with platform, provider, privacy, and copyright rules in your jurisdiction.
