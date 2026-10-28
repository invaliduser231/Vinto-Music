import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { SessionManager } from '../src/bot/sessionManager.ts';
import { clearAutoPause } from '../src/bot/sessionManager/autoPause.ts';
import { VoiceStateStore } from '../src/bot/voiceStateStore.ts';
import type { Session, VoiceStateChange } from '../src/types/domain.ts';

class FakeVoiceStateStore extends EventEmitter {
  humans = 1;

  countUsersInChannel() {
    return this.humans;
  }
}

function createPlayer(track: Record<string, unknown> | null = { id: 't1', title: 'Song', source: 'youtube' }) {
  return {
    playing: true,
    paused: false,
    currentTrack: track,
    queue: { pendingSize: 0 },
    pause() {
      if (this.paused) return false;
      this.paused = true;
      return true;
    },
    resume() {
      if (!this.paused) return false;
      this.paused = false;
      return true;
    },
  };
}

function setup(track?: Record<string, unknown> | null) {
  const store = new FakeVoiceStateStore();
  const manager = new SessionManager({
    gateway: { joinVoice() {}, leaveVoice() {}, on() {}, off() {} },
    config: { sessionIdleMs: 0 },
    logger: null,
    voiceStateStore: store,
    botUserId: 'bot-1',
  });
  const player = createPlayer(track);
  const session = {
    sessionId: 'guild-1:voice-1',
    guildId: '1000001',
    connection: { channelId: '2000001' },
    player,
    settings: { stayInVoiceEnabled: false },
    snapshot: { dirty: false, lastPersistAt: 0, inFlight: false },
  } as unknown as Session;
  manager.sessions.set(session.sessionId!, session);
  manager.persistSessionSnapshot = async () => true;
  return { store, manager, player, session };
}

function change(overrides: Partial<VoiceStateChange>): VoiceStateChange {
  return {
    guildId: '1000001',
    userId: 'user-1',
    channelId: null,
    previousChannelId: '2000001',
    mute: false,
    ...overrides,
  };
}

test('pauses when the last listener leaves and resumes when someone returns', () => {
  const { store, player, session } = setup();

  store.humans = 0;
  store.emit('change', change({}));
  assert.equal(player.paused, true);
  assert.deepEqual([...session.autoPause!.reasons], ['empty']);

  store.humans = 1;
  store.emit('change', change({ channelId: '2000001', previousChannelId: null }));
  assert.equal(player.paused, false);
  assert.equal(session.autoPause!.reasons.size, 0);
});

test('ignores voice changes in other channels', () => {
  const { store, player } = setup();

  store.humans = 0;
  store.emit('change', change({ previousChannelId: '2000002' }));
  assert.equal(player.paused, false);
});

test('pauses on server mute and resumes when unmuted', () => {
  const { store, player, session } = setup();

  store.emit('change', change({ userId: 'bot-1', channelId: '2000001', previousChannelId: '2000001', mute: true }));
  assert.equal(player.paused, true);
  assert.deepEqual([...session.autoPause!.reasons], ['muted']);

  store.emit('change', change({ userId: 'bot-1', channelId: '2000001', previousChannelId: '2000001', mute: false }));
  assert.equal(player.paused, false);
});

test('stays paused until both mute and empty channel are resolved', () => {
  const { store, player } = setup();

  store.emit('change', change({ userId: 'bot-1', channelId: '2000001', previousChannelId: '2000001', mute: true }));
  store.humans = 0;
  store.emit('change', change({}));
  store.emit('change', change({ userId: 'bot-1', channelId: '2000001', previousChannelId: '2000001', mute: false }));
  assert.equal(player.paused, true);

  store.humans = 1;
  store.emit('change', change({ channelId: '2000001', previousChannelId: null }));
  assert.equal(player.paused, false);
});

test('does not resume a manual pause', () => {
  const { store, player } = setup();
  player.pause();

  store.humans = 0;
  store.emit('change', change({}));
  store.humans = 1;
  store.emit('change', change({ channelId: '2000001', previousChannelId: null }));
  assert.equal(player.paused, true);
});

test('manual resume during auto-pause hands control back to the user', () => {
  const { store, player, session } = setup();

  store.humans = 0;
  store.emit('change', change({}));
  clearAutoPause(session);
  player.resume();
  player.pause();

  store.humans = 1;
  store.emit('change', change({ channelId: '2000001', previousChannelId: null }));
  assert.equal(player.paused, true);
});

test('keeps live streams running in an empty channel', () => {
  const { store, player } = setup({ id: 'r1', title: 'Radio', source: 'radio', isLive: true });

  store.humans = 0;
  store.emit('change', change({}));
  assert.equal(player.paused, false);
});

test('auto-paused empty session no longer counts as active for the idle timeout', async () => {
  const { store, manager, session } = setup();
  manager.config.sessionIdleMs = 20;
  const destroyed: string[] = [];
  manager.destroy = async (_guildId: string, reason: string) => {
    destroyed.push(reason);
    return true;
  };

  store.humans = 0;
  store.emit('change', change({}));
  await new Promise((resolve) => setTimeout(resolve, 60));
  manager._clearIdleTimer(session);

  assert.deepEqual(destroyed, ['idle_timeout']);
});

test('voice state store reports the previous channel and server mute', () => {
  const gateway = new EventEmitter();
  const store = new VoiceStateStore();
  store.register(gateway);
  const changes: VoiceStateChange[] = [];
  store.on('change', (entry: VoiceStateChange) => changes.push(entry));

  gateway.emit('VOICE_STATE_UPDATE', { guild_id: '1000001', user_id: 'user-1', channel_id: '2000001' });
  gateway.emit('VOICE_STATE_UPDATE', { guild_id: '1000001', user_id: 'user-1', channel_id: '2000001', mute: true });
  gateway.emit('VOICE_STATE_UPDATE', { guild_id: '1000001', user_id: 'user-1', channel_id: null });

  assert.deepEqual(changes.map((entry) => [entry.channelId, entry.previousChannelId, entry.mute]), [
    ['2000001', null, false],
    ['2000001', '2000001', true],
    [null, '2000001', false],
  ]);
});
