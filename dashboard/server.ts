import { createServer } from 'node:http';
import next from 'next';
import { getShardDirectory } from './src/lib/shard-directory.ts';
import { proxyWebSocket, readLiveConnectionGuildId, rejectUpgrade } from './src/server/ws-proxy.ts';

const LIVE_CONNECTION_PATH = '/ws';

const dev = !process.argv.includes('--production') && process.env.NODE_ENV !== 'production';
const port = Number.parseInt(String(process.env.PORT ?? '3000'), 10) || 3000;
const hostname = String(process.env.DASHBOARD_LISTEN_HOST ?? '0.0.0.0').trim() || '0.0.0.0';

const app = next({ dev, hostname, port });
const handleRequest = app.getRequestHandler();
await app.prepare();
const handleNextUpgrade = app.getUpgradeHandler();

const server = createServer((req, res) => {
  void handleRequest(req, res);
});

server.on('upgrade', (req, socket, head) => {
  const pathname = new URL(req.url ?? '/', 'http://dashboard.local').pathname;
  if (pathname !== LIVE_CONNECTION_PATH) {
    void handleNextUpgrade(req, socket, head);
    return;
  }

  const directory = getShardDirectory();
  const guildId = readLiveConnectionGuildId(req.url);
  if (!directory || !guildId) {
    rejectUpgrade(socket, directory ? 400 : 503);
    return;
  }

  directory.urlForGuild(guildId)
    .then((target) => {
      if (!target) {
        rejectUpgrade(socket, 503);
        return;
      }
      proxyWebSocket(req, socket, head, target);
    })
    .catch(() => rejectUpgrade(socket, 502));
});

server.listen(port, hostname, () => {
  console.log(`Vinto dashboard listening on http://${hostname}:${port} (${dev ? 'development' : 'production'})`);
});
