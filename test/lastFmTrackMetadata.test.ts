import test from 'node:test';
import assert from 'node:assert/strict';

import { toLastFmTrack } from '../src/integrations/lastfm/trackMetadata.ts';

test('an explicit artist field wins over title parsing', () => {
  const meta = toLastFmTrack({
    title: 'Midnight City',
    artist: 'M83',
    duration: '4:03',
    source: 'deezer',
  });

  assert.deepEqual(meta, {
    artist: 'M83',
    track: 'Midnight City',
    album: null,
    durationSec: 243,
  });
});

test('artist and title are split out of a youtube style title', () => {
  const meta = toLastFmTrack({
    title: 'Daft Punk - Around the World (Official Video)',
    duration: '7:09',
    source: 'youtube',
  });

  assert.equal(meta?.artist, 'Daft Punk');
  assert.equal(meta?.track, 'Around the World');
});

test('a topic channel suffix is removed from the artist', () => {
  const meta = toLastFmTrack({
    title: 'Kavinsky - Nightcall',
    artist: 'Kavinsky - Topic',
    duration: '4:18',
    source: 'youtube',
  });

  assert.equal(meta?.artist, 'Kavinsky');
});

test('a duplicated artist prefix is dropped from the title', () => {
  const meta = toLastFmTrack({
    title: 'Boards of Canada - Roygbiv',
    artist: 'Boards of Canada',
    duration: '2:31',
    source: 'youtube',
  });

  assert.equal(meta?.track, 'Roygbiv');
});

test('common video noise is stripped', () => {
  const meta = toLastFmTrack({
    title: 'Artist - Song [Official Music Video] (4K)',
    duration: '3:30',
    source: 'youtube',
  });

  assert.equal(meta?.track, 'Song');
});

test('live streams and radio are never scrobbled', () => {
  assert.equal(toLastFmTrack({ title: 'Artist - Song', duration: '4:00', isLive: true }), null);
  assert.equal(toLastFmTrack({ title: 'Some Station', duration: '4:00', source: 'radio' }), null);
  assert.equal(toLastFmTrack({ title: 'Artist - Song', duration: '4:00', isPreview: true }), null);
});

test('tracks without a usable duration are skipped', () => {
  assert.equal(toLastFmTrack({ title: 'Artist - Song', duration: 'Unknown' }), null);
  assert.equal(toLastFmTrack({ title: 'Artist - Song', duration: null }), null);
});

test('tracks below the minimum length are skipped', () => {
  assert.equal(toLastFmTrack({ title: 'Artist - Song', duration: '0:20' }), null);
  assert.notEqual(toLastFmTrack({ title: 'Artist - Song', duration: '0:20' }, { minDurationSec: 10 }), null);
});

test('a title without any artist information is skipped', () => {
  assert.equal(toLastFmTrack({ title: 'just some words', duration: '4:00' }), null);
});

test('deferred metadata and youtube mix placeholders are skipped', () => {
  assert.equal(toLastFmTrack({ title: 'Artist - Song', duration: '4:00', metadataDeferred: true }), null);
  assert.equal(toLastFmTrack({ title: 'YouTube Mix Track', artist: 'Mix', duration: '4:00' }), null);
});
