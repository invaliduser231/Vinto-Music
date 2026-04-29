import http from 'node:http';
import type { LoggerLike } from '../types/core.ts';
import type { MetricsRegistry } from './metrics.ts';

interface MonitoringHealth {
  ok: boolean;
  [key: string]: unknown;
}

interface MonitoringServerOptions {
  logger?: LoggerLike | undefined;
  host?: string;
  port?: number;
  enabled?: boolean;
  metrics?: MetricsRegistry | null;
  getHealth?: () => MonitoringHealth | Promise<MonitoringHealth>;
}

export class MonitoringServer {
  logger: LoggerLike | undefined;
  host: string;
  port: number;
  enabled: boolean;
  metrics: MetricsRegistry | null;
  getHealth: () => MonitoringHealth | Promise<MonitoringHealth>;
  server: http.Server | null;

  constructor(options: MonitoringServerOptions = {}) {
    this.logger = options.logger ?? undefined;
    this.host = options.host ?? '0.0.0.0';
    this.port = options.port ?? 9091;
    this.enabled = options.enabled !== false;
    this.metrics = options.metrics ?? null;
    this.getHealth = options.getHealth ?? (() => ({ ok: true }));

    this.server = null;
  }

  async start() {
    if (!this.enabled) return false;
    if (this.server) return true;

    this.server = http.createServer(async (req, res) => {
      const parsed = new URL(req.url ?? '/', 'http://monitor.local');
      const path = parsed.pathname ?? '/';
      if (path === '/healthz' || path === '/readyz') {
        try {
          const health = await this.getHealth();
          const status = health?.ok ? 200 : 503;
          const body = JSON.stringify({
            ...health,
            ok: Boolean(health?.ok),
          });

          res.writeHead(status, {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store',
          });
          res.end(body);
        } catch (err) {
          this.logger?.error?.('Monitoring health check failed', {
            error: err instanceof Error
              ? { name: err.name, message: err.message, stack: err.stack }
              : String(err),
          });
          res.writeHead(503, {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store',
          });
          res.end(JSON.stringify({
            ok: false,
            error: 'Health check failed',
          }));
        }
        return;
      }

      if (path === '/metrics') {
        const payload = this.metrics?.renderPrometheus?.() ?? '';
        res.writeHead(200, {
          'Content-Type': 'text/plain; version=0.0.4',
          'Cache-Control': 'no-store',
        });
        res.end(payload);
        return;
      }

      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('not found');
    });

    const server = this.server;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.port, this.host, resolve);
    });

    this.logger?.info?.('Monitoring server listening', {
      host: this.host,
      port: this.port,
      endpoints: ['/healthz', '/readyz', '/metrics'],
    });
    return true;
  }

  async stop() {
    if (!this.server) return;

    const server = this.server;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });

    this.server = null;
    this.logger?.info?.('Monitoring server stopped');
  }
}




