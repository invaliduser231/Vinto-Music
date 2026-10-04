export const GATEWAY_RECONNECT_ACTIVITY_WINDOW_MS = 120_000;

export interface UnhealthyExitPolicy {
  unhealthyExitAfterMs: number;
  gatewayOutageExitAfterMs: number;
}

export interface UnhealthyExitState {
  gatewayConnected: boolean;
  lastGatewayReconnectActivityAtMs: number | null;
  nowMs: number;
}

export function isGatewayRecovering(state: UnhealthyExitState): boolean {
  if (state.gatewayConnected || state.lastGatewayReconnectActivityAtMs == null) return false;
  return state.nowMs - state.lastGatewayReconnectActivityAtMs <= GATEWAY_RECONNECT_ACTIVITY_WINDOW_MS;
}

export function unhealthyExitThresholdMs(policy: UnhealthyExitPolicy, state: UnhealthyExitState): number {
  if (!isGatewayRecovering(state)) return policy.unhealthyExitAfterMs;
  return Math.max(policy.unhealthyExitAfterMs, policy.gatewayOutageExitAfterMs);
}
