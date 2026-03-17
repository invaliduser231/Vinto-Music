# Changelog

All notable changes to this project are documented in this file.

## [0.5.0] - 2026-03-18

- Session and persistence model:
  - changed playback sessions from guild-wide to voice-channel-scoped so one guild can run multiple independent voice sessions
  - changed 24/7 mode from guild-wide to voice-channel-scoped via voice profiles
  - added compact playback snapshots plus restart recovery for active non-24/7 sessions
  - restored playback state after restart for queue, current track, volume, loop mode, paused state, and seek where supported
  - added stale persistent-channel cleanup when a saved target voice channel no longer exists
- Runtime cleanup:
  - disabled the legacy session panel runtime path
  - added a guild-level limit for concurrent voice-channel sessions
- Tests:
  - added regression coverage for multi-session shutdown recovery ordering, snapshot persistence, missing-channel cleanup, and voice-channel-scoped 24/7 behavior

## [0.4.9] - 2026-03-16

- HTTP/radio playback and URL classification hardening:
  - split direct HTTP audio files from live radio streams so `.mp3`-style URLs no longer default to radio handling
  - restored live-radio handling for generic `m3u8`/`m3u`/`pls` inputs, including relative HLS playlist targets and fallback live classification
  - routed generic HTTP media URLs through direct ffmpeg playback instead of `play-dl`
  - simplified live HTTP ffmpeg input flags for wider compatibility with Icecast/Shoutcast/Securenet-style streams
  - enriched startup playback errors with ffmpeg stderr details to make failing URLs diagnosable
- YouTube and seek behavior:
  - changed single YouTube URL and search resolution to prefer `yt-dlp` before `play-dl`
  - switched YouTube seek startup to prefer direct media URLs for more reliable long seeks
  - rejected seek targets at or beyond the known track length instead of failing later during playback startup
- Radio now-playing and progress UX:
  - kept live progress labeling for real radio streams while showing `Unknown` for non-live tracks with missing duration
  - added ffmpeg-based audio sampling for HLS radio links so AudD fallback can work on playlist-style live streams
  - kept radio-only now-playing recognition behavior tied to tracks classified as `radio-stream`
- Runtime defaults and operational stability:
  - reduced default MongoDB pool sizing for smaller deployments
  - added conservative Docker/Node memory defaults for self-hosted runtime stability
  - stopped retrying unsafe REST message sends automatically to avoid duplicate bot messages on client-side timeouts
- Tests:
  - added regression coverage for HTTP audio vs radio classification, HLS resolver fallback, yt-dlp seek startup, and radio now-playing fallback behavior

## [0.4.8] - 2026-03-10

- Spotify playlist mirroring fix:
  - preserved artist metadata when Spotify tracks are mirrored to YouTube so playlist and album imports use `artist - title` searches instead of title-only lookups
  - normalized Spotify mirror duration handoff to avoid feeding formatted duration labels back through the preview-length fallback path
  - added targeted regression coverage for Spotify playlist collection mirroring

## [0.4.7] - 2026-03-09

- Amazon Music mirroring:
  - added Amazon Music URL detection for track and album links
  - resolved Amazon Music metadata through Amazon's web `config.json` and `legacy/lookup` endpoints before HTML fallback
  - mirrored Amazon tracks to Deezer first with YouTube fallback
  - mirrored Amazon album links to Deezer album-track search so collection links resolve to multiple playable tracks instead of collapsing to one song
  - removed the temporary `song.link` dependency from the Amazon path
- Now playing cleanup:
  - removed the `Source` field from all `now` / `now playing` embeds
  - simplified radio `now` output to focus on detected song, artist, progress, and linked station name
  - restored the radio recognition support footer for live radio embeds only

## [0.4.6] - 2026-03-08

- Radio now-playing recognition and live-stream UX:
  - added radio now-playing detection from ICY metadata with optional AudD fallback via `AUDD_API_TOKEN`
  - upgraded radio `now` output to show the detected live song and recognition source
  - added a subtle support footer on radio recognition embeds because that lookup path has ongoing API cost
  - changed `play` so active radio/live playback is interrupted immediately and the new track or stream starts next instead of waiting in queue
  - normalized live progress labeling from `live/unknown` to `Live`
- Docs and branding refresh:
  - reworked README styling with badges, tables, collapsible setup sections, and project links
  - added repository logo and official website link to the README
  - rewrote self-hosting docs around the expected Fluxer deployment path
  - aligned configuration, architecture, support, contribution, privacy, and terms docs with the current codebase and stored data model

## [0.4.5] - 2026-03-08

- Fluxer guild and presence fixes:
  - fixed global guild pagination to use the correct `after` cursor so bot-wide guild counts continue past the first 200 entries
  - aligned startup and rotating gateway presence handling with Fluxer custom status payloads
  - initialized presence from real guild counts instead of leaving the bot stuck on a placeholder startup status
- Apple Music mirroring:
  - added Apple Music URL detection for song, album, and artist links
  - resolved Apple Music metadata through public lookup/fallback page parsing and mirrored playable results to Deezer or YouTube
  - added targeted regression coverage for Apple Music single-track and collection resolution paths

## [0.4.4] - 2026-03-07

- Spotify URL import and mirroring:
  - added Spotify Web API metadata resolution for track, album, playlist, and artist URLs
  - introduced Spotify mirror selection that prefers Deezer matches when `DEEZER_ARL` is configured, then falls back to YouTube
  - added Spotify-specific track metadata fields and player wiring for mirrored resolution paths
  - documented Spotify credentials and current non-native playback model in README and architecture/config docs
- YouTube seek startup reliability:
  - increased initial playback startup timeout for large seek offsets so long YouTube seeks have more time to produce their first audio chunk
  - added targeted regression coverage for large-offset seek startup timeout behavior
- YouTube single-track metadata fallback:
  - added yt-dlp JSON metadata fallback for single YouTube URL resolution when `play-dl.video_info()` fails
  - preserved the existing `Unknown` fallback only for cases where both resolvers fail
  - added regression coverage for cloud-style single-link resolution failures that still have valid yt-dlp metadata
- Radio stream URL support:
  - added generic live-stream detection for direct `audio/*` responses and simple `m3u`/`pls` radio playlist links
  - resolved radio links into dedicated live tracks and routed playback through direct HTTP ffmpeg streaming instead of `play-dl`
  - marked live radio tracks as non-seekable and added targeted playback/resolver coverage

## [0.4.3] - 2026-03-06

- Project modularity refactor:
  - split `MusicPlayer` into smaller domain modules and reduced the main player file below the 2000-line cap
  - separated player source logic into dedicated Audius, SoundCloud, Deezer, URL resolver, process, and track factory modules
  - introduced explicit source client wrappers so `MusicPlayer` now talks to domain APIs instead of a flat method mix
  - split command helper logic into dedicated formatting, context, access, guild-stats, and search-selection modules
  - extracted router utility and router operation helpers to reduce `commandRouter` size and tighten responsibility boundaries
  - centralized duplicated command response/progress payload helpers in a shared `responseUtils` module
- Maintenance:
  - enforced the rule that no file in `src/` or `test/` exceeds 2000 lines
- Gateway and live processing:
  - improved invalid-session recovery to delay resume/identify retries correctly and clear stale retry timers during shutdown
  - added a live PCM audio processor with runtime volume, EQ, and filter preset transitions for stream-safe audio shaping
- Tests:
  - verified player, command, and config flows after the refactor with targeted regression coverage
  - added live audio processor coverage for runtime volume changes and live-filter preset support detection

## [0.4.2] - 2026-03-06

- Deezer playback parity and reliability:
  - aligned ARL media URL flow closer to lavasrc (`song.getData` token path and first-media-first-source selection)
  - added Deezer session token caching with TTL refresh behavior for fewer gateway roundtrips
  - switched ARL media format requests to configurable `BF_CBC_STRIPE` format lists (`DEEZER_TRACK_FORMATS`, default `MP3_128,MP3_64`)
  - improved cookie handling compatibility for fetch runtimes that only expose a single `set-cookie` header accessor
- Queue-end and idle-disconnect fixes:
  - fixed queue-empty handling so stale stream-tail state no longer blocks idle timeout scheduling
  - added explicit voice stream stop on queue end/reset paths to avoid lingering stream state
  - ensured queue-end idle timeout can disconnect after configured inactivity even when listeners remain in voice
- YouTube resolver hardening:
  - improved playlist URL normalization for `music.youtube.com`, HTML-escaped query strings, and radio (`RD...`) playlist links
  - added fallback inference from radio playlist IDs to watch URLs when playlist resolvers fail
  - added Windows launcher fallback for yt-dlp via `py -m yt_dlp` when `yt-dlp` binary is not on PATH
- Search defaults:
  - restored Deezer-first text search priority (with YouTube fallback) for standard query resolution
- Tests:
  - added coverage for Deezer parity behavior, queue-empty voice-stop/idle-timeout behavior, and YouTube playlist fallback resolution paths

## [0.4.1] - 2026-03-05

- Lyrics matching reliability:
  - improved `lyrics` fallback to use `artist - title` for the current track instead of title-only lookups
  - added artist metadata propagation for YouTube and stored tracks so lyrics requests have better context
  - changed LRCLIB selection from first-hit to best-match scoring (artist/title/query similarity)
  - kept provider fallback behavior (`lrclib.net` -> `lyrics.ovh`) when no strong LRCLIB match exists
- Tests:
  - added `lyricsService` tests for ranking behavior and provider fallback
  - added command test coverage for `lyrics` fallback query composition

## [0.4.0] - 2026-03-05

- Player source pipeline and resolver updates:
  - added direct playback pipelines for Deezer, Audius, and SoundCloud tracks
  - switched text search resolution to Deezer-first (when ARL/direct path is configured), then YouTube fallback
  - disabled Spotify URL fallback resolution and return `Spotify support is coming soon.`
  - added provider-focused tests for Deezer direct/search behavior, Audius direct playback path, and SoundCloud direct playback path
- Voice/session stability and diagnostics:
  - added configurable voice publish bitrate (`VOICE_MAX_BITRATE`) and richer voice/pump transport diagnostics
  - added opt-in periodic playback diagnostics (`PLAYBACK_DIAGNOSTICS_ENABLED`, `PLAYBACK_DIAGNOSTICS_INTERVAL_MS`)
  - fixed idle-timeout race condition where stale timers from replaced sessions could destroy active sessions
  - documented new runtime/media environment options, including optional `DEEZER_ARL`
- Bot reply media UX:
  - added optional embed thumbnail/image options in responder and router reply plumbing
  - now includes track thumbnails in `play`, `playnext`, `pick`, and automatic `Now playing` responses
- Deezer playback stability and diagnostics:
  - optimized Deezer stripe decryption transform to reduce buffer churn and CPU spikes
  - added Deezer encrypted stream resume/retry with byte-range reconnect support
  - improved voice pump buffering with adaptive target queue and startup prefill
  - added short concealment-frame handling for micro-gaps to reduce audible stalls
  - added owner-only diagnostics command `diag` with snapshot and full-track summary modes
- Docs refresh:
  - aligned README/architecture/privacy/terms wording with current bot behavior and naming
  - documented current Spotify status (`Spotify support is coming soon.`)

## [0.3.0] - 2026-03-04

- Bot command and playback UX improvements:
  - removed autoplay command/settings and deleted remaining autoplay playback logic
  - added reaction-based `search` picking (`1️⃣`-`🔟`) while keeping `pick` compatibility
  - added full-page reaction pagination support for long command outputs (`queue`, `history`, playlists, templates, charts, lyrics)
  - fixed guild recap sweep to iterate all guild pages instead of only the first page
- Rich media and panel updates:
  - added thumbnail propagation from resolver sources through storage and embeds
  - updated `now` and session panel embeds to use track thumbnails/images when available
  - set a default gateway presence/activity at startup and on resume
- Tests:
  - updated config permission/config store tests after autoplay removal
  - added thumbnail pipeline coverage

## [0.2.0] - 2026-02-25

- Repository governance and release hardening:
  - improved README and architecture/configuration docs
  - added contribution and security policies
  - added code of conduct and support guidance
  - added GitHub issue/PR templates, CI workflow, and Dependabot config
- Licensing update:
  - replaced MIT with a private-use-only source-available license
  - clarified licensing model in project metadata and documentation
- Tests:
  - updated help command test for paginated embed behavior

