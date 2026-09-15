import test from 'node:test';
import assert from 'node:assert/strict';

import { VoiceStateStore } from '../src/bot/voiceStateStore.ts';

const GUILD = '1485394316330348923';
const CHANNEL = '1520430848669659136';

function storeWithGateway() {
  const handlers = new Map<string, (payload: unknown) => void>();
  const store = new VoiceStateStore(null as never);
  store.register({ on: (event: string, fn: (payload: never) => void) => handlers.set(event, fn as never) } as never);
  return {
    store,
    voiceUpdate: (payload: Record<string, unknown>) => handlers.get('VOICE_STATE_UPDATE')?.(payload),
    ready: (payload: Record<string, unknown>) => handlers.get('READY')?.(payload),
  };
}

test('a listener who hears is not marked deafened', () => {
  const { store, voiceUpdate } = storeWithGateway();
  voiceUpdate({ guild_id: GUILD, user_id: 'u1', channel_id: CHANNEL, self_deaf: false, deaf: false });

  assert.deepEqual(store.getUsersInChannel(GUILD, CHANNEL), ['u1']);
  assert.equal(store.isDeafened('u1'), false);
});

test('self deafened and server deafened both count', () => {
  const { store, voiceUpdate } = storeWithGateway();
  voiceUpdate({ guild_id: GUILD, user_id: 'self', channel_id: CHANNEL, self_deaf: true });
  voiceUpdate({ guild_id: GUILD, user_id: 'server', channel_id: CHANNEL, deaf: true });

  assert.equal(store.isDeafened('self'), true);
  assert.equal(store.isDeafened('server'), true);
});

test('undeafening clears the flag again', () => {
  const { store, voiceUpdate } = storeWithGateway();
  voiceUpdate({ guild_id: GUILD, user_id: 'u1', channel_id: CHANNEL, self_deaf: true });
  assert.equal(store.isDeafened('u1'), true);

  voiceUpdate({ guild_id: GUILD, user_id: 'u1', channel_id: CHANNEL, self_deaf: false });
  assert.equal(store.isDeafened('u1'), false);
});

test('leaving the channel drops the flag, so the set cannot grow forever', () => {
  const { store, voiceUpdate } = storeWithGateway();
  voiceUpdate({ guild_id: GUILD, user_id: 'u1', channel_id: CHANNEL, self_deaf: true });
  assert.equal(store.deafenedUsers.size, 1);

  voiceUpdate({ guild_id: GUILD, user_id: 'u1', channel_id: null });
  assert.equal(store.deafenedUsers.size, 0, 'a user who left must not stay in the set');
  assert.equal(store.isDeafened('u1'), false);
});

test('a fresh guild seed replaces the previous flags', () => {
  const { store, ready } = storeWithGateway();

  ready({
    guilds: [{
      id: GUILD,
      voice_states: [
        { user_id: 'u1', channel_id: CHANNEL, self_deaf: true },
        { user_id: 'u2', channel_id: CHANNEL },
      ],
    }],
  });
  assert.equal(store.isDeafened('u1'), true);
  assert.equal(store.isDeafened('u2'), false);

  ready({
    guilds: [{
      id: GUILD,
      voice_states: [
        { user_id: 'u1', channel_id: CHANNEL },
        { user_id: 'u2', channel_id: CHANNEL, deaf: true },
      ],
    }],
  });
  assert.equal(store.isDeafened('u1'), false, 'the flag has to follow the new state');
  assert.equal(store.isDeafened('u2'), true);
});

test('a user missing from a reseed is forgotten', () => {
  const { store, ready } = storeWithGateway();
  ready({ guilds: [{ id: GUILD, voice_states: [{ user_id: 'gone', channel_id: CHANNEL, self_deaf: true }] }] });
  assert.equal(store.isDeafened('gone'), true);

  ready({ guilds: [{ id: GUILD, voice_states: [{ user_id: 'other', channel_id: CHANNEL }] }] });
  assert.equal(store.isDeafened('gone'), false);
  assert.equal(store.deafenedUsers.size, 0);
});

test('the scrobbler skips deafened listeners', async () => {
  const { ScrobbleService } = await import('../src/bot/services/scrobbleService.ts');
  const listeners = (ScrobbleService.prototype as unknown as {
    _listeners: (this: unknown, guildId: unknown, channelId: unknown) => string[];
  })._listeners;

  const runtime = {
    botUserId: 'bot',
    voiceStateStore: {
      getUsersInChannel: () => ['bot', 'hears', 'deafened'],
      isDeafened: (userId: string) => userId === 'deafened',
    },
  };

  assert.deepEqual(
    listeners.call(runtime, GUILD, CHANNEL),
    ['hears'],
    'the bot itself and anyone who cannot hear must be left out',
  );
});

test('a store without the flag keeps every listener', async () => {
  const { ScrobbleService } = await import('../src/bot/services/scrobbleService.ts');
  const listeners = (ScrobbleService.prototype as unknown as {
    _listeners: (this: unknown, guildId: unknown, channelId: unknown) => string[];
  })._listeners;

  const runtime = {
    botUserId: 'bot',
    voiceStateStore: { getUsersInChannel: () => ['bot', 'a', 'b'] },
  };

  assert.deepEqual(listeners.call(runtime, GUILD, CHANNEL), ['a', 'b']);
});
