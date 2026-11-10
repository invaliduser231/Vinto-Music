import net from 'node:net';

type ConnectArgs = Parameters<net.Socket['connect']>;

const LOOPBACK_HOSTS = new Set(['localhost', '::1', '0.0.0.0', '::']);
const reported = new Set<string>();

function targetHost(args: unknown[]): string | null {
  const [first, second] = args;
  if (Array.isArray(first)) return targetHost(first);
  if (typeof first === 'object' && first !== null) {
    const options = first as { host?: unknown; path?: unknown };
    if (typeof options.path === 'string') return null;
    return typeof options.host === 'string' ? options.host : 'localhost';
  }
  if (typeof first === 'number' || (typeof first === 'string' && /^\d+$/.test(first))) {
    return typeof second === 'string' ? second : 'localhost';
  }
  return null;
}

function isLoopback(host: string | null): boolean {
  if (host === null) return true;
  const normalized = host.replace(/^\[|\]$/g, '').toLowerCase();
  return LOOPBACK_HOSTS.has(normalized) || normalized.startsWith('127.') || normalized.startsWith('::ffff:127.');
}

const originalConnect = net.Socket.prototype.connect;

net.Socket.prototype.connect = function connect(this: net.Socket, ...args: unknown[]) {
  const host = targetHost(args);
  if (isLoopback(host)) return originalConnect.apply(this, args as ConnectArgs);

  if (!reported.has(String(host))) {
    reported.add(String(host));
    process.stderr.write(`[tests] blocked network access to ${host}\n`);
  }
  process.nextTick(() => this.destroy(new Error(`Network access is blocked in tests: ${host}`)));
  return this;
} as net.Socket['connect'];
