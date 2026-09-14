import test from 'node:test';
import assert from 'node:assert/strict';

import { VoiceConnection } from '../src/voice/VoiceConnection.ts';

function publication(sid: string, calls: Array<{ sid: string; subscribed: boolean }>) {
  return {
    sid,
    track: { sid },
    setSubscribed(subscribed: boolean) {
      calls.push({ sid, subscribed });
    },
  };
}

function connectionWithRoom(calls: Array<{ sid: string; subscribed: boolean }>) {
  const connection = new VoiceConnection({ on() {}, off() {} } as never, 'guild-1', {
    logger: null,
  } as never) as never as {
    room: unknown;
    earrapeProtectionEnabled: boolean;
    setEarrapeProtectionEnabled: (enabled: unknown) => void;
    _setRemoteAudioSubscribed: (subscribed: boolean) => void;
    _syncVoiceDeafState: () => void;
    _monitorSubscribedRemoteAudio: () => void;
  };

  connection.room = {
    remoteParticipants: new Map([
      ['a', { trackPublications: new Map([['t1', publication('t1', calls)]]) }],
      ['b', { trackPublications: new Map([['t2', publication('t2', calls)]]) }],
    ]),
  };
  connection._syncVoiceDeafState = () => {};
  return connection;
}

test('turning earrape protection on subscribes to the remote tracks', () => {
  const calls: Array<{ sid: string; subscribed: boolean }> = [];
  const connection = connectionWithRoom(calls);

  connection.setEarrapeProtectionEnabled(true);

  assert.deepEqual(
    calls.map((c) => `${c.sid}:${c.subscribed}`).sort(),
    ['t1:true', 't2:true'],
    'the detector needs the remote audio, so it has to ask for it',
  );
});

test('turning it off drops the subscriptions again', () => {
  const calls: Array<{ sid: string; subscribed: boolean }> = [];
  const connection = connectionWithRoom(calls);
  connection.earrapeProtectionEnabled = true;

  connection.setEarrapeProtectionEnabled(false);

  assert.deepEqual(
    calls.map((c) => `${c.sid}:${c.subscribed}`).sort(),
    ['t1:false', 't2:false'],
    'without the detector nobody decodes that audio, so it must not be received',
  );
});

test('a publication without setSubscribed is skipped instead of throwing', () => {
  const connection = connectionWithRoom([]);
  connection.room = {
    remoteParticipants: new Map([
      ['a', { trackPublications: new Map([['t1', { sid: 't1' }]]) }],
    ]),
  };

  assert.doesNotThrow(() => connection._setRemoteAudioSubscribed(true));
});

test('no room means nothing to unsubscribe', () => {
  const connection = connectionWithRoom([]);
  connection.room = null;

  assert.doesNotThrow(() => connection._setRemoteAudioSubscribed(false));
});
