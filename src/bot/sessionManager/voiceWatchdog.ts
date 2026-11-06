import type { Session, VoiceStateChange } from '../../types/domain.ts';
import { toChannelId } from './runtimeHelpers.ts';

export const VOICE_WATCHDOG_INTERVAL_MS = 60_000;
export const REMOVAL_WINDOW_MS = 15 * 60_000;
export const MAX_REMOVALS_PER_WINDOW = 3;
const BACKOFF_STEPS_MS = [2, 4, 8, 16, 32].map((minutes) => minutes * 60_000);
const BACKOFF_CEILING_MS = 60 * 60_000;

export function watchdogBackoffMs(failures: number): number {
  const index = Math.max(0, Math.floor(failures) - 1);
  return BACKOFF_STEPS_MS[index] ?? BACKOFF_CEILING_MS;
}

type WatchdogConnection = Session['connection'] & {
  connectionId?: string | null;
  connectingPromise?: Promise<unknown> | null;
  _reconnectInProgress?: boolean;
  _runAutoReconnect?: (channelId: string) => Promise<void>;
  forceRejoin?: (channelId: string) => Promise<void>;
};

export type WatchdogState = {
  failures: number;
  nextAttemptAt: number;
  removals: number[];
};

export type PendingRestore = {
  guildId: string;
  voiceChannelId: string;
  textChannelId: string | null;
  failures: number;
  nextAttemptAt: number;
};

export type WatchdogHost = {
  sessions: Map<string, Session>;
  pendingRestores: Map<string, PendingRestore>;
  logger?: {
    info?: (message: string, meta?: Record<string, unknown>) => void;
    warn?: (message: string, meta?: Record<string, unknown>) => void;
    debug?: (message: string, meta?: Record<string, unknown>) => void;
  } | null | undefined;
  listByGuild: (guildId: string) => Session[];
  has: (guildId: string, selector: { voiceChannelId: string }) => boolean;
  destroy: (guildId: string, reason?: string, selector?: { sessionId: string }) => Promise<boolean>;
  _hasSessionInstance: (session: unknown) => boolean;
  _restorePersistentBinding: (binding: { guildId: string; voiceChannelId: string; textChannelId: string | null }) => Promise<{ restored: boolean; permanent?: boolean }>;
};

function watchdogState(session: Session & { watchdog?: WatchdogState }): WatchdogState {
  session.watchdog ??= { failures: 0, nextAttemptAt: 0, removals: [] };
  return session.watchdog;
}

function targetChannel(session: Session): string | null {
  return toChannelId(session.connection?.channelId) ?? toChannelId(session.targetVoiceChannelId);
}

export function findSessionForBotVoiceState(host: WatchdogHost, change: VoiceStateChange): Session | null {
  const sessions = host.listByGuild(change.guildId);
  const connectionId = String(change.connectionId ?? '').trim();
  if (connectionId) {
    return sessions.find((session) => (session.connection as WatchdogConnection).connectionId === connectionId) ?? null;
  }
  if (sessions.length !== 1) return null;
  const only = sessions[0]!;
  return toChannelId(only.connection?.channelId) === change.previousChannelId ? only : null;
}

export async function handleBotVoiceRemoval(host: WatchdogHost, change: VoiceStateChange, now: number = Date.now()): Promise<'ignored' | 'rejoining' | 'closed'> {
  if (change.channelId) return 'ignored';

  const session = findSessionForBotVoiceState(host, change);
  if (!session) return 'ignored';

  const connection = session.connection as WatchdogConnection;
  if (!connection.connectionId) return 'ignored';

  const channelId = targetChannel(session);
  if (!channelId) return 'ignored';

  const state = watchdogState(session);
  state.removals = state.removals.filter((at) => now - at < REMOVAL_WINDOW_MS);
  state.removals.push(now);

  const stayInVoice = session.settings?.stayInVoiceEnabled === true;
  if (stayInVoice && state.removals.length < MAX_REMOVALS_PER_WINDOW && connection._reconnectInProgress) {
    return 'rejoining';
  }
  if (stayInVoice && state.removals.length < MAX_REMOVALS_PER_WINDOW && typeof connection.forceRejoin === 'function') {
    host.logger?.info?.('Bot was removed from a 24/7 voice channel, rejoining', {
      guildId: session.guildId,
      channelId,
      removalsInWindow: state.removals.length,
    });
    await connection.forceRejoin(channelId);
    return 'rejoining';
  }

  host.logger?.info?.('Bot was removed from voice, closing the session', {
    guildId: session.guildId,
    channelId,
    stayInVoice,
    removalsInWindow: state.removals.length,
  });
  await host.destroy(session.guildId, stayInVoice ? 'removed_from_voice_repeatedly' : 'removed_from_voice', {
    sessionId: String(session.sessionId),
  });
  return 'closed';
}

export function queuePendingRestore(host: WatchdogHost, binding: { guildId: string; voiceChannelId: string; textChannelId: string | null }, now: number = Date.now()): void {
  const key = `${binding.guildId}:${binding.voiceChannelId}`;
  const existing = host.pendingRestores.get(key);
  const failures = (existing?.failures ?? 0) + 1;
  host.pendingRestores.set(key, {
    ...binding,
    failures,
    nextAttemptAt: now + watchdogBackoffMs(failures),
  });
}

export async function runVoiceWatchdogSweep(host: WatchdogHost, now: number = Date.now()): Promise<void> {
  for (const session of [...host.sessions.values()]) {
    if (!host._hasSessionInstance(session)) continue;
    if (session.settings?.stayInVoiceEnabled !== true) continue;

    const connection = session.connection as WatchdogConnection;
    const state = watchdogState(session);
    if (connection.connected) {
      state.failures = 0;
      state.nextAttemptAt = 0;
      continue;
    }
    if (connection.connectingPromise || connection._reconnectInProgress || session.voiceRetryTimer) continue;

    const channelId = targetChannel(session);
    if (!channelId || typeof connection._runAutoReconnect !== 'function') continue;
    if (state.nextAttemptAt > now) continue;

    state.failures += 1;
    state.nextAttemptAt = now + watchdogBackoffMs(state.failures);
    host.logger?.warn?.('Voice watchdog found a disconnected 24/7 session, reconnecting', {
      guildId: session.guildId,
      channelId,
      failures: state.failures,
      nextAttemptInMs: state.nextAttemptAt - now,
    });
    void connection._runAutoReconnect(channelId);
  }

  for (const [key, pending] of [...host.pendingRestores.entries()]) {
    if (pending.nextAttemptAt > now) continue;
    if (host.has(pending.guildId, { voiceChannelId: pending.voiceChannelId })) {
      host.pendingRestores.delete(key);
      continue;
    }

    const result = await host._restorePersistentBinding(pending).catch(() => ({ restored: false, permanent: false }));
    if (result.restored || result.permanent) {
      host.pendingRestores.delete(key);
      continue;
    }
    queuePendingRestore(host, pending, now);
  }
}
