import test from 'node:test';
import assert from 'node:assert/strict';

import { MusicPlayer } from '../src/player/MusicPlayer.ts';

type PlaylistResolveOptions = {
  fallbackWatchUrl?: string;
};

function createPlayer() {
  return new MusicPlayer({}, {
    logger: null,
    maxPlaylistTracks: 25,
  });
}

test('yt-dlp playlist fallback resolves track entries to playable URLs', async () => {
  const player = createPlayer();

  player._runYtDlpCommand = async () => ({
    code: 0,
    stdout: JSON.stringify({
      entries: [
        { id: 'QX_VR_Wshvk', title: 'KAFFKIEZ - Du Sagst', duration: 214 },
        { url: 'https://www.youtube.com/watch?v=osjLPATYHOY', title: 'VERMISSEN' },
      ],
    }),
    stderr: '',
  });

  const tracks = await player._resolveYouTubePlaylistTracksViaYtDlp(
    'https://www.youtube.com/playlist?list=PL3-sRm8xAzY89yb_OB-QtcCukQfFe864A',
    'user-1'
  );

  assert.equal(tracks.length, 2);
  assert.equal(tracks[0]!.url, 'https://www.youtube.com/watch?v=QX_VR_Wshvk');
  assert.equal(tracks[0]!.source, 'youtube-playlist-ytdlp');
  assert.equal(tracks[1]!.url, 'https://www.youtube.com/watch?v=osjLPATYHOY');
});

test('playlist resolver in default mode prefers yt-dlp before play-dl', async () => {
  const player = createPlayer();

  let ytdlpCalls = 0;
  let playdlCalls = 0;

  player._resolveYouTubePlaylistTracksViaYtDlp = async () => {
    ytdlpCalls += 1;
    return [
      player._buildTrack({
      title: 'Recovered via yt-dlp',
      url: 'https://www.youtube.com/watch?v=QX_VR_Wshvk',
      duration: 214,
      requestedBy: 'user-1',
      source: 'youtube-playlist-ytdlp',
      }),
    ];
  };
  player._resolveYouTubePlaylistTracksViaPlayDl = async () => {
    playdlCalls += 1;
    return [
      player._buildTrack({
        title: 'Should not run',
        url: 'https://www.youtube.com/watch?v=osjLPATYHOY',
        duration: 200,
        requestedBy: 'user-1',
        source: 'youtube-playlist',
      }),
    ];
  };
  player._resolveSingleYouTubeTrack = async () => {
    throw new Error('single fallback should not be used');
  };

  const tracks = await player._resolveYouTubePlaylistTracks(
    'https://www.youtube.com/playlist?list=PL3-sRm8xAzY89yb_OB-QtcCukQfFe864A',
    'user-1',
    { fallbackWatchUrl: 'https://www.youtube.com/watch?v=abc123' } as PlaylistResolveOptions
  );

  assert.equal(tracks.length, 1);
  assert.equal(tracks[0]!.title, 'Recovered via yt-dlp');
  assert.equal(ytdlpCalls, 1);
  assert.equal(playdlCalls, 0);
});

test('playlist resolver in playdl mode falls back to yt-dlp', async () => {
  const player = new MusicPlayer({}, {
    logger: null,
    maxPlaylistTracks: 25,
    youtubePlaylistResolver: 'playdl',
  });

  let ytdlpCalls = 0;
  let playdlCalls = 0;

  player._resolveYouTubePlaylistTracksViaPlayDl = async () => {
    playdlCalls += 1;
    throw new Error("Cannot read properties of undefined (reading 'browseId')");
  };
  player._resolveYouTubePlaylistTracksViaYtDlp = async () => {
    ytdlpCalls += 1;
    return [
      player._buildTrack({
        title: 'Recovered via yt-dlp',
        url: 'https://www.youtube.com/watch?v=QX_VR_Wshvk',
        duration: 214,
        requestedBy: 'user-1',
        source: 'youtube-playlist-ytdlp',
      }),
    ];
  };
  player._resolveSingleYouTubeTrack = async () => {
    throw new Error('single fallback should not be used');
  };

  const tracks = await player._resolveYouTubePlaylistTracks(
    'https://www.youtube.com/playlist?list=PL3-sRm8xAzY89yb_OB-QtcCukQfFe864A',
    'user-1',
    { fallbackWatchUrl: 'https://www.youtube.com/watch?v=abc123' } as PlaylistResolveOptions
  );

  assert.equal(tracks.length, 1);
  assert.equal(tracks[0]!.title, 'Recovered via yt-dlp');
  assert.equal(playdlCalls, 1);
  assert.equal(ytdlpCalls, 1);
});

test('playlist resolver uses play-dl fallback when yt-dlp fails in default mode', async () => {
  const player = createPlayer();

  let ytdlpCalls = 0;
  let playdlCalls = 0;

  player._resolveYouTubePlaylistTracksViaYtDlp = async () => {
    ytdlpCalls += 1;
    throw new Error('yt-dlp failed');
  };
  player._resolveYouTubePlaylistTracksViaPlayDl = async () => {
    playdlCalls += 1;
    return [
      player._buildTrack({
        title: 'Recovered via play-dl',
        url: 'https://www.youtube.com/watch?v=osjLPATYHOY',
        duration: 200,
        requestedBy: 'user-1',
        source: 'youtube-playlist',
      }),
    ];
  };
  player._resolveSingleYouTubeTrack = async () => {
    throw new Error('single fallback should not be used');
  };

  const tracks = await player._resolveYouTubePlaylistTracks(
    'https://www.youtube.com/playlist?list=PL3-sRm8xAzY89yb_OB-QtcCukQfFe864A',
    'user-1',
    { fallbackWatchUrl: 'https://www.youtube.com/watch?v=abc123' } as PlaylistResolveOptions
  );

  assert.equal(tracks.length, 1);
  assert.equal(tracks[0]!.title, 'Recovered via play-dl');
  assert.equal(ytdlpCalls, 1);
  assert.equal(playdlCalls, 1);
});

test('watch-context YouTube mix with limit 1 skips metadata lookup and returns immediate watch track', async () => {
  const player = createPlayer();
  let singleCalls = 0;
  let ytdlpCalls = 0;
  let playdlCalls = 0;

  player._resolveSingleYouTubeTrack = async () => {
    singleCalls += 1;
    throw new Error('single resolver should not be used');
  };
  player._resolveYouTubePlaylistTracksViaYtDlp = async () => {
    ytdlpCalls += 1;
    throw new Error('playlist ytdlp should not be used');
  };
  player._resolveYouTubePlaylistTracksViaPlayDl = async () => {
    playdlCalls += 1;
    throw new Error('playlist play-dl should not be used');
  };

  const tracks = await player._resolveYouTubePlaylistTracks(
    'https://www.youtube.com/watch?v=NN96DHjYCzM&list=RDMM&start_radio=1',
    'user-1',
    { fallbackWatchUrl: 'https://www.youtube.com/watch?v=NN96DHjYCzM', limit: 1 } as PlaylistResolveOptions
  );

  assert.equal(tracks.length, 1);
  assert.equal(tracks[0]!.url, 'https://www.youtube.com/watch?v=NN96DHjYCzM');
  assert.equal(tracks[0]!.title, 'YouTube Mix Track');
  assert.equal(singleCalls, 0);
  assert.equal(ytdlpCalls, 0);
  assert.equal(playdlCalls, 0);
});





