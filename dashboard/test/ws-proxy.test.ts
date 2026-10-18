import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { connect, type AddressInfo, type Socket } from 'node:net';

import { proxyWebSocket, readLiveConnectionGuildId } from '../src/server/ws-proxy';

type Upstream = { server: Server; url: string; seenHeaders: IncomingHttpHeaders[] };

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

async function startEchoUpstream(): Promise<Upstream> {
  const seenHeaders: IncomingHttpHeaders[] = [];
  const server = createServer((_req, res) => res.writeHead(404).end());
  server.on('upgrade', (req, socket) => {
    seenHeaders.push(req.headers);
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: test\r\n\r\n');
    socket.on('data', (chunk) => socket.write(chunk));
    socket.on('end', () => socket.end());
  });
  const port = await listen(server);
  return { server, url: `http://127.0.0.1:${port}`, seenHeaders };
}

async function startProxy(targetUrl: string): Promise<{ server: Server; port: number }> {
  const server = createServer((_req, res) => res.writeHead(404).end());
  server.on('upgrade', (req, socket, head) => proxyWebSocket(req, socket, head, targetUrl));
  return { server, port: await listen(server) };
}

function readUntil(socket: Socket, marker: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString('latin1');
      if (buffer.includes(marker)) {
        socket.off('data', onData);
        resolve(buffer);
      }
    };
    socket.on('data', onData);
    socket.once('error', reject);
    socket.once('close', () => resolve(buffer));
  });
}

function openUpgrade(port: number): Socket {
  const socket = connect(port, '127.0.0.1');
  socket.write([
    'GET /ws?guildId=1485394316330348923 HTTP/1.1',
    `Host: 127.0.0.1:${port}`,
    'Upgrade: websocket',
    'Connection: Upgrade',
    'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
    'Sec-WebSocket-Version: 13',
    'Origin: https://dashboard.example',
    'Cookie: vinto_dashboard_session=secret-session',
    'Authorization: Bearer leaked',
    '',
    '',
  ].join('\r\n'));
  return socket;
}

async function close(...servers: Server[]) {
  for (const server of servers) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('the guild of a live connection is read from its query', () => {
  assert.equal(readLiveConnectionGuildId('/ws?guildId=1485394316330348923'), '1485394316330348923');
  assert.equal(readLiveConnectionGuildId('/ws'), null);
  assert.equal(readLiveConnectionGuildId('/ws?guildId=abc'), null);
});

test('a live connection is upgraded at the shard and frames flow both ways', async () => {
  const upstream = await startEchoUpstream();
  const proxy = await startProxy(upstream.url);
  const socket = openUpgrade(proxy.port);
  try {
    const handshake = await readUntil(socket, '\r\n\r\n');
    assert.match(handshake, /^HTTP\/1\.1 101 Switching Protocols/);

    const echoed = readUntil(socket, 'frame-bytes');
    socket.write('frame-bytes');
    assert.match(await echoed, /frame-bytes/);

    const forwarded = upstream.seenHeaders[0] ?? {};
    assert.equal(forwarded['sec-websocket-key'], 'dGhlIHNhbXBsZSBub25jZQ==');
    assert.equal(forwarded.origin, 'https://dashboard.example');
    assert.equal(forwarded.cookie, undefined, 'the dashboard session cookie never reaches the bot');
    assert.equal(forwarded.authorization, undefined);
    assert.equal(forwarded['x-forwarded-for'], '127.0.0.1');
  } finally {
    socket.destroy();
    await close(proxy.server, upstream.server);
  }
});

test('a shard that refuses the upgrade answers the browser with 502', async () => {
  const refusing = createServer((_req, res) => res.writeHead(426).end());
  const refusingPort = await listen(refusing);
  const proxy = await startProxy(`http://127.0.0.1:${refusingPort}`);
  const socket = openUpgrade(proxy.port);
  try {
    assert.match(await readUntil(socket, '\r\n\r\n'), /^HTTP\/1\.1 502 Bad Gateway/);
  } finally {
    socket.destroy();
    await close(proxy.server, refusing);
  }
});

test('an unreachable shard answers the browser with 502', async () => {
  const placeholder = createServer();
  const freePort = await listen(placeholder);
  await close(placeholder);
  const proxy = await startProxy(`http://127.0.0.1:${freePort}`);
  const socket = openUpgrade(proxy.port);
  try {
    assert.match(await readUntil(socket, '\r\n\r\n'), /^HTTP\/1\.1 502 Bad Gateway/);
  } finally {
    socket.destroy();
    await close(proxy.server);
  }
});
