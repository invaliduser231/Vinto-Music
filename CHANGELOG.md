# Changelog

All notable changes to this project are documented in this file.

## [Unreleased]

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

