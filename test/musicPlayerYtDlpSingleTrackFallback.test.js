import test from 'node:test';
import assert from 'node:assert/strict';

import { MusicPlayer } from '../src/player/MusicPlayer.js';

function createPlayer() {
  return new MusicPlayer({}, {
    logger: null,
  });
}

test('single YouTube track resolver falls back to yt-dlp metadata when play-dl fails', async () => {
  const player = createPlayer();

  player._fetchSingleYouTubeTrackViaPlayDl = async () => {
    throw new Error('play-dl blocked');
  };
  player._runYtDlpCommand = async () => ({
    code: 0,
    stdout: JSON.stringify({
      webpage_url: 'https://www.youtube.com/watch?v=OBoMLZTtqb8',
      title: 'RETRO REWIND',
      duration: 5401,
      duration_string: '1:30:01',
      channel: 'Chill City FM',
      thumbnail: 'https://i.ytimg.com/vi/OBoMLZTtqb8/maxresdefault.jpg',
    }),
    stderr: '',
  });

  const tracks = await player._resolveSingleYouTubeTrack('https://www.youtube.com/watch?v=OBoMLZTtqb8', 'user-1');
  assert.equal(tracks.length, 1);
  assert.equal(tracks[0].title, 'RETRO REWIND');
  assert.equal(tracks[0].duration, '1:30:01');
  assert.equal(tracks[0].artist, 'Chill City FM');
  assert.equal(tracks[0].url, 'https://www.youtube.com/watch?v=OBoMLZTtqb8');
});

test('single YouTube track resolver still returns unknown metadata if play-dl and yt-dlp both fail', async () => {
  const player = createPlayer();

  player._fetchSingleYouTubeTrackViaPlayDl = async () => {
    throw new Error('play-dl blocked');
  };
  player._runYtDlpCommand = async () => {
    throw new Error('yt-dlp blocked');
  };

  const tracks = await player._resolveSingleYouTubeTrack('https://www.youtube.com/watch?v=OBoMLZTtqb8', 'user-1');
  assert.equal(tracks.length, 1);
  assert.equal(tracks[0].title, 'https://www.youtube.com/watch?v=OBoMLZTtqb8');
  assert.equal(tracks[0].duration, 'Unknown');
});
