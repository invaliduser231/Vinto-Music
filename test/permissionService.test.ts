import test from 'node:test';
import assert from 'node:assert/strict';

import { PermissionService } from '../src/bot/services/permissionService.ts';

const VIEW_CHANNEL = String(1n << 10n);
const VIEW_AND_SEND = String((1n << 10n) | (1n << 11n));
const CONNECT_ONLY = String(1n << 20n);
const ADMINISTRATOR = String(1n << 3n);
const SEND_MESSAGES = String(1n << 11n);

const BOT_ID = 'bot-1';

function buildService(options: {
  guild: Record<string, unknown>;
  member?: Record<string, unknown>;
  channel?: Record<string, unknown>;
  listGuildRoles?: (guildId: string) => Promise<unknown>;
}) {
  const rest = {
    async getGuild() {
      return options.guild;
    },
    async getGuildMember() {
      return options.member ?? { roles: [] };
    },
    async getChannel() {
      return options.channel ?? {};
    },
    ...(options.listGuildRoles ? { listGuildRoles: options.listGuildRoles } : {}),
  };

  return new PermissionService({ rest, botUserId: BOT_ID });
}

test('everyone role grants send permission when the bot role omits it', async () => {
  const service = buildService({
    guild: {
      id: 'guild-1',
      owner_id: 'owner-1',
      roles: [
        { id: 'guild-1', permissions: VIEW_AND_SEND },
        { id: 'role-bot', permissions: CONNECT_ONLY },
      ],
    },
    member: { roles: ['role-bot'] },
  });

  assert.equal(await service.canBotSendMessages('guild-1', 'chan-1'), true);
});

test('administrator implies every permission', async () => {
  const service = buildService({
    guild: {
      id: 'guild-2',
      owner_id: 'owner-1',
      roles: [
        { id: 'guild-2', permissions: '0' },
        { id: 'role-admin', permissions: ADMINISTRATOR },
      ],
    },
    member: { roles: ['role-admin'] },
  });

  assert.equal(await service.canBotSendMessages('guild-2', 'chan-2'), true);
  assert.equal(await service.canBotJoinAndSpeak('guild-2', 'chan-2'), true);
});

test('guild owner receives all permissions', async () => {
  const service = buildService({
    guild: { id: 'guild-3', owner_id: BOT_ID, roles: [] },
    member: { roles: [] },
  });

  assert.equal(await service.canBotSendMessages('guild-3', 'chan-3'), true);
});

test('member overwrite denies send only for overwrite type 1', async () => {
  const denied = buildService({
    guild: {
      id: 'guild-4',
      owner_id: 'owner-1',
      roles: [{ id: 'guild-4', permissions: VIEW_AND_SEND }],
    },
    member: { roles: [] },
    channel: {
      permission_overwrites: [{ id: BOT_ID, type: 1, allow: '0', deny: SEND_MESSAGES }],
    },
  });
  assert.equal(await denied.canBotSendMessages('guild-4', 'chan-4'), false);

  const unaffected = buildService({
    guild: {
      id: 'guild-5',
      owner_id: 'owner-1',
      roles: [{ id: 'guild-5', permissions: VIEW_AND_SEND }],
    },
    member: { roles: [] },
    channel: {
      permission_overwrites: [{ id: BOT_ID, type: 0, allow: '0', deny: SEND_MESSAGES }],
    },
  });
  assert.equal(await unaffected.canBotSendMessages('guild-5', 'chan-5'), true);
});

test('everyone overwrite is applied before role allows', async () => {
  const service = buildService({
    guild: {
      id: 'guild-6',
      owner_id: 'owner-1',
      roles: [
        { id: 'guild-6', permissions: VIEW_CHANNEL },
        { id: 'role-bot', permissions: '0' },
      ],
    },
    member: { roles: ['role-bot'] },
    channel: {
      permission_overwrites: [
        { id: 'guild-6', type: 0, allow: '0', deny: SEND_MESSAGES },
        { id: 'role-bot', type: 0, allow: SEND_MESSAGES, deny: '0' },
      ],
    },
  });

  assert.equal(await service.canBotSendMessages('guild-6', 'chan-6'), true);
});

test('roles are fetched via listGuildRoles when the guild payload omits them', async () => {
  let called = 0;
  const service = buildService({
    guild: { id: 'guild-7', owner_id: 'owner-1' },
    member: { roles: ['role-bot'] },
    async listGuildRoles() {
      called += 1;
      return [
        { id: 'guild-7', permissions: VIEW_AND_SEND },
        { id: 'role-bot', permissions: CONNECT_ONLY },
      ];
    },
  });

  assert.equal(await service.canBotSendMessages('guild-7', 'chan-7'), true);
  assert.equal(called, 1);
});

test('resolution stays unknown when no role data is available', async () => {
  const service = buildService({
    guild: { id: 'guild-8', owner_id: 'owner-1' },
    member: { roles: ['role-bot'] },
  });

  assert.equal(await service.canBotSendMessages('guild-8', 'chan-8'), null);
});
