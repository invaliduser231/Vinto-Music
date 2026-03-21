import { MetricsRegistry } from '../monitoring/metrics.ts';
import type { BivariantCallback } from '../types/core.ts';
type GatewayMetricOptions = {
  onConnectedChange?: (connected: boolean) => void;
};

type AppMetricSet = ReturnType<typeof createAppMetrics>;
type GatewayLike = {
  on: (event: string, listener: BivariantCallback<unknown[], void>) => void;
  off: (event: string, listener: BivariantCallback<unknown[], void>) => void;
  getHeartbeatLatencyMs?: () => number | null;
};
type SessionsLike = {
  sessions: Map<string, unknown>;
  on: (event: string, listener: BivariantCallback<unknown[], void>) => void;
  off: (event: string, listener: BivariantCallback<unknown[], void>) => void;
};

export function createAppMetrics() {
  const registry = new MetricsRegistry();

  return {
    registry,
    sessionsActive: registry.gauge('sessions_active', 'Number of active guild sessions'),
    gatewayConnected: registry.gauge('gateway_connected', 'Gateway connection state (1=connected)'),
    gatewayHeartbeatLatencyMs: registry.gauge('gateway_heartbeat_latency_ms', 'Latest gateway heartbeat latency in milliseconds'),
    gatewayReconnects: registry.counter('gateway_reconnects_total', 'Gateway reconnect schedules'),
    tracksStarted: registry.counter('tracks_started_total', 'Tracks started'),
    trackErrors: registry.counter('track_errors_total', 'Track playback errors'),
    commandsTotal: registry.counter('commands_total', 'Commands processed by outcome'),
    restRetriesTotal: registry.counter('rest_retries_total', 'REST retries triggered'),
    restRateLimitedTotal: registry.counter('rest_rate_limited_total', 'REST responses with HTTP 429'),
    restGlobalRateLimitWaitMs: registry.counter('rest_global_rate_limit_wait_ms_total', 'Total wait time spent in global REST rate limits'),
    mongoConnected: registry.gauge('mongo_connected', 'MongoDB connection health (1=reachable)'),
    mongoPingLatencyMs: registry.gauge('mongo_ping_latency_ms', 'Latest MongoDB ping latency in milliseconds'),
    mongoPingFailuresTotal: registry.counter('mongo_ping_failures_total', 'MongoDB ping failures'),
  };
}

export function bindGatewayMetrics(gateway: GatewayLike, metricSet: AppMetricSet, options: GatewayMetricOptions = {}) {
  const onConnectedChange = options.onConnectedChange ?? (() => {});

  const onOpen = () => {
    metricSet.gatewayConnected.set(1);
    const latency = gateway.getHeartbeatLatencyMs?.();
    metricSet.gatewayHeartbeatLatencyMs.set(Number.isFinite(latency) ? Number(latency) : 0);
    onConnectedChange(true);
  };
  const onClose = () => {
    metricSet.gatewayConnected.set(0);
    metricSet.gatewayHeartbeatLatencyMs.set(0);
    onConnectedChange(false);
  };
  const onReconnectScheduled = () => {
    metricSet.gatewayReconnects.inc(1);
  };
  const onHeartbeatAck = (payload: { latencyMs?: number } | null | undefined) => {
    const latency = Number.isFinite(payload?.latencyMs)
      ? Number(payload?.latencyMs)
      : gateway.getHeartbeatLatencyMs?.();
    metricSet.gatewayHeartbeatLatencyMs.set(Number.isFinite(latency) ? Number(latency) : 0);
  };

  gateway.on('open', onOpen);
  gateway.on('close', onClose);
  gateway.on('reconnect_scheduled', onReconnectScheduled);
  gateway.on('heartbeat_ack', onHeartbeatAck);

  metricSet.gatewayConnected.set(0);
  metricSet.gatewayHeartbeatLatencyMs.set(0);

  return () => {
    gateway.off('open', onOpen);
    gateway.off('close', onClose);
    gateway.off('reconnect_scheduled', onReconnectScheduled);
    gateway.off('heartbeat_ack', onHeartbeatAck);
  };
}

export function bindSessionMetrics(sessions: SessionsLike, metricSet: AppMetricSet) {
  metricSet.sessionsActive.set(0);

  const onTrackStart = () => {
    metricSet.tracksStarted.inc(1);
    metricSet.sessionsActive.set(sessions.sessions.size);
  };
  const onTrackError = () => {
    metricSet.trackErrors.inc(1);
  };
  const onDestroyed = () => {
    metricSet.sessionsActive.set(sessions.sessions.size);
  };

  sessions.on('trackStart', onTrackStart);
  sessions.on('trackError', onTrackError);
  sessions.on('destroyed', onDestroyed);

  const interval = setInterval(() => {
    metricSet.sessionsActive.set(sessions.sessions.size);
  }, 5_000);
  interval.unref?.();

  return () => {
    clearInterval(interval);
    sessions.off('trackStart', onTrackStart);
    sessions.off('trackError', onTrackError);
    sessions.off('destroyed', onDestroyed);
  };
}




