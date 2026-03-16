import { ValidationError } from '../../core/errors.js';
import {
  isConnectionRefusedError,
  isYtDlpModuleMissingError,
  isYouTubeBotCheckError,
} from './errorUtils.js';

export function cleanupProcesses(player) {
  const sourceProc = player.sourceProc;
  const ffmpeg = player.ffmpeg;

  try {
    if (ffmpeg?.stdout && player.liveAudioProcessor) {
      ffmpeg.stdout.unpipe(player.liveAudioProcessor);
    }
  } catch {}

  try {
    if (sourceProc?.stdout && ffmpeg?.stdin) {
      sourceProc.stdout.unpipe(ffmpeg.stdin);
    }
  } catch {}

  try {
    if (player.sourceStream && ffmpeg?.stdin) {
      player.sourceStream.unpipe(ffmpeg.stdin);
    }
  } catch {}

  try {
    if (player.sourceStream && player.deezerDecryptStream) {
      player.sourceStream.unpipe(player.deezerDecryptStream);
    }
  } catch {}

  try {
    if (player.deezerDecryptStream && ffmpeg?.stdin) {
      player.deezerDecryptStream.unpipe(ffmpeg.stdin);
    }
  } catch {}

  try {
    player.liveAudioProcessor?.destroy?.();
  } catch {}
  player.liveAudioProcessor = null;

  try {
    player.deezerDecryptStream?.destroy?.();
  } catch {}
  player.deezerDecryptStream = null;

  try {
    player.sourceStream?.destroy?.();
  } catch {}
  player.sourceStream = null;

  try {
    sourceProc?.stdout?.destroy?.();
  } catch {}
  try {
    sourceProc?.stderr?.destroy?.();
  } catch {}
  try {
    sourceProc?.stdin?.destroy?.();
  } catch {}

  sourceProc?.kill?.('SIGKILL');
  player.sourceProc = null;

  try {
    ffmpeg?.stdin?.destroy?.();
  } catch {}
  try {
    ffmpeg?.stdout?.destroy?.();
  } catch {}
  try {
    ffmpeg?.stderr?.destroy?.();
  } catch {}

  ffmpeg?.kill?.('SIGKILL');
  player.ffmpeg = null;
  clearPipelineErrorHandlers(player);
}

export function clearPipelineState(player) {
  clearPipelineErrorHandlers(player);
  player.liveAudioProcessor = null;
  player.deezerDecryptStream = null;
  player.sourceStream = null;
}

export function stopVoiceStream(player) {
  const stopAudio = player.voice?.stopAudio;
  if (typeof stopAudio !== 'function') return;
  try {
    stopAudio.call(player.voice);
  } catch {}
}

export function clearPipelineErrorHandlers(player) {
  for (const unbind of player.pipelineErrorHandlers) {
    try {
      unbind();
    } catch {}
  }
  player.pipelineErrorHandlers = [];
}

export function bindPipelineErrorHandler(player, stream, label) {
  if (!stream?.on || !stream?.off) return;

  const onError = (err) => {
    if (isExpectedPipeError(err)) {
      player.logger?.debug?.('Ignoring expected pipeline error', {
        label,
        code: err?.code ?? null,
      });
      return;
    }

    player.logger?.warn?.('Pipeline stream error', {
      label,
      code: err?.code ?? null,
      error: err instanceof Error ? err.message : String(err),
    });
  };

  stream.on('error', onError);
  player.pipelineErrorHandlers.push(() => {
    stream.off('error', onError);
  });
}

export function isExpectedPipeError(err) {
  const code = err?.code;
  return code === 'EPIPE' || code === 'ERR_STREAM_DESTROYED' || code === 'ECONNRESET';
}

export function startPlaybackClock(player, offsetSec) {
  player.currentTrackOffsetSec = Math.max(0, Number.parseInt(String(offsetSec), 10) || 0);
  player.trackStartedAtMs = Date.now();
  player.pauseStartedAtMs = null;
  player.totalPausedMs = 0;
}

export function resetPlaybackClock(player) {
  player.trackStartedAtMs = null;
  player.pauseStartedAtMs = null;
  player.totalPausedMs = 0;
  player.currentTrackOffsetSec = 0;
}

export function normalizePlaybackError(player, err) {
  if (err?.code === 'ENOENT' && (err?.path === player.ffmpegBin || err?.path === 'ffmpeg')) {
    return new Error('FFmpeg is not available. Install ffmpeg or set FFMPEG_BIN.');
  }
  if (err?.code === 'ENOENT' && /yt[_-]?dlp/i.test(String(err?.path ?? ''))) {
    return new Error('yt-dlp is not available. Install yt-dlp or set YTDLP_BIN.');
  }
  if (isYtDlpModuleMissingError(err)) {
    return new Error('yt-dlp is missing. Install the standalone `yt-dlp` binary or set YTDLP_BIN to its path.');
  }
  if (isConnectionRefusedError(err)) {
    return new Error('Network connection refused during media fetch. Check proxy env vars (HTTP_PROXY/HTTPS_PROXY/ALL_PROXY) and remove localhost:9 mappings.');
  }
  if (isYouTubeBotCheckError(err)) {
    return new Error('YouTube requested bot verification. Configure YTDLP_COOKIES_FILE or YTDLP_COOKIES_FROM_BROWSER and update yt-dlp.');
  }

  if (err instanceof ValidationError) return err;
  if (err instanceof Error) return err;
  return new Error(String(err));
}
