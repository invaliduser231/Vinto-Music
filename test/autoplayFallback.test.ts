import test from 'node:test';
import assert from 'node:assert/strict';

import { findFallbackAutoplayTrack, isAutoplayCandidate } from '../src/bot/autoplayFallback.ts';

const seed = {
  title: 'Tame Impala - The Less I Know The Better (Official Video)',
  url: 'https://www.youtube.com/watch?v=2SUwOgmvzK4',
  artist: 'Tame Impala',
  duration: '3:38',
};

test('fallback autoplay pulls from the YouTube mix and skips the seed and recent tracks', async () => {
  const requested: string[] = [];
  const player = {
    async previewTracks(query: string) {
      requested.push(query);
      return [
        { title: 'Tame Impala - The Less I Know The Better', url: 'https://www.youtube.com/watch?v=2SUwOgmvzK4', duration: '3:38' },
        { title: 'Let It Happen', url: 'https://www.youtube.com/watch?v=pFptt7Cargc', duration: '7:47' },
        { title: 'Feels Like We Only Go Backwards', url: 'https://www.youtube.com/watch?v=wycjnCCgUes', duration: '3:13' },
      ];
    },
  };

  const result = await findFallbackAutoplayTrack(
    player,
    seed,
    [{ title: 'Let It Happen', url: 'https://www.youtube.com/watch?v=pFptt7Cargc' }],
    () => 0,
  );

  assert.equal(requested[0], 'https://www.youtube.com/watch?v=2SUwOgmvzK4&list=RD2SUwOgmvzK4');
  assert.equal(result?.strategy, 'youtube-mix');
  assert.equal((result?.track as { title: string }).title, 'Feels Like We Only Go Backwards');
});

test('fallback autoplay searches the artist when there is no mix to use', async () => {
  const searched: string[] = [];
  const player = {
    async previewTracks() {
      return [];
    },
    async searchCandidates(query: string) {
      searched.push(query);
      return [
        { title: 'Alleine', artist: 'Ok Kid', duration: '3:50' },
        { title: 'Gute Menschen', artist: 'Ok Kid', duration: '4:01' },
      ];
    },
  };

  const result = await findFallbackAutoplayTrack(
    player,
    { title: 'Alleine', url: 'https://www.deezer.com/track/1', artist: 'Ok Kid feat. Someone', duration: '3:50' },
    [],
    () => 0,
  );

  assert.deepEqual(searched, ['Ok Kid']);
  assert.equal(result?.strategy, 'same-artist');
  assert.equal((result?.track as { title: string }).title, 'Gute Menschen');
});

test('autoplay candidates reject live streams and tracks outside the length window', () => {
  const recent = new Set<string>();
  assert.equal(isAutoplayCandidate({ title: 'Short Intro', duration: '0:20' }, recent), false);
  assert.equal(isAutoplayCandidate({ title: 'Full Album', duration: '1:02:00' }, recent), false);
  assert.equal(isAutoplayCandidate({ title: 'Radio', duration: 'Live', isLive: true }, recent), false);
  assert.equal(isAutoplayCandidate({ title: 'Normal Song', duration: 210 }, recent), true);
  assert.equal(isAutoplayCandidate({ title: 'Unknown Length', duration: 'Unknown' }, recent), true);
});

test('fallback autoplay returns nothing without a previous track', async () => {
  assert.equal(await findFallbackAutoplayTrack({}, null, []), null);
});
