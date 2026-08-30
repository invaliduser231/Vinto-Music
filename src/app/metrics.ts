import { MetricsRegistry } from '../monitoring/metrics.ts';
import type { BivariantCallback } from '../types/core.ts';
type GatewayMetricOptions = {
  onConnectedChange?: (connected: boolean) => void;
};

type AppMetricSet = ReturnType<typeof createAppMetrics>;
type SessionMemoryTelemetry = {
  sessionsTotal: number;
  voiceConnectionsConnected: number;
  playersPlaying: number;
  snapshotDirty: number;
  diagnosticsActive: number;
  idleTimersActive: number;
  playerListenerEntries: number;
  pendingTracksTotal: number;
  voiceQueuedDurationMsMax?: number;
};
type GatewayLike = {
  on: (event: string, listener: BivariantCallback<unknown[], void>) => void;
  off: (event: string, listener: BivariantCallback<unknown[], void>) => void;
  getHeartbeatLatencyMs?: () => number | null;
};
type SessionsLike = {
  sessions: Map<string, unknown>;
  on: (event: string, listener: BivariantCallback<unknown[], void>) => void;
  off: (event: string, listener: BivariantCallback<unknown[], void>) => void;
  getMemoryTelemetry?: () => SessionMemoryTelemetry;
};
type SessionMetricOptions = {
  telemetryIntervalMs?: number;
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
    processHeapUsedBytes: registry.gauge('process_heap_used_bytes', 'Process heap currently used in bytes'),
    processHeapTotalBytes: registry.gauge('process_heap_total_bytes', 'Process heap currently allocated in bytes'),
    processRssBytes: registry.gauge('process_rss_bytes', 'Process RSS in bytes'),
    processExternalBytes: registry.gauge('process_external_bytes', 'Process external memory in bytes'),
    processArrayBuffersBytes: registry.gauge('process_array_buffers_bytes', 'Process array buffer memory in bytes'),
    sessionsVoiceConnected: registry.gauge('sessions_voice_connected', 'Sessions with an active voice connection'),
    sessionsPlaying: registry.gauge('sessions_playing', 'Sessions currently playing audio'),
    sessionsSnapshotDirty: registry.gauge('sessions_snapshot_dirty', 'Sessions with dirty snapshots pending persistence'),
    sessionsDiagnosticsActive: registry.gauge('sessions_diagnostics_active', 'Sessions with playback diagnostics timers running'),
    sessionsIdleTimersActive: registry.gauge('sessions_idle_timers_active', 'Sessions currently holding idle timers'),
    sessionPlayerListenerEntries: registry.gauge('session_player_listener_entries', 'Tracked player listener sets in SessionManager'),
    sessionPendingTracks: registry.gauge('session_pending_tracks', 'Total pending tracks across all sessions'),
    voiceQueuedDurationMs: registry.gauge('voice_queued_duration_ms', 'Deepest outbound voice buffer across sessions in milliseconds'),
    lastfmScrobblesTotal: registry.counter('lastfm_scrobbles_total', 'Tracks scrobbled to Last.fm'),
    lastfmScrobbleFailuresTotal: registry.counter('lastfm_scrobble_failures_total', 'Failed Last.fm scrobble submissions'),
    lastfmNowPlayingTotal: registry.counter('lastfm_now_playing_total', 'Last.fm now playing updates sent'),
    lastfmAccountsLinked: registry.gauge('lastfm_accounts_linked', 'Linked Last.fm accounts'),
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

export function bindSessionMetrics(sessions: SessionsLike, metricSet: AppMetricSet, options: SessionMetricOptions = {}) {
  const telemetryIntervalMs = Math.max(1_000, Number.parseInt(String(options.telemetryIntervalMs ?? 5_000), 10) || 5_000);
  metricSet.sessionsActive.set(0);
  metricSet.sessionsVoiceConnected.set(0);
  metricSet.sessionsPlaying.set(0);
  metricSet.sessionsSnapshotDirty.set(0);
  metricSet.sessionsDiagnosticsActive.set(0);
  metricSet.sessionsIdleTimersActive.set(0);
  metricSet.sessionPlayerListenerEntries.set(0);
  metricSet.sessionPendingTracks.set(0);
  metricSet.voiceQueuedDurationMs.set(0);
  metricSet.processHeapUsedBytes.set(0);
  metricSet.processHeapTotalBytes.set(0);
  metricSet.processRssBytes.set(0);
  metricSet.processExternalBytes.set(0);
  metricSet.processArrayBuffersBytes.set(0);

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
  const publishTelemetry = () => {
    metricSet.sessionsActive.set(sessions.sessions.size);

    const memory = process.memoryUsage();
    metricSet.processHeapUsedBytes.set(memory.heapUsed);
    metricSet.processHeapTotalBytes.set(memory.heapTotal);
    metricSet.processRssBytes.set(memory.rss);
    metricSet.processExternalBytes.set(memory.external);
    metricSet.processArrayBuffersBytes.set(memory.arrayBuffers);

    const telemetry = sessions.getMemoryTelemetry?.();
    if (!telemetry) return;

    metricSet.sessionsVoiceConnected.set(telemetry.voiceConnectionsConnected);
    metricSet.sessionsPlaying.set(telemetry.playersPlaying);
    metricSet.sessionsSnapshotDirty.set(telemetry.snapshotDirty);
    metricSet.sessionsDiagnosticsActive.set(telemetry.diagnosticsActive);
    metricSet.sessionsIdleTimersActive.set(telemetry.idleTimersActive);
    metricSet.sessionPlayerListenerEntries.set(telemetry.playerListenerEntries);
    metricSet.sessionPendingTracks.set(telemetry.pendingTracksTotal);
    metricSet.voiceQueuedDurationMs.set(Number(telemetry.voiceQueuedDurationMsMax ?? 0));
  };

  sessions.on('trackStart', onTrackStart);
  sessions.on('trackError', onTrackError);
  sessions.on('destroyed', onDestroyed);

  const interval = setInterval(() => {
    publishTelemetry();
  }, telemetryIntervalMs);
  interval.unref?.();
  publishTelemetry();

  return () => {
    clearInterval(interval);
    sessions.off('trackStart', onTrackStart);
    sessions.off('trackError', onTrackError);
    sessions.off('destroyed', onDestroyed);
  };
}




