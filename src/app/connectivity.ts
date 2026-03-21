import { sleep } from '../utils/retry.ts';
import type { LoggerLike } from '../types/core.ts';
import type { AppConfig } from '../config.ts';

type GatewayPayload = {
  url?: string;
  gateway_url?: string;
  gateway?: { url?: string };
  shards?: number;
  session_start_limit?: {
    remaining?: number;
    total?: number;
    reset_after?: number;
    max_concurrency?: number;
  };
  [key: string]: unknown;
};

type ConnectivityRest = {
  getCurrentUser: () => Promise<{ username?: string; id?: string } | null>;
  getGatewayBot: () => Promise<GatewayPayload>;
};

function pickGatewayUrl(payload: GatewayPayload | null | undefined): string | null {
  const candidates = [
    payload?.url,
    payload?.gateway_url,
    payload?.gateway?.url,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.startsWith('ws')) {
      return candidate;
    }
  }

  return null;
}

export async function verifyApiConnectivity({
  config,
  rest,
  logger,
}: {
  config: AppConfig;
  rest: ConnectivityRest;
  logger: LoggerLike;
}) {
  if (config.gatewayOnlyMode) {
    logger.info?.('Skipping REST API startup check in gateway-only mode');
    return null;
  }

  let lastError = null;

  for (let attempt = 1; attempt <= config.apiCheckRetries; attempt += 1) {
    try {
      const me = await rest.getCurrentUser();
      logger.info?.('REST API check succeeded', {
        apiBase: config.apiBase,
        user: me?.username ?? 'unknown',
      });
      return me;
    } catch (err) {
      lastError = err;
      const detail = err instanceof Error ? err.message : String(err);
      logger.warn?.('REST API check failed', {
        attempt,
        totalAttempts: config.apiCheckRetries,
        error: detail,
      });

      if (attempt < config.apiCheckRetries) {
        await sleep(config.apiCheckDelayMs * attempt);
      }
    }
  }

  const finalDetail = lastError instanceof Error ? lastError.message : String(lastError);
  const message = `REST API check failed after ${config.apiCheckRetries} attempt(s): ${finalDetail}`;

  if (config.strictStartupCheck) {
    throw new Error(message);
  }

  logger.warn?.(`${message}. Continuing startup due to non-strict mode.`);
  return null;
}

export async function resolveGatewayUrl({
  config,
  rest,
  logger,
}: {
  config: AppConfig;
  rest: ConnectivityRest;
  logger: LoggerLike;
}): Promise<string> {
  if (config.gatewayOnlyMode) {
    logger.info?.('Gateway-only mode enabled, using configured gateway URL', {
      gatewayUrl: config.gatewayUrl,
    });
    return config.gatewayUrl;
  }

  if (!config.autoGatewayUrl) {
    return config.gatewayUrl;
  }

  try {
    const data = await rest.getGatewayBot();
    const url = pickGatewayUrl(data);
    if (url) {
      logger.info?.('Gateway URL resolved from API', {
        url,
        shards: data?.shards ?? null,
        sessionStartRemaining: data?.session_start_limit?.remaining ?? null,
        sessionStartTotal: data?.session_start_limit?.total ?? null,
      });
      if (Number.isFinite(data?.shards) && Number(data?.shards) > 1) {
        logger.warn?.('Gateway recommends multiple shards, but app currently runs single-shard', {
          recommendedShards: Number(data?.shards),
        });
      }
      if (Number.isFinite(data?.session_start_limit?.remaining) && Number(data?.session_start_limit?.remaining) <= 0) {
        logger.warn?.('Gateway session start limit is exhausted', {
          resetAfterMs: data?.session_start_limit?.reset_after ?? null,
          maxConcurrency: data?.session_start_limit?.max_concurrency ?? null,
        });
      }
      return url;
    }
  } catch (err) {
    logger.warn?.('Failed to resolve gateway URL from API, using configured fallback', {
      error: err instanceof Error ? err.message : String(err),
      fallback: config.gatewayUrl,
    });
  }

  return config.gatewayUrl;
}


