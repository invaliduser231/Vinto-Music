import { ValidationError } from '../../core/errors.ts';
import { EQ_PRESETS, FILTER_PRESETS, LOOP_MODES } from './constants.ts';
import type { MusicPlayer } from '../MusicPlayer.ts';

type EqPresetName = keyof typeof EQ_PRESETS;
type PlaybackStateMethods = {
  getState(): {
    playing: boolean;
    paused: boolean;
    loopMode: string;
    volumePercent: number;
    current: MusicPlayer['currentTrack'];
    pendingCount: number;
    progressSec: number;
    historyCount: number;
    filterPreset: string;
    eqPreset: string;
    tempoRatio: number;
    pitchSemitones: number;
  };
  getProgressSeconds(): number;
  setLoopMode(mode: unknown): string;
  setVolumePercent(value: string | number): number;
  setFilterPreset(name: unknown): string;
  setEqPreset(name: unknown): string;
  setTempoRatio(value: unknown): number;
  setPitchSemitones(value: unknown): number;
  getAudioEffectsState(): {
    filterPreset: string;
    eqPreset: string;
    tempoRatio: number;
    pitchSemitones: number;
  };
  getAvailableFilterPresets(): string[];
  getAvailableEqPresets(): string[];
};
type PlaybackStateRuntime = MusicPlayer & PlaybackStateMethods & {
  _syncLiveAudioProcessor: () => void;
  _shouldUseLiveAudioProcessor: () => boolean;
  _enableLiveAudioProcessorDuringPlayback: () => boolean;
  refreshCurrentTrackProcessing: () => boolean;
  liveAudioProcessor?: unknown;
};

export const playbackStateMethods: PlaybackStateMethods & ThisType<PlaybackStateRuntime> = {
  getState(this: PlaybackStateRuntime) {
    return {
      playing: this.playing,
      paused: this.paused,
      loopMode: this.loopMode,
      volumePercent: this.volumePercent,
      current: this.currentTrack,
      pendingCount: this.queue.pendingSize,
      progressSec: this.getProgressSeconds(),
      historyCount: this.trackHistory.length,
      filterPreset: this.filterPreset,
      eqPreset: this.eqPreset,
      tempoRatio: this.tempoRatio,
      pitchSemitones: this.pitchSemitones,
    };
  },

  getProgressSeconds(this: PlaybackStateRuntime) {
    if (!this.currentTrack) return 0;
    if (!this.playing || !this.trackStartedAtMs) {
      return Math.max(0, this.currentTrackOffsetSec);
    }

    const now = this.paused && this.pauseStartedAtMs ? this.pauseStartedAtMs : Date.now();
    const elapsedMs = Math.max(0, now - this.trackStartedAtMs - this.totalPausedMs);
    return Math.max(0, this.currentTrackOffsetSec + Math.floor(elapsedMs / 1000));
  },

  setLoopMode(this: PlaybackStateRuntime, mode) {
    const normalized = String(mode ?? '').toLowerCase();
    if (!LOOP_MODES.has(normalized)) {
      throw new ValidationError(`Invalid loop mode: ${mode}`);
    }

    this.loopMode = normalized;
    return this.loopMode;
  },

  setVolumePercent(this: PlaybackStateRuntime, value) {
    const next = Number.parseInt(String(value), 10);
    if (!Number.isFinite(next)) {
      throw new ValidationError('Volume must be a number.');
    }
    if (next < this.minVolumePercent || next > this.maxVolumePercent) {
      throw new ValidationError(`Volume must be between ${this.minVolumePercent} and ${this.maxVolumePercent}.`);
    }

    const hadLiveProcessor = Boolean(this.liveAudioProcessor);
    this.volumePercent = next;
    this._syncLiveAudioProcessor();
    if (this.playing && !hadLiveProcessor && this._shouldUseLiveAudioProcessor()) {
      const enabledLive = this._enableLiveAudioProcessorDuringPlayback();
      if (!enabledLive) {
        this.refreshCurrentTrackProcessing();
      }
    }
    return this.volumePercent;
  },

  setFilterPreset(this: PlaybackStateRuntime, name) {
    const normalized = String(name ?? '').trim().toLowerCase() || 'off';
    if (!FILTER_PRESETS[normalized]) {
      throw new ValidationError(`Unknown filter preset: ${name}`);
    }

    this.filterPreset = normalized;
    this._syncLiveAudioProcessor();
    return this.filterPreset;
  },

  setEqPreset(this: PlaybackStateRuntime, name) {
    const normalized = String(name ?? '').trim().toLowerCase();
    if (!(normalized in EQ_PRESETS)) {
      throw new ValidationError(`Unknown EQ preset: ${name}`);
    }

    this.eqPreset = normalized as EqPresetName;
    this._syncLiveAudioProcessor();
    return this.eqPreset;
  },

  setTempoRatio(this: PlaybackStateRuntime, value) {
    const parsed = Number.parseFloat(String(value ?? ''));
    if (!Number.isFinite(parsed) || parsed < 0.5 || parsed > 2.0) {
      throw new ValidationError('Tempo must be between 0.5 and 2.0.');
    }

    this.tempoRatio = parsed;
    return this.tempoRatio;
  },

  setPitchSemitones(this: PlaybackStateRuntime, value) {
    const parsed = Number.parseFloat(String(value ?? ''));
    if (!Number.isFinite(parsed) || parsed < -12 || parsed > 12) {
      throw new ValidationError('Pitch must be between -12 and +12 semitones.');
    }

    this.pitchSemitones = parsed;
    return this.pitchSemitones;
  },

  getAudioEffectsState(this: PlaybackStateRuntime) {
    return {
      filterPreset: this.filterPreset,
      eqPreset: this.eqPreset,
      tempoRatio: this.tempoRatio,
      pitchSemitones: this.pitchSemitones,
    };
  },

  getAvailableFilterPresets() {
    return Object.keys(FILTER_PRESETS)
      .filter((name) => name !== 'karoake')
      .sort();
  },

  getAvailableEqPresets() {
    return Object.keys(EQ_PRESETS).sort();
  },
};
