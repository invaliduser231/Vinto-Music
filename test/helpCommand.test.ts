import test from 'node:test';
import assert from 'node:assert/strict';

import { registerCommands } from '../src/bot/commands/index.ts';
import { CommandRegistry } from '../src/bot/commandRegistry.ts';

type HelpExecute = NonNullable<NonNullable<ReturnType<CommandRegistry['resolve']>>['execute']>;

type HelpPayload = {
  embeds: Array<{
    title: string;
    description?: string;
  }>;
};

type HelpPaginationRegistration = {
  channelId: string;
  messageId: string;
  pages: HelpPayload[];
};

function dummyConstants() {
  const prefix = '!';
  const channelId = 'channel-1';
  const messageId = 'message-1';

  return {
    prefix,
    channelId,
    messageId,
  };
}

function setup() {
  const registry = new CommandRegistry();
  registerCommands(registry);
  return { registry, help: registry.resolve('help') };
}

test('help command sends paginated embed payload', async () => {
  const { prefix, channelId, messageId, } = dummyConstants();
  const { registry, help } = setup();
  const execute = help?.execute as HelpExecute | undefined;
  assert.ok(execute);
  let sentChannelId: string | null = null;
  let sentPayload: HelpPayload | null = null;
  let registeredPagination: HelpPaginationRegistration | null = null;

  await execute({
    prefix,
    registry,
    channelId,
    rest: {
      async sendMessage(channelId: string, payload: HelpPayload) {
        sentChannelId = channelId;
        sentPayload = payload;
        return { id: messageId };
      },
    },
    async registerHelpPagination(channelId: string, messageId: string, pages: HelpPayload[]) {
      registeredPagination = { channelId, messageId, pages };
    },
    args: [],
  });

  assert.equal(sentChannelId, channelId);
  assert.ok(sentPayload);
  const payload: HelpPayload = sentPayload as HelpPayload;
  assert.ok(Array.isArray(payload.embeds));
  assert.ok(payload.embeds.length > 0);
  assert.match(payload.embeds[0]!.title, /^Help \d+\/\d+$/);
  assert.equal(typeof payload.embeds[0]!.description, 'string');
  assert.ok((payload.embeds[0]!.description ?? '').length > 0);

  assert.ok(registeredPagination);
  const pagination: HelpPaginationRegistration = registeredPagination as HelpPaginationRegistration;
  assert.equal(pagination.channelId, channelId);
  assert.equal(pagination.messageId, messageId);
  assert.ok(Array.isArray(pagination.pages));
  assert.ok(pagination.pages.length > 0);
  const combinedDescriptions = pagination.pages
    .map((page: HelpPayload) => page?.embeds?.[0]?.description ?? '')
    .join('\n');
  assert.match(combinedDescriptions, /`!help \[command\]`/);
});
