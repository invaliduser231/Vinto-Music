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
  index: number | undefined;
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
    async registerHelpPagination(channelId: string, messageId: string, pages: HelpPayload[], index?: number) {
      registeredPagination = { channelId, messageId, pages, index };
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
  assert.equal(pagination.index, undefined);
  assert.ok(Array.isArray(pagination.pages));
  assert.ok(pagination.pages.length > 0);
  const combinedDescriptions = pagination.pages
    .map((page: HelpPayload) => page?.embeds?.[0]?.description ?? '')
    .join('\n');
  assert.match(combinedDescriptions, /`!help \[command\|page_number\]`/);
});

test('help command sends single command description embed payload', async () => {
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
    async registerHelpPagination(channelId: string, messageId: string, pages: HelpPayload[], index?: number) {
      registeredPagination = { channelId, messageId, pages, index };
    },
    args: ['help'],
  });

  assert.equal(sentChannelId, channelId);
  assert.ok(sentPayload);
  const payload: HelpPayload = sentPayload as HelpPayload;
  assert.ok(Array.isArray(payload.embeds));
  assert.equal(payload.embeds.length, 1);
  assert.match(payload.embeds[0]!.title, /^Help$/);
  assert.equal(typeof payload.embeds[0]!.description, 'string');
  assert.match(payload.embeds[0]!.description!, /`!help \[command\|page_number\]`/);
  assert.ok((payload.embeds[0]!.description ?? '').length > 0);

  assert.ok(!registeredPagination);
});

test('help command formats command alternatives without spaced pipes', async () => {
  const { prefix, channelId, messageId } = dummyConstants();
  const { registry, help } = setup();
  const execute = help?.execute as HelpExecute | undefined;
  assert.ok(execute);
  let sentPayload: HelpPayload | null = null;

  await execute({
    prefix,
    registry,
    channelId,
    rest: {
      async sendMessage(_channelId: string, payload: HelpPayload) {
        sentPayload = payload;
        return { id: messageId };
      },
    },
    args: ['play'],
  });

  assert.ok(sentPayload);
  const payload: HelpPayload = sentPayload as HelpPayload;
  const description = payload.embeds[0]?.description ?? '';
  assert.match(description, /`!play <query\|url>`/);
  assert.doesNotMatch(description, /\b \| \b/);
});

test('help command sends arbitrary page for paginated embed payload', async () => {
  const pageNum = '1';
  const { prefix, channelId, messageId, } = dummyConstants();
  const { registry, help } = setup();
  const execute = help?.execute as HelpExecute | undefined;
  assert.ok(execute);
  let sentChannelId: string | null = null;
  let sentPayload: HelpPayload | null = null;
  let registeredPagination: HelpPaginationRegistration | null = null;

  const pageIndex = +pageNum - 1;

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
    async registerHelpPagination(channelId: string, messageId: string, pages: HelpPayload[], index?: number) {
      registeredPagination = { channelId, messageId, pages, index };
    },
    args: [pageNum],
  });

  assert.equal(sentChannelId, channelId);
  assert.ok(sentPayload);
  const payload: HelpPayload = sentPayload as HelpPayload;
  assert.ok(Array.isArray(payload.embeds));
  assert.ok(payload.embeds.length > 0);
  assert.match(payload.embeds[0]!.title, new RegExp('^Help ' + pageNum + '\\/\\d+$'));
  assert.equal(typeof payload.embeds[0]!.description, 'string');
  assert.ok((payload.embeds[0]!.description ?? '').length > 0);

  assert.ok(registeredPagination);
  const pagination: HelpPaginationRegistration = registeredPagination as HelpPaginationRegistration;
  assert.equal(pagination.index, pageIndex);
  assert.equal(pagination.channelId, channelId);
  assert.equal(pagination.messageId, messageId);
  assert.equal(pagination.index, pageIndex);
  assert.ok(Array.isArray(pagination.pages));
  assert.ok(pagination.pages.length > 0);
  const combinedDescriptions = pagination.pages
    .map((page: HelpPayload) => page?.embeds?.[0]?.description ?? '')
    .join('\n');
  assert.match(combinedDescriptions, /`!help \[command\|page_number\]`/);
});
