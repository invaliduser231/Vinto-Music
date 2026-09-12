# Vinto dashboard (local)

Web UI for the Vinto Music bot. Session scoped to one guild voice channel.

## Local dev

```bash
cd dashboard
cp .env.local.example .env.local
pnpm install
pnpm dev
```

Open http://localhost:3000. Mock mode uses local sample data.

## Live bot connection

1. Enable the bot dashboard API (`DASHBOARD_API_ENABLED=1` in the bot `.env`).
2. Set `NEXT_PUBLIC_USE_MOCK_SESSION=0` in `dashboard/.env.local`.
3. Sign in with Fluxer OAuth when configured, pick a server, then join a voice channel on Fluxer.

Without OAuth, set guild, channel, and API credentials in the connect panel manually.

Voice channels with active bot sessions are listed automatically once you are in a channel.

## Behind a reverse proxy

Two upstreams share one hostname: `/ws` belongs to the bot API (port 9092),
everything else to this app (port 3000). Sending the whole hostname to port 3000
loads the page and signs you in, but no session ever arrives, so the player
stays on "Bring Vinto here" and the console repeats
`can't establish a connection to the server at wss://<host>/ws`.

Working Caddy and nginx snippets, plus the `DASHBOARD_WS_URL` alternative, are
in `docs/CONFIGURATION.md` under "Reverse proxy".

## Fluxer OAuth

Optional. Set `FLUXER_OAUTH_CLIENT_ID`, `FLUXER_OAUTH_CLIENT_SECRET`, and `AUTH_COOKIE_SECRET` in `.env.local`.
Register `http://localhost:3000/api/auth/callback` as a redirect URI on your Fluxer application.

Defaults:

- Authorize: `https://web.fluxer.app/oauth2/authorize` (user login + consent in the Fluxer web app)
- Token: `https://api.fluxer.app/oauth2/token` (not under `/v1`)
- API: `https://api.fluxer.app/v1` for userinfo and guilds

When OAuth is configured, login replaces manual user ID entry. Guild roles are resolved by the bot API.

## Dashboard areas

- Player: live playback state, search results, seek, volume, loop modes, queue reordering, CSV export, history and lyrics
- Library: favorites, guild playlists, queue templates and saved radio stations
- Sound: the same filter, equalizer, tempo, pitch and mood controls exposed by bot commands
- Community: vote skip, temporary DJ handoff and the shared two-team party battle
- Insights: guild recap, taste profile, Last.fm connection, scrobbling controls, recent tracks and weekly top tracks

Controls are permission-aware. Listeners can vote, join party teams and manage their own Last.fm account; playback and destructive queue actions follow the configured DJ access, while guild settings and DJ handoff require server management access.
