import type { LoggerLike } from '../types/core.ts';

export function sanitizeBrokenLocalProxyEnv(rootLogger: LoggerLike) {
  const keys = [
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'ALL_PROXY',
    'http_proxy',
    'https_proxy',
    'all_proxy',
    'GIT_HTTP_PROXY',
    'GIT_HTTPS_PROXY',
  ];

  const isBlockedLoopbackProxy = (value: string) => {
    const raw = String(value ?? '').trim().toLowerCase();
    if (!raw) return false;

    try {
      const parsed = new URL(raw);
      const host = String(parsed.hostname ?? '').toLowerCase();
      const port = Number.parseInt(String(parsed.port ?? ''), 10);
      return (host === '127.0.0.1' || host === 'localhost' || host === '::1') && port === 9;
    } catch {
      return /127\.0\.0\.1:9|localhost:9|\[::1\]:9/.test(raw);
    }
  };

  const removed: string[] = [];
  for (const key of keys) {
    const value = process.env[key];
    if (!value) continue;
    if (!isBlockedLoopbackProxy(value)) continue;
    delete process.env[key];
    removed.push(key);
  }

  if (removed.length) {
    rootLogger.warn?.('Removed broken loopback proxy environment variables', {
      removed,
      reason: 'proxy pointed to localhost:9 and would block outbound media/API requests',
    });
  }
}


