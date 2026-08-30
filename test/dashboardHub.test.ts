import test from 'node:test';
import assert from 'node:assert/strict';

import { buildDashboardHubPayload, toggleUserFavorite } from '../src/dashboard/hub.ts';

test('buildDashboardHubPayload combines independent library views', async () => {
  const calls: string[] = [];
  const library = {
    listGuildPlaylists: async () => { calls.push('playlists'); return { items: [], total: 0 }; },
    listUserFavorites: async () => { calls.push('favorites'); return { items: [], total: 0 }; },
    listGuildStations: async () => { calls.push('stations'); return []; },
    listQueueTemplates: async () => { calls.push('templates'); return []; },
    buildGuildRecap: async () => { calls.push('recap'); return { playCount: 4 }; },
    getUserProfile: async () => { calls.push('profile'); return { guildScore: 2 }; },
  };

  const payload = await buildDashboardHubPayload(library, 'guild-1', 'user-1');

  assert.equal((payload.recap as { playCount: number }).playCount, 4);
  assert.equal((payload.profile as { guildScore: number }).guildScore, 2);
  assert.deepEqual(calls.sort(), ['favorites', 'playlists', 'profile', 'recap', 'stations', 'templates']);
});

test('toggleUserFavorite adds and removes the current track', async () => {
  const items: Array<{ url: string }> = [];
  const library = {
    listUserFavorites: async () => ({ items: [...items] }),
    addUserFavorite: async (_userId: string, track: unknown) => {
      items.push(track as { url: string });
    },
    removeUserFavorite: async (_userId: string, index: number) => {
      items.splice(index - 1, 1);
    },
  };
  const track = { url: 'https://example.com/track' };

  assert.equal(await toggleUserFavorite(library, 'user-1', track), true);
  assert.deepEqual(items, [track]);
  assert.equal(await toggleUserFavorite(library, 'user-1', track), false);
  assert.deepEqual(items, []);
});
