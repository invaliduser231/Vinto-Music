import test from 'node:test';
import assert from 'node:assert/strict';

import { ensureBotNotDeafened } from '../src/bot/commands/helpers/context.ts';
import { ValidationError } from '../src/core/errors.ts';

function makeCtx(options: { deaf: boolean; canLift: boolean; hasSetter?: boolean }) {
  let deaf = options.deaf;
  const patches: Array<{ guildId: string; userId: string; deaf: boolean }> = [];
  const rest: Record<string, unknown> = {
    getGuildMember: async () => ({ deaf }),
  };
  if (options.hasSetter !== false) {
    rest.setGuildMemberDeaf = async (guildId: string, userId: string, next: boolean) => {
      patches.push({ guildId, userId, deaf: next });
      if (!options.canLift) throw new Error('Missing Permissions');
      deaf = next;
    };
  }
  return {
    ctx: {
      guildId: 'guild-1',
      botUserId: 'bot-1',
      t: (key: string) => key,
      rest,
    } as never,
    patches,
  };
}

test('a bot that is not deafened passes without touching its member', async () => {
  const { ctx, patches } = makeCtx({ deaf: false, canLift: true });
  await ensureBotNotDeafened(ctx);
  assert.equal(patches.length, 0);
});

test('a server-deafened bot lifts the flag itself when it is allowed to', async () => {
  const { ctx, patches } = makeCtx({ deaf: true, canLift: true });
  await ensureBotNotDeafened(ctx);
  assert.deepEqual(patches, [{ guildId: 'guild-1', userId: 'bot-1', deaf: false }]);
});

test('a server-deafened bot without the permission reports it', async () => {
  const { ctx, patches } = makeCtx({ deaf: true, canLift: false });
  await assert.rejects(ensureBotNotDeafened(ctx), (err: unknown) => (
    err instanceof ValidationError && err.message === 'errors.botDeafened'
  ));
  assert.equal(patches.length, 1);
});

test('a rest client without the setter still reports the deafen', async () => {
  const { ctx } = makeCtx({ deaf: true, canLift: true, hasSetter: false });
  await assert.rejects(ensureBotNotDeafened(ctx), ValidationError);
});
