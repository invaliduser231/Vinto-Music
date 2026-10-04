import test from 'node:test';
import assert from 'node:assert/strict';

import { SessionManager } from '../src/bot/sessionManager.ts';
import { GATEWAY_OFFLINE_MESSAGE } from '../src/voice/VoiceConnection.ts';

type RetryableConnection = {
  onReconnectFailed: ((lastError: unknown, channelId: string) => void) | null;
  _runAutoReconnect: (channelId: string) => Promise<void>;
};

function createManager() {
  return new SessionManager({
    gateway: {
      joinVoice() {},
      leaveVoice() {},
      on() {},
      off() {},
    },
    config: {
      sessionIdleMs: 10_000,
      defaultDedupeEnabled: false,
      defaultStayInVoiceEnabled: false,
      defaultVolumePercent: 100,
      minVolumePercent: 0,
      maxVolumePercent: 200,
      voteSkipRatio: 0.5,
      voteSkipMinVotes: 2,
      voiceMaxBitrate: 192000,
      maxQueueSize: 100,
      maxPlaylistTracks: 25,
      enableYtSearch: true,
      enableYtPlayback: true,
      enableSpotifyImport: true,
      enableDeezerImport: true,
      youtubePlaylistResolver: 'ytdlp',
    },
    logger: null,
    guildConfigs: null,
    voiceStateStore: null,
    botUserId: 'bot-1',
  });
}

async function createSession(manager: SessionManager, stayInVoiceEnabled: boolean) {
  const session = await manager.ensure('1472688260897214465', null, { voiceChannelId: '1554250598667255808' });
  manager._clearIdleTimer(session);
  session.settings.stayInVoiceEnabled = stayInVoiceEnabled;
  const connection = session.connection as unknown as RetryableConnection;
  const retries: string[] = [];
  connection._runAutoReconnect = async (channelId: string) => {
    retries.push(channelId);
  };
  return { session, connection, retries };
}

test('a 24/7 session survives a reconnect that ran out of attempts and retries later', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const manager = createManager();
  const { session, connection, retries } = await createSession(manager, true);

  connection.onReconnectFailed?.(new Error(GATEWAY_OFFLINE_MESSAGE), '1554250598667255808');
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(manager.get('1472688260897214465', { voiceChannelId: '1554250598667255808' }), session);
  assert.deepEqual(retries, []);

  t.mock.timers.tick(5 * 60_000);
  assert.deepEqual(retries, ['1554250598667255808']);

  await manager.destroy('1472688260897214465', 'manual');
});

test('a 24/7 session is still destroyed when the channel is gone for good', async () => {
  const manager = createManager();
  const { connection, retries } = await createSession(manager, true);

  connection.onReconnectFailed?.(Object.assign(new Error('Missing Access'), { status: 403 }), '1554250598667255808');
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(manager.get('1472688260897214465', { voiceChannelId: '1554250598667255808' }), null);
  assert.deepEqual(retries, []);
});

test('a regular session is destroyed after a failed reconnect as before', async () => {
  const manager = createManager();
  const { connection } = await createSession(manager, false);

  connection.onReconnectFailed?.(new Error('Timeout waiting for VOICE_SERVER_UPDATE.'), '1554250598667255808');
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(manager.get('1472688260897214465', { voiceChannelId: '1554250598667255808' }), null);
});

test('destroying a 24/7 session cancels its pending voice retry', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const manager = createManager();
  const { connection, retries } = await createSession(manager, true);

  connection.onReconnectFailed?.(new Error(GATEWAY_OFFLINE_MESSAGE), '1554250598667255808');
  await manager.destroy('1472688260897214465', 'manual');
  t.mock.timers.tick(5 * 60_000);

  assert.deepEqual(retries, []);
});
