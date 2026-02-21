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

export class VoiceConnection {
  constructor(gateway, guildId, options = {}) {
    this.gateway = gateway;
    this.guildId = guildId;
    this.logger = options.logger;
    this.connectTimeoutMs = options.connectTimeoutMs ?? 15_000;

    this.room = null;
    this.channelId = null;
    this.audioSource = null;
    this.audioTrack = null;
    this.audioTrackSid = null;

    this.currentAudioStream = null;
    this.audioPumpToken = 0;
  }

  get connected() {
    return Boolean(this.room?.isConnected);
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

    const options = new TrackPublishOptions();
    options.source = TrackSource.SOURCE_MICROPHONE;

    const publication = await participant.publishTrack(this.audioTrack, options);
    this.audioTrackSid = publication?.sid ?? null;
  }

  _stopAudioPump() {
    this.audioPumpToken += 1;

    if (this.currentAudioStream?.destroy) {
      try {
        this.currentAudioStream.destroy();
      } catch {
        // ignore stream teardown errors
      }
    }

    this.currentAudioStream = null;

    try {
      this.audioSource?.clearQueue();
    } catch {
      // ignore queue clear errors
    }
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

  async _pumpPcmStream(stream, source, token) {
    let pending = Buffer.alloc(0);

    try {
      for await (const chunk of stream) {
        if (token !== this.audioPumpToken) break;

        const asBuffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        if (!asBuffer.length) continue;

        pending = pending.length ? Buffer.concat([pending, asBuffer]) : asBuffer;

        while (pending.length >= BYTES_PER_FRAME && token === this.audioPumpToken) {
          const frameBytes = pending.subarray(0, BYTES_PER_FRAME);
          pending = pending.subarray(BYTES_PER_FRAME);

          const samples = new Int16Array(frameBytes.buffer, frameBytes.byteOffset, SAMPLES_PER_FRAME);
          const frame = new AudioFrame(new Int16Array(samples), SAMPLE_RATE, CHANNELS, SAMPLES_PER_CHANNEL);

          if (source.queuedDuration > 500) {
            await source.waitForPlayout();
          }

          await source.captureFrame(frame);
        }
      }

      if (pending.length > 0 && token === this.audioPumpToken) {
        const padded = Buffer.alloc(BYTES_PER_FRAME);
        pending.copy(padded, 0, 0, Math.min(pending.length, BYTES_PER_FRAME));

        const samples = new Int16Array(padded.buffer, padded.byteOffset, SAMPLES_PER_FRAME);
        const frame = new AudioFrame(new Int16Array(samples), SAMPLE_RATE, CHANNELS, SAMPLES_PER_CHANNEL);
        await source.captureFrame(frame);
      }
    } finally {
      if (token === this.audioPumpToken) {
        this.currentAudioStream = null;
      }
    }
  }
}
