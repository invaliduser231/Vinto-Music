<div align="center">

<img src="assets/logo.png" alt="Vinto Music Bot logo" width="140" />

# Vinto Music Bot

Resilient, self-hosted music bot for Fluxer with persistent music data, queue safety, and operational monitoring.

[![Node.js](https://img.shields.io/badge/Node.js-24%2B-339933?style=for-the-badge&logo=node.js&logoColor=white)](#requirements)
[![MongoDB](https://img.shields.io/badge/MongoDB-Required-47A248?style=for-the-badge&logo=mongodb&logoColor=white)](#requirements)
[![NodeLink](https://img.shields.io/badge/NodeLink-Playback-7c3aed?style=for-the-badge)](#requirements)
[![Monitoring](https://img.shields.io/badge/Monitoring-healthz%20%7C%20readyz%20%7C%20metrics-0A66C2?style=for-the-badge)](#what-it-does)

[![Invite Bot](https://img.shields.io/badge/Invite-Hosted%20Bot-ff2d78?style=for-the-badge)](https://web.fluxer.app/oauth2/authorize?client_id=1474774210677452817&scope=bot&permissions=3525696)
[![Support Guild](https://img.shields.io/badge/Support-Vinto%20Guild-2ea44f?style=for-the-badge)](https://fluxer.gg/qDoq4Tf0)
[![Website](https://img.shields.io/badge/Website-vinto.music-f54b8a?style=for-the-badge)](https://vinto.music)

[![ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/Q5Q31VDH1Z)

</div>

---

## Overview

| Area | Highlights |
| --- | --- |
| Playback | NodeLink-backed YouTube, SoundCloud, Deezer, Audius, radio streams, and mirrored imports from Spotify, Apple Music, Amazon Music, Tidal, Bandcamp, Audiomack, Mixcloud, and JioSaavn |
| Reliability | reconnect, playback resume, 24/7 voice watchdog, heartbeat watchdogs, REST retries, graceful shutdown |
| Look and feel | now playing cards with cover art, replies in English, German, and Brazilian Portuguese |
| Persistence | playlists, favorites, history, templates, recap state, reputation/taste signals |
| Operations | `/healthz`, `/readyz`, `/metrics`, structured logging, optional Sentry |

## Jump To

- [Quick Start](#quick-start)
- [Self-Hosting On Fluxer](#self-hosting-on-fluxer)
- [Configuration](#configuration)
- [Dashboard](#dashboard)
- [Commands](#commands)
- [Troubleshooting](#troubleshooting)
- [Architecture](#architecture)

## What It Does

- Reliable gateway handling with reconnect, resume, heartbeat watchdogs, and REST retry logic.
- Playback through NodeLink from YouTube, SoundCloud, Deezer, Audius, radio streams, and mirrored imports from Spotify, Apple Music, Amazon Music, Tidal, Bandcamp, Audiomack, Mixcloud, and JioSaavn URLs.
- Source prefixes for `play` and `search`: `yt:`, `ytm:`, `sc:`, `dz:`, `sp:`, `am:`, `td:`, `bc:`, `js:` search only that service.
- Now playing cards: an image with the blurred cover as background, the cover, title, artist, progress, and the next track (`npcard` turns them off per guild).
- Independent multi-voice playback sessions per guild, with separate queues per voice channel.
- Voice-channel-scoped 24/7 mode plus one-shot restart recovery for active non-24/7 sessions. A watchdog rejoins dropped 24/7 channels with backoff. If an admin disconnects the bot, a regular session ends, and a 24/7 channel is left alone after three removals within 15 minutes.
- Fast playlist UX with first-track start plus background queueing for large external playlists and mixes.
- Optional opportunistic YouTube startup prefetch to reduce time-to-audio for direct video playback.
- Persistent guild playlists, favorites, history, queue templates, recap data, and lightweight user taste/reputation signals in MongoDB.
- Autoplay that keeps the queue going with related tracks (YouTube mix or same artist), and with Last.fm recommendations first when Last.fm is set up.
- Optional Last.fm support: everyone listening in a voice channel can scrobble to their own profile, plus profile stats, taste comparison, channel blends, and queueing loved, top, or recent tracks.
- Guild controls such as limiting music commands to chosen channels, and a warning when the bot lacks text permissions after joining.
- Links that resolve to private or local network addresses are refused, so `play` cannot be used to reach services inside your network.
- Built-in `/healthz`, `/readyz`, and Prometheus `/metrics` endpoints.
- Optional Sentry reporting, an optional Fluxer error channel with redacted reports, opt-in runtime playback diagnostics, and memory telemetry / heap snapshot controls.

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
- NodeLink (bundled in `docker-compose.yml`)
- `ffmpeg` for radio streams and direct audio links

`GATEWAY_ONLY_MODE=1` only skips the startup REST health check and gateway discovery. During normal Fluxer operation the bot still talks to the Fluxer REST API.

## Requirements

| Requirement | Notes |
| --- | --- |
| Node.js | `>= 24` |
| MongoDB | local or managed |
| NodeLink | playback backend, run with `NODELINK_ENABLELOADSTREAMENDPOINT=true` |
| `ffmpeg` | on `PATH` or via `FFMPEG_BIN`, used for radio streams and direct audio links |

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
NODELINK_ENABLED=1
NODELINK_BASE_URL=http://127.0.0.1:3001
NODELINK_PASSWORD=your_nodelink_password
NODELINK_ROUTING_MODE=all
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

The bundled Compose file starts NodeLink next to the bot, and playback runs through it. The image still ships `ffmpeg` for radio streams and direct audio links, plus `yt-dlp` with the `bgutil-ytdlp-pot-provider` plugin as a resolver fallback for setups that do not route everything through NodeLink. With `NODELINK_ROUTING_MODE=all`, yt-dlp is never used for playback.

If the bot runs on a different server than a self-hosted Fluxer instance, set `rtc.use_external_ip: true` in that instance's `livekit.yaml`. Otherwise the bot joins voice but logs `Playback pipeline did not produce audio output in time`.

## Recommended Setups

<details>
<summary><strong>Minimal setup</strong></summary>

Good for the simplest Fluxer self-hosted deployment.

- keep `ENABLE_YT_SEARCH=1`
- keep `ENABLE_YT_PLAYBACK=1`
- run NodeLink with `NODELINK_ROUTING_MODE=all`
- leave Spotify, Deezer, and Tidal credentials empty
- install `ffmpeg`

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
| YouTube playback fails | NodeLink reachability (`/readyz` shows a `nodelink` object), `NODELINK_PASSWORD`, `NODELINK_ENABLELOADSTREAMENDPOINT=true` on NodeLink, `NODELINK_SOURCES_YOUTUBE_PROXIES` if YouTube blocks the server IP |
| A link is refused as a private address | The URL resolves to a private, loopback, or link-local address. Set `ALLOW_PRIVATE_MEDIA_URLS=1` only on private instances that need LAN streams |
| Commands fail but gateway connects | `API_BASE`, token validity, runtime REST access |
| Voice joins but no audio | Fluxer voice-side setup, `VOICE_MAX_BITRATE`, LiveKit-based publisher flow, and whether a restart recovery snapshot existed before reboot |
| Container becomes `unhealthy` and just sits there | Docker does not restart a process only because the healthcheck failed. Keep `UNHEALTHY_EXIT_ENABLED=1` so prolonged `/readyz` failure forces a real restart, and inspect gateway/API reachability |

<details>
<summary><strong>More detail</strong></summary>

### Bot starts but cannot play YouTube

- check that NodeLink is up and that `/readyz` reports it as reachable
- make sure `NODELINK_PASSWORD` matches `NODELINK_SERVER_PASSWORD` on NodeLink and that NodeLink runs with `NODELINK_ENABLELOADSTREAMENDPOINT=true`
- if YouTube blocks the server IP, give NodeLink a proxy pool through `NODELINK_SOURCES_YOUTUBE_PROXIES`
- with `NODELINK_ROUTING_MODE=all` a failed stream is retried through NodeLink and then mirrored to another source, so a single YouTube failure does not stop the queue
- without NodeLink, the yt-dlp settings in [docs/CONFIGURATION.md](docs/CONFIGURATION.md) still apply

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

## Dashboard

Optional web UI for session-scoped playback control in a guild voice channel.

- Setup: [dashboard/README.md](dashboard/README.md)
- Enable with `DASHBOARD_API_ENABLED=1` and a long `DASHBOARD_API_SECRET`
- Default bind: `127.0.0.1:9092`
- Includes live player and queue control, search, history, lyrics, library and radio access, sound effects, vote skip, party mode, insights and Last.fm account controls

## Commands

Default prefix: `!`

### Core Playback

- `help [command|page_number]`, `support`, `ping`
- `join`, `leave`
- `radio <station|random|url>`, `stations [filter] [page]`
- `play <query|url>`, `playnext <query|url>`, `search <query>`, `pick <index>`
- start a query with `yt:`, `ytm:`, `sc:`, `dz:`, `sp:`, `am:`, `td:`, `bc:`, or `js:` to search a single service, for example `play sc: lofi beats`
- `play` with an attached audio or video file queues the file
- `skip`, `skipto <index>`, `voteskip`, `pause`, `resume`, `seek <time>`
- `now`, `queue [page]`, `history [page]`, `previous`, `replay`
- `remove <index|from-to>`, `clear [from-to]`, `move <from> <to>`, `shuffle`, `loop <off|track|queue>`, `volume [0-200]`
- `filter`, `eq`, `tempo`, `pitch`, `effects`, `lyrics`, `stats`

Playback pauses on its own while the voice channel is empty or the bot is server-muted, and continues once someone is back or the mute is lifted. Radio streams keep running.

### Library

- `playlist <create|add|remove|show|list|delete|play> ...`
- `station <list|show|save|delete> ...`
- `fav`, `favs`, `favname <index> <alias>`, `ufav`, `favplay <index|alias>`

### Last.fm

Available when `LASTFM_ENABLED=1`. Each listener links their own account, nothing is enabled guild-wide.

- `lastfm connect` / `lastfm disconnect` / `lastfm status`
- `lastfm on` / `lastfm off` to pause scrobbling without unlinking
- `lastfm profile [@user]`, `lastfm recent [@user]`
- `lastfm top [artists|tracks|albums] [7d|1m|3m|6m|1y|all] [@user]`
- `lastfm compare <@user>` for a taste match score
- `lastfm blend` builds a queue from the top artists of everyone currently in the voice channel
- `lastfm leaderboard [guild|global]`
- `lastfm whoknows [artist]` ranks linked members for an artist, the playing one by default; the top listener with at least 30 plays holds the crown
- `lastfm crowns [@user]`
- `lastfm play <loved|top|recent> [@user] [7d|1m|3m|6m|1y|all]` queues up to 15 tracks from someone's Last.fm lists
- `fmplay [@user]` queues the track someone scrobbled last
- `love` / `unlove` for the currently playing track

`autoplay [on|off]` works without Last.fm too. It picks from the YouTube mix of the last track or from the same artist, and asks Last.fm first when Last.fm is enabled.

A track is scrobbled once it is longer than 30 seconds and the listener heard at least half of it or four minutes, whichever comes first. Listeners who join mid-track are counted from the moment they join. Live streams and radio are never scrobbled.

### Guild Config

- `prefix`
- `settings`
- `minimalmode [on|off]` / `minimal [on|off]`
- `volumedefault [0-200]`
- `djrole`
- `musiclog`
- `musicchannel [off|#channel ...]` limits music commands to up to five channels; commands elsewhere are removed with a short pointer to the right channel
- `npcard [on|off]` turns the now playing card on or off
- `voteskipcfg`
- `247`
- `dedupe`
- `earrape [on|off]`
- `autoplay [on|off]`

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
- `earrape` is guild-scoped and switches bot voice join behavior: enabled means `self_deaf=false` so remote audio can be analyzed.
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
- License model: MIT
- Operator policy templates: [TERMS.md](TERMS.md), [PRIVACY.md](PRIVACY.md)

If you operate a public instance, you are responsible for complying with platform, provider, privacy, and copyright rules in your jurisdiction.
