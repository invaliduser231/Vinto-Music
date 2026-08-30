import type { DashboardSession } from '@/types/session';
import { requestBotTicket, resolveWebSocketUrl } from '@/lib/bot-client';

const STORAGE_KEY = 'vinto-dashboard-dev';

export type DevConnectSettings = {
  guildId: string;
  voiceChannelId: string;
  userId: string;
  roleIds: string;
};

export const defaultDevConnectSettings = (): DevConnectSettings => ({
  guildId: '',
  voiceChannelId: '',
  userId: '',
  roleIds: '',
});

export function loadDevConnectSettings(): DevConnectSettings {
  if (typeof window === 'undefined') return defaultDevConnectSettings();
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultDevConnectSettings();
    const parsed = JSON.parse(raw) as Partial<DevConnectSettings>;
    return {
      ...defaultDevConnectSettings(),
      ...parsed,
    };
  } catch {
    return defaultDevConnectSettings();
  }
}

export function saveDevConnectSettings(settings: DevConnectSettings): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
}

export function useMockSession(): boolean {
  const flag = String(process.env.NEXT_PUBLIC_USE_MOCK_SESSION ?? '').trim().toLowerCase();
  return flag === '1' || flag === 'true' || flag === 'yes';
}

export type DashboardActionName =
  | 'join'
  | 'leave'
  | 'voteSkip'
  | 'search'
  | 'favoriteCurrent'
  | 'autoplay'
  | 'saveTemplate'
  | 'libraryPlay'
  | 'handoff'
  | 'lastFm'
  | 'party'
  | 'pause'
  | 'resume'
  | 'skip'
  | 'shuffle'
  | 'loop'
  | 'previous'
  | 'volume'
  | 'seek'
  | 'remove'
  | 'reorder'
  | 'playQueueIndex'
  | 'playHistory'
  | 'clear'
  | 'replay'
  | 'effects'
  | 'enqueue'
  | 'favoriteRename'
  | 'favoriteRemove'
  | 'playlistCreate'
  | 'playlistDelete'
  | 'playlistAddCurrent'
  | 'templateDelete'
  | 'stationCreate'
  | 'stationDelete';

export type LiveSessionClientOptions = {
  settings: DevConnectSettings;
  onSession: (session: DashboardSession, serverTs: number) => void;
  onStatus: (status: 'connecting' | 'open' | 'closed' | 'error') => void;
  onError?: (message: string) => void;
  onActionResult?: (action: DashboardActionName, data: Record<string, unknown>) => void;
  onSpectrum?: (bands: number[]) => void;
};

export class LiveSessionClient {
  private socket: WebSocket | null = null;
  private settings: DevConnectSettings;
  private onSession: LiveSessionClientOptions['onSession'];
  private onStatus: LiveSessionClientOptions['onStatus'];
  private onError: LiveSessionClientOptions['onError'];
  private onActionResult: LiveSessionClientOptions['onActionResult'];
  private onSpectrum: LiveSessionClientOptions['onSpectrum'];
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closedByUser = false;

  constructor(options: LiveSessionClientOptions) {
    this.settings = options.settings;
    this.onSession = options.onSession;
    this.onStatus = options.onStatus;
    this.onError = options.onError;
    this.onActionResult = options.onActionResult;
    this.onSpectrum = options.onSpectrum;
  }

  updateSettings(settings: DevConnectSettings): void {
    this.settings = settings;
    this.reconnect();
  }

  connect(): void {
    this.closedByUser = false;
    this.openSocket();
  }

  disconnect(): void {
    this.closedByUser = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
    this.onStatus('closed');
  }

  reconnect(): void {
    this.disconnect();
    this.closedByUser = false;
    this.openSocket();
  }

  sendAction(action: DashboardActionName, payload: Record<string, unknown> = {}): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      this.onError?.('not_connected');
      return;
    }
    this.socket.send(JSON.stringify({
      op: 'action',
      action,
      requestId: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      ...payload,
      guildId: this.settings.guildId,
      voiceChannelId: this.settings.voiceChannelId,
    }));
  }

  private openSocket(): void {
    void this.openSocketWithTicket();
  }

  private async openSocketWithTicket(): Promise<void> {
    const { guildId, voiceChannelId } = this.settings;
    const wsUrl = resolveWebSocketUrl();
    if (!wsUrl || !guildId || !voiceChannelId) {
      this.onStatus('error');
      return;
    }

    this.onStatus('connecting');
    const credentials = await requestBotTicket();
    if (this.closedByUser) return;
    if (!credentials) {
      this.onStatus('error');
      this.scheduleReconnect();
      return;
    }

    const socket = new WebSocket(wsUrl);
    this.socket = socket;

    socket.addEventListener('open', () => {
      this.onStatus('open');
      socket.send(JSON.stringify({ op: 'auth', ticket: credentials.ticket }));
      socket.send(JSON.stringify({
        op: 'subscribe',
        guildId,
        voiceChannelId,
      }));
    });

    socket.addEventListener('message', (event) => {
      try {
        const payload = JSON.parse(String(event.data ?? '')) as {
          op?: string;
          data?: DashboardSession;
          ts?: number;
          message?: string;
          action?: DashboardActionName;
          ok?: boolean;
          [key: string]: unknown;
        };
        if (payload.op === 'session' && payload.data) {
          this.onSession(payload.data, Number(payload.ts ?? Date.now()));
          return;
        }
        if (payload.op === 'spectrum') {
          const bands = (payload as { bands?: unknown }).bands;
          if (Array.isArray(bands)) this.onSpectrum?.(bands as number[]);
          return;
        }
        if (payload.op === 'error') {
          this.onError?.(String(payload.message ?? 'request failed'));
          return;
        }
        if (payload.op === 'action_result' && payload.action) {
          this.onActionResult?.(payload.action, payload);
        }
      } catch {
        return;
      }
    });

    socket.addEventListener('close', () => {
      this.socket = null;
      if (this.closedByUser) {
        this.onStatus('closed');
        return;
      }
      this.onStatus('error');
      this.scheduleReconnect();
    });

    socket.addEventListener('error', () => {
      this.onStatus('error');
    });
  }

  private scheduleReconnect(): void {
    if (this.closedByUser) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this.openSocket(), 800);
  }
}
