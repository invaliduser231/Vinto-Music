# Self hosting with Docker

Runs the bot and everything it needs on a single host. Four containers:

| Container    | Purpose                                              |
| ------------ | ---------------------------------------------------- |
| `app`        | the bot itself                                       |
| `nodelink`   | audio resolution and streaming                       |
| `mongo`      | playlists, favorites, guild settings, session state   |
| `bgutil-pot` | token provider that keeps YouTube from blocking hosts |

Only `app` talks to the internet. Nothing is exposed publicly.

## Requirements

- A host with at least 2 GB RAM. Typical usage: bot ~1 GB, NodeLink ~300 MB,
  Mongo ~200 MB.
- Docker Engine with the Compose plugin.
- A bot account and token from the Fluxer developer portal.

The prebuilt images are public, so no registry login is required.

## Install Docker

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

| Variable             | Value                                            |
| -------------------- | ------------------------------------------------ |
| `BOT_TOKEN`          | token from the developer portal                  |
| `NODELINK_PASSWORD`  | any secret, e.g. `openssl rand -hex 24`          |
| `BOT_OWNER_USER_ID`  | your Fluxer user id, unlocks owner only commands |

Everything else has working defaults. Music source credentials are optional:
a source without credentials stays inactive and the bot uses the others.

## Run

```bash
docker compose up -d
docker compose logs -f app
```

The bot is ready once the log shows `Bot user id resolved` and `Gateway ready`.
The first start pulls roughly 1 GB of images.

## Verify

In a guild:

```
!ping           bot responds
!permissions    reports any missing permission in this channel
!play <song>    playback works
```

On the host:

```bash
curl -s localhost:9091/readyz     # 200
docker compose ps                 # all containers healthy
docker compose images nodelink    # check which NodeLink build is running
```

## Updating

```bash
cd ~/vinto
curl -fsSLO https://raw.githubusercontent.com/invaliduser231/Vinto-Music/main/deploy/docker-compose.yml
docker compose pull
docker compose up -d
docker image prune -f
```

When a release adds new settings, merge the template into your existing file
instead of overwriting it:

```bash
BASE=https://raw.githubusercontent.com/invaliduser231/Vinto-Music/main/deploy
curl -fsSL "$BASE/.env.example" -o .env.example
curl -fsSL "$BASE/merge-env.sh" -o merge-env.sh && chmod +x merge-env.sh
./merge-env.sh
```

The script keeps every value you already set, adds keys that are new in the
template, preserves keys that exist only in your file, and writes a timestamped
backup first.

`pull_policy: always` makes `up -d` fetch the current image for the configured
tag. To pin a deployment instead, set `APP_IMAGE` to a `sha-<commit>` tag.

## Security

Do not publish any ports. The monitoring endpoint is bound to `127.0.0.1` and
is meant to stay local. A minimal firewall:

```bash
sudo ufw allow OpenSSH
sudo ufw enable
```

MongoDB runs without authentication. That is acceptable because it is only
reachable inside the compose network and additionally restricted through
`--bind_ip`. If you ever publish that port, enable authentication first.

`.env` contains tokens in plain text. Keep it at `chmod 600` and out of version
control.

## Backups

All persistent state lives in the `vinto_mongo_data` volume:

```bash
docker compose exec -T mongo mongodump --archive --gzip > backup-$(date +%F).gz
```

Restore:

```bash
docker compose exec -T mongo mongorestore --archive --gzip --drop < backup-2026-08-20.gz
```

This covers playlists, favorites, guild settings, language preferences and
session snapshots. The bot starts fine without a backup; only that data is lost.

## Troubleshooting

**Bot does not start.** Check `docker compose logs app`. Usually a missing
`BOT_TOKEN` or an unreachable API.

**No audio.** Check `docker compose logs nodelink`, then confirm which NodeLink
build is running. Upstream `performanc/nodelink` currently plays Deezer
distorted and about a third too fast because it bypasses Blowfish decryption;
the image referenced in `.env.example` fixes that in the source worker.

**YouTube reports "Sign in to confirm you're not a bot".** The host IP is
flagged. Set `YTDLP_PROXY_URL` to route requests through a proxy.

**Bot stays silent in a channel.** Run `!permissions` there. It names the exact
missing permission instead of a generic error.

## Notes on small hosts

Node spikes while transcoding, so on a 2 GB host swap is worth adding:

```bash
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

## Building the image yourself

The compose file consumes prebuilt images. To build from source instead, use
the `Dockerfile` in the repository root and point `APP_IMAGE` at your own
registry, or use the development compose file in the repository root which
builds locally.
