# Self hosting with Docker

Docker Compose is the supported way to run Vinto. Everything the bot needs runs
next to it, and every setting lives in a single `.env` file.

For a Kubernetes cluster there is a Helm chart instead, see
[helm/README.md](helm/README.md). Running without containers is meant for
development only, see "Running from source" in the main README.

## What runs

| Container     | Purpose                                                 | Started        |
| ------------- | ------------------------------------------------------- | -------------- |
| `app`         | the bot                                                 | always         |
| `nodelink`    | resolves links and streams the audio                    | always         |
| `yt-cipher`   | solves YouTube signature ciphers for NodeLink           | always         |
| `bgutil-pot`  | YouTube token provider for the yt-dlp fallback          | always         |
| `mongo`       | playlists, favorites, guild settings, session snapshots | `bundled-db`   |
| `dashboard`   | web dashboard with Fluxer login                         | `dashboard`    |
| `app-shard-1` | second bot process for large installs                   | `sharded`      |

The last column names the profile that switches a container on. Profiles are
set once in `.env` through `COMPOSE_PROFILES`, so plain `docker compose up -d`
always starts the same set. Nothing is reachable from outside the host; the
monitoring and dashboard ports are bound to `127.0.0.1`.

## Requirements

- A Linux host with at least 2 GB RAM. Typical usage: bot 500 MB to 1 GB,
  NodeLink about 700 MB, Mongo about 200 MB, cipher about 250 MB.
- Docker Engine with the Compose plugin.
- A bot account and its token from the Fluxer developer portal.

The images are public, no registry login is needed.

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker "$USER"
newgrp docker
docker compose version
```

## Set up

```bash
mkdir -p ~/vinto && cd ~/vinto
BASE=https://raw.githubusercontent.com/invaliduser231/Vinto-Music/main/deploy
curl -fsSLO "$BASE/docker-compose.yml"
curl -fsSL "$BASE/.env.example" -o .env
chmod 600 .env
```

Edit `.env`. Three values are required:

| Variable            | Value                                            |
| ------------------- | ------------------------------------------------ |
| `BOT_TOKEN`         | token from the developer portal                  |
| `NODELINK_PASSWORD` | any secret, for example `openssl rand -hex 24`   |
| `BOT_OWNER_USER_ID` | your Fluxer user id, unlocks owner only commands |

Everything else has working defaults. YouTube, SoundCloud, Bandcamp, radio
streams and Spotify links play without any credentials. The "Music sources"
section of `.env` explains what Deezer, Spotify app credentials and a YouTube
refresh token add.

### Database

By default `COMPOSE_PROFILES=bundled-db` starts MongoDB in a container. For a
hosted database such as Atlas, set `MONGODB_URI` and remove `bundled-db`:

```
COMPOSE_PROFILES=
MONGODB_URI=mongodb+srv://user:password@cluster.example.net/?appName=Vinto
```

Do not run the bundled container next to an external database. An idle Mongo
still costs CPU, and on a small host that is capacity playback needs.

## Run

```bash
docker compose up -d
docker compose logs -f app
```

The bot is ready once the log shows `Bot user id resolved` and `Gateway ready`.
The first start pulls roughly 1.5 GB of images.

## Verify

In a guild:

```
!ping           bot responds
!permissions    reports any missing permission in this channel
!play <song>    playback works
```

On the host:

```bash
curl -s localhost:9091/readyz          # 200
docker compose ps                      # all containers healthy
docker compose images nodelink         # which NodeLink build is running
```

To see which database the bot uses without printing the password:

```bash
docker compose exec app node -e "console.log(new URL(process.env.MONGODB_URI).host)"
```

## Dashboard

The dashboard shows the queue and lets listeners control playback after
logging in with their Fluxer account.

1. Create an OAuth application in the Fluxer developer portal. Its redirect URL
   is `https://<your domain>/api/auth/callback`, or
   `http://127.0.0.1:3000/api/auth/callback` when the dashboard stays local.
2. Fill in `.env`:

   ```
   COMPOSE_PROFILES=bundled-db,dashboard
   DASHBOARD_API_ENABLED=1
   DASHBOARD_API_SECRET=<openssl rand -hex 24>
   AUTH_COOKIE_SECRET=<openssl rand -hex 32>
   FLUXER_OAUTH_CLIENT_ID=<from the portal>
   FLUXER_OAUTH_CLIENT_SECRET=<from the portal>
   FLUXER_OAUTH_REDIRECT_URI=https://dashboard.example.com/api/auth/callback
   DASHBOARD_API_ALLOWED_ORIGINS=https://dashboard.example.com
   ```

3. `docker compose up -d`

The dashboard listens on `127.0.0.1:3000`. To make it public, put a reverse
proxy with TLS in front of that port. The dashboard forwards its live
connection (`/ws`) to the bot itself, so a single route is enough. With Caddy:

```
dashboard.example.com {
	reverse_proxy 127.0.0.1:3000
}
```

Point the DNS record of the domain at the host and open ports 80 and 443.
Caddy fetches the certificate on its own.

## Sharding

One bot process handles a few thousand guilds. Beyond that, split them across
two processes:

```
SHARD_COUNT=2
COMPOSE_PROFILES=bundled-db,sharded
```

Then `docker compose up -d`. Each shard announces itself, the dashboard and
`!stats` cover all of them. Shard 1 has its monitoring endpoint on
`127.0.0.1:9093`.

## Updating

```bash
cd ~/vinto
curl -fsSLO https://raw.githubusercontent.com/invaliduser231/Vinto-Music/main/deploy/docker-compose.yml
docker compose pull
docker compose up -d
docker image prune -f
```

`up -d` recreates every container whose image or settings changed, including
all shards and the dashboard. Active voice sessions are restored after the
restart.

When a release adds new settings, merge the template into your existing file
instead of overwriting it:

```bash
BASE=https://raw.githubusercontent.com/invaliduser231/Vinto-Music/main/deploy
curl -fsSL "$BASE/.env.example" -o .env.example
curl -fsSL "$BASE/merge-env.sh" -o merge-env.sh && chmod +x merge-env.sh
./merge-env.sh
```

The script keeps every value you already set, adds keys that are new in the
template, keeps keys that exist only in your file, and writes a timestamped
backup first.

To pin a release instead of following the latest build, set `APP_IMAGE` and
`DASHBOARD_IMAGE` to a version tag such as `v0.16.1`.

## Building the images yourself

Clone the repository and use the build override, which builds the bot and the
dashboard from the checkout instead of pulling them:

```bash
git clone https://github.com/invaliduser231/Vinto-Music.git
cd Vinto-Music/deploy
cp .env.example .env
docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build
```

To make that the default for this directory, add
`COMPOSE_FILE=docker-compose.yml:docker-compose.build.yml` to `.env`.

## Security

Do not publish any ports except through a reverse proxy for the dashboard. A
minimal firewall:

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80,443/tcp    # only with a public dashboard
sudo ufw enable
```

MongoDB runs without authentication. That is acceptable because it is only
reachable inside the compose network and additionally restricted through
`--bind_ip`. If you ever publish that port, enable authentication first.

`.env` contains tokens in plain text. Keep it at `chmod 600` and out of version
control.

## Backups

With the bundled database, all persistent state lives in the `vinto_mongo_data`
volume:

```bash
docker compose exec -T mongo mongodump --archive --gzip > backup-$(date +%F).gz
```

Restore:

```bash
docker compose exec -T mongo mongorestore --archive --gzip --drop < backup-2026-08-20.gz
```

This covers playlists, favorites, guild settings, language preferences, Last.fm
connections and session snapshots. The bot starts fine without a backup; only
that data is lost.

## Troubleshooting

**Bot does not start.** Check `docker compose logs app`. A configuration error
names the variable, for example `Missing environment variable BOT_TOKEN`.

**No audio.** Check `docker compose logs nodelink`, then confirm the NodeLink
image. `NODELINK_IMAGE` has to point at `ghcr.io/invaliduser231/nodelink:dev`:
the upstream image plays Deezer distorted and about a third too fast, and it
replaces offline YouTube live streams with unrelated tracks.

**YouTube reports "Sign in to confirm you're not a bot".** The host IP is
flagged. A YouTube refresh token usually lifts this, see the "Music sources"
section of `.env`. Otherwise route NodeLink through a proxy with
`NODELINK_SOURCES_YOUTUBE_PROXIES`.

**NodeLink logs "No streaming data found" for every YouTube video.** NodeLink
cannot reach the cipher service. Check the local container:

```bash
docker compose logs yt-cipher --tail 50
docker compose exec nodelink node -e "fetch(process.env.NODELINK_SOURCES_YOUTUBE_CIPHER_URL+'/get_sts',{method:'POST',headers:{'content-type':'application/json'},body:'{}'}).then(r=>console.log('HTTP',r.status)).catch(e=>console.log('FAIL',e.cause?.code||e.message))"
```

The public instance at `https://cipher.kikkia.dev/api` works as a drop in
replacement through `NODELINK_SOURCES_YOUTUBE_CIPHER_URL`, but it is rate limited
and shared by everyone who uses it.

**"No streaming data found" for a single YouTube live stream.** The stream has
ended or was removed. Vinto reports the error instead of playing something else.

**Bot stays silent in a channel.** Run `!permissions` there. It names the exact
missing permission instead of a generic error.

**Dashboard login loops back to the start page.** `FLUXER_OAUTH_REDIRECT_URI`
does not match the redirect URL of the OAuth application, or
`DASHBOARD_API_ALLOWED_ORIGINS` does not contain the address in the browser.

## Notes on small hosts

Node spikes while transcoding, so on a 2 GB host swap is worth adding:

```bash
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```
