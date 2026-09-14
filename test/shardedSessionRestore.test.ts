import test from 'node:test';
import assert from 'node:assert/strict';

import { SessionManager } from '../src/bot/sessionManager.ts';
import { shardForGuild } from '../src/core/sharding.ts';

const GUILDS = [
  '1485394316330348923',
  '1541587443302535168',
  '1474874137937518680',
  '1473874611065868398',
];

function managerForShard(shardId: number, shardCount: number, guildIds: string[], inspected: string[]) {
  const manager = Object.create(SessionManager.prototype) as Record<string, unknown> & {
    restorePersistentVoiceSessions: () => Promise<unknown[]>;
    _ownsGuild: (guildId: unknown) => boolean;
  };

  manager.config = { shardId, shardCount };
  manager.logger = null;
  manager.library = {
    listPersistentVoiceConnections: async () => guildIds.map((guildId) => ({
      guildId,
      voiceChannelId: '1520430848669659136',
      textChannelId: '1520430848669659136',
    })),
  };
  manager._loadGuildConfig = async () => null;
  manager._inspectPersistentVoiceChannel = async (guildId: string) => {
    inspected.push(guildId);
    return 'missing';
  };
  manager._clearPersistentVoiceBinding = async () => null;
  manager.has = () => false;
  return manager;
}

test('without sharding every persisted session is restored', async () => {
  const inspected: string[] = [];
  const manager = managerForShard(0, 1, GUILDS.slice(0, 2), inspected);

  await manager.restorePersistentVoiceSessions();

  assert.deepEqual(inspected.sort(), GUILDS.slice(0, 2).sort());
});

test('a shard skips the guilds that belong to another one', async () => {
  const mine = GUILDS.filter((id) => shardForGuild(id, 2) === 0);
  const theirs = GUILDS.filter((id) => shardForGuild(id, 2) === 1);
  assert.ok(mine.length > 0 && theirs.length > 0, 'the fixture must cover both shards');

  const inspected: string[] = [];
  await managerForShard(0, 2, [mine[0]!, theirs[0]!], inspected).restorePersistentVoiceSessions();

  assert.deepEqual(inspected, [mine[0]], 'only the own guild may be touched');
});

test('the ownership check covers every guild exactly once across shards', () => {
  for (const guildId of GUILDS) {
    const owners = [0, 1].filter((shardId) => {
      const manager = managerForShard(shardId, 2, [], []);
      return manager._ownsGuild(guildId);
    });
    assert.equal(owners.length, 1, `${guildId} must be owned by exactly one shard`);
  }
});
