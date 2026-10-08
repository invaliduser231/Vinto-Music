import test from 'node:test';
import assert from 'node:assert/strict';

import { createProgressReporter } from '../src/bot/commands/responseUtils.ts';
import type { MessagePayload } from '../src/types/core.ts';

function createContext(editMessage: (channelId: string, messageId: string, payload: MessagePayload) => Promise<unknown>) {
  const noop = async () => undefined;
  return {
    channelId: 'text-1',
    guildId: 'guild-1',
    config: { enableEmbeds: true },
    rest: {
      sendMessage: async () => ({ id: 'progress-1', channel_id: 'text-1' }),
      editMessage,
    },
    reply: { success: noop, warning: noop, info: noop, error: noop },
  };
}

test('replace returns the id of the edited progress message, not the edit response', async () => {
  const edits: string[] = [];
  const progress = await createProgressReporter(createContext(async (_channelId, messageId) => {
    edits.push(messageId);
    return { id: messageId, channel_id: 'text-1', embeds: [] };
  }), 'Searching');

  const messageId = await progress.replace({ content: 'results' });

  assert.equal(messageId, 'progress-1');
  assert.deepEqual(edits, ['progress-1']);
});

test('replace returns null when the edit fails so the caller can send a new message', async () => {
  const progress = await createProgressReporter(createContext(async () => {
    throw new Error('Unknown Message');
  }), 'Searching');

  assert.equal(await progress.replace({ content: 'results' }), null);
});
