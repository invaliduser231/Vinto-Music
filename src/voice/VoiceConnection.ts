import {
  AudioStream,
  AudioFrame,
  AudioSource,
  LocalAudioTrack,
  Room,
  RoomEvent,
  TrackKind,
  TrackPublishOptions,
  TrackSource,
} from '@livekit/rtc-node';
import type { EarrapeProfileSnapshot, EarrapeProfileStoreLike } from '../types/domain.ts';

const SAMPLE_RATE = 48_000;
const CHANNELS = 2;
const FRAME_DURATION_MS = 20;
const SAMPLES_PER_CHANNEL = (SAMPLE_RATE * FRAME_DURATION_MS) / 1000;
const SAMPLES_PER_FRAME = SAMPLES_PER_CHANNEL * CHANNELS;
const BYTES_PER_SAMPLE = 2;
const BYTES_PER_FRAME = SAMPLES_PER_FRAME * BYTES_PER_SAMPLE;
const STATS_TIMEOUT_MS = 750;
const TARGET_QUEUE_MS = 600;
const MAX_QUEUE_MS = 1200;
const STARTUP_PREFILL_MS = 240;
const CONCEALMENT_MAX_FRAMES = 12;
const PUMP_IDLE_WAIT_MS = 5;
const EARRAPE_WARMUP_MS = 1_100;
const EARRAPE_CONFIDENCE_TRIGGER = 1.1;
const EARRAPE_CONFIDENCE_MAX = 2.5;
const EARRAPE_CONFIDENCE_DECAY_ACTIVE = 0.06;
const EARRAPE_CONFIDENCE_DECAY_CALM = 0.18;
const EARRAPE_SUSTAIN_MIN_MS = 140;
const EARRAPE_SUSTAIN_RMS_MIN = 0.36;
const EARRAPE_RMS_HARD = 0.5;
const EARRAPE_BURST_PEAK_THRESHOLD = 0.95;
const EARRAPE_BURST_RMS_MIN = 0.26;
const EARRAPE_BURST_WINDOW_MS = 1_600;
const EARRAPE_BURST_TRIGGER_COUNT = 3;
const EARRAPE_CLIP_HIGH_RATIO = 0.08;
const EARRAPE_CLIP_SEVERE_RATIO = 0.2;
const EARRAPE_CREST_POP_THRESHOLD = 5.3;
const EARRAPE_BASELINE_ALPHA = 0.04;
const EARRAPE_BASELINE_CAPTURE_RMS_MAX = 0.3;
const EARRAPE_BASELINE_DELTA_TRIGGER = 0.18;
const EARRAPE_CALM_RMS_THRESHOLD = 0.18;
const EARRAPE_CALM_PEAK_THRESHOLD = 0.32;
const EARRAPE_MUTE_HOLD_MS = 300;
const EARRAPE_RECOVERY_DELAY_MS = 300;
const EARRAPE_DISCONNECT_COOLDOWN_MS = 3_000;
const EARRAPE_PROFILE_SYNC_INTERVAL_MS = 75_000;

type VoiceConnectionOptions = {
  logger?: {
    warn?: (message: string, meta?: Record<string, unknown>) => void;
    info?: (message: string, meta?: Record<string, unknown>) => void;
    error?: (message: string, meta?: Record<string, unknown>) => void;
    debug?: (message: string, meta?: Record<string, unknown>) => void;
  } | null;
  connectTimeoutMs?: number;
  voiceMaxBitrate?: number;
  earrapeProtectionEnabled?: boolean;
  botUserId?: string | null;
  onEarrapeDetected?: EarrapeDetectionHandler | null;
  earrapeProfileStore?: EarrapeProfileStoreLike | null;
};

type VoiceServerUpdate = {
  guild_id?: string;
  endpoint?: string;
  token?: string;
};

type GatewayLike = {
  joinVoice: (guildId: string, channelId: string, options?: { selfDeaf?: boolean }) => void;
  leaveVoice: (guildId: string) => void;
  on: (event: string, listener: (data: VoiceServerUpdate) => void) => void;
  off: (event: string, listener: (data: VoiceServerUpdate) => void) => void;
};

type RemoteParticipantLike = {
  identity?: unknown;
};

type EarrapeParticipantState = {
  joinedAtMs: number;
  lastSeenAtMs: number;
  sustainSinceMs: number | null;
  lastBurstAtMs: number;
  burstCount: number;
  confidence: number;
  mutedSinceMs: number | null;
  calmSinceMs: number | null;
  lastDisconnectAtMs: number;
  baselineRms: number | null;
  baselineFrames: number;
  offenseScore: number;
  profileLoaded: boolean;
  lastProfileSyncAtMs: number;
};

type AudioFrameLike = {
  data?: unknown;
};

type EarrapeFrameMetrics = {
  peak: number;
  rms: number;
  clippedSampleRatio: number;
  crestFactor: number;
};

type EarrapeTriggerDecision = {
  peak: number;
  rms: number;
  clippedSampleRatio: number;
  crestFactor: number;
  sustainMs: number;
  confidence: number;
  baselineRms: number | null;
  offenseScore: number;
};

export type EarrapeDetectionEvent = {
  guildId: string;
  channelId: string | null;
  participantId: string;
  peak: number;
  rms?: number;
  clippedSampleRatio?: number;
  crestFactor?: number;
  sustainMs?: number;
  confidence?: number;
  baselineRms?: number | null;
  offenseScore?: number;
  threshold: number;
};

type EarrapeDetectionHandler = (event: EarrapeDetectionEvent) => Promise<unknown> | unknown;

type PcmReadableLike = AsyncIterable<unknown> & {
  destroy?: (error?: Error) => void;
  pause?: () => void;
  resume?: () => void;
};

type PeerConnectionLike = {
  getStats?: () => Promise<unknown> | unknown;
};

type StatsRowLike = {
  type?: string;
  kind?: string;
  mediaType?: string;
  bytesSent?: number;
  packetsSent?: number;
  packetsLost?: number;
  roundTripTime?: number;
  jitter?: number;
};

type PumpStats = {
  startedAtMs: number | null;
  bytesIn: number;
  framesCaptured: number;
  concealedFrames: number;
  maxQueuedDurationMs: number;
  backpressureWaits: number;
  pendingBufferBytes: number;
};

type FfiClientEmitterLike = {
  off?: (event: string, listener: (...args: unknown[]) => void) => unknown;
  removeListener?: (event: string, listener: (...args: unknown[]) => void) => unknown;
};

type InternalRoomLike = {
  onFfiEvent?: ((...args: unknown[]) => void) | null;
  preConnectEvents?: unknown[];
  removeAllListeners?: (event?: string) => unknown;
};

export class VoiceConnection {
  [key: string]: unknown;
  gateway: GatewayLike;
  guildId: string;
  channelId: string | null;
  logger: VoiceConnectionOptions['logger'];
  connectTimeoutMs: number;
  voiceMaxBitrate: number;
  room: Room | null;
  audioSource: AudioSource | null;
  audioTrack: LocalAudioTrack | null;
  audioTrackSid: string | null;
  currentAudioStream: PcmReadableLike | null;
  audioPumpToken: number;
  playbackPaused: boolean;
  pauseWaiters: Array<() => void>;
  _transportStatsState: { bytesSent: number; tsMs: number } | null;
  _pumpStats: PumpStats;
  _pumpStatsSample: { tsMs: number; bytesIn: number; framesCaptured: number } | null;
  roomDisconnectedListener: (() => void) | null;
  roomTrackSubscribedListener: ((track: unknown, publication: unknown, participant: unknown) => void) | null;
  roomTrackUnsubscribedListener: ((track: unknown, publication: unknown, participant: unknown) => void) | null;
  earrapeProtectionEnabled: boolean;
  botUserId: string | null;
  onEarrapeDetected: EarrapeDetectionHandler | null;
  remoteAudioMonitorToken: number;
  participantAudioStates: Map<string, EarrapeParticipantState>;
  earrapeProfileStore: EarrapeProfileStoreLike | null;
  constructor(gateway: GatewayLike, guildId: string, options: VoiceConnectionOptions = {}) {
    this.gateway = gateway;
    this.guildId = guildId;
    this.logger = options.logger;
    this.connectTimeoutMs = options.connectTimeoutMs ?? 15_000;
    this.voiceMaxBitrate = Number.isFinite(options.voiceMaxBitrate)
      ? Math.max(24_000, Math.min(320_000, Math.trunc(options.voiceMaxBitrate ?? 192_000)))
      : 192_000;

    this.room = null;
    this.channelId = null;
    this.audioSource = null;
    this.audioTrack = null;
    this.audioTrackSid = null;

    this.currentAudioStream = null;
    this.audioPumpToken = 0;
    this.playbackPaused = false;
    this.pauseWaiters = [];
    this._transportStatsState = null;
    this._pumpStats = this._createPumpStats();
    this._pumpStatsSample = null;
    this.roomDisconnectedListener = null;
    this.roomTrackSubscribedListener = null;
    this.roomTrackUnsubscribedListener = null;
    this.earrapeProtectionEnabled = options.earrapeProtectionEnabled === true;
    this.botUserId = String(options.botUserId ?? '').trim() || null;
    this.onEarrapeDetected = options.onEarrapeDetected ?? null;
    this.earrapeProfileStore = options.earrapeProfileStore ?? null;
    this.remoteAudioMonitorToken = 0;
    this.participantAudioStates = new Map();
  }

  get connected() {
    return Boolean(this.room?.isConnected);
  }

  get isStreaming() {
    return Boolean(this.currentAudioStream);
  }

  setEarrapeProtectionEnabled(enabled: unknown) {
    const next = enabled === true;
    if (this.earrapeProtectionEnabled === next) return;

    this.earrapeProtectionEnabled = next;
    if (!next) {
      this._resetEarrapeStates();
    }

    this._syncVoiceDeafState();
  }

  setBotUserId(botUserId: unknown) {
    this.botUserId = String(botUserId ?? '').trim() || null;
  }

  setEarrapeDetectionHandler(handler: EarrapeDetectionHandler | null | undefined) {
    this.onEarrapeDetected = handler ?? null;
  }

  async connect(channelId: string) {
    if (!channelId) {
      throw new Error('Missing voice channel id.');
    }

    if (this.connected) {
      this.channelId = channelId;
      this._syncVoiceDeafState();
      return;
    }

    this.gateway.joinVoice(this.guildId, channelId, {
      selfDeaf: !this.earrapeProtectionEnabled,
    });
    const update = await this._waitForVoiceServer();
    const endpoint = update.endpoint;
    const token = update.token;

    if (!endpoint || !token) {
      throw new Error('Voice server response is missing endpoint or token.');
    }

    const roomUrl = endpoint.startsWith('ws://') || endpoint.startsWith('wss://')
      ? endpoint
      : `wss://${endpoint}`;

    const room = new Room();
    this.room = room;
    this._attachRoomListeners(room);

    try {
      await room.connect(roomUrl, token);
      this.channelId = channelId;
      await this._ensureAudioTrack();
    } catch (err) {
      await this._cleanupFailedConnect(room);
      throw err;
    }

    this.logger?.info?.('Voice connection established', {
      guildId: this.guildId,
      endpoint,
    });
  }

  async disconnect() {
    this._stopAudioPump();
    this._stopRemoteAudioMonitoring();
    this.gateway.leaveVoice(this.guildId);

    const room = this.room;
    this._detachRoomListeners();
    await room?.disconnect().catch(() => null);
    this._detachRoomFfiListener(room);
    this._resetRoomPreConnectEvents(room);
    room?.removeAllListeners?.();
    await this._closeAudioResources();

    this.room = null;
    this.channelId = null;
  }

  async _cleanupFailedConnect(room: Room) {
    this._stopAudioPump();
    this._stopRemoteAudioMonitoring();
    this._detachRoomListeners();

    try {
      await room.disconnect();
    } catch {
      // ignore failed room teardown during connect rollback
    }

    this._detachRoomFfiListener(room);
    this._resetRoomPreConnectEvents(room);
    room.removeAllListeners?.();
    await this._closeAudioResources();

    try {
      this.gateway.leaveVoice(this.guildId);
    } catch {
      // ignore gateway leave failures during connect rollback
    }

    this.room = null;
    this.channelId = null;
  }

  async _closeAudioResources() {
    const source = this.audioSource;
    const track = this.audioTrack;

    this.audioSource = null;
    this.audioTrack = null;
    this.audioTrackSid = null;

    try {
      source?.clearQueue();
    } catch {
      // ignore queue clear errors during teardown
    }

    if (track) {
      try {
        await track.close(true);
      } catch {
        // ignore track teardown failures during disconnect
      }
      return;
    }

    try {
      await source?.close();
    } catch {
      // ignore source teardown failures during disconnect
    }
  }

  _attachRoomListeners(room: Room) {
    this._detachRoomListeners();
    const roomLike = room as {
      on?: (event: string | number, listener: (...args: unknown[]) => void) => unknown;
    };
    if (typeof roomLike.on !== 'function') return;

    this.roomDisconnectedListener = () => {
      this.logger?.warn?.('Voice room disconnected', { guildId: this.guildId });
    };
    this.roomTrackSubscribedListener = (track, _publication, participant) => {
      this._monitorRemoteAudioTrack(track, participant).catch((err) => {
        this.logger?.debug?.('Remote audio monitor failed', {
          guildId: this.guildId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    };
    this.roomTrackUnsubscribedListener = (_track, _publication, participant) => {
      const participantId = this._normalizeParticipantId(participant);
      if (!participantId) return;
      const state = this.participantAudioStates.get(participantId) ?? null;
      if (state) {
        this._syncParticipantProfile(participantId, state, {
          calmRmsSample: state.baselineRms,
        }, Date.now(), false);
      }
      this.participantAudioStates.delete(participantId);
    };

    roomLike.on(RoomEvent.Disconnected, this.roomDisconnectedListener);
    roomLike.on(RoomEvent.TrackSubscribed, this.roomTrackSubscribedListener);
    roomLike.on(RoomEvent.TrackUnsubscribed, this.roomTrackUnsubscribedListener);
  }

  _detachRoomListeners() {
    const room = this.room as {
      off?: (event: string | number, listener: (...args: unknown[]) => void) => unknown;
      removeListener?: (event: string | number, listener: (...args: unknown[]) => void) => unknown;
      removeAllListeners?: (event?: string | number) => unknown;
    } | null;
    if (!room) {
      this.roomDisconnectedListener = null;
      this.roomTrackSubscribedListener = null;
      this.roomTrackUnsubscribedListener = null;
      return;
    }

    this._detachSingleRoomListener(room, RoomEvent.Disconnected, this.roomDisconnectedListener);
    this._detachSingleRoomListener(room, RoomEvent.TrackSubscribed, this.roomTrackSubscribedListener);
    this._detachSingleRoomListener(room, RoomEvent.TrackUnsubscribed, this.roomTrackUnsubscribedListener);
    this.roomDisconnectedListener = null;
    this.roomTrackSubscribedListener = null;
    this.roomTrackUnsubscribedListener = null;
  }

  _detachSingleRoomListener(
    room: {
      off?: (event: string | number, listener: (...args: unknown[]) => void) => unknown;
      removeListener?: (event: string | number, listener: (...args: unknown[]) => void) => unknown;
      removeAllListeners?: (event?: string | number) => unknown;
    },
    event: string | number,
    listener: ((...args: unknown[]) => void) | null,
  ) {
    if (!listener) return;
    if (typeof room.off === 'function') {
      room.off(event, listener);
      return;
    }
    if (typeof room.removeListener === 'function') {
      room.removeListener(event, listener);
      return;
    }
    room.removeAllListeners?.(event);
  }

  _detachRoomFfiListener(room: Room | null) {
    const ffiClient = (globalThis as typeof globalThis & {
      _ffiClientInstance?: FfiClientEmitterLike;
    })._ffiClientInstance;
    const listener = (room as unknown as InternalRoomLike | null)?.onFfiEvent;

    if (!ffiClient || typeof listener !== 'function') return;

    if (typeof ffiClient.off === 'function') {
      ffiClient.off('ffi_event', listener);
      return;
    }

    ffiClient.removeListener?.('ffi_event', listener);
  }

  _resetRoomPreConnectEvents(room: Room | null) {
    const internalRoom = room as unknown as InternalRoomLike | null;
    if (!internalRoom || !Array.isArray(internalRoom.preConnectEvents)) return;
    internalRoom.preConnectEvents.length = 0;
  }

  _syncVoiceDeafState() {
    if (!this.connected || !this.channelId) return;
    try {
      this.gateway.joinVoice(this.guildId, this.channelId, {
        selfDeaf: !this.earrapeProtectionEnabled,
      });
    } catch (err) {
      this.logger?.debug?.('Failed to synchronize voice deaf state', {
        guildId: this.guildId,
        channelId: this.channelId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  _stopRemoteAudioMonitoring() {
    this.remoteAudioMonitorToken += 1;
    this._resetEarrapeStates();
  }

  _resetEarrapeStates() {
    const nowMs = Date.now();
    for (const [participantId, state] of this.participantAudioStates.entries()) {
      this._syncParticipantProfile(participantId, state, {
        calmRmsSample: state.baselineRms,
      }, nowMs, false);
    }
    this.participantAudioStates.clear();
  }

  _normalizeParticipantId(participant: unknown) {
    const normalized = String((participant as RemoteParticipantLike | null | undefined)?.identity ?? '').trim();
    if (!normalized) return null;

    // Fluxer identities can include a user tag prefix/suffix around the real snowflake.
    const snowflakeMatch = normalized.match(/\d{17,20}/);
    return snowflakeMatch?.[0] ?? normalized;
  }

  async _monitorRemoteAudioTrack(track: unknown, participant: unknown) {
    const trackKind = (track as { kind?: unknown } | null | undefined)?.kind;
    if (trackKind !== TrackKind.KIND_AUDIO) return;

    const participantId = this._normalizeParticipantId(participant);
    if (!participantId) return;
    if (this.botUserId && participantId === this.botUserId) return;

    const state = this._ensureParticipantAudioState(participantId);
    await this._hydrateParticipantProfile(participantId, state).catch(() => null);

    const monitorToken = this.remoteAudioMonitorToken;
    const stream = new AudioStream(track as ConstructorParameters<typeof AudioStream>[0]);
    for await (const frame of stream) {
      if (monitorToken !== this.remoteAudioMonitorToken) break;
      // Keep ingestion lightweight while protection is disabled, then resume from a clean state.
      if (!this.earrapeProtectionEnabled) {
        const profileState = this.participantAudioStates.get(participantId) ?? null;
        if (profileState) {
          this._syncParticipantProfile(participantId, profileState, {
            calmRmsSample: profileState.baselineRms,
          }, Date.now(), false);
        }
        this.participantAudioStates.delete(participantId);
        continue;
      }

      const metrics = this._computeFrameMetrics(frame);
      const decision = this._ingestParticipantFrame(participantId, metrics);
      if (!decision) continue;
      await this._emitEarrapeDetection(participantId, decision);
    }
  }

  _computeFramePeak(frame: AudioFrameLike | null | undefined): number {
    return this._computeFrameMetrics(frame).peak;
  }

  _computeFrameMetrics(frame: AudioFrameLike | null | undefined): EarrapeFrameMetrics {
    const samples = this._toInt16Samples(frame?.data);
    if (!samples || samples.length === 0) {
      return {
        peak: 0,
        rms: 0,
        clippedSampleRatio: 0,
        crestFactor: 0,
      };
    }

    let max = 0;
    let sumSquares = 0;
    let clippedSamples = 0;
    for (let i = 0; i < samples.length; i += 1) {
      const normalized = Math.abs(samples[i] ?? 0) / 32_767;
      if (normalized > max) max = normalized;
      sumSquares += normalized * normalized;
      if (normalized >= 0.985) clippedSamples += 1;
    }

    const rms = Math.sqrt(sumSquares / samples.length);
    const clippedSampleRatio = clippedSamples / samples.length;
    const crestFactor = rms > 0 ? max / rms : 0;
    return {
      peak: max,
      rms,
      clippedSampleRatio,
      crestFactor,
    };
  }

  _toInt16Samples(value: unknown): Int16Array | null {
    if (!value) return null;
    if (value instanceof Int16Array) return value;

    if (Buffer.isBuffer(value)) {
      const sampleBytes = Math.floor(value.byteLength / 2) * 2;
      return sampleBytes > 0
        ? new Int16Array(value.buffer, value.byteOffset, sampleBytes / 2)
        : null;
    }

    if (value instanceof Uint8Array || ArrayBuffer.isView(value)) {
      const bytes = value as ArrayBufferView;
      const sampleBytes = Math.floor(bytes.byteLength / 2) * 2;
      return sampleBytes > 0
        ? new Int16Array(bytes.buffer, bytes.byteOffset, sampleBytes / 2)
        : null;
    }

    if (value instanceof ArrayBuffer) {
      const sampleBytes = Math.floor(value.byteLength / 2) * 2;
      return sampleBytes > 0 ? new Int16Array(value, 0, sampleBytes / 2) : null;
    }

    if (Array.isArray(value)) {
      const sampleArray = Int16Array.from(value.map((item) => Number.parseInt(String(item ?? 0), 10) || 0));
      return sampleArray.length ? sampleArray : null;
    }

    return null;
  }

  _ensureParticipantAudioState(participantId: string): EarrapeParticipantState {
    const existing = this.participantAudioStates.get(participantId);
    if (existing) return existing;

    const nowMs = Date.now();
    const created: EarrapeParticipantState = {
      joinedAtMs: nowMs,
      lastSeenAtMs: nowMs,
      sustainSinceMs: null,
      lastBurstAtMs: -EARRAPE_BURST_WINDOW_MS,
      burstCount: 0,
      confidence: 0,
      mutedSinceMs: null,
      calmSinceMs: null,
      lastDisconnectAtMs: -EARRAPE_DISCONNECT_COOLDOWN_MS,
      baselineRms: null,
      baselineFrames: 0,
      offenseScore: 0,
      profileLoaded: false,
      lastProfileSyncAtMs: 0,
    };
    this.participantAudioStates.set(participantId, created);
    return created;
  }

  async _hydrateParticipantProfile(participantId: string, state: EarrapeParticipantState, nowMs = Date.now()) {
    if (!this.earrapeProfileStore || state.profileLoaded) return;
    const profile = await this.earrapeProfileStore.getProfile(this.guildId, participantId, nowMs);
    state.offenseScore = Math.max(0, Number(profile?.offenseScore ?? 0));
    if (profile?.calmRmsBaseline != null) {
      state.baselineRms = Math.max(0, Math.min(1, Number(profile.calmRmsBaseline)));
      state.baselineFrames = Math.max(state.baselineFrames, 100);
    }
    state.profileLoaded = true;
  }

  _syncParticipantProfile(
    participantId: string,
    state: EarrapeParticipantState,
    update: { offenseDetected?: boolean; calmRmsSample?: number | null },
    nowMs = Date.now(),
    wait = false
  ) {
    if (!this.earrapeProfileStore) return Promise.resolve(null);
    const hasOffense = update.offenseDetected === true;
    const calmSample = Number(update.calmRmsSample);
    const hasCalmSample = Number.isFinite(calmSample);
    if (!hasOffense && !hasCalmSample) return Promise.resolve(null);

    const shouldSyncCalmOnly = update.offenseDetected !== true;
    if (
      shouldSyncCalmOnly
      && state.lastProfileSyncAtMs > 0
      && (nowMs - state.lastProfileSyncAtMs) < EARRAPE_PROFILE_SYNC_INTERVAL_MS
    ) {
      return Promise.resolve(null);
    }

    state.lastProfileSyncAtMs = nowMs;
    const promise = this.earrapeProfileStore
      .updateProfile(this.guildId, participantId, update, nowMs)
      .then((profile: EarrapeProfileSnapshot) => {
        state.offenseScore = Math.max(0, Number(profile.offenseScore ?? state.offenseScore ?? 0));
        if (profile.calmRmsBaseline != null) {
          state.baselineRms = Math.max(0, Math.min(1, Number(profile.calmRmsBaseline)));
        }
        return profile;
      })
      .catch((err: unknown) => {
        this.logger?.debug?.('Failed to sync earrape participant profile', {
          guildId: this.guildId,
          participantId,
          error: err instanceof Error ? err.message : String(err),
        });
        return null;
      });

    return wait ? promise : Promise.resolve(null);
  }

  _updateAdaptiveBaseline(state: EarrapeParticipantState, rms: number) {
    if (!Number.isFinite(rms)) return;
    if (rms > EARRAPE_BASELINE_CAPTURE_RMS_MAX) return;

    if (state.baselineRms == null) {
      state.baselineRms = rms;
      state.baselineFrames = 1;
      return;
    }

    const alpha = state.baselineFrames < 60 ? 0.14 : EARRAPE_BASELINE_ALPHA;
    state.baselineRms = (state.baselineRms * (1 - alpha)) + (rms * alpha);
    state.baselineFrames += 1;
  }

  _ingestParticipantPeak(participantId: string, peak: number, nowMs = Date.now()): boolean {
    const metrics: EarrapeFrameMetrics = {
      peak,
      rms: peak,
      clippedSampleRatio: peak >= 0.985 ? 1 : 0,
      crestFactor: 1,
    };
    return Boolean(this._ingestParticipantFrame(participantId, metrics, nowMs));
  }

  _ingestParticipantFrame(
    participantId: string,
    metrics: EarrapeFrameMetrics,
    nowMs = Date.now()
  ): EarrapeTriggerDecision | null {
    const safeParticipantId = String(participantId ?? '').trim();
    if (!safeParticipantId) return null;
    const state = this._ensureParticipantAudioState(safeParticipantId);
    state.lastSeenAtMs = nowMs;
    this._updateAdaptiveBaseline(state, metrics.rms);

    if ((nowMs - state.joinedAtMs) < EARRAPE_WARMUP_MS) {
      return null;
    }

    if (state.mutedSinceMs != null) {
      // After a trigger we wait for a short hold window, then require calm audio before re-arming.
      const holdElapsed = nowMs - state.mutedSinceMs;
      if (holdElapsed < EARRAPE_MUTE_HOLD_MS) return null;

      if (metrics.rms < EARRAPE_CALM_RMS_THRESHOLD && metrics.peak < EARRAPE_CALM_PEAK_THRESHOLD) {
        if (state.calmSinceMs == null) {
          state.calmSinceMs = nowMs;
          return null;
        }
        if ((nowMs - state.calmSinceMs) >= EARRAPE_RECOVERY_DELAY_MS) {
          state.mutedSinceMs = null;
          state.calmSinceMs = null;
          state.confidence = Math.max(0, state.confidence * 0.4);
          state.sustainSinceMs = null;
          state.burstCount = 0;
        }
        return null;
      }

      state.calmSinceMs = null;
      return null;
    }

    const baselineRms = state.baselineRms ?? 0.09;
    const baselineTriggerRms = Math.max(EARRAPE_SUSTAIN_RMS_MIN, baselineRms + EARRAPE_BASELINE_DELTA_TRIGGER);
    const isLoudFrame = metrics.rms >= baselineTriggerRms || metrics.clippedSampleRatio >= EARRAPE_CLIP_HIGH_RATIO;

    if (isLoudFrame) {
      if (state.sustainSinceMs == null) state.sustainSinceMs = nowMs;
    } else {
      state.sustainSinceMs = null;
    }
    const sustainMs = state.sustainSinceMs == null ? 0 : Math.max(FRAME_DURATION_MS, (nowMs - state.sustainSinceMs) + FRAME_DURATION_MS);

    if (metrics.peak >= EARRAPE_BURST_PEAK_THRESHOLD && metrics.rms >= EARRAPE_BURST_RMS_MIN) {
      if ((nowMs - state.lastBurstAtMs) > EARRAPE_BURST_WINDOW_MS) {
        state.burstCount = 1;
      } else {
        state.burstCount += 1;
      }
      state.lastBurstAtMs = nowMs;
    } else if ((nowMs - state.lastBurstAtMs) > EARRAPE_BURST_WINDOW_MS) {
      state.burstCount = 0;
    }

    const calmFrame = metrics.rms < Math.max(EARRAPE_CALM_RMS_THRESHOLD, baselineRms + 0.05);
    const activeDecay = calmFrame ? EARRAPE_CONFIDENCE_DECAY_CALM : EARRAPE_CONFIDENCE_DECAY_ACTIVE;

    let confidenceDelta = 0;
    if (sustainMs >= EARRAPE_SUSTAIN_MIN_MS) confidenceDelta += 0.55;
    if (metrics.rms >= EARRAPE_RMS_HARD) confidenceDelta += 0.32;
    if (metrics.clippedSampleRatio >= EARRAPE_CLIP_HIGH_RATIO) confidenceDelta += 0.28;
    if (metrics.clippedSampleRatio >= EARRAPE_CLIP_SEVERE_RATIO) confidenceDelta += 0.3;
    if (state.burstCount >= EARRAPE_BURST_TRIGGER_COUNT) confidenceDelta += 0.24;
    if (metrics.crestFactor >= EARRAPE_CREST_POP_THRESHOLD && sustainMs < EARRAPE_SUSTAIN_MIN_MS) {
      confidenceDelta -= 0.4;
    }
    if (metrics.rms < baselineRms + 0.03) confidenceDelta -= 0.15;

    const offenseBias = Math.min(0.3, state.offenseScore * 0.09);
    state.confidence = Math.max(
      0,
      Math.min(EARRAPE_CONFIDENCE_MAX, state.confidence + confidenceDelta + offenseBias - activeDecay)
    );

    if (
      state.profileLoaded
      && state.baselineRms != null
      && calmFrame
      && (nowMs - state.lastProfileSyncAtMs) >= EARRAPE_PROFILE_SYNC_INTERVAL_MS
    ) {
      this._syncParticipantProfile(safeParticipantId, state, {
        calmRmsSample: state.baselineRms,
      }, nowMs, false);
    }

    const hasSustainedSignal = sustainMs >= EARRAPE_SUSTAIN_MIN_MS;
    const hasSevereBurstSignal = (
      metrics.clippedSampleRatio >= EARRAPE_CLIP_SEVERE_RATIO
      && state.burstCount >= Math.max(2, EARRAPE_BURST_TRIGGER_COUNT - 1)
    );
    if (state.confidence < EARRAPE_CONFIDENCE_TRIGGER || (!hasSustainedSignal && !hasSevereBurstSignal)) {
      return null;
    }

    if ((nowMs - state.lastDisconnectAtMs) < EARRAPE_DISCONNECT_COOLDOWN_MS) {
      return null;
    }

    const confidence = state.confidence;
    state.lastDisconnectAtMs = nowMs;
    state.mutedSinceMs = nowMs;
    state.calmSinceMs = null;
    state.sustainSinceMs = null;
    state.burstCount = 0;
    state.confidence = 0;
    return {
      peak: metrics.peak,
      rms: metrics.rms,
      clippedSampleRatio: metrics.clippedSampleRatio,
      crestFactor: metrics.crestFactor,
      sustainMs,
      confidence,
      baselineRms: state.baselineRms,
      offenseScore: state.offenseScore,
    };
  }

  async _emitEarrapeDetection(participantId: string, decision: EarrapeTriggerDecision) {
    if (!this.onEarrapeDetected) return;
    const state = this.participantAudioStates.get(participantId) ?? null;
    const nowMs = Date.now();
    if (state) {
      await this._syncParticipantProfile(participantId, state, {
        offenseDetected: true,
        calmRmsSample: state.baselineRms,
      }, nowMs, true);
    }

    try {
      await this.onEarrapeDetected({
        guildId: this.guildId,
        channelId: this.channelId,
        participantId,
        peak: decision.peak,
        rms: decision.rms,
        clippedSampleRatio: decision.clippedSampleRatio,
        crestFactor: decision.crestFactor,
        sustainMs: decision.sustainMs,
        confidence: decision.confidence,
        baselineRms: decision.baselineRms,
        offenseScore: decision.offenseScore,
        threshold: EARRAPE_CONFIDENCE_TRIGGER,
      });
    } catch (err) {
      this.logger?.debug?.('Failed to handle earrape detection', {
        guildId: this.guildId,
        channelId: this.channelId,
        participantId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async sendAudio(pcmStream: unknown) {
    if (!this.connected) {
      throw new Error('Voice room is not connected.');
    }
    if (!this._isPcmReadableLike(pcmStream)) {
      throw new Error('Audio stream must be async-iterable PCM data.');
    }

    await this._ensureAudioTrack();
    if (!this.audioSource) {
      throw new Error('Audio source is not available.');
    }

    this._stopAudioPump();
    this.currentAudioStream = pcmStream;
    this._pumpStats = this._createPumpStats();
    this._pumpStats.startedAtMs = Date.now();
    this._pumpStatsSample = null;

    const token = ++this.audioPumpToken;
    this._pumpPcmStream(pcmStream, this.audioSource, token).catch((err) => {
      if (this._isExpectedPumpError(err, token)) {
        this.logger?.debug?.('Ignoring expected audio pump shutdown', {
          guildId: this.guildId,
          code: err?.code ?? null,
          error: err instanceof Error ? err.message : String(err),
        });
        return;
      }

      this.logger?.error?.('Audio pump failed', {
        guildId: this.guildId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  stopAudio() {
    this._stopAudioPump();
  }

  _waitForVoiceServer(): Promise<VoiceServerUpdate> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.gateway.off('VOICE_SERVER_UPDATE', onUpdate);
        reject(new Error('Timeout waiting for VOICE_SERVER_UPDATE.'));
      }, this.connectTimeoutMs);

      const onUpdate = (data: VoiceServerUpdate) => {
        if (data?.guild_id !== this.guildId) return;

        clearTimeout(timeout);
        this.gateway.off('VOICE_SERVER_UPDATE', onUpdate);
        resolve(data);
      };

      this.gateway.on('VOICE_SERVER_UPDATE', onUpdate);
    });
  }

  async _ensureAudioTrack() {
    if (this.audioSource && this.audioTrack && this.audioTrackSid) return;

    const participant = this.room?.localParticipant;
    if (!participant) {
      throw new Error('No local participant available.');
    }

    this.audioSource = new AudioSource(SAMPLE_RATE, CHANNELS);
    this.audioTrack = LocalAudioTrack.createAudioTrack('music', this.audioSource);

    const options = new TrackPublishOptions({
      source: TrackSource.SOURCE_MICROPHONE,
      dtx: false,
      red: false,
      audioEncoding: {
        maxBitrate: BigInt(this.voiceMaxBitrate),
      },
    });

    const publication = await participant.publishTrack(this.audioTrack, options);
    this.audioTrackSid = String(publication?.sid ?? '') || null;
  }

  _stopAudioPump() {
    this.audioPumpToken += 1;
    this.playbackPaused = false;
    this._flushPauseWaiters();

    if (this.currentAudioStream?.destroy) {
      try {
        this.currentAudioStream.destroy();
      } catch {
        // ignore stream teardown errors
      }
    }

    this.currentAudioStream = null;
    this._pumpStatsSample = null;

    try {
      this.audioSource?.clearQueue();
    } catch {
      // ignore queue clear errors
    }
  }

  pauseAudio() {
    if (this.playbackPaused) return false;
    this.playbackPaused = true;
    return true;
  }

  resumeAudio() {
    if (!this.playbackPaused) return false;
    this.playbackPaused = false;
    this._flushPauseWaiters();
    return true;
  }

  async getDiagnostics() {
    const base = {
      connected: this.connected,
      isStreaming: this.isStreaming,
      guildId: this.guildId,
      channelId: this.channelId ?? null,
      playbackPaused: this.playbackPaused,
      queuedDurationMs: this.audioSource && Number.isFinite(this.audioSource.queuedDuration)
        ? Number(this.audioSource.queuedDuration)
        : null,
      trackSid: this.audioTrackSid ?? null,
      voiceMaxBitrate: this.voiceMaxBitrate,
      earrapeProtectionEnabled: this.earrapeProtectionEnabled,
      trackedParticipants: this.participantAudioStates.size,
    };

    const transport = await this._collectTransportStats();
    const pump = this._collectPumpStatsSnapshot();
    return { ...base, transport, pump };
  }

  _flushPauseWaiters() {
    if (!this.pauseWaiters.length) return;
    const waiters = this.pauseWaiters.splice(0, this.pauseWaiters.length);
    for (const resume of waiters) {
      try {
        resume();
      } catch {
        // ignore waiter completion errors
      }
    }
  }

  _waitWhilePaused(token: number) {
    if (!this.playbackPaused || token !== this.audioPumpToken) {
      return Promise.resolve();
    }

    return new Promise<void>((resolve) => {
      this.pauseWaiters.push(() => resolve());
    });
  }

  _assertPumpActive(token: number) {
    if (token !== this.audioPumpToken) {
      const aborted = new Error('Audio pump aborted.');
      (aborted as Error & { code?: string }).code = 'ERR_AUDIO_PUMP_ABORTED';
      throw aborted;
    }
  }

  async _awaitPumpOperation<T>(promiseFactory: () => Promise<T>, token: number) {
    this._assertPumpActive(token);

    const operation = promiseFactory();
    while (true) {
      const result = await Promise.race([
        operation.then((value) => ({ done: true as const, value })),
        new Promise<{ done: false }>((resolve) => setTimeout(() => resolve({ done: false }), PUMP_IDLE_WAIT_MS)),
      ]);

      if (result.done) {
        this._assertPumpActive(token);
        return result.value;
      }

      this._assertPumpActive(token);
    }
  }

  _isExpectedPumpError(err: unknown, token: number) {
    if (token !== this.audioPumpToken) return true;
    if (!this.connected) return true;

    const maybeError = this._toErrorLike(err);
    const code = maybeError?.code ?? null;
    const message = String(maybeError?.message ?? err ?? '').toLowerCase();
    return (
      code === 'ERR_STREAM_PREMATURE_CLOSE'
      || code === 'ERR_STREAM_DESTROYED'
      || code === 'ERR_AUDIO_PUMP_ABORTED'
      || code === 'EPIPE'
      || message.includes('premature close')
      || message.includes('stream destroyed')
      || message.includes('aborted')
    );
  }

  _createPumpStats(): PumpStats {
    return {
      startedAtMs: null,
      bytesIn: 0,
      framesCaptured: 0,
      concealedFrames: 0,
      maxQueuedDurationMs: 0,
      backpressureWaits: 0,
      pendingBufferBytes: 0,
    };
  }

  _collectPumpStatsSnapshot() {
    const stats = this._pumpStats ?? this._createPumpStats();
    const nowMs = Date.now();
    const prev = this._pumpStatsSample;

    let inputKbps = null;
    let framesPerSec = null;
    if (prev && nowMs > prev.tsMs) {
      const deltaMs = nowMs - prev.tsMs;
      const deltaBytes = Math.max(0, stats.bytesIn - prev.bytesIn);
      const deltaFrames = Math.max(0, stats.framesCaptured - prev.framesCaptured);
      inputKbps = Math.round((deltaBytes * 8) / deltaMs);
      framesPerSec = Number(((deltaFrames * 1000) / deltaMs).toFixed(1));
    }

    this._pumpStatsSample = {
      tsMs: nowMs,
      bytesIn: stats.bytesIn,
      framesCaptured: stats.framesCaptured,
    };

    return {
      inputKbps,
      framesPerSec,
      bytesIn: stats.bytesIn,
      framesCaptured: stats.framesCaptured,
      concealedFrames: stats.concealedFrames,
      pendingBufferBytes: stats.pendingBufferBytes,
      maxQueuedDurationMs: stats.maxQueuedDurationMs,
      backpressureWaits: stats.backpressureWaits,
      uptimeSec: stats.startedAtMs ? Math.max(0, Math.floor((nowMs - stats.startedAtMs) / 1000)) : 0,
    };
  }

  async _collectTransportStats() {
    const peerConnection = this._resolvePublisherPeerConnection();
    const getStats = peerConnection?.getStats;
    if (typeof getStats !== 'function') {
      return null;
    }

    let report: unknown;
    try {
      report = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('stats-timeout'));
        }, STATS_TIMEOUT_MS);

        Promise.resolve(getStats.call(peerConnection))
          .then((value) => {
            clearTimeout(timeout);
            resolve(value);
          })
          .catch((err) => {
            clearTimeout(timeout);
            reject(err);
          });
      });
    } catch {
      return null;
    }

    const rows: StatsRowLike[] = [];
    if (report && typeof (report as { forEach?: (cb: (entry: StatsRowLike) => void) => void }).forEach === 'function') {
      (report as { forEach: (cb: (entry: StatsRowLike) => void) => void }).forEach((entry) => rows.push(entry));
    } else if (Array.isArray(report)) {
      rows.push(...report as StatsRowLike[]);
    } else if (report && typeof report === 'object') {
      rows.push(...Object.values(report) as StatsRowLike[]);
    }

    let bytesSent = null;
    let packetsSent = null;
    let packetsLost = null;
    let roundTripTimeSec = null;
    let jitterSec = null;

    for (const row of rows) {
      const type = String(row?.type ?? '').toLowerCase();
      const kind = String(row?.kind ?? row?.mediaType ?? '').toLowerCase();
      if (kind !== 'audio') continue;

      if (type === 'outbound-rtp') {
        if (Number.isFinite(row?.bytesSent)) bytesSent = Number(row.bytesSent);
        if (Number.isFinite(row?.packetsSent)) packetsSent = Number(row.packetsSent);
      } else if (type === 'remote-inbound-rtp') {
        if (Number.isFinite(row?.packetsLost)) packetsLost = Number(row.packetsLost);
        if (Number.isFinite(row?.roundTripTime)) roundTripTimeSec = Number(row.roundTripTime);
        if (Number.isFinite(row?.jitter)) jitterSec = Number(row.jitter);
      }
    }

    const nowMs = Date.now();
    let outboundBitrateKbps = null;
    if (Number.isFinite(bytesSent) && this._transportStatsState?.bytesSent != null && this._transportStatsState?.tsMs != null) {
      const deltaBytes = (bytesSent ?? 0) - this._transportStatsState.bytesSent;
      const deltaMs = nowMs - this._transportStatsState.tsMs;
      if (deltaBytes >= 0 && deltaMs > 0) {
        outboundBitrateKbps = Math.round((deltaBytes * 8) / deltaMs);
      }
    }

    this._transportStatsState = Number.isFinite(bytesSent)
      ? { bytesSent: bytesSent ?? 0, tsMs: nowMs }
      : this._transportStatsState;

    return {
      outboundBitrateKbps,
      packetsSent,
      packetsLost,
      roundTripTimeMs: Number.isFinite(roundTripTimeSec) ? Math.round((roundTripTimeSec ?? 0) * 1000) : null,
      jitterMs: Number.isFinite(jitterSec) ? Math.round((jitterSec ?? 0) * 1000) : null,
    };
  }

  _resolvePublisherPeerConnection() {
    const room = this.room as Room & {
      engine?: {
        publisher?: { pc?: PeerConnectionLike | null };
        pcManager?: { publisher?: { pc?: PeerConnectionLike | null } };
        client?: {
          pcManager?: { publisher?: { pc?: PeerConnectionLike | null } };
          publisher?: { pc?: PeerConnectionLike | null };
        };
      };
    };
    if (!room) return null;

    return (
      room?.engine?.publisher?.pc
      || room?.engine?.pcManager?.publisher?.pc
      || room?.engine?.client?.pcManager?.publisher?.pc
      || room?.engine?.client?.publisher?.pc
      || null
    );
  }

  _isPcmReadableLike(value: unknown): value is PcmReadableLike {
    return Boolean(
      value
      && typeof value === 'object'
      && typeof (value as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === 'function'
    );
  }

  _toErrorLike(err: unknown): { code?: string | number | null; message?: string | null } | null {
    if (!err || typeof err !== 'object') return null;
    return err as { code?: string | number | null; message?: string | null };
  }

  _toBufferChunk(chunk: unknown): Uint8Array {
    if (Buffer.isBuffer(chunk)) return chunk;
    if (chunk instanceof Uint8Array) return Buffer.from(chunk);
    if (typeof chunk === 'string') return Buffer.from(chunk);
    if (chunk instanceof ArrayBuffer) return Buffer.from(chunk);
    if (ArrayBuffer.isView(chunk)) {
      return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    }
    return Buffer.alloc(0);
  }

  async _pumpPcmStream(stream: PcmReadableLike, source: AudioSource, token: number) {
    let pending: Uint8Array = Buffer.alloc(0);
    const stats = this._pumpStats ?? this._createPumpStats();
    const targetPendingBytes = Math.max(BYTES_PER_FRAME, Math.round((TARGET_QUEUE_MS / FRAME_DURATION_MS) * BYTES_PER_FRAME));
    const maxPendingBytes = Math.max(targetPendingBytes, Math.round((MAX_QUEUE_MS / FRAME_DURATION_MS) * BYTES_PER_FRAME));
    let inputPaused = false;

    const pauseInput = () => {
      if (inputPaused || typeof stream.pause !== 'function') return;
      try {
        stream.pause();
        inputPaused = true;
      } catch {
        // ignore source pause failures
      }
    };

    const resumeInput = () => {
      if (!inputPaused || typeof stream.resume !== 'function') return;
      try {
        stream.resume();
        inputPaused = false;
      } catch {
        // ignore source resume failures
      }
    };

    try {
      for await (const chunk of stream) {
        if (token !== this.audioPumpToken) break;
        await this._waitWhilePaused(token);
        if (token !== this.audioPumpToken) break;

        const asBuffer = this._toBufferChunk(chunk);
        if (!asBuffer.length) continue;
        stats.bytesIn += asBuffer.length;

        pending = pending.length ? Buffer.concat([pending, asBuffer]) : asBuffer;
        stats.pendingBufferBytes = pending.length;
        if (pending.length >= maxPendingBytes || Number(source.queuedDuration) >= MAX_QUEUE_MS) {
          pauseInput();
        }

        while (pending.length >= BYTES_PER_FRAME && token === this.audioPumpToken) {
          await this._waitWhilePaused(token);
          if (token !== this.audioPumpToken) break;

          const frameBytes = pending.subarray(0, BYTES_PER_FRAME);
          pending = pending.subarray(BYTES_PER_FRAME);

          const samples = new Int16Array(frameBytes.buffer, frameBytes.byteOffset, SAMPLES_PER_FRAME);
          const frame = new AudioFrame(new Int16Array(samples), SAMPLE_RATE, CHANNELS, SAMPLES_PER_CHANNEL);

          if (source.queuedDuration > TARGET_QUEUE_MS) {
            stats.backpressureWaits += 1;
            await this._awaitPumpOperation(() => source.waitForPlayout(), token);
          }
          if (Number.isFinite(source.queuedDuration)) {
            stats.maxQueuedDurationMs = Math.max(stats.maxQueuedDurationMs, Number(source.queuedDuration));
          }

          await this._awaitPumpOperation(() => source.captureFrame(frame), token);
          stats.framesCaptured += 1;
          stats.pendingBufferBytes = pending.length;
          if (inputPaused && pending.length <= targetPendingBytes && Number(source.queuedDuration) <= TARGET_QUEUE_MS) {
            resumeInput();
          }
        }
      }

      if (pending.length > 0 && token === this.audioPumpToken) {
        const padded = Buffer.alloc(BYTES_PER_FRAME);
        padded.set(pending.subarray(0, Math.min(pending.length, BYTES_PER_FRAME)), 0);

        const samples = new Int16Array(padded.buffer, padded.byteOffset, SAMPLES_PER_FRAME);
        const frame = new AudioFrame(new Int16Array(samples), SAMPLE_RATE, CHANNELS, SAMPLES_PER_CHANNEL);
        await this._awaitPumpOperation(() => source.captureFrame(frame), token);
        stats.framesCaptured += 1;
        stats.pendingBufferBytes = 0;
      }
    } finally {
      resumeInput();
      if (token === this.audioPumpToken) {
        this.currentAudioStream = null;
      }
    }
  }
}




