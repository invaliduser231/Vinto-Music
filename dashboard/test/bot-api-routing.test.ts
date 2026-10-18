import test from 'node:test';
import assert from 'node:assert/strict';

import { mergeUserVoiceResponses, planBotApiRoute } from '../src/lib/bot-api';
import { withLiveConnectionGuild } from '../src/lib/bot-client';

const GUILD = '1485394316330348923';

test('guild scoped requests are routed by the guild in the query or body', () => {
  assert.deepEqual(planBotApiRoute('session', new URLSearchParams({ guildId: GUILD })), { kind: 'guild', guildId: GUILD });
  assert.deepEqual(
    planBotApiRoute('session/action', new URLSearchParams(), JSON.stringify({ guildId: GUILD, action: 'pause' })),
    { kind: 'guild', guildId: GUILD },
  );
});

test('voice discovery asks every shard and the bot guild list asks the bootstrap shard', () => {
  assert.deepEqual(planBotApiRoute('user/voice', new URLSearchParams({ guildIds: GUILD })), { kind: 'every-shard' });
  assert.deepEqual(planBotApiRoute('bot/guilds', new URLSearchParams({ guildIds: GUILD })), { kind: 'bootstrap' });
  assert.deepEqual(planBotApiRoute('guild', new URLSearchParams()), { kind: 'bootstrap' });
  assert.deepEqual(planBotApiRoute('session/action', new URLSearchParams(), 'not json'), { kind: 'bootstrap' });
});

test('merged voice discovery keeps the shard that found the user', () => {
  const found = { voice: { guildId: GUILD, voiceChannelId: 'vc-1' }, ts: 2 };
  assert.deepEqual(mergeUserVoiceResponses([{ voice: null, ts: 1 }, found]), found);
  assert.deepEqual(mergeUserVoiceResponses([{ voice: null, ts: 3 }]), { voice: null, ts: 3 });
});

test('the live connection url names its guild so the dashboard can pick the shard', () => {
  assert.equal(withLiveConnectionGuild('wss://dash.example/ws', GUILD), `wss://dash.example/ws?guildId=${GUILD}`);
  assert.equal(withLiveConnectionGuild('ws://127.0.0.1:9092', GUILD), `ws://127.0.0.1:9092/?guildId=${GUILD}`);
});
