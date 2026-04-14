import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import { MusicPlayer } from '../src/player/MusicPlayer.ts';

type VoiceMock = {
  stopCalls: number;
  sendAudio: () => Promise<void>;
  stopAudio: () => void;
};

type FfmpegMock = EventEmitter & {
  stdout: PassThrough;
  kill: () => void;
};

function createVoice() {
  return {
    stopCalls: 0,
    async sendAudio() {},
    stopAudio() {
      this.stopCalls += 1;
    },
  } as VoiceMock;
}

test('play() on empty queue stops voice stream before queueEmpty', async () => {
  const voice = createVoice();
  const player = new MusicPlayer(voice, {});

  let queueEmptyCount = 0;
  player.on('queueEmpty', () => {
    queueEmptyCount += 1;
  });

  await player.play();

  assert.equal(queueEmptyCount, 1);
  assert.equal(voice.stopCalls, 1);
});

test('_handleTrackClose with empty queue stops voice stream and emits queueEmpty', async () => {
  const voice = createVoice();
  const player = new MusicPlayer(voice, {});
  const track = player._buildTrack({
    title: 'Track',
    url: 'https://example.com/audio',
    duration: '03:00',
    source: 'url',
    requestedBy: 'user-1',
  });

  player.queue.current = track;
  player.playing = true;
  player.skipRequested = false;

  let queueEmptyCount = 0;
  player.on('queueEmpty', () => {
    queueEmptyCount += 1;
  });

  await player._handleTrackClose(track, 0, null);

  assert.equal(queueEmptyCount, 1);
  assert.equal(voice.stopCalls, 1);
});

test('play() reports a startup pipeline close as trackError instead of queueEmpty', async () => {
  const voice = createVoice();
  const player = new MusicPlayer(voice, {});
  const ffmpeg = new EventEmitter() as FfmpegMock;
  ffmpeg.stdout = new PassThrough();
  ffmpeg.kill = () => {};

  player._startPlayDlPipeline = async () => {
    player.ffmpeg = ffmpeg;
  };

  let queueEmptyEvent: { reason?: string } | null = null;
  let trackError: Error | null = null;
  player.on('queueEmpty', (event: { reason?: string }) => {
    queueEmptyEvent = event;
  });
  player.on('trackError', ({ error }: { error: Error }) => {
    trackError = error;
  });

  player.enqueueResolvedTracks([
    player._buildTrack({
      title: 'Broken startup track',
      url: 'https://example.com/audio',
      duration: '03:00',
      source: 'url',
      requestedBy: 'user-1',
    }),
  ]);

  const playPromise = player.play();
  setImmediate(() => {
    ffmpeg.emit('close', 1, null);
  });
  await playPromise;

  assert.equal((queueEmptyEvent as { reason?: string } | null)?.reason, 'startup_error');
  assert.match(String((trackError as Error | null)?.message ?? ''), /before audio output/i);
});

test('play() increases initial playback timeout for large seek offsets', async () => {
  const voice = createVoice();
  const player = new MusicPlayer(voice, {});
  let startupTimeoutMs: number | null = null;

  player._startYouTubePipeline = async () => {
    player.ffmpeg = {
      stdout: {
        pipe() {},
      },
      once() {},
    };
  };
  player._awaitInitialPlaybackChunk = async (_stream: unknown, _proc: unknown, timeoutMs: number) => {
    startupTimeoutMs = timeoutMs;
  };

  player.enqueueResolvedTracks([
    player._buildTrack({
      title: 'Long seek track',
      url: 'https://www.youtube.com/watch?v=OBoMLZTtqb8',
      duration: '2:00:00',
      source: 'youtube',
      requestedBy: 'user-1',
      seekStartSec: 5340,
    }),
  ]);

  await player.play();

  assert.equal(startupTimeoutMs, 60_000);
});

test('play() retries a pre-audio YouTube pipeline exit with yt-dlp url fallback', async () => {
  const voice = createVoice();
  const player = new MusicPlayer(voice, {});
  const startedPipelines: string[] = [];
  let initialChunkAttempts = 0;
  let trackErrorCount = 0;

  player._scheduleNextTrackPrefetch = () => {};
  const installFfmpeg = () => {
    player.ffmpeg = {
      stdout: {
        pipe() {},
      },
      once() {},
      stderr: new PassThrough(),
    } as unknown as typeof player.ffmpeg;
  };
  player._startYouTubePipeline = async () => {
    startedPipelines.push('youtube');
    installFfmpeg();
  };
  player._startYtDlpSeekPipeline = async () => {
    startedPipelines.push('ytdlp-url');
    installFfmpeg();
  };
  player._awaitInitialPlaybackChunk = async () => {
    initialChunkAttempts += 1;
    if (initialChunkAttempts === 1) {
      throw new Error('Playback pipeline exited before audio output (code=1). pipe:0: Invalid data found when processing input');
    }
  };

  player.enqueueResolvedTracks([
    player._buildTrack({
      title: 'Fallback Track',
      url: 'https://www.youtube.com/watch?v=abcdefghijk',
      duration: '03:00',
      source: 'youtube-playlist-ytdlp',
      requestedBy: 'user-1',
    }),
  ]);

  await player.play();

  assert.deepEqual(startedPipelines, ['youtube', 'ytdlp-url']);
  assert.equal(initialChunkAttempts, 2);
  assert.equal(trackErrorCount, 0);
  assert.equal(player.currentTrack?.title, 'Fallback Track');
  assert.equal(player.consecutiveStartupFailures, 0);
});

test('play() retries a pre-audio YouTube pipeline exit with yt-dlp proxy pipe fallback', async () => {
  const voice = createVoice();
  const player = new MusicPlayer(voice, { ytdlpProxyUrl: 'http://proxy.example:8080' });
  const startedPipelines: Array<{ name: string; proxyOnly?: boolean }> = [];
  let initialChunkAttempts = 0;
  let trackErrorCount = 0;

  player._scheduleNextTrackPrefetch = () => {};
  const installFfmpeg = () => {
    player.ffmpeg = {
      stdout: {
        pipe() {},
      },
      once() {},
      stderr: new PassThrough(),
    } as unknown as typeof player.ffmpeg;
  };
  player._startYouTubePipeline = async () => {
    startedPipelines.push({ name: 'youtube' });
    player._lastYtDlpDiagnostics = { proxyEnabled: false };
    installFfmpeg();
  };
  player._startYtDlpPipeline = async (_url: string, _seekSec = 0, options = {}) => {
    startedPipelines.push({ name: 'ytdlp-pipe', ...(options.proxyOnly != null ? { proxyOnly: options.proxyOnly } : {}) });
    installFfmpeg();
  };
  player._awaitInitialPlaybackChunk = async () => {
    initialChunkAttempts += 1;
    if (initialChunkAttempts === 1) {
      throw new Error('Playback pipeline exited before audio output (code=1). pipe:0: Invalid data found when processing input');
    }
  };
  player.on('trackError', () => {
    trackErrorCount += 1;
  });

  player.enqueueResolvedTracks([
    player._buildTrack({
      title: 'Proxy Fallback Track',
      url: 'https://www.youtube.com/watch?v=abcdefghijk',
      duration: '03:00',
      source: 'youtube',
      requestedBy: 'user-1',
    }),
  ]);

  await player.play();

  assert.deepEqual(startedPipelines, [
    { name: 'youtube' },
    { name: 'ytdlp-pipe', proxyOnly: true },
  ]);
  assert.equal(initialChunkAttempts, 2);
  assert.equal(trackErrorCount, 0);
  assert.equal(player.currentTrack?.title, 'Proxy Fallback Track');
});

test('play() retries a skipped YouTube startup timeout with yt-dlp proxy pipe fallback', async () => {
  const voice = createVoice();
  const player = new MusicPlayer(voice, { ytdlpProxyUrl: 'http://proxy.example:8080' });
  const startedPipelines: Array<{ name: string; proxyOnly?: boolean }> = [];
  let initialChunkAttempts = 0;
  let trackErrorCount = 0;

  player.nextPlaybackStartupHint = 'skip';
  player._scheduleNextTrackPrefetch = () => {};
  const installFfmpeg = () => {
    player.ffmpeg = {
      stdout: {
        pipe() {},
      },
      once() {},
      stderr: new PassThrough(),
    } as unknown as typeof player.ffmpeg;
  };
  player._startYouTubePipeline = async () => {
    startedPipelines.push({ name: 'youtube' });
    player._lastYtDlpDiagnostics = { proxyEnabled: false };
    installFfmpeg();
  };
  player._startYtDlpPipeline = async (_url: string, _seekSec = 0, options = {}) => {
    startedPipelines.push({ name: 'ytdlp-pipe', ...(options.proxyOnly != null ? { proxyOnly: options.proxyOnly } : {}) });
    installFfmpeg();
  };
  player._awaitInitialPlaybackChunk = async () => {
    initialChunkAttempts += 1;
    if (initialChunkAttempts === 1) {
      throw new Error('Playback pipeline did not produce audio output in time.');
    }
  };
  player.on('trackError', () => {
    trackErrorCount += 1;
  });

  player.enqueueResolvedTracks([
    player._buildTrack({
      title: 'Proxy Timeout Fallback Track',
      url: 'https://www.youtube.com/watch?v=abcdefghijk',
      duration: '03:00',
      source: 'youtube',
      requestedBy: 'user-1',
    }),
  ]);

  await player.play();

  assert.deepEqual(startedPipelines, [
    { name: 'youtube' },
    { name: 'ytdlp-pipe', proxyOnly: true },
  ]);
  assert.equal(initialChunkAttempts, 2);
  assert.equal(trackErrorCount, 0);
  assert.equal(player.currentTrack?.title, 'Proxy Timeout Fallback Track');
});

test('play() halts queue drain after repeated startup failures', async () => {
  const voice = createVoice();
  const player = new MusicPlayer(voice, {});
  const attemptedTracks: string[] = [];
  const queueEmptyEvents: Array<{ reason?: string; droppedTracks?: number }> = [];
  let trackErrorCount = 0;

  let activeFfmpeg: FfmpegMock | null = null;
  const emitActiveClose = () => {
    assert.ok(activeFfmpeg);
    activeFfmpeg.emit('close', 1, null);
  };
  player._startHttpUrlPipeline = async (url: string) => {
    attemptedTracks.push(url);
    const ffmpeg = new EventEmitter() as FfmpegMock;
    ffmpeg.stdout = new PassThrough();
    ffmpeg.kill = () => {};
    player.ffmpeg = ffmpeg;
    activeFfmpeg = ffmpeg;
  };

  player.on('trackError', () => {
    trackErrorCount += 1;
  });
  player.on('queueEmpty', (event: { reason?: string; droppedTracks?: number }) => {
    queueEmptyEvents.push(event);
  });

  player.enqueueResolvedTracks([
    player._buildTrack({ title: 'Track 1', url: 'https://example.com/1', duration: '03:00', source: 'url', requestedBy: 'u' }),
    player._buildTrack({ title: 'Track 2', url: 'https://example.com/2', duration: '03:00', source: 'url', requestedBy: 'u' }),
    player._buildTrack({ title: 'Track 3', url: 'https://example.com/3', duration: '03:00', source: 'url', requestedBy: 'u' }),
    player._buildTrack({ title: 'Track 4', url: 'https://example.com/4', duration: '03:00', source: 'url', requestedBy: 'u' }),
  ]);

  const playPromise = player.play();
  await new Promise((resolve) => setImmediate(resolve));
  emitActiveClose();
  await new Promise((resolve) => setImmediate(resolve));
  emitActiveClose();
  await new Promise((resolve) => setImmediate(resolve));
  emitActiveClose();
  await playPromise;

  assert.equal(trackErrorCount, 3);
  assert.deepEqual(attemptedTracks, [
    'https://example.com/1',
    'https://example.com/2',
    'https://example.com/3',
  ]);
  assert.equal(queueEmptyEvents.at(-1)?.reason, 'startup_error_limit');
  assert.equal(queueEmptyEvents.at(-1)?.droppedTracks, 1);
  assert.equal(player.pendingTracks.length, 0);
});

test('stop() removes runtime yt-dlp cookies file and allows recreating it later', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'fluxer-cookies-test-'));
  const sourcePath = join(tempDir, 'cookies.txt');
  writeFileSync(sourcePath, '# Netscape HTTP Cookie File\n');

  try {
    const player = new MusicPlayer(createVoice(), { ytdlpCookiesFile: sourcePath, logger: null });
    const runtimePath = player.ytdlpCookiesFile;

    assert.ok(runtimePath);
    assert.notEqual(runtimePath, sourcePath);
    assert.equal(existsSync(String(runtimePath)), true);

    player.stop();

    assert.equal(existsSync(String(runtimePath)), false);
    assert.equal(player.ytdlpCookiesFile, sourcePath);

    const recreatedRuntimePath = player._getActiveYtDlpCookiesFile();
    assert.ok(recreatedRuntimePath);
    assert.notEqual(recreatedRuntimePath, sourcePath);
    assert.equal(existsSync(String(recreatedRuntimePath)), true);

    player.stop();
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('seekTo rejects positions at or beyond the current track length', () => {
  const voice = createVoice();
  const player = new MusicPlayer(voice, {});

  player.playing = true;
  player.queue.current = player._buildTrack({
    title: 'Bounded Track',
    url: 'https://www.youtube.com/watch?v=OBoMLZTtqb8',
    duration: '47:00',
    source: 'youtube',
    requestedBy: 'user-1',
  });

  assert.throws(() => {
    player.seekTo(47 * 60);
  }, /exceeds track length/i);
});

test('skip() advances to the next queued track immediately after cleanup', async () => {
  const voice = createVoice();
  const player = new MusicPlayer(voice, {});
  const currentTrack = player._buildTrack({
    title: 'Current Track',
    url: 'https://example.com/current',
    duration: '03:00',
    source: 'url',
    requestedBy: 'user-1',
  });
  const nextTrack = player._buildTrack({
    title: 'Next Track',
    url: 'https://example.com/next',
    duration: '02:30',
    source: 'url',
    requestedBy: 'user-1',
  });

  const staleFfmpeg = new EventEmitter() as FfmpegMock;
  staleFfmpeg.stdout = new PassThrough();
  staleFfmpeg.kill = () => {};

  const startedUrls: string[] = [];
  player.queue.current = currentTrack;
  player.queue.add(nextTrack);
  player.playing = true;
  player.trackStartedAtMs = Date.now() - 1_000;
  player.ffmpeg = staleFfmpeg;
  player._startHttpUrlPipeline = async (url: string) => {
    startedUrls.push(url);
    player.ffmpeg = {
      stdout: new PassThrough(),
      once() {},
      stderr: new PassThrough(),
    } as unknown as typeof player.ffmpeg;
  };
  player._awaitInitialPlaybackChunk = async () => {};

  assert.equal(player.skip(), true);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(startedUrls, ['https://example.com/next']);
  assert.equal(player.currentTrack?.title, 'Next Track');
});

test('play() uses a more tolerant YouTube startup timeout for the next track after a skip transition', async () => {
  const voice = createVoice();
  const player = new MusicPlayer(voice, {});
  let startupTimeoutMs: number | null = null;

  player.nextPlaybackStartupHint = 'skip';
  player._startYouTubePipeline = async () => {
    player.ffmpeg = {
      stdout: {
        pipe() {},
      },
      once() {},
      stderr: new PassThrough(),
    } as unknown as typeof player.ffmpeg;
  };
  player._awaitInitialPlaybackChunk = async (_stream: unknown, _proc: unknown, timeoutMs: number) => {
    startupTimeoutMs = timeoutMs;
  };

  player.enqueueResolvedTracks([
    player._buildTrack({
      title: 'Skipped To Track',
      url: 'https://www.youtube.com/watch?v=QX_VR_Wshvk',
      duration: '03:00',
      source: 'youtube',
      requestedBy: 'user-1',
    }),
  ]);

  await player.play();

  assert.equal(startupTimeoutMs, 10_000);
});

test('play() retries a skipped-to YouTube track once with a longer startup timeout after an initial audio timeout', async () => {
  const voice = createVoice();
  const player = new MusicPlayer(voice, {});
  const startupTimeouts: number[] = [];
  let youtubePipelineStarts = 0;
  let trackErrorCount = 0;
  let queueEmptyCount = 0;

  player.nextPlaybackStartupHint = 'skip';
  player._startYouTubePipeline = async () => {
    youtubePipelineStarts += 1;
    player.ffmpeg = {
      stdout: {
        pipe() {},
      },
      once() {},
      stderr: new PassThrough(),
    } as unknown as typeof player.ffmpeg;
  };
  player._awaitInitialPlaybackChunk = async (_stream: unknown, _proc: unknown, timeoutMs: number) => {
    startupTimeouts.push(timeoutMs);
    if (startupTimeouts.length === 1) {
      throw new Error('Playback pipeline did not produce audio output in time.');
    }
  };

  player.on('trackError', () => {
    trackErrorCount += 1;
  });
  player.on('queueEmpty', () => {
    queueEmptyCount += 1;
  });

  player.enqueueResolvedTracks([
    player._buildTrack({
      title: 'Retry Track',
      url: 'https://www.youtube.com/watch?v=QX_VR_Wshvk',
      duration: '03:00',
      source: 'youtube',
      requestedBy: 'user-1',
    }),
  ]);

  await player.play();

  assert.deepEqual(startupTimeouts, [10_000, 22_000]);
  assert.equal(youtubePipelineStarts, 2);
  assert.equal(trackErrorCount, 0);
  assert.equal(queueEmptyCount, 0);
  assert.equal(player.currentTrack?.title, 'Retry Track');
});

test('play() ignores a prefetched YouTube stream URL by default and uses yt-dlp startup instead', async () => {
  const voice = createVoice();
  const player = new MusicPlayer(voice, {});
  let startedUrl: string | null = null;
  let youtubePipelineStarts = 0;

  player._scheduleNextTrackPrefetch = () => {};
  player._startHttpUrlPipeline = async (url: string) => {
    startedUrl = url;
    player.ffmpeg = {
      stdout: {
        pipe() {},
      },
      once() {},
      stderr: new PassThrough(),
    } as unknown as typeof player.ffmpeg;
  };
  player._awaitInitialPlaybackChunk = async () => {};
  player._startYouTubePipeline = async () => {
    youtubePipelineStarts += 1;
    player.ffmpeg = {
      stdout: {
        pipe() {},
      },
      once() {},
      stderr: new PassThrough(),
    } as unknown as typeof player.ffmpeg;
  };

  player.enqueueResolvedTracks([
    player._buildTrack({
      title: 'Prefetched Track',
      url: 'https://www.youtube.com/watch?v=abcdefghijk',
      duration: '03:00',
      source: 'youtube',
      requestedBy: 'user-1',
    }),
  ]);

  const queuedTrack = player.pendingTracks[0] ?? null;
  const prefetchKey = player._getTrackPrefetchKey(queuedTrack);
  assert.ok(prefetchKey);
  player.nextTrackPrefetchState = {
    key: String(prefetchKey),
    streamUrl: 'https://stream.example.com/audio',
    proxyUrl: null,
    createdAtMs: Date.now(),
  };

  await player.play();

  assert.equal(startedUrl, null);
  assert.equal(youtubePipelineStarts, 1);
});

test('play() uses a prefetched YouTube stream URL for skip transitions even when general prefetched playback is disabled', async () => {
  const voice = createVoice();
  const player = new MusicPlayer(voice, {});
  let startedUrl: string | null = null;
  let youtubePipelineStarts = 0;

  player.nextPlaybackStartupHint = 'skip';
  player._scheduleNextTrackPrefetch = () => {};
  player._startHttpUrlPipeline = async (url: string) => {
    startedUrl = url;
    player.ffmpeg = {
      stdout: {
        pipe() {},
      },
      once() {},
      stderr: new PassThrough(),
    } as unknown as typeof player.ffmpeg;
  };
  player._awaitInitialPlaybackChunk = async () => {};
  player._startYouTubePipeline = async () => {
    youtubePipelineStarts += 1;
    player.ffmpeg = {
      stdout: {
        pipe() {},
      },
      once() {},
      stderr: new PassThrough(),
    } as unknown as typeof player.ffmpeg;
  };

  player.enqueueResolvedTracks([
    player._buildTrack({
      title: 'Skip Prefetched Track',
      url: 'https://www.youtube.com/watch?v=abcdefghijk',
      duration: '03:00',
      source: 'youtube',
      requestedBy: 'user-1',
    }),
  ]);

  const queuedTrack = player.pendingTracks[0] ?? null;
  const prefetchKey = player._getTrackPrefetchKey(queuedTrack);
  assert.ok(prefetchKey);
  player.nextTrackPrefetchState = {
    key: String(prefetchKey),
    streamUrl: 'https://stream.example.com/skip-audio',
    proxyUrl: null,
    createdAtMs: Date.now(),
  };

  await player.play();

  assert.equal(startedUrl, 'https://stream.example.com/skip-audio');
  assert.equal(youtubePipelineStarts, 0);
});

test('play() uses a prefetched YouTube stream URL when prefetched playback is enabled', async () => {
  const voice = createVoice();
  const player = new MusicPlayer(voice, { enableYouTubePrefetchedPlayback: true });
  let startedUrl: string | null = null;

  player._scheduleNextTrackPrefetch = () => {};
  player._startHttpUrlPipeline = async (url: string) => {
    startedUrl = url;
    player.ffmpeg = {
      stdout: {
        pipe() {},
      },
      once() {},
      stderr: new PassThrough(),
    } as unknown as typeof player.ffmpeg;
  };
  player._awaitInitialPlaybackChunk = async () => {};
  player._startYouTubePipeline = async () => {
    throw new Error('Expected prefetched stream URL to bypass yt-dlp startup.');
  };

  player.enqueueResolvedTracks([
    player._buildTrack({
      title: 'Prefetched Track',
      url: 'https://www.youtube.com/watch?v=abcdefghijk',
      duration: '03:00',
      source: 'youtube',
      requestedBy: 'user-1',
    }),
  ]);

  const queuedTrack = player.pendingTracks[0] ?? null;
  const prefetchKey = player._getTrackPrefetchKey(queuedTrack);
  assert.ok(prefetchKey);
  player.nextTrackPrefetchState = {
    key: String(prefetchKey),
    streamUrl: 'https://stream.example.com/audio',
    proxyUrl: null,
    createdAtMs: Date.now(),
  };

  await player.play();

  assert.equal(startedUrl, 'https://stream.example.com/audio');
});

test('play() preserves the proxy for prefetched YouTube stream URLs', async () => {
  const voice = createVoice();
  const player = new MusicPlayer(voice, { enableYouTubePrefetchedPlayback: true });
  let startedUrl: string | null = null;
  let startedProxyUrl: string | null = null;

  player._scheduleNextTrackPrefetch = () => {};
  player._startHttpUrlPipeline = async (url: string, _seekSec = 0, options = {}) => {
    startedUrl = url;
    startedProxyUrl = String(options.proxyUrl ?? '').trim() || null;
    player.ffmpeg = {
      stdout: {
        pipe() {},
      },
      once() {},
      stderr: new PassThrough(),
    } as unknown as typeof player.ffmpeg;
  };
  player._awaitInitialPlaybackChunk = async () => {};
  player._startYouTubePipeline = async () => {
    throw new Error('Expected prefetched stream URL to bypass yt-dlp startup.');
  };

  player.enqueueResolvedTracks([
    player._buildTrack({
      title: 'Prefetched Proxy Track',
      url: 'https://www.youtube.com/watch?v=abcdefghijk',
      duration: '03:00',
      source: 'youtube',
      requestedBy: 'user-1',
    }),
  ]);

  const queuedTrack = player.pendingTracks[0] ?? null;
  const prefetchKey = player._getTrackPrefetchKey(queuedTrack);
  assert.ok(prefetchKey);
  player.nextTrackPrefetchState = {
    key: String(prefetchKey),
    streamUrl: 'https://stream.example.com/proxy-audio',
    proxyUrl: 'http://proxy.example:8080',
    createdAtMs: Date.now(),
  };

  await player.play();

  assert.equal(startedUrl, 'https://stream.example.com/proxy-audio');
  assert.equal(startedProxyUrl, 'http://proxy.example:8080');
});





