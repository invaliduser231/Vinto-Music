import { ValidationError } from '../../core/errors.ts';
import { LOOP_QUEUE, LOOP_TRACK } from './constants.ts';
import { isHttpUrl, isYouTubeUrl } from './trackUtils.ts';
import type { MusicPlayer } from '../MusicPlayer.ts';
import type { Track } from '../../types/domain.ts';

type QueueLifecycleMethods = {
  clearQueue(): number;
  shuffleQueue(): number;
  removeFromQueue(index: number): unknown;
  getLastHistoryTrack(): Track | null;
  replayCurrentTrack(): boolean;
  refreshCurrentTrackProcessing(): boolean;
  getTotalPendingDurationSeconds(): number;
  queuePreviousTrack(): Track | null;
  canSeekCurrentTrack(): boolean;
  seekTo(seconds: unknown): number;
  pause(): boolean;
  resume(): boolean;
  _setPipelinePaused(paused: unknown): boolean;
  skip(): boolean;
  stop(): void;
  _handleTrackClose(track: Track, code: unknown, signal: unknown, playbackToken?: number | null): Promise<void>;
};
type QueueLifecycleRuntime = MusicPlayer & QueueLifecycleMethods & {
  getProgressSeconds(): number;
};

export const queueLifecycleMethods: QueueLifecycleMethods & ThisType<QueueLifecycleRuntime> = {
  clearQueue(this: QueueLifecycleRuntime) {
    const removed = this.queue.pendingSize;
    this.queue.tracks = [];
    return removed;
  },

  shuffleQueue(this: QueueLifecycleRuntime) {
    this.queue.shuffle();
    return this.queue.pendingSize;
  },

  removeFromQueue(this: QueueLifecycleRuntime, index) {
    return this.queue.remove(index);
  },

  getLastHistoryTrack(this: QueueLifecycleRuntime) {
    if (!this.trackHistory.length) return null;
    return this.trackHistory[this.trackHistory.length - 1] ?? null;
  },

  replayCurrentTrack(this: QueueLifecycleRuntime) {
    if (!this.currentTrack || !this.playing) return false;
    this.pendingSeekTrack = this._cloneTrack(this.currentTrack, { seekStartSec: 0 });
    this._invalidatePlaybackStartup();
    this.skipRequested = true;
    this._stopVoiceStream();
    this._cleanupProcesses();
    return true;
  },

  refreshCurrentTrackProcessing(this: QueueLifecycleRuntime) {
    if (!this.playing || !this.currentTrack) return false;
    const seekStartSec = this.canSeekCurrentTrack()
      ? this.getProgressSeconds()
      : 0;
    this.pendingSeekTrack = this._cloneTrack(this.currentTrack, { seekStartSec });
    this._invalidatePlaybackStartup();
    this.skipRequested = true;
    this._stopVoiceStream();
    this._cleanupProcesses();
    return true;
  },

  getTotalPendingDurationSeconds(this: QueueLifecycleRuntime) {
    let total = 0;
    for (const track of this.pendingTracks) {
      const parsed = this._parseDurationSeconds(track.duration);
      if (parsed == null) continue;
      total += parsed;
    }
    return total;
  },

  queuePreviousTrack(this: QueueLifecycleRuntime) {
    const previous = this.getLastHistoryTrack();
    if (!previous) return null;

    const clone = this._cloneTrack(previous);
    this.queue.addFront(clone);
    this.emit('tracksAdded', [clone]);
    return clone;
  },

  canSeekCurrentTrack(this: QueueLifecycleRuntime) {
    if (!this.currentTrack) return false;
    if (this.currentTrack.isLive) return false;
    if (isYouTubeUrl(this.currentTrack.url)) return true;
    return isHttpUrl(this.currentTrack.url) && (
      String(this.currentTrack.source ?? '') === 'http-audio'
      || String(this.currentTrack.source ?? '') === 'url'
    );
  },

  seekTo(this: QueueLifecycleRuntime, seconds) {
    if (!this.playing || !this.currentTrack) {
      throw new ValidationError('Nothing is currently playing.');
    }

    if (!this.canSeekCurrentTrack()) {
      throw new ValidationError('Seek is currently supported for YouTube tracks only.');
    }

    const target = Number.parseInt(String(seconds), 10);
    if (!Number.isFinite(target) || target < 0) {
      throw new ValidationError('Seek target must be a non-negative number of seconds.');
    }

    const currentDurationSec = this._parseDurationSeconds(this.currentTrack.duration);
    if (currentDurationSec != null && target >= currentDurationSec) {
      throw new ValidationError(`Seek target exceeds track length (${this.currentTrack.duration}).`);
    }

    this.pendingSeekTrack = {
      ...this.currentTrack,
      seekStartSec: target,
    };

    this._invalidatePlaybackStartup();
    this.skipRequested = true;
    this._stopVoiceStream();
    this._cleanupProcesses();
    return target;
  },

  pause(this: QueueLifecycleRuntime) {
    if (!this.playing || this.paused) return false;
    if (!this._setPipelinePaused(true)) return false;

    this.paused = true;
    this.pauseStartedAtMs = Date.now();
    return true;
  },

  resume(this: QueueLifecycleRuntime) {
    if (!this.playing || !this.paused) return false;
    if (!this._setPipelinePaused(false)) return false;

    if (this.pauseStartedAtMs) {
      this.totalPausedMs += Date.now() - this.pauseStartedAtMs;
    }

    this.pauseStartedAtMs = null;
    this.paused = false;
    return true;
  },

  _setPipelinePaused(this: QueueLifecycleRuntime, paused) {
    const shouldPause = Boolean(paused);
    const signal = shouldPause ? 'SIGSTOP' : 'SIGCONT';
    const streamMethod = shouldPause ? 'pause' : 'resume';
    const voiceMethod = shouldPause ? 'pauseAudio' : 'resumeAudio';
    let changed = false;

    const applyVoicePause = this.voice?.[voiceMethod];
    if (typeof applyVoicePause === 'function') {
      try {
        changed = Boolean(applyVoicePause.call(this.voice)) || changed;
      } catch {
      }
    }

    if (process.platform !== 'win32') {
      for (const proc of [this.sourceProc, this.ffmpeg]) {
        if (!proc?.kill) continue;
        try {
          proc.kill(signal);
          changed = true;
        } catch (err) {
          this.logger?.debug?.('Process signal pause/resume failed; falling back to stream controls', {
            signal,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    for (const stream of [this.sourceStream, this.sourceProc?.stdout, this.ffmpeg?.stdout]) {
      const method = (stream as { pause?: () => void; resume?: () => void } | null | undefined)?.[streamMethod];
      if (typeof method !== 'function') continue;
      try {
        method.call(stream);
        changed = true;
      } catch {
      }
    }

    return changed;
  },

  skip(this: QueueLifecycleRuntime) {
    if (!this.playing) return false;
    this._invalidatePlaybackStartup();
    this.skipRequested = true;
    this._stopVoiceStream();
    this._cleanupProcesses();
    return true;
  },

  stop(this: QueueLifecycleRuntime) {
    this._invalidatePlaybackStartup();
    this.skipRequested = true;
    this.consecutiveStartupFailures = 0;
    this.pendingSeekTrack = null;
    this.queue.clear();
    this._cleanupProcesses();
    this._cleanupRuntimeYtDlpCookiesFile?.();
    this._stopVoiceStream();
    this.playing = false;
    this.paused = false;
    this._resetPlaybackClock();
  },

  async _handleTrackClose(this: QueueLifecycleRuntime, track, code, signal, playbackToken = null) {
    if (playbackToken != null && playbackToken !== this.activePlaybackToken) {
      this.logger?.debug?.('Ignoring stale track close event', {
        title: track?.title ?? null,
        token: playbackToken,
        activeToken: this.activePlaybackToken,
      });
      return;
    }

    const wasSkip = this.skipRequested;
    const pendingSeekTrack = this.pendingSeekTrack;
    const elapsedSeconds = typeof this.getProgressSeconds === 'function'
      ? this.getProgressSeconds()
      : null;
    const expectedDurationSeconds = this._parseDurationSeconds(track?.duration);
    const sourceCloseInfo = this.activeSourceProcessCloseInfo;
    this.pendingSeekTrack = null;

    this._cleanupProcesses();
    this.playing = false;
    this.paused = false;
    this._resetPlaybackClock();
    this.queue.current = null;

    this.emit('trackEnd', {
      track,
      code,
      signal,
      skipped: wasSkip,
      seekRestart: Boolean(pendingSeekTrack),
    });

    const endedEarly = (
      !wasSkip
      && !pendingSeekTrack
      && expectedDurationSeconds != null
      && elapsedSeconds != null
      && expectedDurationSeconds >= 45
      && elapsedSeconds >= 5
      && elapsedSeconds < Math.max(10, expectedDurationSeconds * 0.7)
    );
    if (endedEarly) {
      this.logger?.warn?.('Track pipeline closed earlier than expected', {
        title: track?.title ?? null,
        code: code ?? null,
        signal: signal ?? null,
        elapsedSeconds,
        expectedDurationSeconds,
        source: track?.source ?? null,
        url: track?.url ?? null,
      });
    }

    const sourceEndedUnexpectedly = (
      !wasSkip
      && !pendingSeekTrack
      && sourceCloseInfo
      && String(track?.source ?? '').startsWith('youtube')
      && expectedDurationSeconds != null
      && elapsedSeconds != null
      && elapsedSeconds >= 5
      && elapsedSeconds < Math.max(10, expectedDurationSeconds - 120)
    );
    if (sourceEndedUnexpectedly) {
      this.logger?.warn?.('Source process ended before expected track duration', {
        title: track?.title ?? null,
        url: track?.url ?? null,
        sourceUrl: sourceCloseInfo.url,
        elapsedSeconds,
        expectedDurationSeconds,
        sourceCode: sourceCloseInfo.code,
        sourceSignal: sourceCloseInfo.signal,
        sourceStderrTail: sourceCloseInfo.stderrTail,
      });
    }

    if (!pendingSeekTrack) {
      this._rememberTrack(track);
    }

    if (pendingSeekTrack) {
      this.queue.addFront(pendingSeekTrack);
      await this.play();
      return;
    }

    if (!wasSkip) {
      if (this.loopMode === LOOP_TRACK) {
        this.queue.addFront(this._cloneTrack(track, { seekStartSec: 0 }));
      } else if (this.loopMode === LOOP_QUEUE) {
        this.queue.add(this._cloneTrack(track, { seekStartSec: 0 }));
      }
    }

    if (this.queue.pendingSize > 0) {
      await this.play();
      return;
    }

    this.activeSourceProcessCloseInfo = null;
    this.consecutiveStartupFailures = 0;
    this._cleanupRuntimeYtDlpCookiesFile?.();
    this._stopVoiceStream();
    this.emit('queueEmpty');
  },
};
