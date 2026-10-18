import { request as httpRequest, type IncomingHttpHeaders, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { Duplex } from 'node:stream';

const FORWARDED_HEADERS = [
  'upgrade',
  'connection',
  'origin',
  'user-agent',
  'sec-websocket-key',
  'sec-websocket-version',
  'sec-websocket-extensions',
  'sec-websocket-protocol',
];

const STATUS_TEXT: Record<number, string> = {
  400: 'Bad Request',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
};

export function readLiveConnectionGuildId(requestUrl: string | undefined): string | null {
  const url = new URL(requestUrl ?? '/', 'http://dashboard.local');
  const guildId = String(url.searchParams.get('guildId') ?? '').trim();
  return /^\d+$/.test(guildId) ? guildId : null;
}

export function rejectUpgrade(socket: Duplex, status: number): void {
  if (socket.writable) {
    socket.write(`HTTP/1.1 ${status} ${STATUS_TEXT[status] ?? 'Error'}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  }
  socket.destroy();
}

function forwardedHeaders(req: IncomingMessage, target: URL): Record<string, string> {
  const headers: Record<string, string> = { host: target.host };
  for (const name of FORWARDED_HEADERS) {
    const value = req.headers[name];
    if (typeof value === 'string') headers[name] = value;
  }
  const remoteAddress = req.socket.remoteAddress;
  const priorForwardedFor = req.headers['x-forwarded-for'];
  const forwardedFor = [typeof priorForwardedFor === 'string' ? priorForwardedFor : null, remoteAddress ?? null]
    .filter((entry): entry is string => Boolean(entry))
    .join(', ');
  if (forwardedFor) headers['x-forwarded-for'] = forwardedFor;
  return headers;
}

function serializeResponseHead(statusCode: number, statusMessage: string, headers: IncomingHttpHeaders): string {
  const lines = [`HTTP/1.1 ${statusCode} ${statusMessage}`];
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    for (const entry of Array.isArray(value) ? value : [value]) lines.push(`${name}: ${entry}`);
  }
  return `${lines.join('\r\n')}\r\n\r\n`;
}

export function proxyWebSocket(req: IncomingMessage, socket: Duplex, head: Buffer, targetBaseUrl: string): void {
  const target = new URL(targetBaseUrl);
  const send = target.protocol === 'https:' ? httpsRequest : httpRequest;
  const upstream = send({
    protocol: target.protocol,
    hostname: target.hostname,
    port: target.port || undefined,
    method: 'GET',
    path: '/',
    headers: forwardedHeaders(req, target),
  });

  socket.on('error', () => upstream.destroy());

  upstream.on('upgrade', (response, upstreamSocket, upstreamHead) => {
    socket.write(serializeResponseHead(response.statusCode ?? 101, response.statusMessage ?? 'Switching Protocols', response.headers));
    if (upstreamHead.length) socket.write(upstreamHead);
    if (head.length) upstreamSocket.write(head);

    const closeBoth = () => {
      upstreamSocket.destroy();
      socket.destroy();
    };
    upstreamSocket.on('error', closeBoth);
    socket.on('error', closeBoth);
    upstreamSocket.on('close', () => socket.destroy());
    socket.on('close', () => upstreamSocket.destroy());
    upstreamSocket.pipe(socket);
    socket.pipe(upstreamSocket);
  });

  upstream.on('response', (response) => {
    response.resume();
    rejectUpgrade(socket, 502);
  });

  upstream.on('error', () => rejectUpgrade(socket, 502));
  upstream.end();
}
