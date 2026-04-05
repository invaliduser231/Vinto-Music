# Architecture

## Runtime Overview

The bot is split into a few clear runtime layers:

- `src/index.ts`: process entrypoint and top-level startup error handling
- `src/app/bootstrap.ts`: config loading, dependency wiring, monitoring, presence rotation, graceful shutdown
- `src/gateway.ts`: websocket lifecycle, heartbeat handling, reconnect, resume, presence updates, voice state dispatch
- `src/rest.ts`: authenticated REST client with retry, timeout, and rate-limit handling
- `src/bot/`: command router, command registry, guild sessions, permission checks, state stores, and domain services
- `src/player/`: queue model, resolver pipeline, ffmpeg/yt-dlp processing, playback control, and provider-specific source logic
- `src/voice/`: LiveKit-based PCM publishing
- `src/storage/`: MongoDB connectivity
- `src/monitoring/`: health, readiness, Prometheus metrics, and optional Sentry integration

## Fluxer Runtime Assumptions

The bot is built for Fluxer and targets the official Fluxer REST and Gateway endpoints by default.

Operationally that means:

- runtime API calls go through the Fluxer REST API
- websocket events come from the Fluxer Gateway
- voice publishing uses the LiveKit-based flow implemented in `src/voice/VoiceConnection.ts`

## Startup Flow

1. `loadConfig()` validates environment variables.
2. DNS result ordering is configured.
3. Media auth bootstrap runs for `play-dl` provider support.
4. Optional Sentry integration is initialized.
5. MongoDB connects and background health pings start.
6. Guild config store and music library store initialize indexes.
7. The bot resolves the Gateway URL, either from config or REST discovery.
8. REST connectivity is verified unless `GATEWAY_ONLY_MODE=1`.
9. Gateway, session manager, monitoring server, command router, and presence rotation are started.

## Command Flow

1. Gateway emits `MESSAGE_CREATE`.
2. `CommandRouter` parses the prefix and command name.
3. Rate limits, permissions, guild context, and command-specific preconditions are checked.
4. The command resolves or creates a voice-channel session through `SessionManager`.
5. `MusicPlayer` resolves tracks, mutates queue state, and starts or updates playback.
6. `VoiceConnection` publishes PCM frames into the platform voice session.
7. Persistent features write through Mongo-backed stores where needed.

## Playback Resolution Strategy

Resolution is intentionally layered:

1. Plain text query:
   - Deezer search first when `DEEZER_ARL` is configured and Deezer import is enabled
   - then YouTube fallback when enabled
2. Known provider URLs:
   - YouTube video or playlist
   - SoundCloud track or playlist
   - Spotify track, album, playlist, artist
   - Apple Music song, album, artist
   - Amazon Music song or album
   - Deezer track, album, playlist
   - Tidal track, album, playlist, mix
   - Bandcamp track or album
   - Audiomack song URLs
   - Mixcloud cloudcast and playlist-style URLs
   - JioSaavn song and collection-style URLs
   - Audius links
   - direct radio stream URLs and lightweight playlist formats such as `m3u` and `pls`
3. Generic URL fallback:
   - provider-specific metadata lookup when possible
   - otherwise a best-effort fallback search path

Playback path notes:

- YouTube uses ffmpeg plus hardened `yt-dlp` resolution with multiple client strategies, then `play-dl` fallback when needed.
- Direct YouTube startup can optionally prefetch the next direct media URL before the normal playback call path when `ENABLE_YOUTUBE_PREFETCHED_PLAYBACK=1`.
- SoundCloud and Audius use direct API-backed playback paths.
- Deezer can use direct media URL resolution when `DEEZER_ARL` is available.
- Spotify, Apple Music, Amazon Music, Tidal, Bandcamp, Audiomack, Mixcloud, and JioSaavn act as metadata resolvers only. They are mirrored to Deezer first when possible, otherwise YouTube.
- Radio streams are treated as live sources and are not seekable.

## Session and Voice Lifecycle

`SessionManager` owns one playback session per voice channel. A single guild can therefore have multiple concurrent playback sessions. Each session contains:

- a `VoiceConnection`
- a `MusicPlayer`
- effective guild settings plus voice-channel profile overrides
- vote-skip state
- idle timeout state
- optional playback diagnostics state

Important behavior:

- idle sessions are destroyed after `SESSION_IDLE_MS` unless that voice-channel session has 24/7 enabled
- vote-skip state resets per track
- playback diagnostics can log periodic player and transport snapshots
- runtime memory telemetry and optional heap snapshot signal handling are configured from env
- queue-end behavior can still disconnect after idle timeout even if listeners remain, unless that voice-channel session has 24/7 enabled
- 24/7 is voice-channel-scoped and comes from `guild_features.voiceProfiles[channelId].stayInVoiceEnabled`
- active non-24/7 sessions still persist restart-recovery state so playback can be restored after a bot restart
- active sessions flush progress snapshots periodically while audio is running, so restart recovery resumes closer to the current position instead of the last command boundary

## Data Model

MongoDB collections used by the current code:

- `guild_configs`: prefix, dedupe, legacy/fallback 24/7 default, vote-skip settings, DJ roles, music log channel
- `guild_playlists`: saved guild playlists
- `user_favorites`: per-user favorites
- `guild_history`: recent played-track history per guild
- `guild_features`: queue templates, queue guard config, voice profiles, webhook URL, recap channel, persistent 24/7 bindings, restart-recovery bindings
- `guild_session_snapshots`: compact per-session playback snapshots for 24/7 resume and restart recovery
- `user_profiles`: lightweight taste memory and guild-level reputation stats
- `guild_recaps`: recap send-state metadata

Notes:

- Restart recovery is intentionally separate from 24/7. Non-24/7 sessions are restored only when they were active at shutdown.

The guild config store keeps a TTL cache in memory to reduce repeated reads for hot guilds.

## Monitoring and Reliability

- Gateway reconnects with exponential backoff and resumes sessions when possible.
- REST requests retry on retryable failures and respect route/global rate limits.
- Mongo health is tracked with recurring ping checks.
- Monitoring endpoints:
  - `/healthz`
  - `/readyz`
  - `/metrics`
- Shutdown handles active sessions, monitoring server, MongoDB, and Sentry flushing.

## Practical Self-Hosting Implication

For normal Fluxer self-hosting, the operator-managed pieces are mainly:

- bot token and env configuration
- MongoDB
- `ffmpeg`
- usually `yt-dlp`
