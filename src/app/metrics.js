import { MetricsRegistry } from '../monitoring/metrics.js';

export function createAppMetrics() {
  const registry = new MetricsRegistry();

  return {
    registry,
    sessionsActive: registry.gauge('sessions_active', 'Number of active guild sessions'),
    gatewayConnected: registry.gauge('gateway_connected', 'Gateway connection state (1=connected)'),
    gatewayReconnects: registry.counter('gateway_reconnects_total', 'Gateway reconnect schedules'),
    tracksStarted: registry.counter('tracks_started_total', 'Tracks started'),
    trackErrors: registry.counter('track_errors_total', 'Track playback errors'),
    commandsTotal: registry.counter('commands_total', 'Commands processed by outcome'),
    restRetriesTotal: registry.counter('rest_retries_total', 'REST retries triggered'),
    restRateLimitedTotal: registry.counter('rest_rate_limited_total', 'REST responses with HTTP 429'),
    restGlobalRateLimitWaitMs: registry.counter('rest_global_rate_limit_wait_ms_total', 'Total wait time spent in global REST rate limits'),
  };
}

export function bindGatewayMetrics(gateway, metricSet, options = {}) {
  const onConnectedChange = options.onConnectedChange ?? (() => {});

  const onOpen = () => {
    metricSet.gatewayConnected.set(1);
    onConnectedChange(true);
  };
  const onClose = () => {
    metricSet.gatewayConnected.set(0);
    onConnectedChange(false);
  };
  const onReconnectScheduled = () => {
    metricSet.gatewayReconnects.inc(1);
  };

  gateway.on('open', onOpen);
  gateway.on('close', onClose);
  gateway.on('reconnect_scheduled', onReconnectScheduled);

  metricSet.gatewayConnected.set(0);

  return () => {
    gateway.off('open', onOpen);
    gateway.off('close', onClose);
    gateway.off('reconnect_scheduled', onReconnectScheduled);
  };
}

export function bindSessionMetrics(sessions, metricSet) {
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
