# Changelog

All notable changes to this project are documented in this file.

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
- Tests:
  - verified player, command, and config flows after the refactor with targeted regression coverage

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

