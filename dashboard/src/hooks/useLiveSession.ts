'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DashboardSession, NowPlayingTrack, QueueTrack } from '@/types/session';
import {
  defaultDevConnectSettings,
  LiveSessionClient,
  loadDevConnectSettings,
  useMockSession,
  type DevConnectSettings,
} from '@/lib/live-session';
import { PlaybackProgressStore } from '@/lib/playback-progress';
import { SpectrumStore } from '@/lib/spectrum-store';
import { createMockSession } from '@/lib/mock-session';

const PROGRESS_RESYNC_DRIFT_SEC = 1.5;

function applyOptimisticNowPlaying(
  track: NowPlayingTrack | null,
  patch: Partial<NowPlayingTrack>,
): NowPlayingTrack | null {
  if (!track) return null;
  return { ...track, ...patch };
}

function sessionSignature(session: DashboardSession): string {
  const nowPlaying = session.nowPlaying
    ? { ...session.nowPlaying, positionSec: 0 }
    : null;
  return JSON.stringify({ ...session, nowPlaying });
}

function anchorFromTrack(track: NowPlayingTrack, atMs: number) {
  return {
    positionSec: track.positionSec,
    atMs,
    durationSec: track.durationSec,
    paused: track.paused,
    seekable: track.seekable,
  };
}

function friendlyError(message: string): string {
  const messages: Record<string, string> = {
    'action rejected': 'The player rejected that action. Its state may have changed.',
    'control not allowed': 'You need the configured DJ role to use this control.',
    join_failed: 'Vinto could not join this voice channel.',
    not_connected: 'The dashboard is offline. Reconnecting…',
    not_in_voice: 'Join the same voice channel as Vinto first.',
    nothing_playing: 'There is no active track.',
    'session not found': 'The player session is no longer active.',
  };
  return messages[message] ?? message;
}

export function useLiveSession(settings: DevConnectSettings) {
  const mockEnabled = useMockSession();
  const [session, setSession] = useState<DashboardSession>(() => (
    mockEnabled ? createMockSession() : emptySession(settings)
  ));
  const [status, setStatus] = useState<'connecting' | 'open' | 'closed' | 'error'>(
    mockEnabled ? 'open' : 'connecting',
  );
  const [message, setMessage] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
  const [settled, setSettled] = useState(mockEnabled);
  const [searchResults, setSearchResults] = useState<QueueTrack[]>([]);
  const [searching, setSearching] = useState(false);
  const [lastFmAuthUrl, setLastFmAuthUrl] = useState<string | null>(null);
  const [hubRevision, setHubRevision] = useState(0);
  const [favoriteOverride, setFavoriteOverride] = useState<{ trackId: string; favorite: boolean } | null>(null);
  const clearMessage = useCallback(() => setMessage(null), []);
  const searchQueryRef = useRef('');
  const clearSearchResults = useCallback(() => {
    searchQueryRef.current = '';
    setSearching(false);
    setSearchResults([]);
  }, []);
  const progressRef = useRef<PlaybackProgressStore | null>(null);
  if (!progressRef.current) progressRef.current = new PlaybackProgressStore();
  const progress = progressRef.current;
  const spectrumRef = useRef<SpectrumStore | null>(null);
  if (!spectrumRef.current) spectrumRef.current = new SpectrumStore();
  const spectrum = spectrumRef.current;
  const signatureRef = useRef<string | null>(null);
  const trackIdRef = useRef<string | null>(null);
  const clientRef = useRef<LiveSessionClient | null>(null);
  const volumeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const effectsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingVolumeRef = useRef<number | null>(null);
  const favoritePendingRef = useRef(false);

  const invalidateSignature = useCallback(() => {
    signatureRef.current = null;
  }, []);

  useEffect(() => {
    if (mockEnabled) {
      const mock = createMockSession();
      setSession(mock);
      if (mock.nowPlaying) progress.setAnchor(anchorFromTrack(mock.nowPlaying, Date.now()));
      return;
    }

    setSession(emptySession(settings));
    signatureRef.current = null;
    trackIdRef.current = null;
    setSettled(false);
    progress.setAnchor(null);

    const client = new LiveSessionClient({
      settings,
      onSession: (nextSession, serverTs) => {
        setSettled(true);
        const np = nextSession.nowPlaying;
        if (np) {
          const anchor = progress.getAnchor();
          const trackChanged = trackIdRef.current !== np.id;
          trackIdRef.current = np.id;
          const drift = anchor ? Math.abs(np.positionSec - progress.estimate()) : Infinity;
          if (trackChanged || !anchor || drift > PROGRESS_RESYNC_DRIFT_SEC || anchor.paused !== np.paused) {
            progress.setAnchor(anchorFromTrack(np, serverTs));
          } else {
            progress.patchAnchor({
              durationSec: np.durationSec,
              seekable: np.seekable,
              paused: np.paused,
            });
          }
        } else {
          trackIdRef.current = null;
          progress.setAnchor(null);
        }

        const signature = sessionSignature(nextSession);
        if (signatureRef.current === signature) return;
        signatureRef.current = signature;
        setSession(nextSession);
      },
      onSpectrum: (bands) => spectrum.push(bands),
      onStatus: (nextStatus) => {
        setStatus(nextStatus);
        if (nextStatus === 'error' || nextStatus === 'closed') setSettled(true);
        if (nextStatus === 'error' || nextStatus === 'closed') spectrum.reset();
      },
      onError: (errorText) => {
        setSettled(true);
        setSearching(false);
        favoritePendingRef.current = false;
        setFavoriteOverride(null);
        setMessage({ tone: 'error', text: friendlyError(errorText) });
        invalidateSignature();
        if (errorText === 'not_in_voice') {
          trackIdRef.current = null;
          progress.setAnchor(null);
          setSession(emptySession(settings));
        }
      },
      onActionResult: (action, data) => {
        if (action === 'search') {
          if (String(data.query ?? '') !== searchQueryRef.current) return;
          setSearchResults(Array.isArray(data.results) ? data.results as QueueTrack[] : []);
          setSearching(false);
          return;
        }
        if (action === 'lastFm') {
          const operation = String(data.operation ?? '');
          if (operation === 'connect') {
            setLastFmAuthUrl(String(data.authUrl ?? '').trim() || null);
            setMessage({ tone: 'success', text: 'Authorize Vinto on Last.fm, then finish the connection here.' });
            return;
          }
          if (operation === 'complete' || operation === 'disconnect') setLastFmAuthUrl(null);
          setHubRevision((revision) => revision + 1);
          const labels: Record<string, string> = {
            complete: 'Last.fm connected',
            disconnect: 'Last.fm disconnected',
            toggle: 'Scrobbling preference updated',
            love: 'Track loved on Last.fm',
            unlove: 'Love removed on Last.fm',
          };
          setMessage({ tone: 'success', text: labels[operation] ?? 'Last.fm updated' });
          return;
        }
        if (
          action === 'favoriteCurrent'
          || action === 'saveTemplate'
          || action === 'favoriteRename'
          || action === 'favoriteRemove'
          || action === 'playlistCreate'
          || action === 'playlistDelete'
          || action === 'playlistAddCurrent'
          || action === 'templateDelete'
          || action === 'stationCreate'
          || action === 'stationDelete'
        ) {
          setHubRevision((revision) => revision + 1);
        }
        if (action === 'stationCreate') {
          setMessage({ tone: 'success', text: 'Station saved' });
          return;
        }
        if (action === 'playlistCreate') {
          setMessage({ tone: 'success', text: 'Playlist created' });
          return;
        }
        if (action === 'playlistAddCurrent') {
          setMessage({ tone: 'success', text: 'Added to playlist' });
          return;
        }
        if (action === 'favoriteCurrent') {
          favoritePendingRef.current = false;
          const trackId = String(data.trackId ?? '').trim();
          if (trackId) setFavoriteOverride({ trackId, favorite: data.favorite === true });
          return;
        }
        if (action === 'autoplay') {
          invalidateSignature();
          setSession((current) => ({ ...current, autoplayEnabled: data.enabled === true }));
          return;
        }
        if (action === 'party') {
          setHubRevision((revision) => revision + 1);
          const alreadyVoted = data.alreadyVoted === true;
          setMessage({
            tone: alreadyVoted ? 'error' : 'success',
            text: alreadyVoted ? 'You already voted today' : 'Party updated',
          });
          return;
        }
        const added = Number(data.added ?? 0);
        if (action === 'enqueue' && added > 0) {
          setMessage({ tone: 'success', text: `${added} track${added === 1 ? '' : 's'} added` });
          return;
        }
        if (action === 'voteSkip') {
          setMessage({
            tone: 'success',
            text: `Vote registered (${Number(data.votes ?? 0)}/${Number(data.required ?? 1)})`,
          });
        }
      },
    });
    clientRef.current = client;
    client.connect();

    return () => {
      if (volumeTimerRef.current) clearTimeout(volumeTimerRef.current);
      if (effectsTimerRef.current) clearTimeout(effectsTimerRef.current);
      client.disconnect();
      clientRef.current = null;
    };
  }, [
    invalidateSignature,
    mockEnabled,
    progress,
    settings.apiUrl,
    settings.wsUrl,
    settings.secret,
    settings.guildId,
    settings.voiceChannelId,
    settings.userId,
    settings.roleIds,
    spectrum,
  ]);

  useEffect(() => () => progress.destroy(), [progress]);

  const actions = useMemo(() => ({
    join: () => clientRef.current?.sendAction('join'),
    leave: () => clientRef.current?.sendAction('leave'),
    voteSkip: () => clientRef.current?.sendAction('voteSkip'),
    search: (query: string) => {
      searchQueryRef.current = query;
      setSearching(true);
      clientRef.current?.sendAction('search', { query });
    },
    favoriteCurrent: (trackId: string, favorite: boolean) => {
      if (favoritePendingRef.current) return;
      setFavoriteOverride({ trackId, favorite: !favorite });
      if (!clientRef.current) return;
      favoritePendingRef.current = true;
      clientRef.current?.sendAction('favoriteCurrent');
    },
    setAutoplay: (enabled: boolean) => {
      if (mockEnabled) {
        setSession((current) => ({ ...current, autoplayEnabled: enabled }));
        return;
      }
      clientRef.current?.sendAction('autoplay', { enabled });
    },
    saveTemplate: (name: string) => clientRef.current?.sendAction('saveTemplate', { name }),
    favoriteRename: (index: number, alias: string) => (
      clientRef.current?.sendAction('favoriteRename', { index, alias })
    ),
    favoriteRemove: (index: number) => clientRef.current?.sendAction('favoriteRemove', { index }),
    playlistCreate: (name: string) => clientRef.current?.sendAction('playlistCreate', { name }),
    playlistDelete: (name: string) => clientRef.current?.sendAction('playlistDelete', { name }),
    playlistAddCurrent: (name: string) => clientRef.current?.sendAction('playlistAddCurrent', { name }),
    templateDelete: (key: string) => clientRef.current?.sendAction('templateDelete', { key }),
    stationCreate: (name: string, url: string) => (
      clientRef.current?.sendAction('stationCreate', { name, url })
    ),
    stationDelete: (key: string) => clientRef.current?.sendAction('stationDelete', { key }),
    libraryPlay: (kind: 'playlist' | 'template' | 'favorite' | 'station', key: string) => (
      clientRef.current?.sendAction('libraryPlay', { kind, key })
    ),
    handoff: (targetUserId: string | null, minutes = 15) => clientRef.current?.sendAction('handoff', {
      targetUserId,
      minutes,
      off: targetUserId == null,
    }),
    lastFm: (
      operation: 'connect' | 'complete' | 'disconnect' | 'toggle' | 'love' | 'unlove',
      enabled?: boolean,
    ) => clientRef.current?.sendAction('lastFm', { operation, ...(enabled == null ? {} : { enabled }) }),
    party: (operation: 'start' | 'join' | 'vote' | 'end', team?: 'a' | 'b') => (
      clientRef.current?.sendAction('party', { operation, ...(team ? { team } : {}) })
    ),
    pause: () => {
      invalidateSignature();
      setSession((prev) => ({
        ...prev,
        nowPlaying: applyOptimisticNowPlaying(prev.nowPlaying, { paused: true }),
      }));
      progress.patchAnchor({ positionSec: progress.estimate(), atMs: Date.now(), paused: true });
      clientRef.current?.sendAction('pause');
    },
    resume: () => {
      invalidateSignature();
      setSession((prev) => ({
        ...prev,
        nowPlaying: applyOptimisticNowPlaying(prev.nowPlaying, { paused: false }),
      }));
      progress.patchAnchor({ atMs: Date.now(), paused: false });
      clientRef.current?.sendAction('resume');
    },
    shuffle: () => clientRef.current?.sendAction('shuffle'),
    setLoop: (mode: 'off' | 'track' | 'queue') => {
      invalidateSignature();
      setSession((prev) => ({
        ...prev,
        nowPlaying: applyOptimisticNowPlaying(prev.nowPlaying, { loopMode: mode }),
      }));
      clientRef.current?.sendAction('loop', { mode });
    },
    previous: () => clientRef.current?.sendAction('previous'),
    skip: () => clientRef.current?.sendAction('skip'),
    replay: () => clientRef.current?.sendAction('replay'),
    clear: () => clientRef.current?.sendAction('clear'),
    setEffects: (effects: DashboardSession['effects']) => {
      invalidateSignature();
      setSession((prev) => ({ ...prev, effects }));
      if (effectsTimerRef.current) clearTimeout(effectsTimerRef.current);
      effectsTimerRef.current = setTimeout(() => {
        clientRef.current?.sendAction('effects', effects);
      }, 250);
    },
    setVolume: (volumePercent: number) => {
      invalidateSignature();
      setSession((prev) => ({
        ...prev,
        nowPlaying: applyOptimisticNowPlaying(prev.nowPlaying, { volumePercent }),
      }));
      pendingVolumeRef.current = volumePercent;
      if (volumeTimerRef.current) clearTimeout(volumeTimerRef.current);
      volumeTimerRef.current = setTimeout(() => {
        const next = pendingVolumeRef.current;
        if (next == null) return;
        clientRef.current?.sendAction('volume', { volumePercent: next });
        pendingVolumeRef.current = null;
      }, 350);
    },
    seek: (positionSec: number) => {
      invalidateSignature();
      progress.patchAnchor({ positionSec, atMs: Date.now() });
      setSession((prev) => {
        if (!prev.nowPlaying) return prev;
        return { ...prev, nowPlaying: { ...prev.nowPlaying, positionSec } };
      });
      if (!mockEnabled) {
        clientRef.current?.sendAction('seek', { positionSec });
      }
    },
    removeQueueItem: (queueIndex: number) => {
      invalidateSignature();
      setSession((prev) => ({
        ...prev,
        queue: prev.queue.filter((_, index) => index + 1 !== queueIndex),
      }));
      clientRef.current?.sendAction('remove', { queueIndex });
    },
    reorderQueueItem: (fromIndex: number, toIndex: number) => {
      invalidateSignature();
      setSession((prev) => {
        if (fromIndex === toIndex) return prev;
        const queue = [...prev.queue];
        const [track] = queue.splice(fromIndex - 1, 1);
        if (!track) return prev;
        queue.splice(toIndex - 1, 0, track);
        return { ...prev, queue };
      });
      clientRef.current?.sendAction('reorder', { fromIndex, toIndex });
    },
    playQueueIndex: (queueIndex: number) => {
      invalidateSignature();
      setSession((prev) => ({
        ...prev,
        queue: prev.queue.filter((_, index) => index + 1 !== queueIndex),
      }));
      clientRef.current?.sendAction('playQueueIndex', { queueIndex });
    },
    playHistory: (query: string) => clientRef.current?.sendAction('playHistory', { query }),
    enqueue: (query: string, playNext = false) => {
      if (mockEnabled) {
        setSession((prev) => {
          const entry = {
            id: `mock-${Date.now()}`,
            title: query,
            artist: 'Mock',
            durationSec: 180,
            thumbnailUrl: null,
            source: 'search',
            requestedBy: prev.nowPlaying?.requestedBy ?? 'user-1',
            requestedByName: prev.nowPlaying?.requestedByName ?? 'You',
            requestedByAvatarUrl: prev.nowPlaying?.requestedByAvatarUrl ?? null,
          };
          const queue = playNext
            ? [entry, ...prev.queue]
            : [...prev.queue, entry];
          return { ...prev, queue };
        });
        return;
      }
      clientRef.current?.sendAction('enqueue', { query, playNext });
    },
  }), [invalidateSignature, mockEnabled, progress]);

  return {
    session,
    actions,
    progress,
    spectrum,
    mockEnabled,
    status,
    settled,
    message,
    clearMessage,
    searchResults,
    searching,
    lastFmAuthUrl,
    hubRevision,
    favoriteOverride,
    clearSearchResults,
  };
}

function emptySession(settings: DevConnectSettings): DashboardSession {
  return {
    guildId: settings.guildId,
    guildName: settings.guildId || 'Guild',
    voiceChannelId: settings.voiceChannelId,
    voiceChannelName: settings.voiceChannelId || 'Voice channel',
    userInChannel: false,
    canControl: false,
    autoplayEnabled: false,
    nowPlaying: null,
    queue: [],
    voiceChannels: [],
    listeners: [],
    effects: {
      filterPreset: 'off',
      eqPreset: 'flat',
      tempoRatio: 1,
      pitchSemitones: 0,
    },
    voteSkip: { votes: 0, required: 1 },
    handoff: null,
  };
}

export function useStoredDevSettings(): [
  DevConnectSettings,
  (next: DevConnectSettings | ((prev: DevConnectSettings) => DevConnectSettings)) => void,
] {
  const [settings, setSettings] = useState<DevConnectSettings>(defaultDevConnectSettings);
  useEffect(() => {
    setSettings(loadDevConnectSettings());
  }, []);
  return [settings, setSettings];
}
