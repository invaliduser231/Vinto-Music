import test from 'node:test';
import assert from 'node:assert/strict';

import { toVoiceRoomUrl } from '../src/voice/VoiceConnection.ts';

test('an endpoint that already speaks websocket is left alone', () => {
  assert.equal(toVoiceRoomUrl('wss://voice.example.net'), 'wss://voice.example.net');
  assert.equal(toVoiceRoomUrl('ws://voice.example.net:7880'), 'ws://voice.example.net:7880');
});

test('a bare host gets the secure websocket scheme', () => {
  assert.equal(toVoiceRoomUrl('318166d.fra.fluxer.media'), 'wss://318166d.fra.fluxer.media');
  assert.equal(toVoiceRoomUrl('livekit:7880'), 'wss://livekit:7880');
  assert.equal(toVoiceRoomUrl('10.0.0.5:7880'), 'wss://10.0.0.5:7880');
});

test('an http endpoint is translated instead of prefixed', () => {
  assert.equal(
    toVoiceRoomUrl('https://my.fluxerinstance.com/livekit'),
    'wss://my.fluxerinstance.com/livekit',
  );
  assert.equal(toVoiceRoomUrl('http://livekit:7880'), 'ws://livekit:7880');
  assert.equal(toVoiceRoomUrl('HTTPS://Voice.Example.net'), 'wss://Voice.Example.net');
});

test('the self hosted endpoint no longer resolves to a host named https', () => {
  const url = toVoiceRoomUrl('https://my.fluxerinstance.com/livekit');
  assert.equal(new URL(url).host, 'my.fluxerinstance.com', 'the host must be the instance, not the scheme');
  assert.equal(new URL(url).pathname, '/livekit', 'the path has to survive the rewrite');
});

test('an unexpected scheme falls back to a secure websocket', () => {
  assert.equal(toVoiceRoomUrl('rtmp://voice.example.net'), 'wss://voice.example.net');
});

test('a blank endpoint stays blank so the caller can reject it', () => {
  assert.equal(toVoiceRoomUrl(''), '');
  assert.equal(toVoiceRoomUrl('   '), '');
});
