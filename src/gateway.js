import { EventEmitter } from 'events';
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
};

const NON_RECOVERABLE_CLOSE_CODES = new Set([
  4004, // authentication failed
  4010, // invalid shard
  4011, // sharding required
  4012, // invalid API version
  4013, // invalid intents
  4014, // disallowed intents
]);

function withGatewayQuery(url) {
  const parsed = new URL(url);

  if (!parsed.searchParams.has('v')) {
    parsed.searchParams.set('v', '1');
  }

  if (!parsed.searchParams.has('encoding')) {
    parsed.searchParams.set('encoding', 'json');
  }

  return parsed.toString();
}

function randomBetween(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

export class Gateway extends EventEmitter {
  constructor(options) {
    super();

    this.url = withGatewayQuery(options.url);
    this.token = options.token.startsWith('Bot ') ? options.token.slice(4) : options.token;
    this.intents = options.intents ?? 0;
    this.logger = options.logger;

    this.reconnectBaseDelayMs = options.reconnectBaseDelayMs ?? 1_000;
    this.reconnectMaxDelayMs = options.reconnectMaxDelayMs ?? 30_000;
    this.handshakeTimeoutMs = options.handshakeTimeoutMs ?? 15_000;
    this.connectOpenTimeoutMs = options.connectOpenTimeoutMs ?? 15_000;

    this.ws = null;
    this.heartbeatIntervalMs = null;
    this.heartbeatIntervalHandle = null;
    this.heartbeatStartTimeoutHandle = null;
    this.reconnectTimeoutHandle = null;
    this.connectOpenTimeoutHandle = null;
    this.helloTimeoutHandle = null;
    this.invalidSessionTimeoutHandle = null;

    this.sequence = null;
    this.sessionId = null;

    this.awaitingHeartbeatAck = false;
    this.lastHeartbeatSentAt = null;
    this.heartbeatLatencyMs = null;
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

      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutHandle);
        this.off('heartbeat_ack', onAck);
        resolve(value);
      };

      const onAck = (payload) => {
        const latency = Number.isFinite(payload?.latencyMs)
          ? payload.latencyMs
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

  joinVoice(guildId, channelId) {
    this._send(Op.VOICE_STATE_UPDATE, {
      guild_id: guildId,
      channel_id: channelId,
      self_mute: false,
      self_deaf: true,
    });
  }

  leaveVoice(guildId) {
    this._send(Op.VOICE_STATE_UPDATE, {
      guild_id: guildId,
      channel_id: null,
      self_mute: false,
      self_deaf: false,
    });
  }

  updatePresence(presence) {
    if (!presence || typeof presence !== 'object') return false;
    this._send(Op.PRESENCE_UPDATE, presence);
    return true;
  }

  _openSocket() {
    this._clearTimers();

    this.ws = new WebSocket(this.url, {
      handshakeTimeout: this.handshakeTimeoutMs,
      perMessageDeflate: false,
    });

    this.connectOpenTimeoutHandle = setTimeout(() => {
      if (this.ws && this.ws.readyState === WebSocket.CONNECTING) {
        this.logger?.warn?.('Gateway open timeout reached, terminating socket', {
          timeoutMs: this.connectOpenTimeoutMs,
        });
        this.ws.terminate();
      }
    }, this.connectOpenTimeoutMs);

    this.ws.on('open', () => {
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

    this.ws.on('message', (raw) => {
      try {
        const packet = JSON.parse(raw.toString());
        this._handlePacket(packet);
      } catch (err) {
        this.logger?.warn?.('Gateway packet parsing failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });

    this.ws.on('close', (code) => {
      this.emit('close', code);
      this._handleClose(code);
    });

    this.ws.on('error', (err) => {
      this.logger?.warn?.('Gateway socket error', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  _handlePacket(packet) {
    const { op, d, t, s } = packet;

    if (s != null) {
      this.sequence = s;
    }

    switch (op) {
      case Op.HELLO:
        if (this.helloTimeoutHandle) {
          clearTimeout(this.helloTimeoutHandle);
          this.helloTimeoutHandle = null;
        }

        this.heartbeatIntervalMs = d.heartbeat_interval;
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
          this.heartbeatLatencyMs = Math.max(0, Date.now() - this.lastHeartbeatSentAt);
        }
        this.emit('heartbeat_ack', { latencyMs: this.heartbeatLatencyMs });
        this.awaitingHeartbeatAck = false;
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
        if (t === 'READY') {
          this.sessionId = d.session_id;
          this.reconnectAttempts = 0;
          this.logger?.info?.('Gateway ready', {
            user: d?.user?.username ?? 'unknown',
          });
        }

        if (t === 'RESUMED') {
          this.reconnectAttempts = 0;
          this.logger?.info?.('Gateway session resumed');
        }

        this.emit(t, d);
        break;

      default:
        break;
    }
  }

  _identify() {
    const payload = {
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

    const initialDelay = randomBetween(0, Math.max(100, this.heartbeatIntervalMs));
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
      }, this.heartbeatIntervalMs);
    }, initialDelay);
  }

  _sendHeartbeat() {
    this.lastHeartbeatSentAt = Date.now();
    this.awaitingHeartbeatAck = true;
    this._send(Op.HEARTBEAT, this.sequence);
  }

  _send(op, d) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    this.ws.send(JSON.stringify({ op, d }));
  }

  _handleClose(code) {
    this._clearTimers();

    if (this.manualDisconnect) {
      this.logger?.info?.('Gateway disconnected manually');
      return;
    }

    if (NON_RECOVERABLE_CLOSE_CODES.has(code)) {
      this.logger?.error?.('Gateway closed with non-recoverable code, reconnect aborted', { code });
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

  _scheduleReconnect(reason) {
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
