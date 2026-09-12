import test from 'node:test';
import assert from 'node:assert/strict';

import { VoiceConnection } from '../src/voice/VoiceConnection.ts';

function createGateway() {
  return { joinVoice() {}, leaveVoice() {}, on() {}, off() {} };
}

function createConnection() {
  const logged: Array<{ message: string; context: Record<string, unknown> }> = [];
  const logger = {
    error: (message: string, context: Record<string, unknown>) => {
      logged.push({ message, context });
    },
    warn: () => {},
    info: () => {},
    debug: () => {},
  };
  const connection = new VoiceConnection(createGateway(), 'guild-1', { logger } as never);
  return { connection, logged };
}

test('an unresolvable voice endpoint names the host it could not resolve', () => {
  const { connection, logged } = createConnection();
  const original = new Error(
    'engine: signal failure: transport connection error: IO error: failed to lookup address information: Name or service not known',
  );

  const described = connection._describeConnectFailure(
    original,
    'voice.internal:7880',
    'wss://voice.internal:7880',
  );

  assert.match(described.message, /voice\.internal/);
  assert.match(described.message, /could not be resolved/i);
  assert.equal((described as Error & { cause?: unknown }).cause, original);

  const entry = logged.at(-1);
  assert.equal(entry?.context.host, 'voice.internal:7880');
  assert.equal(entry?.context.unresolvedHost, true);
});

test('an unrelated connect failure is passed through untouched', () => {
  const { connection, logged } = createConnection();
  const original = new Error('engine: signal failure: 401 unauthorized');

  const described = connection._describeConnectFailure(
    original,
    'voice.example.com',
    'wss://voice.example.com',
  );

  assert.equal(described, original);
  assert.equal(logged.at(-1)?.context.unresolvedHost, false);
});

test('the failure is logged even when the host is not a valid url', () => {
  const { connection, logged } = createConnection();
  const described = connection._describeConnectFailure(
    new Error('getaddrinfo ENOTFOUND nonsense'),
    'nonsense',
    'not a url',
  );

  assert.match(described.message, /not a url/);
  assert.equal(logged.at(-1)?.context.unresolvedHost, true);
});
