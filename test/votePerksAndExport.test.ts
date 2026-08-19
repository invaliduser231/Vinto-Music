import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyVoterPerks,
  baseLimits,
  describePerkDelta,
  resolveLimits,
} from '../src/bot/services/votePerks.ts';
import { VoteService, extractTotal, extractVoterIds } from '../src/bot/services/voteService.ts';
import {
  buildCsvRow,
  buildExportFilename,
  buildQueueCsv,
  escapeCsvField,
} from '../src/bot/commands/helpers/csvExport.ts';

const CONFIG = {
  maxPlaylistTracks: 25,
  searchResultLimit: 5,
  playCommandCooldownMs: 2_000,
  maxFavoritesPerUser: 500,
};

test('non-voters keep exactly the configured limits', () => {
  assert.deepEqual(resolveLimits(CONFIG, false), baseLimits(CONFIG));
});

test('voters never receive worse limits than the base configuration', () => {
  const base = baseLimits(CONFIG);
  const voter = applyVoterPerks(base);

  assert.ok(voter.maxPlaylistTracks! > base.maxPlaylistTracks!);
  assert.ok(voter.searchResultLimit >= base.searchResultLimit);
  assert.ok(voter.playCommandCooldownMs <= base.playCommandCooldownMs);
  assert.ok(voter.maxFavoritesPerUser > base.maxFavoritesPerUser);
});

test('a generous base configuration is not downgraded for voters', () => {
  const generous = {
    maxPlaylistTracks: 500,
    searchResultLimit: 10,
    playCommandCooldownMs: 0,
    maxFavoritesPerUser: 5_000,
  };
  const voter = resolveLimits(generous, true);

  assert.equal(voter.searchResultLimit, 10);
  assert.equal(voter.playCommandCooldownMs, 0);
  assert.ok(voter.maxPlaylistTracks! >= 500);
});

test('an unlimited playlist setting stays unlimited for voters', () => {
  const unlimited = { ...CONFIG, maxPlaylistTracks: null };
  assert.equal(resolveLimits(unlimited, true).maxPlaylistTracks, null);
});

test('perk overview reports both the base and the voter value', () => {
  const delta = describePerkDelta(CONFIG);
  const playlist = delta.find((entry) => entry.key === 'playlistTracks');

  assert.equal(playlist?.base, 25);
  assert.equal(playlist?.voter, 100);
  assert.equal(delta.length, 4);
});

test('voter ids survive snowflakes that exceed safe integer precision', () => {
  const big = '9007199254740993';
  assert.notEqual(String(JSON.parse(`{"v":${big}}`).v), big, 'precondition: JSON.parse loses precision');

  const ids = extractVoterIds(`{"voters":[{"username":"a","fluxerId":${big}}]}`);
  assert.deepEqual(ids, [big], 'raw extraction keeps the exact id');
});

test('voter ids are also read when the API quotes them', () => {
  assert.deepEqual(extractVoterIds('{"voters":[{"fluxerId":"123"}]}'), ['123']);
});

test('total is read from the payload and missing totals stay null', () => {
  assert.equal(extractTotal('{"total":42,"voters":[]}'), 42);
  assert.equal(extractTotal('{"voters":[]}'), null);
});

test('vote service stays disabled without an api key or bot id', () => {
  const noKey = new VoteService({ apiBase: 'https://x', apiKey: null, botId: '1' });
  const noBot = new VoteService({ apiBase: 'https://x', apiKey: 'fl_x', botId: null });

  assert.equal(noKey.enabled, false);
  assert.equal(noBot.enabled, false);
  assert.equal(noKey.hasVoted('123'), false);
});

test('vote service never reports a voter it has not seen', () => {
  const service = new VoteService({ apiBase: 'https://x', apiKey: 'fl_x', botId: '1' });
  assert.equal(service.hasVoted('123'), false);
  assert.equal(service.hasVoted(''), false);
  assert.equal(service.hasVoted(null), false);
});

test('known voters survive a failed refresh because votes are permanent', async () => {
  const service = new VoteService({ apiBase: 'https://x', apiKey: 'fl_x', botId: '1' });
  service.voterIds.add('123');

  service._fetchPage = async () => {
    throw new Error('network down');
  };
  const ok = await service.refresh();

  assert.equal(ok, false);
  assert.equal(service.hasVoted('123'), true, 'a failed refresh must not revoke perks');
  assert.match(String(service.lastError), /network down/);
});

test('refresh accumulates voters across pages and stops at the reported total', async () => {
  const service = new VoteService({ apiBase: 'https://x', apiKey: 'fl_x', botId: '1', pageLimit: 2 });
  const pages: Record<number, string[]> = { 1: ['1', '2'], 2: ['3'] };
  const requested: number[] = [];

  service._fetchPage = async (page: number) => {
    requested.push(page);
    return { voterIds: pages[page] ?? [], total: 3 };
  };

  assert.equal(await service.refresh(), true);
  assert.deepEqual(requested, [1, 2]);
  assert.equal(service.hasVoted('3'), true);
  assert.equal(service.voterIds.size, 3);
});

test('csv escaping protects separators, quotes and newlines', () => {
  assert.equal(escapeCsvField('plain'), 'plain');
  assert.equal(escapeCsvField('a,b'), '"a,b"');
  assert.equal(escapeCsvField('say "hi"'), '"say ""hi"""');
  assert.equal(escapeCsvField('line\nbreak'), '"line\nbreak"');
  assert.equal(escapeCsvField(null), '');
});

test('csv row keeps a comma in a track title from shifting columns', () => {
  const row = buildCsvRow([1, 'queued', 'Hello, World', 'Artist']);
  assert.equal(row, '1,queued,"Hello, World",Artist');
});

test('queue export lists the current track first and numbers continuously', () => {
  const csv = buildQueueCsv({
    current: { title: 'Now', duration: '3:00', source: 'deezer', requestedBy: 'u1' },
    pending: [
      { title: 'Next', duration: '4:00', source: 'youtube', requestedBy: 'u2' },
      { title: 'Later', duration: '5:00', source: 'spotify', requestedBy: 'u3' },
    ],
  });
  const lines = csv.trim().split('\r\n');

  assert.equal(lines.length, 4, 'header plus three tracks');
  assert.match(lines[0]!, /^position,state,title/);
  assert.match(lines[1]!, /^1,playing,Now/);
  assert.match(lines[2]!, /^2,queued,Next/);
  assert.match(lines[3]!, /^3,queued,Later/);
});

test('queue export works without a current track', () => {
  const csv = buildQueueCsv({ current: null, pending: [{ title: 'Only' }] });
  const lines = csv.trim().split('\r\n');

  assert.equal(lines.length, 2);
  assert.match(lines[1]!, /^1,queued,Only/);
});

test('live tracks report live instead of a bogus duration', () => {
  const csv = buildQueueCsv({ current: { title: 'Radio', isLive: true, duration: 'Unknown' }, pending: [] });
  assert.match(csv, /1,playing,Radio,,live,/);
});

test('an empty queue still produces a valid header-only file', () => {
  const csv = buildQueueCsv({ current: null, pending: [] });
  assert.equal(csv.trim(), buildCsvRow([...['position', 'state', 'title', 'artist', 'duration', 'source', 'url', 'requested_by']]));
});

test('export filename is filesystem safe and carries the guild', () => {
  const name = buildExportFilename('123456', new Date('2026-08-19T18:30:45.000Z'));
  assert.match(name, /^queue-123456-2026-08-19T18-30-45\.csv$/);
  assert.doesNotMatch(buildExportFilename('../etc/passwd', new Date()), /[/\\.]{2}/);
});
