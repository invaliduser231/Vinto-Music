import { EventEmitter } from 'node:events';
import WebSocket from 'ws';

const Op = {
  DISPATCH: 0,
  HEARTBEAT: 1,
  IDENTIFY: 2,
  PRESENCE_UPDATE: 3,
  VOICE_STATE_UPDATE: 4,
  RESUME: 6,
  RECONNECT: 7,
  INVALID_SESSION: 9,
  HELLO: 10,
  HEARTBEAT_ACK: 11,
  GATEWAY_ERROR: 12,
};

const NON_RECOVERABLE_CLOSE_CODES = new Set([
  4004, // authentication failed
  4010, // invalid shard
  4011, // sharding required
  4012, // invalid API version
  4014, // disallowed intents
]);
const MIN_HEARTBEAT_INTERVAL_MS = 100;
const MAX_HEARTBEAT_INTERVAL_MS = 60_000;
const SEQUENCE_ACK_HEARTBEAT_INTERVAL_MS = 750;

type GatewayOptions = {
  url: string;
  token: string;
  intents?: number;
  logger?: {
    info?: (message: string, meta?: Record<string, unknown>) => void;
    warn?: (message: string, meta?: Record<string, unknown>) => void;
    error?: (message: string, meta?: Record<string, unknown>) => void;
  } | null;
  reconnectBaseDelayMs?: number;
  reconnectMaxDelayMs?: number;
  handshakeTimeoutMs?: number;
  connectOpenTimeoutMs?: number;
  initialPresence?: Record<string, unknown> | null;
};

type GatewayPresence = Record<string, unknown>;
type GatewayLogger = NonNullable<GatewayOptions['logger']>;
type TimerHandle = ReturnType<typeof setTimeout> | null;
type IntervalHandle = ReturnType<typeof setInterval> | null;
type WsLike = {
  readyState: number;
  on: (event: string, listener: (...args: unknown[]) => void) => void;
  close: (code?: number, reason?: string) => void;
  terminate: () => void;
  send: (data: string) => void;
} | null;

type GatewayPacket = {
  op?: unknown;
  d?: unknown;
  t?: unknown;
  s?: unknown;
};

type HelloPayload = {
  heartbeat_interval?: unknown;
};

type ReadyPayload = {
  session_id?: unknown;
  user?: { username?: unknown } | null;
};

function isGatewayPacket(value: unknown): value is GatewayPacket {
  return Boolean(value && typeof value === 'object');
}

type GatewayIdentifyPayload = {
  token: string;
  intents: number;
  properties: {
    os: string;
    browser: string;
    device: string;
  };
  presence?: GatewayPresence;
};

function withGatewayQuery(url: string) {
  const parsed = new URL(url);

  if (!parsed.searchParams.has('v')) {
    parsed.searchParams.set('v', '1');
  }

  if (!parsed.searchParams.has('encoding')) {
    parsed.searchParams.set('encoding', 'json');
  }

  return parsed.toString();
}

function randomBetween(min: number, max: number) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function normalizeHeartbeatIntervalMs(value: unknown) {
  const intervalMs = Number(value);
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) return null;
  return Math.max(MIN_HEARTBEAT_INTERVAL_MS, Math.min(MAX_HEARTBEAT_INTERVAL_MS, Math.floor(intervalMs)));
}

export class Gateway extends EventEmitter {
  [key: string]: unknown;
  url: string;
  token: string;
  intents: number;
  logger: GatewayLogger | null | undefined;
  reconnectBaseDelayMs: number;
  reconnectMaxDelayMs: number;
  handshakeTimeoutMs: number;
  connectOpenTimeoutMs: number;
  ws: WsLike;
  heartbeatIntervalMs: number | null;
  heartbeatIntervalHandle: IntervalHandle;
  heartbeatStartTimeoutHandle: TimerHandle;
  sequenceAckHeartbeatTimeoutHandle: TimerHandle;
  reconnectTimeoutHandle: TimerHandle;
  connectOpenTimeoutHandle: TimerHandle;
  helloTimeoutHandle: TimerHandle;
  invalidSessionTimeoutHandle: TimerHandle;
  sequence: number | null;
  sessionId: string | null;
  awaitingHeartbeatAck;
  lastHeartbeatSentAt: number | null;
  heartbeatLatencyMs: number | null;
  lastSequenceAckSentAt: number;
  lastSequenceAckSent: number;
  reconnectAttempts: number;
  manualDisconnect;
  initialPresence: GatewayPresence | null;
  constructor(options: GatewayOptions) {
    super();

    this.url = withGatewayQuery(options.url);
    this.token = options.token.startsWith('Bot ') ? options.token.slice(4) : options.token;
    this.intents = options.intents ?? 0;
    this.logger = options.logger ?? null;

    this.reconnectBaseDelayMs = options.reconnectBaseDelayMs ?? 1_000;
    this.reconnectMaxDelayMs = options.reconnectMaxDelayMs ?? 30_000;
    this.handshakeTimeoutMs = options.handshakeTimeoutMs ?? 15_000;
    this.connectOpenTimeoutMs = options.connectOpenTimeoutMs ?? 15_000;

    this.ws = null;
    this.heartbeatIntervalMs = null;
    this.heartbeatIntervalHandle = null;
    this.heartbeatStartTimeoutHandle = null;
    this.sequenceAckHeartbeatTimeoutHandle = null;
    this.reconnectTimeoutHandle = null;
    this.connectOpenTimeoutHandle = null;
    this.helloTimeoutHandle = null;
    this.invalidSessionTimeoutHandle = null;

    this.sequence = null;
    this.sessionId = null;

    this.awaitingHeartbeatAck = false;
    this.lastHeartbeatSentAt = null;
    this.heartbeatLatencyMs = null;
    this.lastSequenceAckSentAt = 0;
    this.lastSequenceAckSent = 0;
    this.reconnectAttempts = 0;
    this.manualDisconnect = false;
    this.initialPresence = options.initialPresence ?? null;
  }

  getHeartbeatLatencyMs() {
    return Number.isFinite(this.heartbeatLatencyMs) ? this.heartbeatLatencyMs : null;
  }

  async sampleHeartbeatLatency(timeoutMs = 4_000) {
    const socket = this.ws;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return null;
    }

    return new Promise((resolve) => {
      let settled = false;

      const finish = (value: number | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutHandle);
        this.off('heartbeat_ack', onAck);
        resolve(value);
      };

      const onAck = (payload: { latencyMs?: number | null } | null) => {
        const latency = Number.isFinite(payload?.latencyMs)
          ? (payload?.latencyMs ?? null)
          : this.getHeartbeatLatencyMs();
        finish(latency);
      };

      const timeoutHandle = setTimeout(() => {
        finish(this.getHeartbeatLatencyMs());
      }, Math.max(250, Number.parseInt(String(timeoutMs), 10) || 4_000));

      this.on('heartbeat_ack', onAck);
      this._sendHeartbeat();
    });
  }

  connect() {
    this.manualDisconnect = false;
    this._openSocket();
  }

  disconnect() {
    this.manualDisconnect = true;
    this._clearTimers();

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.close(1000, 'manual shutdown');
    }

    if (this.ws && this.ws.readyState === WebSocket.CONNECTING) {
      this.ws.terminate();
    }

    this.ws = null;
  }

  joinVoice(guildId: string, channelId: string) {
    this._send(Op.VOICE_STATE_UPDATE, {
      guild_id: guildId,
      channel_id: channelId,
      self_mute: false,
      self_deaf: true,
    });
  }

  leaveVoice(guildId: string) {
    this._send(Op.VOICE_STATE_UPDATE, {
      guild_id: guildId,
      channel_id: null,
      self_mute: false,
      self_deaf: false,
    });
  }

  updatePresence(presence: GatewayPresence | null | undefined) {
    if (!presence || typeof presence !== 'object') return false;
    this.initialPresence = presence;
    this._send(Op.PRESENCE_UPDATE, presence);
    return true;
  }

  _openSocket() {
    this._clearTimers();

    this.ws = new WebSocket(this.url, {
      handshakeTimeout: this.handshakeTimeoutMs,
      perMessageDeflate: false,
    }) as unknown as NonNullable<WsLike>;

    this.connectOpenTimeoutHandle = setTimeout(() => {
      if (this.ws && this.ws.readyState === WebSocket.CONNECTING) {
        this.logger?.warn?.('Gateway open timeout reached, terminating socket', {
          timeoutMs: this.connectOpenTimeoutMs,
        });
        this.ws.terminate();
      }
    }, this.connectOpenTimeoutMs);

    this.ws?.on('open', () => {
      this.reconnectAttempts = 0;
      if (this.connectOpenTimeoutHandle) {
        clearTimeout(this.connectOpenTimeoutHandle);
        this.connectOpenTimeoutHandle = null;
      }

      this.helloTimeoutHandle = setTimeout(() => {
        this.logger?.warn?.('Gateway HELLO timeout reached, terminating socket', {
          timeoutMs: this.handshakeTimeoutMs,
        });
        this.ws?.terminate();
      }, this.handshakeTimeoutMs);

      this.logger?.info?.('Gateway connected');
      this.emit('open');
    });

    this.ws?.on('message', (raw: unknown) => {
      try {
        const text = typeof raw === 'string' ? raw : Buffer.isBuffer(raw) ? raw.toString() : String(raw ?? '');
        const packet = JSON.parse(text) as unknown;
        this._handlePacket(packet);
      } catch (err) {
        this.logger?.warn?.('Gateway packet parsing failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });

    this.ws?.on('close', (code: unknown, reason: unknown) => {
      const closeCode = Number(code);
      const closeReason = Buffer.isBuffer(reason)
        ? reason.toString()
        : String(reason ?? '');
      this.emit('close', closeCode);
      this._handleClose(Number.isFinite(closeCode) ? closeCode : 1006, closeReason);
    });

    this.ws?.on('error', (err: unknown) => {
      this.logger?.warn?.('Gateway socket error', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  _handlePacket(packet: unknown) {
    if (!isGatewayPacket(packet)) return;
    const { op, d, t, s } = packet;
    const opCode = typeof op === 'number' ? op : Number.NaN;
    const eventName = typeof t === 'string' ? t : null;

    if (s != null) {
      const nextSequence = Number(s);
      this.sequence = Number.isFinite(nextSequence) ? nextSequence : this.sequence;
    }

    switch (opCode) {
      case Op.HELLO:
        if (this.helloTimeoutHandle) {
          clearTimeout(this.helloTimeoutHandle);
          this.helloTimeoutHandle = null;
        }

        this.heartbeatIntervalMs = normalizeHeartbeatIntervalMs((d as HelloPayload | null | undefined)?.heartbeat_interval);
        this._startHeartbeat();

        if (this.sessionId && this.sequence != null) {
          this._resume();
        } else {
          this._identify();
        }
        break;

      case Op.HEARTBEAT:
        this._sendHeartbeat();
        break;

      case Op.HEARTBEAT_ACK:
        if (Number.isFinite(this.lastHeartbeatSentAt)) {
          this.heartbeatLatencyMs = Math.max(0, Date.now() - (this.lastHeartbeatSentAt ?? 0));
        }
        this.emit('heartbeat_ack', { latencyMs: this.heartbeatLatencyMs });
        this.awaitingHeartbeatAck = false;
        this._scheduleSequenceAckHeartbeat();
        break;

      case Op.RECONNECT:
        this.logger?.warn?.('Gateway requested reconnect');
        this._reconnectNow();
        break;

      case Op.INVALID_SESSION:
        this.logger?.warn?.('Gateway invalid session', { canResume: Boolean(d) });
        if (!d) {
          this.sessionId = null;
          this.sequence = null;
        }

        if (this.invalidSessionTimeoutHandle) {
          clearTimeout(this.invalidSessionTimeoutHandle);
          this.invalidSessionTimeoutHandle = null;
        }

        this.invalidSessionTimeoutHandle = setTimeout(() => {
          this.invalidSessionTimeoutHandle = null;

          if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            this._scheduleReconnect('invalid_session_socket_closed');
            return;
          }

          if (Boolean(d) && this.sessionId && this.sequence != null) {
            this._resume();
            return;
          }

          this._identify();
        }, randomBetween(1_000, 5_000));
        break;

      case Op.DISPATCH:
        if (eventName === 'READY') {
          const ready = d as ReadyPayload | null | undefined;
          this.sessionId = String(ready?.session_id ?? '') || null;
          this.reconnectAttempts = 0;
          this.logger?.info?.('Gateway ready', {
            user: String(ready?.user?.username ?? 'unknown'),
          });
        }

        if (eventName === 'RESUMED') {
          this.reconnectAttempts = 0;
          this.logger?.info?.('Gateway session resumed');
        }

        if (eventName) {
          this.emit(eventName, d);
        }

        this._scheduleSequenceAckHeartbeat();
        break;

      case Op.GATEWAY_ERROR:
        this.logger?.warn?.('Gateway reported an error', {
          details: d ?? null,
        });
        this.emit('GATEWAY_ERROR', d);
        break;

      default:
        break;
    }
  }

  _identify() {
    const payload: GatewayIdentifyPayload = {
      token: this.token,
      intents: this.intents,
      properties: {
        os: process.platform,
        browser: 'fluxer-music-bot',
        device: 'fluxer-music-bot',
      },
    };

    if (this.initialPresence && typeof this.initialPresence === 'object') {
      payload.presence = this.initialPresence;
    }

    this._send(Op.IDENTIFY, payload);
  }

  _resume() {
    this._send(Op.RESUME, {
      token: this.token,
      session_id: this.sessionId,
      seq: this.sequence,
    });
  }

  _startHeartbeat() {
    if (!this.heartbeatIntervalMs) return;

    if (this.heartbeatIntervalHandle) {
      clearInterval(this.heartbeatIntervalHandle);
      this.heartbeatIntervalHandle = null;
    }

    // Clamp the gateway-provided heartbeat so malformed remote values cannot pin local timers indefinitely.
    const heartbeatIntervalMs = normalizeHeartbeatIntervalMs(this.heartbeatIntervalMs);
    if (!heartbeatIntervalMs) return;

    const initialDelay = randomBetween(0, heartbeatIntervalMs);
    this.heartbeatStartTimeoutHandle = setTimeout(() => {
      this.heartbeatStartTimeoutHandle = null;
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      this._sendHeartbeat();

      this.heartbeatIntervalHandle = setInterval(() => {
        if (this.awaitingHeartbeatAck) {
          this.logger?.warn?.('Gateway heartbeat ACK timeout, terminating socket');
          this.ws?.terminate();
          return;
        }

        this._sendHeartbeat();
      }, heartbeatIntervalMs);
    }, initialDelay);
  }

  _sendHeartbeat() {
    this.lastHeartbeatSentAt = Date.now();
    this.awaitingHeartbeatAck = true;
    const sent = this._send(Op.HEARTBEAT, this.sequence);
    if (sent && this.sequence != null) {
      this.lastSequenceAckSentAt = this.lastHeartbeatSentAt;
      this.lastSequenceAckSent = this.sequence;
    }
    return sent;
  }

  _scheduleSequenceAckHeartbeat() {
    if (this.sequence == null || this.sequence <= this.lastSequenceAckSent) return false;
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;

    if (this.awaitingHeartbeatAck) {
      return false;
    }

    const now = Date.now();
    const elapsedMs = now - this.lastSequenceAckSentAt;
    const delayMs = Math.max(0, SEQUENCE_ACK_HEARTBEAT_INTERVAL_MS - elapsedMs);

    if (delayMs === 0) {
      return this._sendHeartbeat();
    }

    if (this.sequenceAckHeartbeatTimeoutHandle) {
      return false;
    }

    // Fluxer uses heartbeat sequence numbers as delivery acknowledgements, so
    // busy startup dispatch bursts need acks before the normal heartbeat tick.
    this.sequenceAckHeartbeatTimeoutHandle = setTimeout(() => {
      this.sequenceAckHeartbeatTimeoutHandle = null;
      this._scheduleSequenceAckHeartbeat();
    }, delayMs);
    return false;
  }

  _send(op: number, d: unknown) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;

    this.ws.send(JSON.stringify({ op, d }));
    return true;
  }

  _handleClose(code: number, reason = '') {
    this._clearTimers();

    if (this.manualDisconnect) {
      this.logger?.info?.('Gateway disconnected manually', { code, reason: reason || null });
      return;
    }

    if (NON_RECOVERABLE_CLOSE_CODES.has(code)) {
      this.logger?.error?.('Gateway closed with non-recoverable code, reconnect aborted', {
        code,
        reason: reason || null,
      });
      return;
    }

    if ([4007, 4009].includes(code)) {
      this.sessionId = null;
      this.sequence = null;
    }

    this._scheduleReconnect(code);
  }

  _reconnectNow() {
    if (!this.ws) {
      this._scheduleReconnect('manual_reconnect');
      return;
    }

    if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
      this.ws.terminate();
      return;
    }

    this._scheduleReconnect('stale_socket');
  }

  _scheduleReconnect(reason: string | number) {
    if (this.reconnectTimeoutHandle) return;

    this.reconnectAttempts += 1;

    const delay = Math.min(
      this.reconnectMaxDelayMs,
      this.reconnectBaseDelayMs * 2 ** (this.reconnectAttempts - 1)
    ) + randomBetween(0, 300);

    this.logger?.warn?.('Gateway reconnect scheduled', {
      reason,
      reconnectAttempts: this.reconnectAttempts,
      delay,
    });
    this.emit('reconnect_scheduled', {
      reason,
      reconnectAttempts: this.reconnectAttempts,
      delayMs: delay,
    });

    this.reconnectTimeoutHandle = setTimeout(() => {
      this.reconnectTimeoutHandle = null;
      this._openSocket();
    }, delay);
  }

  _clearTimers() {
    if (this.heartbeatStartTimeoutHandle) {
      clearTimeout(this.heartbeatStartTimeoutHandle);
      this.heartbeatStartTimeoutHandle = null;
    }

    if (this.heartbeatIntervalHandle) {
      clearInterval(this.heartbeatIntervalHandle);
      this.heartbeatIntervalHandle = null;
    }

    if (this.sequenceAckHeartbeatTimeoutHandle) {
      clearTimeout(this.sequenceAckHeartbeatTimeoutHandle);
      this.sequenceAckHeartbeatTimeoutHandle = null;
    }

    if (this.reconnectTimeoutHandle) {
      clearTimeout(this.reconnectTimeoutHandle);
      this.reconnectTimeoutHandle = null;
    }

    if (this.invalidSessionTimeoutHandle) {
      clearTimeout(this.invalidSessionTimeoutHandle);
      this.invalidSessionTimeoutHandle = null;
    }

    if (this.connectOpenTimeoutHandle) {
      clearTimeout(this.connectOpenTimeoutHandle);
      this.connectOpenTimeoutHandle = null;
    }

    if (this.helloTimeoutHandle) {
      clearTimeout(this.helloTimeoutHandle);
      this.helloTimeoutHandle = null;
    }

    this.awaitingHeartbeatAck = false;
  }
}




