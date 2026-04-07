import { ValidationError } from '../../core/errors.ts';
import {
  isConnectionRefusedError,
  isYtDlpModuleMissingError,
  isYouTubeBotCheckError,
} from './errorUtils.ts';
import type { MusicPlayer } from '../MusicPlayer.ts';

type ProcessUtilsPlayer = MusicPlayer & {
  pipelineErrorHandlers: unknown[];
};
type ErrorAwareStream = {
  on?: (event: string, listener: (err: unknown) => void) => unknown;
  off?: (event: string, listener: (err: unknown) => void) => unknown;
} | null | undefined;

export function cleanupProcesses(player: ProcessUtilsPlayer) {
  const sourceProc = player.sourceProc;
  const ffmpeg = player.ffmpeg;

  try {
    if (ffmpeg?.stdout && player.liveAudioProcessor) {
      ffmpeg.stdout.unpipe?.(player.liveAudioProcessor as unknown as NodeJS.WritableStream);
    }
  } catch {}

  try {
    if (ffmpeg?.stdout && player.playbackOutputStream) {
      ffmpeg.stdout.unpipe?.(player.playbackOutputStream as unknown as NodeJS.WritableStream);
    }
  } catch {}

  try {
    if (player.liveAudioProcessor && player.playbackOutputStream) {
      player.liveAudioProcessor.unpipe?.(player.playbackOutputStream as unknown as NodeJS.WritableStream);
    }
  } catch {}

  try {
    if (sourceProc?.stdout && ffmpeg?.stdin) {
      sourceProc.stdout.unpipe?.(ffmpeg.stdin as unknown as NodeJS.WritableStream);
    }
  } catch {}

  try {
    if (player.sourceStream && ffmpeg?.stdin) {
      player.sourceStream.unpipe?.(ffmpeg.stdin as unknown as NodeJS.WritableStream);
    }
  } catch {}

  try {
    if (player.sourceStream && player.deezerDecryptStream) {
      player.sourceStream.unpipe?.(player.deezerDecryptStream as unknown as NodeJS.WritableStream);
    }
  } catch {}

  try {
    if (player.deezerDecryptStream && ffmpeg?.stdin) {
      player.deezerDecryptStream.unpipe?.(ffmpeg.stdin as unknown as NodeJS.WritableStream);
    }
  } catch {}

  try {
    player.liveAudioProcessor?.destroy?.();
  } catch {}
  player.liveAudioProcessor = null;

  try {
    player.playbackOutputStream?.destroy?.();
  } catch {}
  player.playbackOutputStream = null;

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
  player.activeSourceProcessCloseInfo = null;
  clearPipelineErrorHandlers(player);
}

export function clearPipelineState(player: ProcessUtilsPlayer) {
  clearPipelineErrorHandlers(player);
  player.liveAudioProcessor = null;
  player.playbackOutputStream = null;
  player.deezerDecryptStream = null;
  player.sourceStream = null;
  player.activeSourceProcessCloseInfo = null;
}

export function stopVoiceStream(player: ProcessUtilsPlayer) {
  const stopAudio = (player.voice as { stopAudio?: () => unknown } | null | undefined)?.stopAudio;
  if (typeof stopAudio !== 'function') return;
  try {
    stopAudio.call(player.voice);
  } catch {}
}

export function clearPipelineErrorHandlers(player: ProcessUtilsPlayer) {
  for (const unbind of player.pipelineErrorHandlers) {
    if (typeof unbind !== 'function') continue;
    try {
      unbind();
    } catch {}
  }
  player.pipelineErrorHandlers = [];
}

export function bindPipelineErrorHandler(player: ProcessUtilsPlayer, stream: unknown, label: string) {
  const targetStream = stream as ErrorAwareStream;
  if (!targetStream?.on || !targetStream?.off) return;

  const onError = (err: unknown) => {
    if (isExpectedPipeError(err)) {
      player.logger?.debug?.('Ignoring expected pipeline error', {
        label,
        code: err instanceof Error && 'code' in err ? (err as { code?: unknown }).code ?? null : null,
      });
      return;
    }

    player.logger?.warn?.('Pipeline stream error', {
      label,
      code: err instanceof Error && 'code' in err ? (err as { code?: unknown }).code ?? null : null,
      error: err instanceof Error ? err.message : String(err),
    });
  };

  targetStream.on('error', onError);
  player.pipelineErrorHandlers.push(() => {
    targetStream.off?.('error', onError);
  });
}

export function isExpectedPipeError(err: unknown) {
  const code = err && typeof err === 'object' && 'code' in err ? (err as { code?: unknown }).code : undefined;
  return code === 'EPIPE' || code === 'ERR_STREAM_DESTROYED' || code === 'ECONNRESET';
}

export function startPlaybackClock(player: ProcessUtilsPlayer, offsetSec: unknown) {
  player.currentTrackOffsetSec = Math.max(0, Number.parseInt(String(offsetSec), 10) || 0);
  player.trackStartedAtMs = Date.now();
  player.pauseStartedAtMs = null;
  player.totalPausedMs = 0;
}

export function resetPlaybackClock(player: ProcessUtilsPlayer) {
  player.trackStartedAtMs = null;
  player.pauseStartedAtMs = null;
  player.totalPausedMs = 0;
  player.currentTrackOffsetSec = 0;
}

export function normalizePlaybackError(player: ProcessUtilsPlayer, err: unknown) {
  const errno = err && typeof err === 'object' ? err as { code?: unknown; path?: unknown } : null;
  if (errno?.code === 'ENOENT' && (errno.path === player.ffmpegBin || errno.path === 'ffmpeg')) {
    return new Error('FFmpeg is not available. Install ffmpeg or set FFMPEG_BIN.');
  }
  if (errno?.code === 'ENOENT' && /yt[_-]?dlp/i.test(String(errno.path ?? ''))) {
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


