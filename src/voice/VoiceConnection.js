import {
  AudioFrame,
  AudioSource,
  LocalAudioTrack,
  Room,
  RoomEvent,
  TrackPublishOptions,
  TrackSource,
} from '@livekit/rtc-node';

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

export class VoiceConnection {
  constructor(gateway, guildId, options = {}) {
    this.gateway = gateway;
    this.guildId = guildId;
    this.logger = options.logger;
    this.connectTimeoutMs = options.connectTimeoutMs ?? 15_000;
    this.voiceMaxBitrate = Number.isFinite(options.voiceMaxBitrate)
      ? Math.max(24_000, Math.min(320_000, Math.trunc(options.voiceMaxBitrate)))
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
  }

  get connected() {
    return Boolean(this.room?.isConnected);
  }

  get isStreaming() {
    return Boolean(this.currentAudioStream);
  }

  async connect(channelId) {
    if (!channelId) {
      throw new Error('Missing voice channel id.');
    }

    if (this.connected) {
      this.channelId = channelId;
      return;
    }

    this.gateway.joinVoice(this.guildId, channelId);
    const update = await this._waitForVoiceServer();

    const endpoint = update.endpoint;
    const token = update.token;

    if (!endpoint || !token) {
      throw new Error('Voice server response is missing endpoint or token.');
    }

    const roomUrl = endpoint.startsWith('ws://') || endpoint.startsWith('wss://')
      ? endpoint
      : `wss://${endpoint}`;

    this.room = new Room();
    this.room.on(RoomEvent.Disconnected, () => {
      this.logger?.warn?.('Voice room disconnected', { guildId: this.guildId });
    });

    await this.room.connect(roomUrl, token);
    this.channelId = channelId;
    await this._ensureAudioTrack();

    this.logger?.info?.('Voice connection established', {
      guildId: this.guildId,
      endpoint,
    });
  }

  async disconnect() {
    this._stopAudioPump();
    this.gateway.leaveVoice(this.guildId);

    await this.room?.disconnect().catch(() => null);

    this.room = null;
    this.channelId = null;
    this.audioSource = null;
    this.audioTrack = null;
    this.audioTrackSid = null;
  }

  async sendAudio(pcmStream) {
    if (!this.connected) {
      throw new Error('Voice room is not connected.');
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

  _waitForVoiceServer() {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.gateway.off('VOICE_SERVER_UPDATE', onUpdate);
        reject(new Error('Timeout waiting for VOICE_SERVER_UPDATE.'));
      }, this.connectTimeoutMs);

      const onUpdate = (data) => {
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
    this.audioTrackSid = publication?.sid ?? null;
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
      queuedDurationMs: Number.isFinite(this.audioSource?.queuedDuration)
        ? Number(this.audioSource.queuedDuration)
        : null,
      trackSid: this.audioTrackSid ?? null,
      voiceMaxBitrate: this.voiceMaxBitrate,
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

  _waitWhilePaused(token) {
    if (!this.playbackPaused || token !== this.audioPumpToken) {
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      this.pauseWaiters.push(resolve);
    });
  }

  _isExpectedPumpError(err, token) {
    if (token !== this.audioPumpToken) return true;
    if (!this.connected) return true;

    const code = err?.code ?? null;
    const message = String(err?.message ?? err ?? '').toLowerCase();
    return (
      code === 'ERR_STREAM_PREMATURE_CLOSE'
      || code === 'ERR_STREAM_DESTROYED'
      || code === 'EPIPE'
      || message.includes('premature close')
      || message.includes('stream destroyed')
      || message.includes('aborted')
    );
  }

  _createPumpStats() {
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
    if (!peerConnection?.getStats) {
      return null;
    }

    let report;
    try {
      report = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('stats-timeout'));
        }, STATS_TIMEOUT_MS);

        Promise.resolve(peerConnection.getStats())
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

    const rows = [];
    if (report && typeof report.forEach === 'function') {
      report.forEach((entry) => rows.push(entry));
    } else if (Array.isArray(report)) {
      rows.push(...report);
    } else if (report && typeof report === 'object') {
      rows.push(...Object.values(report));
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
      const deltaBytes = bytesSent - this._transportStatsState.bytesSent;
      const deltaMs = nowMs - this._transportStatsState.tsMs;
      if (deltaBytes >= 0 && deltaMs > 0) {
        outboundBitrateKbps = Math.round((deltaBytes * 8) / deltaMs);
      }
    }

    this._transportStatsState = Number.isFinite(bytesSent)
      ? { bytesSent, tsMs: nowMs }
      : this._transportStatsState;

    return {
      outboundBitrateKbps,
      packetsSent,
      packetsLost,
      roundTripTimeMs: Number.isFinite(roundTripTimeSec) ? Math.round(roundTripTimeSec * 1000) : null,
      jitterMs: Number.isFinite(jitterSec) ? Math.round(jitterSec * 1000) : null,
    };
  }

  _resolvePublisherPeerConnection() {
    const room = this.room;
    if (!room) return null;

    return (
      room?.engine?.publisher?.pc
      || room?.engine?.pcManager?.publisher?.pc
      || room?.engine?.client?.pcManager?.publisher?.pc
      || room?.engine?.client?.publisher?.pc
      || null
    );
  }

  async _pumpPcmStream(stream, source, token) {
    let pending = Buffer.alloc(0);
    let startedCapturing = false;
    let lastFrameBytes = null;
    let consecutiveConcealmentFrames = 0;
    let streamEnded = false;
    let streamError = null;
    const stats = this._pumpStats ?? this._createPumpStats();
    const startupPrefillFrames = Math.max(1, Math.ceil(STARTUP_PREFILL_MS / FRAME_DURATION_MS));
    const startupPrefillBytes = startupPrefillFrames * BYTES_PER_FRAME;
    const silenceFrameBytes = Buffer.alloc(BYTES_PER_FRAME);

    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    const readTask = (async () => {
      try {
        for await (const chunk of stream) {
          if (token !== this.audioPumpToken) break;
          const asBuffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          if (!asBuffer.length) continue;

          stats.bytesIn += asBuffer.length;
          pending = pending.length ? Buffer.concat([pending, asBuffer]) : asBuffer;
          stats.pendingBufferBytes = pending.length;
        }
      } catch (err) {
        streamError = err;
      } finally {
        streamEnded = true;
      }
    })();

    try {
      while (token === this.audioPumpToken) {
        if (token !== this.audioPumpToken) break;
        await this._waitWhilePaused(token);
        if (token !== this.audioPumpToken) break;

        if (streamError) {
          throw streamError;
        }

        let frameBytes = null;
        let isConcealment = false;

        if (pending.length >= BYTES_PER_FRAME) {
          frameBytes = pending.subarray(0, BYTES_PER_FRAME);
          pending = pending.subarray(BYTES_PER_FRAME);
          stats.pendingBufferBytes = pending.length;
          lastFrameBytes = Buffer.from(frameBytes);
          consecutiveConcealmentFrames = 0;
        } else if (!startedCapturing && pending.length < startupPrefillBytes) {
          if (streamEnded) break;
          await sleep(PUMP_IDLE_WAIT_MS);
          continue;
        } else if (!streamEnded && startedCapturing && consecutiveConcealmentFrames < CONCEALMENT_MAX_FRAMES) {
          frameBytes = lastFrameBytes ?? silenceFrameBytes;
          isConcealment = true;
          consecutiveConcealmentFrames += 1;
        } else {
          if (streamEnded) break;
          await sleep(PUMP_IDLE_WAIT_MS);
          continue;
        }

        const samples = new Int16Array(frameBytes.buffer, frameBytes.byteOffset, SAMPLES_PER_FRAME);
        const frame = new AudioFrame(new Int16Array(samples), SAMPLE_RATE, CHANNELS, SAMPLES_PER_CHANNEL);

        const queuedDurationMs = Number.isFinite(source.queuedDuration)
          ? Number(source.queuedDuration)
          : 0;
        if (queuedDurationMs > MAX_QUEUE_MS) {
          stats.backpressureWaits += 1;
          await source.waitForPlayout();
        } else if (queuedDurationMs >= TARGET_QUEUE_MS) {
          await source.waitForPlayout();
        }
        if (Number.isFinite(source.queuedDuration)) {
          stats.maxQueuedDurationMs = Math.max(stats.maxQueuedDurationMs, Number(source.queuedDuration));
        }

        await source.captureFrame(frame);
        stats.framesCaptured += 1;
        if (isConcealment) {
          stats.concealedFrames += 1;
        }
        startedCapturing = true;
      }

      if (pending.length > 0 && token === this.audioPumpToken) {
        const padded = Buffer.alloc(BYTES_PER_FRAME);
        pending.copy(padded, 0, 0, Math.min(pending.length, BYTES_PER_FRAME));

        const samples = new Int16Array(padded.buffer, padded.byteOffset, SAMPLES_PER_FRAME);
        const frame = new AudioFrame(new Int16Array(samples), SAMPLE_RATE, CHANNELS, SAMPLES_PER_CHANNEL);
        await source.captureFrame(frame);
        stats.framesCaptured += 1;
        stats.pendingBufferBytes = 0;
      }
      await readTask.catch(() => null);
    } finally {
      if (token === this.audioPumpToken) {
        this.currentAudioStream = null;
      }
    }
  }
}
