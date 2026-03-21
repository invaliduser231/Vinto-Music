import test from 'node:test';
import assert from 'node:assert/strict';

import { SessionManager } from '../src/bot/sessionManager.ts';

type IdleSession = {
  guildId: string;
  connection: {
    channelId: string;
    isStreaming?: boolean;
    currentAudioStream?: unknown;
  };
  player: {
    playing: boolean;
    currentTrack: Record<string, unknown> | null;
    queue: {
      pendingSize: number;
      current?: Record<string, unknown> | null;
    };
    emit: (event: string) => void;
  };
  settings: {
    stayInVoiceEnabled: boolean;
  };
  idleTimer: ReturnType<typeof setTimeout> | null;
};

type ManagerOverrides = {
  config?: Record<string, unknown>;
  voiceStateStore?: {
    countUsersInChannel?: (guildId?: string, channelId?: string, excludedIds?: string[]) => number;
  } | null;
  botUserId?: string | null;
};

function createManager(overrides: ManagerOverrides = {}) {
  const defaultConfig = {
    sessionIdleMs: 20,
    defaultDedupeEnabled: false,
    defaultStayInVoiceEnabled: false,
    voteSkipRatio: 0.5,
    voteSkipMinVotes: 2,
  };

  return new SessionManager({
    gateway: {
      joinVoice() {},
      leaveVoice() {},
      on() {},
      off() {},
    },
    config: { ...defaultConfig, ...(overrides.config ?? {}) },
    guildConfigs: null,
    logger: null,
    voiceStateStore: overrides.voiceStateStore ?? null,
    botUserId: overrides.botUserId ?? null,
  });
}

function createIdleSession(): IdleSession {
  return {
    guildId: 'guild-1',
    connection: {
      channelId: 'voice-1',
    },
    player: {
      playing: false,
      currentTrack: null,
      queue: {
        pendingSize: 0,
      },
      emit() {},
    },
    settings: {
      stayInVoiceEnabled: false,
    },
    idleTimer: null,
  };
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('idle timeout destroys session when no playback and no listeners', async () => {
  const manager = createManager({
    voiceStateStore: {
      countUsersInChannel() {
        return 0;
      },
    },
  });
  const session = createIdleSession();

  const calls: string[][] = [];
  manager.destroy = async (guildId: string, reason: string) => {
    calls.push([guildId, reason]);
    return true;
  };

  manager._scheduleIdleTimeout(session);
  await sleep(50);
  manager._clearIdleTimer(session);

  assert.deepEqual(calls, [['guild-1', 'idle_timeout']]);
});

test('idle timeout does not destroy session while human listeners are in VC', async () => {
  const manager = createManager({
    voiceStateStore: {
      countUsersInChannel(guildId, channelId, excludedIds) {
        assert.equal(guildId, 'guild-1');
        assert.equal(channelId, 'voice-1');
        assert.deepEqual(excludedIds, ['bot-1']);
        return 1;
      },
    },
    botUserId: 'bot-1',
  });
  const session = createIdleSession();

  let destroyCalls = 0;
  manager.destroy = async () => {
    destroyCalls += 1;
    return true;
  };

  manager._scheduleIdleTimeout(session);
  await sleep(55);
  manager._clearIdleTimer(session);

  assert.equal(destroyCalls, 0);
});

test('idle timeout does not destroy session while playback is active', async () => {
  const manager = createManager({
    voiceStateStore: {
      countUsersInChannel() {
        return 0;
      },
    },
  });
  const session = createIdleSession();
  session.player.playing = true;

  let destroyCalls = 0;
  manager.destroy = async () => {
    destroyCalls += 1;
    return true;
  };

  manager._scheduleIdleTimeout(session);
  await sleep(55);
  manager._clearIdleTimer(session);

  assert.equal(destroyCalls, 0);
});

test('idle timeout does not destroy session while a current track is present', async () => {
  const manager = createManager({
    voiceStateStore: {
      countUsersInChannel() {
        return 0;
      },
    },
  });
  const session = createIdleSession();
  session.player.currentTrack = { id: 'track-1' };

  let destroyCalls = 0;
  manager.destroy = async () => {
    destroyCalls += 1;
    return true;
  };

  manager._scheduleIdleTimeout(session);
  await sleep(55);
  manager._clearIdleTimer(session);

  assert.equal(destroyCalls, 0);
});

test('idle timeout does not destroy session while voice stream is active', async () => {
  const manager = createManager({
    voiceStateStore: {
      countUsersInChannel() {
        return 0;
      },
    },
  });
  const session = createIdleSession();
  session.connection.isStreaming = true;

  let destroyCalls = 0;
  manager.destroy = async () => {
    destroyCalls += 1;
    return true;
  };

  manager._scheduleIdleTimeout(session);
  await sleep(55);
  manager._clearIdleTimer(session);

  assert.equal(destroyCalls, 0);
});

test('idle timeout ignores stale timer from replaced session instance', async () => {
  const manager = createManager({
    voiceStateStore: {
      countUsersInChannel() {
        return 0;
      },
    },
  });

  const stale = createIdleSession();
  const active = createIdleSession();
  active.player.playing = true;

  manager.sessions.set('guild-1', active);

  let destroyCalls = 0;
  manager.destroy = async () => {
    destroyCalls += 1;
    return true;
  };

  manager._scheduleIdleTimeout(stale);
  await sleep(55);
  manager._clearIdleTimer(stale);

  assert.equal(destroyCalls, 0);
});

test('queueEmpty is handled when only stream tail is active', async () => {
  const manager = createManager({
    config: {
      sessionIdleMs: 10_000,
    },
  });

  const session = await manager.ensure('guild-1');
  manager._clearIdleTimer(session);

  const queueEmptyEvents: boolean[] = [];
  manager.on('queueEmpty', ({ session: emitted }) => {
    if (emitted === session) {
      queueEmptyEvents.push(true);
    }
  });

  session.connection.currentAudioStream = {};
  session.player.playing = false;
  session.player.queue!.current = null;
  session.player.emit?.('queueEmpty');

  await sleep(5);
  assert.equal(queueEmptyEvents.length, 1);
  assert.ok(session.idleTimer);

  manager._clearIdleTimer(session);
  session.connection.currentAudioStream = null;
});

test('queueEmpty is ignored while current track is still active', async () => {
  const manager = createManager({
    config: {
      sessionIdleMs: 10_000,
    },
  });

  const session = await manager.ensure('guild-1');
  manager._clearIdleTimer(session);

  let queueEmptyEvents = 0;
  manager.on('queueEmpty', ({ session: emitted }) => {
    if (emitted === session) {
      queueEmptyEvents += 1;
    }
  });

  session.player.playing = true;
  session.player.queue!.current = { id: 'track-1', title: 'active' };
  session.player.emit?.('queueEmpty');

  await sleep(5);
  assert.equal(queueEmptyEvents, 0);
  assert.equal(session.idleTimer, null);
});

test('queueEmpty idle timeout disconnects even when listeners remain in VC', async () => {
  const manager = createManager({
    config: {
      sessionIdleMs: 20,
    },
    voiceStateStore: {
      countUsersInChannel() {
        return 1;
      },
    },
    botUserId: 'bot-1',
  });

  const session = await manager.ensure('guild-1');
  session.connection.channelId = 'voice-1';
  manager._clearIdleTimer(session);

  const calls: string[][] = [];
  manager.destroy = async (guildId: string, reason: string) => {
    calls.push([guildId, reason]);
    return true;
  };

  session.player.playing = false;
  session.player.queue!.current = null;
  session.player.emit?.('queueEmpty');

  await sleep(70);
  manager._clearIdleTimer(session);

  assert.deepEqual(calls, [['guild-1', 'idle_timeout']]);
});





