# Deployment auf einer frischen VPS

Vier Container: der Bot, NodeLink (Audio-Auflösung), MongoDB (Persistenz) und
der bgutil-POT-Provider (YouTube-Bot-Schutz). Nichts davon ist von außen
erreichbar — nur der Bot spricht nach draußen.

## Voraussetzungen

- Linux-VPS, **mindestens 2 GB RAM** (Bot ~1 GB, NodeLink ~300 MB, Mongo ~200 MB)
- Docker Engine mit Compose-Plugin
- Kein GHCR-Login nötig, beide Images sind öffentlich

## 1. Docker installieren

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker "$USER"
newgrp docker
docker compose version
```

## 2. Dateien ablegen

```bash
sudo mkdir -p /opt/vinto && sudo chown "$USER" /opt/vinto
cd /opt/vinto
# docker-compose.yml und .env.example aus diesem Verzeichnis hierher kopieren
cp .env.example .env
chmod 600 .env
```

## 3. `.env` ausfüllen

Pflicht sind `BOT_TOKEN`, `NODELINK_PASSWORD` und `BOT_OWNER_USER_ID`.
Passwort erzeugen:

```bash
openssl rand -hex 24
```

Alles Übrige ist optional — ohne Deezer-ARL läuft Deezer eben nicht, der Rest
funktioniert trotzdem.

## 4. Starten

```bash
docker compose up -d
docker compose ps
docker compose logs -f app
```

Erfolgreich, wenn im Log `Bot user id resolved` und `Gateway ready` stehen.

## 5. Prüfen

Im Server:

```
!ping           - antwortet der Bot?
!permissions    - fehlen ihm Rechte im Kanal?
!play <song>    - spielt er ab?
```

Auf der VPS:

```bash
curl -s localhost:9091/readyz    # muss 200 liefern
docker compose ps                # alle Container "healthy"
```

## Aktualisieren

```bash
cd /opt/vinto
docker compose pull
docker compose up -d
docker image prune -f
```

Da `pull_policy: always` gesetzt ist, holt `up -d` immer das aktuelle Image des
konfigurierten Tags.

## Sicherheit

**Keine Ports öffnen.** Der Monitoring-Port ist bewusst an `127.0.0.1` gebunden
und damit nur lokal erreichbar. Firewall:

```bash
sudo ufw allow OpenSSH
sudo ufw enable
```

Mongo läuft ohne Passwort, ist aber nur im internen Compose-Netz erreichbar und
zusätzlich per `--bind_ip` eingeschränkt. Wer den Port doch veröffentlicht,
muss zwingend Authentifizierung einrichten.

`.env` enthält Token im Klartext — `chmod 600` und nicht ins Git.

## Datensicherung

Alles Persistente liegt im Volume `vinto_mongo_data`:

```bash
docker compose exec -T mongo mongodump --archive --gzip > backup-$(date +%F).gz
# Zurückspielen:
docker compose exec -T mongo mongorestore --archive --gzip --drop < backup-2026-08-20.gz
```

Gesichert werden Playlists, Favoriten, Server-Einstellungen, Sprachwahl und
Sitzungs-Snapshots. Der Bot startet auch ohne Backup neu — dann sind lediglich
diese Daten weg.

## Wenn etwas nicht läuft

**Bot startet nicht** → `docker compose logs app`. Fast immer ein fehlendes
`BOT_TOKEN` oder eine unerreichbare API.

**Musik bleibt stumm** → `docker compose logs nodelink`. Prüfen, ob wirklich der
Fork läuft: `docker compose images nodelink` muss `ghcr.io/invaliduser231/nodelink`
zeigen. Das Upstream-Image spielt Deezer verzerrt ab.

**Deezer klingt kratzig/zu schnell** → falsches NodeLink-Image (siehe oben).

**YouTube meldet „Sign in to confirm you're not a bot"** → die VPS-IP ist
markiert. Abhilfe: `YTDLP_PROXY_URL` setzen.

**Bot antwortet nicht im Kanal** → `!permissions` im betroffenen Kanal; es nennt
genau das fehlende Recht.

## Ressourcen

Auf einer 2-GB-VPS ist Swap sinnvoll, weil Node beim Transcodieren Spitzen hat:

```bash
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```
