const DEFAULT_QUIET_MS = 1_500;
const DEFAULT_MAX_WAIT_MS = 30_000;

type GuildStreamGatewayLike = {
  on: (event: string, listener: () => void) => void;
  off: (event: string, listener: () => void) => void;
};

export type GuildStreamSettleOptions = {
  expected?: number;
  quietMs?: number;
  maxWaitMs?: number;
};

export type GuildStreamSettleResult = {
  reason: 'complete' | 'quiet' | 'timeout';
  received: number;
  expected: number;
  waitedMs: number;
};

export function waitForGuildStreamSettled(
  gateway: GuildStreamGatewayLike,
  options: GuildStreamSettleOptions = {},
): Promise<GuildStreamSettleResult> {
  const expected = Math.max(0, Number(options.expected) || 0);
  const quietMs = Math.max(0, Number(options.quietMs) || DEFAULT_QUIET_MS);
  const maxWaitMs = Math.max(quietMs, Number(options.maxWaitMs) || DEFAULT_MAX_WAIT_MS);
  const startedAt = Date.now();

  return new Promise((resolve) => {
    let received = 0;
    let settled = false;
    let quietHandle: ReturnType<typeof setTimeout> | null = null;

    const finish = (reason: GuildStreamSettleResult['reason']) => {
      if (settled) return;
      settled = true;
      if (quietHandle) clearTimeout(quietHandle);
      clearTimeout(maxHandle);
      gateway.off('GUILD_CREATE', onGuildCreate);
      resolve({ reason, received, expected, waitedMs: Date.now() - startedAt });
    };

    const armQuietTimer = () => {
      if (quietHandle) clearTimeout(quietHandle);
      quietHandle = setTimeout(() => finish('quiet'), quietMs);
    };

    const onGuildCreate = () => {
      received += 1;
      if (expected > 0 && received >= expected) {
        finish('complete');
        return;
      }
      armQuietTimer();
    };

    const maxHandle = setTimeout(() => finish('timeout'), maxWaitMs);

    gateway.on('GUILD_CREATE', onGuildCreate);
    armQuietTimer();
  });
}
