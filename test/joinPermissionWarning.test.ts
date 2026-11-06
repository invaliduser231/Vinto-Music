import test from 'node:test';
import assert from 'node:assert/strict';

import { _resetPermissionWarnings, warnAboutMissingTextPermissions } from '../src/bot/commands/helpers/context.ts';
import { createTranslator } from '../src/i18n/index.ts';
import type { CommandContextLike } from '../src/bot/commands/helpers/types.ts';

function createCtx(missing: string[], known = true) {
  const warnings: string[] = [];
  const ctx = {
    guildId: '1000001',
    channelId: '2000002',
    t: createTranslator('en'),
    permissionService: {
      async checkBotPermissions() {
        return { known, allowed: missing.length === 0, missing, reason: known ? null : 'lookup_failed' };
      },
    },
    reply: {
      async warning(text: string) {
        warnings.push(text);
      },
    },
  } as unknown as CommandContextLike;
  return { ctx, warnings };
}

test('joining warns once about missing text permissions', async () => {
  _resetPermissionWarnings();
  const { ctx, warnings } = createCtx(['EMBED_LINKS', 'ATTACH_FILES']);

  assert.equal(await warnAboutMissingTextPermissions(ctx), true);
  assert.equal(await warnAboutMissingTextPermissions(ctx), false);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /Embed Links/);
  assert.match(warnings[0]!, /Attach Files/);
});

test('joining stays quiet when permissions are fine or unknown', async () => {
  _resetPermissionWarnings();
  const fine = createCtx([]);
  const unknown = createCtx(['EMBED_LINKS'], false);

  assert.equal(await warnAboutMissingTextPermissions(fine.ctx), false);
  assert.equal(await warnAboutMissingTextPermissions(unknown.ctx), false);
  assert.deepEqual(fine.warnings, []);
  assert.deepEqual(unknown.warnings, []);
});
