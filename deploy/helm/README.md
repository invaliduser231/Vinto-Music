# Self hosting on Kubernetes

An alternative to the [Docker Compose setup](../README.md) for clusters. The
chart in `vinto/` runs the same containers:

| Workload     | Kind        | Purpose                                              |
| ------------ | ----------- | ---------------------------------------------------- |
| `app`        | StatefulSet | the bot, one pod per shard                           |
| `nodelink`   | Deployment  | audio resolution and streaming                       |
| `yt-cipher`  | Deployment  | solves YouTube signature ciphers for NodeLink        |
| `bgutil-pot` | Deployment  | token provider for the yt-dlp fallback               |
| `dashboard`  | Deployment  | web dashboard, off by default                        |

There is no bundled database. Point `MONGODB_URI` at your own MongoDB, for
example Atlas.

## Requirements

- Kubernetes 1.28 or newer. The shard id comes from the
  `apps.kubernetes.io/pod-index` label.
- Helm 3.8 or newer, Helm 4 works as well.
- Permission to create Deployments, StatefulSets, Services, Secrets and
  NetworkPolicies in the target namespace. Ingress is only needed for a public
  dashboard.

## Set up

All configuration that the Compose setup keeps in `.env` lives in one Secret.
Start from the same template:

```bash
BASE=https://raw.githubusercontent.com/invaliduser231/Vinto-Music/main/deploy
curl -fsSL "$BASE/.env.example" -o .env
chmod 600 .env
```

Fill at least `BOT_TOKEN`, `NODELINK_PASSWORD`, `BOT_OWNER_USER_ID` and
`MONGODB_URI`. With the dashboard enabled, `DASHBOARD_API_SECRET` and the
`FLUXER_OAUTH_*` values are required too. Then create the Secret:

```bash
kubectl -n <namespace> create secret generic vinto-env --from-env-file=.env
```

`--from-env-file` takes values literally. Remove quotes around values in
`.env` before creating the Secret.

## Install

```bash
git clone --depth 1 https://github.com/invaliduser231/Vinto-Music.git
helm upgrade --install vinto Vinto-Music/deploy/helm/vinto \
  -n <namespace> --set secret.name=vinto-env
```

The bot is ready once `kubectl -n <namespace> get pods` shows the `vinto-app-0`
pod as ready and its log contains `Gateway ready`.

Settings that are not secret can also go into a values file instead of the
Secret. Keys under `app.env`, `nodelink.env` and `dashboard.env` take
precedence over the Secret:

```yaml
secret:
  name: vinto-env
app:
  env:
    NODELINK_ROUTING_MODE: all
```

```bash
helm upgrade --install vinto Vinto-Music/deploy/helm/vinto -n <namespace> -f my-values.yaml
```

## Updating

Images default to moving tags with `pullPolicy: Always`, so a restart pulls
the current build:

```bash
kubectl -n <namespace> rollout restart statefulset/vinto-app deployment/vinto-nodelink
```

To pin a release, set `app.image.tag` to a `sha-<commit>` tag and run
`helm upgrade` again. After editing `.env`, replace the Secret and restart:

```bash
kubectl -n <namespace> create secret generic vinto-env --from-env-file=.env \
  --dry-run=client -o yaml | kubectl -n <namespace> apply -f -
kubectl -n <namespace> rollout restart statefulset/vinto-app deployment/vinto-nodelink
```

`helm rollback vinto` returns to the previous release.

## Sharding

Set `shardCount`. Each pod of the `vinto-app` StatefulSet takes its ordinal as
`SHARD_ID` and announces itself to the dashboard through the headless service.
A rolling update replaces one pod at a time, so two processes never share a
shard id.

```bash
helm upgrade vinto Vinto-Music/deploy/helm/vinto -n <namespace> --reuse-values --set shardCount=2
```

## Dashboard

Enable it with `dashboard.enabled=true`. Without an Ingress it is only
reachable through a port forward:

```bash
kubectl -n <namespace> port-forward svc/vinto-dashboard 3000:3000
```

For a public dashboard set `dashboard.ingress.enabled`, `dashboard.ingress.host`
and, if needed, `dashboard.ingress.className` and `dashboard.ingress.tls`. Set
`DASHBOARD_API_ALLOWED_ORIGINS` and `FLUXER_OAUTH_REDIRECT_URI` to the public
origin. The Ingress controller must allow WebSocket upgrades on `/ws`.

## Network policies

With `networkPolicy.enabled` (default) only the bot reaches NodeLink and the
token provider, only NodeLink reaches the cipher service, and only the dashboard
reaches the bot API. The monitoring port stays closed unless
`networkPolicy.monitoringFrom` lists peers, for example:

```yaml
networkPolicy:
  monitoringFrom:
    - namespaceSelector:
        matchLabels:
          kubernetes.io/metadata.name: monitoring
```

## Optional components

- `bgutilPot.enabled=false` drops the token provider. Only the yt-dlp fallback
  uses it, so it is not needed with `NODELINK_ROUTING_MODE=all`.
- `ytCipher.enabled=false` with `ytCipher.externalUrl=https://cipher.kikkia.dev/api`
  uses the public cipher service instead of a local one.

## Security

Containers run with the runtime default seccomp profile, without
capabilities and without privilege escalation. The images run as root, so a
namespace that enforces the `restricted` Pod Security level rejects them.
