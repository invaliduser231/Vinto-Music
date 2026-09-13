import test from 'node:test';
import assert from 'node:assert/strict';

import {
  connectPreparedSession,
  isRetryableVoiceConnectFailure,
} from '../src/bot/commands/helpers/context.ts';

function timeoutError() {
  return new Error('Timeout waiting for VOICE_SERVER_UPDATE.');
}

function makeCtx() {
  const destroyed: string[] = [];
  return {
    ctx: {
      guildId: 'guild-1',
      t: (key: string) => key,
      sessions: {
        adoptVoiceChannel: () => {},
        syncPersistentVoiceState: async () => {},
        destroy: async (_g: string, reason: string) => { destroyed.push(reason); },
      },
      rest: { getGuildMember: async () => ({ deaf: false }) },
      botUserId: 'bot-1',
    } as never,
    destroyed,
  };
}

function makeSession(failures: number) {
  let attempts = 0;
  return {
    session: {
      sessionId: 's1',
      connection: {
        connected: false,
        async connect() {
          attempts += 1;
          if (attempts <= failures) throw timeoutError();
        },
      },
    } as never,
    attemptCount: () => attempts,
  };
}

test('a transient voice timeout is classified as retryable', () => {
  assert.equal(isRetryableVoiceConnectFailure(timeoutError()), true);
  assert.equal(isRetryableVoiceConnectFailure(new Error('missing permissions')), false);
  assert.equal(isRetryableVoiceConnectFailure(null), false);
});

test('a command retries the join instead of giving up after one try', async () => {
  const { ctx } = makeCtx();
  const { session, attemptCount } = makeSession(2);

  await connectPreparedSession(ctx, {
    hadSession: true,
    hasUsablePlayer: true,
    resolvedVoice: 'vc-1',
    session,
  } as never);

  assert.equal(attemptCount(), 3, 'it must keep trying while the failure is transient');
});

test('a permanent failure is not retried', async () => {
  const { ctx } = makeCtx();
  let attempts = 0;
  const session = {
    sessionId: 's1',
    connection: {
      connected: false,
      async connect() {
        attempts += 1;
        throw new Error('Missing permissions to join that channel.');
      },
    },
  } as never;

  await assert.rejects(
    connectPreparedSession(ctx, {
      hadSession: true,
      hasUsablePlayer: true,
      resolvedVoice: 'vc-1',
      session,
    } as never),
  );
  assert.equal(attempts, 1, 'a permission problem must not be retried');
});

test('an already connected session does not reconnect', async () => {
  const { ctx } = makeCtx();
  let attempts = 0;
  const session = {
    sessionId: 's1',
    connection: {
      connected: true,
      async connect() { attempts += 1; },
    },
  } as never;

  await connectPreparedSession(ctx, {
    hadSession: true,
    hasUsablePlayer: true,
    resolvedVoice: 'vc-1',
    session,
  } as never);

  assert.equal(attempts, 0);
});
