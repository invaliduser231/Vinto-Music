# Changelog

All notable changes to this project are documented in this file.

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

