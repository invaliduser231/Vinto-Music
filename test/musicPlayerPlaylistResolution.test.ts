import test from 'node:test';
import assert from 'node:assert/strict';

import { MusicPlayer } from '../src/player/MusicPlayer.ts';

type PlaylistResolveOptions = {
  fallbackWatchUrl?: string | null;
};

test('watch URL with list parameter is resolved as YouTube playlist', async () => {
  const player = new MusicPlayer({}, {
    logger: undefined,
    enableYtPlayback: true,
    enableYtSearch: true,
  });

  const inputUrl = 'https://www.youtube.com/watch?v=X5kmM98iklo&list=PL19SqEq2HQT3KLFZ-YfvA3m3t-mR5XlC7';
  const expectedPlaylistUrl = 'https://www.youtube.com/playlist?list=PL19SqEq2HQT3KLFZ-YfvA3m3t-mR5XlC7';
  const expectedFallbackWatchUrl = 'https://www.youtube.com/watch?v=X5kmM98iklo';

  const originalResolvePlaylist = player._resolveYouTubePlaylistTracks.bind(player);
  const originalResolveVideo = player._resolveSingleYouTubeTrack.bind(player);

  let playlistCalledWith: string | null = null;
  let fallbackWatchUrl: string | null = null;
  let singleVideoCalled = false;

  player._resolveYouTubePlaylistTracks = async (url: string, requestedBy: string | null | undefined, options: PlaylistResolveOptions = {}) => {
    playlistCalledWith = url;
    fallbackWatchUrl = options.fallbackWatchUrl ?? null;
    return [{
      id: 't1',
      title: 'Playlist Track',
      url: 'https://www.youtube.com/watch?v=track1',
      duration: '3:00',
      requestedBy: requestedBy ?? null,
      source: 'youtube-playlist',
      queuedAt: Date.now(),
      seekStartSec: 0,
    }];
  };
  player._resolveSingleYouTubeTrack = async () => {
    singleVideoCalled = true;
    return [];
  };

  try {
    const tracks = await player.previewTracks(inputUrl, { requestedBy: 'user-1' });
    assert.equal(singleVideoCalled, false);
    assert.equal(playlistCalledWith, expectedPlaylistUrl);
    assert.equal(fallbackWatchUrl, expectedFallbackWatchUrl);
    assert.equal(tracks.length, 1);
    assert.equal(tracks[0]!.title, 'Playlist Track');
  } finally {
    player._resolveYouTubePlaylistTracks = originalResolvePlaylist;
    player._resolveSingleYouTubeTrack = originalResolveVideo;
  }
});

test('watch URL with YouTube radio list keeps watch context for playlist resolution', async () => {
  const player = new MusicPlayer({}, {
    logger: undefined,
    enableYtPlayback: true,
    enableYtSearch: true,
  });

  const inputUrl = 'https://www.youtube.com/watch?v=mnbK4NI4Bdo&list=RDEMOJxofmVkX6mubel8yOeMIQ&start_radio=1';
  const expectedPlaylistUrl = 'https://www.youtube.com/watch?v=mnbK4NI4Bdo&list=RDEMOJxofmVkX6mubel8yOeMIQ';
  const expectedFallbackWatchUrl = 'https://www.youtube.com/watch?v=mnbK4NI4Bdo';

  const originalResolvePlaylist = player._resolveYouTubePlaylistTracks.bind(player);
  const originalResolveVideo = player._resolveSingleYouTubeTrack.bind(player);

  let playlistCalledWith: string | null = null;
  let fallbackWatchUrl: string | null = null;
  let singleVideoCalled = false;

  player._resolveYouTubePlaylistTracks = async (url: string, requestedBy: string | null | undefined, options: PlaylistResolveOptions = {}) => {
    playlistCalledWith = url;
    fallbackWatchUrl = options.fallbackWatchUrl ?? null;
    return [{
      id: 't1',
      title: 'Playlist Track',
      url: 'https://www.youtube.com/watch?v=track1',
      duration: '3:00',
      requestedBy: requestedBy ?? null,
      source: 'youtube-playlist',
      queuedAt: Date.now(),
      seekStartSec: 0,
    }];
  };
  player._resolveSingleYouTubeTrack = async () => {
    singleVideoCalled = true;
    return [];
  };

  try {
    const tracks = await player.previewTracks(inputUrl, { requestedBy: 'user-1' });
    assert.equal(singleVideoCalled, false);
    assert.equal(playlistCalledWith, expectedPlaylistUrl);
    assert.equal(fallbackWatchUrl, expectedFallbackWatchUrl);
    assert.equal(tracks.length, 1);
    assert.equal(tracks[0]!.title, 'Playlist Track');
  } finally {
    player._resolveYouTubePlaylistTracks = originalResolvePlaylist;
    player._resolveSingleYouTubeTrack = originalResolveVideo;
  }
});

test('watch URL with HTML-escaped list parameter is resolved as YouTube playlist', async () => {
  const player = new MusicPlayer({}, {
    logger: undefined,
    enableYtPlayback: true,
    enableYtSearch: true,
  });

  const inputUrl = 'https://www.youtube.com/watch?v=X5kmM98iklo&amp;list=PL19SqEq2HQT3KLFZ-YfvA3m3t-mR5XlC7';
  const expectedPlaylistUrl = 'https://www.youtube.com/playlist?list=PL19SqEq2HQT3KLFZ-YfvA3m3t-mR5XlC7';

  const originalResolvePlaylist = player._resolveYouTubePlaylistTracks.bind(player);
  let playlistCalledWith: string | null = null;

  player._resolveYouTubePlaylistTracks = async (url: string) => {
    playlistCalledWith = url;
    return [];
  };

  try {
    await player.previewTracks(inputUrl, { requestedBy: 'user-1' });
    assert.equal(playlistCalledWith, expectedPlaylistUrl);
  } catch {
    // ignore resolver failure; this test only validates URL classification path.
    assert.equal(playlistCalledWith, expectedPlaylistUrl);
  } finally {
    player._resolveYouTubePlaylistTracks = originalResolvePlaylist;
  }
});

test('music.youtube RD playlist without v infers watch fallback from playlist id', async () => {
  const player = new MusicPlayer({}, {
    logger: undefined,
    enableYtPlayback: true,
    enableYtSearch: true,
  });

  const inputUrl = 'https://music.youtube.com/playlist?list=RDATd1Xa0fqvmdgE&playnext=1&si=dEDVPhJPn_0bWL4G';
  const expectedPlaylistUrl = 'https://www.youtube.com/playlist?list=RDATd1Xa0fqvmdgE';
  const expectedFallbackWatchUrl = 'https://www.youtube.com/watch?v=1Xa0fqvmdgE&list=RDATd1Xa0fqvmdgE';

  const originalResolvePlaylist = player._resolveYouTubePlaylistTracks.bind(player);

  let playlistCalledWith: string | null = null;
  let fallbackWatchUrl: string | null = null;

  player._resolveYouTubePlaylistTracks = async (url: string, requestedBy: string | null | undefined, options: PlaylistResolveOptions = {}) => {
    playlistCalledWith = url;
    fallbackWatchUrl = options.fallbackWatchUrl ?? null;
    return [{
      id: 't1',
      title: 'Playlist Track',
      url: 'https://www.youtube.com/watch?v=track1',
      duration: '3:00',
      requestedBy: requestedBy ?? null,
      source: 'youtube-playlist',
      queuedAt: Date.now(),
      seekStartSec: 0,
    }];
  };

  try {
    const tracks = await player.previewTracks(inputUrl, { requestedBy: 'user-1' });
    assert.equal(playlistCalledWith, expectedPlaylistUrl);
    assert.equal(fallbackWatchUrl, expectedFallbackWatchUrl);
    assert.equal(tracks.length, 1);
  } finally {
    player._resolveYouTubePlaylistTracks = originalResolvePlaylist;
  }
});

test('playlist resolver falls back to inferred watch URL when ytdlp/play-dl fail', async () => {
  const player = new MusicPlayer({}, {
    logger: undefined,
    enableYtPlayback: true,
    enableYtSearch: true,
  });

  const inputUrl = 'https://www.youtube.com/playlist?list=RDATd1Xa0fqvmdgE';
  const expectedWatchUrl = 'https://www.youtube.com/watch?v=1Xa0fqvmdgE&list=RDATd1Xa0fqvmdgE';

  const originalYtDlp = player._resolveYouTubePlaylistTracksViaYtDlp.bind(player);
  const originalPlayDl = player._resolveYouTubePlaylistTracksViaPlayDl.bind(player);
  const originalSingle = player._resolveSingleYouTubeTrack.bind(player);

  let singleCalledWith: string | null = null;

  player._resolveYouTubePlaylistTracksViaYtDlp = async () => {
    throw new Error('yt-dlp unavailable');
  };
  player._resolveYouTubePlaylistTracksViaPlayDl = async () => {
    throw new Error('play-dl unviewable');
  };
  player._resolveSingleYouTubeTrack = async (url: string, requestedBy: string | null | undefined) => {
    singleCalledWith = url;
    return [{
      id: 'single-1',
      title: 'Fallback Track',
      url,
      duration: '3:00',
      requestedBy: requestedBy ?? null,
      source: 'youtube',
      queuedAt: Date.now(),
      seekStartSec: 0,
    }];
  };

  try {
    const tracks = await player._resolveYouTubePlaylistTracks(inputUrl, 'user-1');
    assert.equal(singleCalledWith, expectedWatchUrl);
    assert.equal(tracks.length, 1);
    assert.equal(tracks[0]!.title, 'Fallback Track');
  } finally {
    player._resolveYouTubePlaylistTracksViaYtDlp = originalYtDlp;
    player._resolveYouTubePlaylistTracksViaPlayDl = originalPlayDl;
    player._resolveSingleYouTubeTrack = originalSingle;
  }
});





