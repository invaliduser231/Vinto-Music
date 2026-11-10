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

- [Self-Hosting](#self-hosting)
- [Running From Source](#running-from-source)
- [Music Sources](#music-sources)
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

## Self-Hosting

Docker Compose is the supported way to run Vinto. The stack brings the bot,
NodeLink, the YouTube cipher service and optionally MongoDB and the dashboard,
all configured through one `.env` file:

```bash
mkdir -p ~/vinto && cd ~/vinto
BASE=https://raw.githubusercontent.com/invaliduser231/Vinto-Music/main/deploy
curl -fsSLO "$BASE/docker-compose.yml"
curl -fsSL "$BASE/.env.example" -o .env
# set BOT_TOKEN, NODELINK_PASSWORD and BOT_OWNER_USER_ID in .env
docker compose up -d
```

The full guide covers the database, the dashboard with your own domain,
sharding, updates and backups: [deploy/README.md](deploy/README.md).

On Kubernetes, use the Helm chart in [`deploy/helm/vinto`](deploy/helm/vinto).
It runs the same stack with one pod per shard, see
[`deploy/helm/README.md`](deploy/helm/README.md).

Coolify and similar platforms can deploy `deploy/docker-compose.yml` directly
as a Docker Compose resource. Set the variables from `deploy/.env.example` in
the platform instead of a file.

The defaults point at the official Fluxer services. For a self-hosted Fluxer
instance, set `API_BASE` and `GATEWAY_URL`. If the bot runs on a different
server than that instance, also set `rtc.use_external_ip: true` in its
`livekit.yaml`, otherwise the bot joins voice but logs
`Playback pipeline did not produce audio output in time`.

## Running From Source

For development. Running the bot outside Docker in production means installing
and updating NodeLink (the fork, not upstream), the cipher service, MongoDB and
ffmpeg by hand, which is what the compose file does for you.

| Requirement | Notes |
| --- | --- |
| Node.js | `>= 24`, the images use 26 |
| pnpm | 12, install with `npm install -g pnpm@12` |
| ffmpeg | on `PATH` or via `FFMPEG_BIN`, used for radio streams and direct audio links |

Start NodeLink and MongoDB in Docker and the bot from source:

```bash
pnpm install --frozen-lockfile
cp deploy/.env.example .env
# set BOT_TOKEN and NODELINK_PASSWORD, then add:
#   NODELINK_BASE_URL=http://127.0.0.1:2333
#   MONGODB_URI=mongodb://127.0.0.1:27017
cp .env deploy/.env
docker compose -f deploy/docker-compose.yml -f deploy/docker-compose.dev.yml up -d nodelink mongo
pnpm dev
```

| Action | Command |
| --- | --- |
| Dev mode | `pnpm dev` |
| Build | `pnpm run build` |
| Start the build | `pnpm start` |
| Typecheck | `pnpm run typecheck` |
| Tests | `pnpm test` |
| Spotify token helper | `pnpm spotify:token` |

## Music Sources

Without any credentials Vinto plays YouTube, SoundCloud, Bandcamp, Audius, radio
streams and direct audio links, and resolves Spotify, Apple Music and Tidal
links to a playable match.

| Add | Variables | Effect |
| --- | --- | --- |
| Deezer | `DEEZER_ARL`, `NODELINK_SOURCES_DEEZER_DECRYPTIONKEY` | full-length Deezer playback, preferred for text search and for matching Spotify tracks by ISRC |
| Spotify app | `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET` | own rate limit instead of the shared token service |
| YouTube login | `NODELINK_SOURCES_YOUTUBE_CLIENTS_SETTINGS_TV_REFRESHTOKEN` | fewer "Sign in to confirm you're not a bot" blocks |
| Last.fm | `LASTFM_ENABLED`, `LASTFM_API_KEY`, `LASTFM_API_SECRET`, `LASTFM_ENCRYPTION_KEY` | scrobbling, profile stats, Last.fm autoplay |

Each entry is explained in [deploy/.env.example](deploy/.env.example).

## Troubleshooting

| Problem | What to check |
| --- | --- |
| YouTube playback fails | NodeLink reachability (`/readyz` shows a `nodelink` object), `NODELINK_PASSWORD`, `NODELINK_API_ENABLELOADSTREAMENDPOINT=true` on NodeLink, a YouTube refresh token or `NODELINK_SOURCES_YOUTUBE_PROXIES` if YouTube blocks the server IP |
| A link is refused as a private address | The URL resolves to a private, loopback, or link-local address. Set `ALLOW_PRIVATE_MEDIA_URLS=1` only on private instances that need LAN streams |
| Commands fail but gateway connects | `API_BASE`, token validity, runtime REST access |
| Voice joins but no audio | Fluxer voice-side setup, `VOICE_MAX_BITRATE`, LiveKit-based publisher flow, and whether a restart recovery snapshot existed before reboot |
| Container becomes `unhealthy` and just sits there | Docker does not restart a process only because the healthcheck failed. Keep `UNHEALTHY_EXIT_ENABLED=1` so prolonged `/readyz` failure forces a real restart, and inspect gateway/API reachability |

<details>
<summary><strong>More detail</strong></summary>

### Bot starts but cannot play YouTube

- check that NodeLink is up and that `/readyz` reports it as reachable
- make sure `NODELINK_PASSWORD` matches `NODELINK_SERVER_PASSWORD` on NodeLink and that NodeLink runs with `NODELINK_API_ENABLELOADSTREAMENDPOINT=true`
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
- Env template: [deploy/.env.example](deploy/.env.example)

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
