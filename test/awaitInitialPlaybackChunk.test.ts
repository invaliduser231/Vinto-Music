import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { pipelineMethods } from '../src/player/musicPlayer/pipelineMethods.ts';

const awaitChunk = pipelineMethods._awaitInitialPlaybackChunk as (
  stream: unknown,
  proc: unknown,
  timeoutMs?: number,
) => Promise<void>;

function makeProc() {
  const proc = new EventEmitter() as EventEmitter & { stdout: PassThrough };
  proc.stdout = new PassThrough();
  return proc;
}

test('the first audio chunk resolves the wait', async () => {
  const proc = makeProc();
  const pending = awaitChunk(proc.stdout, proc, 5_000);
  proc.stdout.emit('data', Buffer.alloc(4));
  await pending;
});

test('a pipeline that closes before audio reports it as such', async () => {
  const proc = makeProc();
  const pending = awaitChunk(proc.stdout, proc, 5_000);
  proc.emit('close', 1, null);
  await assert.rejects(pending, /before audio output/i);
});

test('the close code and signal are named in the message', async () => {
  const proc = makeProc();
  const pending = awaitChunk(proc.stdout, proc, 5_000);
  proc.emit('close', 3, 'SIGKILL');
  await assert.rejects(pending, /code=3.*signal=SIGKILL/i);
});

test('a stream error is surfaced instead of waiting for the timeout', async () => {
  const proc = makeProc();
  const pending = awaitChunk(proc.stdout, proc, 5_000);
  proc.stdout.emit('error', new Error('broken pipe'));
  await assert.rejects(pending, /broken pipe/);
});

test('nothing at all ends in the timeout message', async () => {
  const proc = makeProc();
  await assert.rejects(awaitChunk(proc.stdout, proc, 30), /did not produce audio output in time/i);
});

test('a stream without listener support resolves immediately', async () => {
  await awaitChunk({}, null, 5_000);
});
