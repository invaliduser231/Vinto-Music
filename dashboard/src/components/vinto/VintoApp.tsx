'use client';

import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import {
  MagnifyingGlass,
  Pause,
  Play,
  Repeat,
  Shuffle,
  SkipBack,
  SkipForward,
  SlidersHorizontal,
  SpeakerHigh,
  SpeakerSlash,
  Trash,
  MusicNotes,
  Broom,
  ArrowClockwise,
  Heart,
  Plus,
  ArrowUp,
  ArrowDown,
  DownloadSimple,
  Sparkle,
} from '@phosphor-icons/react';
import { DashboardHubPanel } from '@/components/vinto/DashboardHubPanel';
import { ProfilePanel } from '@/components/vinto/ProfilePanel';
import { SoundPanel } from '@/components/vinto/SoundPanel';
import { CommunityPanel } from '@/components/vinto/CommunityPanel';
import { SettingsModal } from '@/components/vinto/SettingsModal';
import { GuildSidebar } from '@/components/vinto/GuildSidebar';
import { CommandPalette, type PaletteCommand } from '@/components/vinto/CommandPalette';
import { ListenerRow } from '@/components/vinto/ListenerRow';
import { MarqueeTitle } from '@/components/vinto/MarqueeTitle';
import { Visualizer } from '@/components/vinto/Visualizer';
import { PlaybackProgressRow } from '@/components/vinto/PlaybackProgressRow';
import { RequesterBadge } from '@/components/vinto/RequesterBadge';
import { SyncedLyrics } from '@/components/vinto/SyncedLyrics';
import { UserProfileAvatar } from '@/components/vinto/UserProfileAvatar';
import { useAuthSession } from '@/hooks/useAuthSession';
import { useBotGuildIds } from '@/hooks/useBotGuildIds';
import { useGuildHistory } from '@/hooks/useGuildHistory';
import { useGuildOverview } from '@/hooks/useGuildOverview';
import { useGuildSettings } from '@/hooks/useGuildSettings';
import { useDashboardHub } from '@/hooks/useDashboardHub';
import { useTrackLyrics } from '@/hooks/useTrackLyrics';
import { useUserVoiceDiscovery } from '@/hooks/useUserVoiceDiscovery';
import { useLiveSession, useStoredDevSettings } from '@/hooks/useLiveSession';
import { useOAuthGuilds } from '@/hooks/useOAuthGuilds';
import { useCoverAccent } from '@/hooks/useCoverAccent';
import { formatTime } from '@/lib/format-time';
import { downloadDashboardQueue } from '@/lib/queue-export';
import { sourceBrandColor, sourceBrandIconUrl, sourceBrandLabel } from '@/lib/source-brand';
import {
  saveDevConnectSettings,
  type DevConnectSettings,
} from '@/lib/live-session';
import {
  shouldShowConnectPanel,
  shouldShowControls,
  shouldShowPlayer,
} from '@/lib/session-visibility';
import type { QueueTrack } from '@/types/session';

export function VintoApp() {
  const [devSettings, setDevSettings] = useStoredDevSettings();
  const {
    session,
    actions,
    progress,
    spectrum,
    mockEnabled,
    settled,
    message,
    clearMessage,
    searchResults,
    clearSearchResults,
    searching,
    lastFmAuthUrl,
    hubRevision,
    favoriteOverride,
  } = useLiveSession(devSettings);
  const { oauthEnabled, user, logout, loading: authLoading } = useAuthSession();
  const guilds = useOAuthGuilds(oauthEnabled, Boolean(user));
  const oauthGuildIds = useMemo(() => guilds.map((guild) => guild.id), [guilds]);
  const { guildIds: botGuildIds, loaded: botGuildsLoaded } = useBotGuildIds(
    oauthGuildIds,
    oauthEnabled && Boolean(user) && !mockEnabled,
  );
  const visibleGuilds = useMemo(() => {
    if (!oauthEnabled || mockEnabled) return guilds;
    if (!botGuildsLoaded) return [];
    const botGuildSet = new Set(botGuildIds);
    return guilds.filter((guild) => botGuildSet.has(guild.id));
  }, [guilds, oauthEnabled, mockEnabled, botGuildsLoaded, botGuildIds]);
  const voiceDiscovery = useUserVoiceDiscovery(
    oauthGuildIds,
    !mockEnabled && oauthEnabled && Boolean(user),
  );
  const guildAllowed = Boolean(devSettings.guildId) && (
    !oauthEnabled
    || mockEnabled
    || guilds.some((guild) => guild.id === devSettings.guildId)
  ) && (
    mockEnabled
    || !oauthEnabled
    || !botGuildsLoaded
    || botGuildIds.includes(devSettings.guildId)
  );
  const guildOverview = useGuildOverview(devSettings, !mockEnabled && guildAllowed);
  const guildSettingsHook = useGuildSettings(
    devSettings.guildId,
    !mockEnabled && guildAllowed && Boolean(devSettings.guildId),
  );

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<'queue' | 'history' | 'lyrics'>('queue');
  const [searchQuery, setSearchQuery] = useState('');
  const [historyPage, setHistoryPage] = useState(1);
  const [activeView, setActiveView] = useState<'player' | 'library' | 'sound' | 'community' | 'insights' | 'profile'>('player');

  useEffect(() => {
    if (!user) return;
    setDevSettings((prev) => {
      if (prev.userId === user.id) return prev;
      return { ...prev, userId: user.id };
    });
  }, [user, setDevSettings]);

  useEffect(() => {
    if (!oauthEnabled || !user || !botGuildsLoaded || !devSettings.guildId) return;
    if (visibleGuilds.some((g) => g.id === devSettings.guildId)) return;
    setDevSettings((prev) => ({ ...prev, guildId: '', voiceChannelId: '' }));
  }, [oauthEnabled, user, botGuildsLoaded, visibleGuilds, devSettings.guildId, setDevSettings]);

  useEffect(() => {
    if (!voiceDiscovery) return;
    setDevSettings((prev) => {
      if (
        prev.guildId === voiceDiscovery.guildId
        && prev.voiceChannelId === voiceDiscovery.voiceChannelId
      ) {
        return prev;
      }
      const next = {
        ...prev,
        guildId: voiceDiscovery.guildId,
        voiceChannelId: voiceDiscovery.voiceChannelId,
      };
      saveDevConnectSettings(next);
      return next;
    });
  }, [voiceDiscovery, setDevSettings]);

  useEffect(() => {
    if (!guildOverview?.userVoiceChannelId) return;
    const userChannel = guildOverview.userVoiceChannelId;
    setDevSettings((prev) => {
      if (prev.voiceChannelId === userChannel) return prev;
      const next = { ...prev, voiceChannelId: userChannel };
      saveDevConnectSettings(next);
      return next;
    });
  }, [guildOverview?.userVoiceChannelId, setDevSettings]);

  const inVoice = shouldShowPlayer(mockEnabled, session.userInChannel);
  const canControl = shouldShowControls(mockEnabled, session.canControl);
  const showConnect = shouldShowConnectPanel(mockEnabled, inVoice);
  const showPlayer = inVoice;
  const userInVoiceNow = oauthEnabled && !mockEnabled
    ? Boolean(voiceDiscovery?.voiceChannelId)
    : Boolean(devSettings.voiceChannelId);

  const historySettings = useMemo(() => {
    if (!session.userInChannel) return devSettings;
    return {
      ...devSettings,
      guildId: session.guildId || devSettings.guildId,
      voiceChannelId: session.voiceChannelId || devSettings.voiceChannelId,
    };
  }, [
    devSettings,
    session.guildId,
    session.voiceChannelId,
    session.userInChannel,
  ]);

  const historyHook = useGuildHistory(
    historySettings,
    showPlayer && activeTab === 'history' && !mockEnabled,
    historyPage,
  );
  const trackKey = session.nowPlaying
    ? `${session.nowPlaying.id}:${session.nowPlaying.title}:${session.nowPlaying.artist}`
    : null;
  const lyricsHook = useTrackLyrics(
    devSettings,
    showPlayer && activeTab === 'lyrics' && !mockEnabled,
    trackKey,
  );
  const hubHook = useDashboardHub(
    devSettings,
    showPlayer && !mockEnabled && (
      activeView === 'player'
      || activeView === 'library'
      || activeView === 'insights'
      || activeView === 'community'
      || activeView === 'profile'
    ),
    hubRevision,
  );

  const loopMode = session.nowPlaying?.loopMode ?? 'off';
  const loopActive = loopMode === 'track' || loopMode === 'queue';

  const cycleLoop = () => {
    if (!canControl) return;
    const nextMode = loopMode === 'off' ? 'track' : loopMode === 'track' ? 'queue' : 'off';
    actions.setLoop(nextMode);
  };

  const activeGuild = visibleGuilds.find((g) => g.id === devSettings.guildId);
  const guildName = activeGuild?.name ?? session.guildName ?? 'Server';

  const channelNameMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const ch of session.voiceChannels) map.set(ch.id, ch.name);
    for (const ch of guildOverview?.voiceChannels ?? []) map.set(ch.id, ch.name);
    return map;
  }, [session.voiceChannels, guildOverview?.voiceChannels]);

  const vcName = channelNameMap.get(devSettings.voiceChannelId)
    ?? session.voiceChannelName
    ?? devSettings.voiceChannelId;

  const storedCurrentFavorite = Boolean(
    session.nowPlaying?.url && hubHook.data?.favorites.items.some((favorite) => (
      String(favorite.url ?? '').trim() === String(session.nowPlaying?.url ?? '').trim()
    )),
  );
  const currentFavorite = favoriteOverride && favoriteOverride.trackId === session.nowPlaying?.id
    ? favoriteOverride.favorite
    : storedCurrentFavorite;

  const paletteCommands = useMemo<PaletteCommand[]>(() => {
    const views: Array<typeof activeView> = ['player', 'library', 'sound', 'community', 'insights', 'profile'];
    const viewCommands: PaletteCommand[] = views.map((view) => ({
      id: `view:${view}`,
      group: 'Go to',
      label: view.charAt(0).toUpperCase() + view.slice(1),
      run: () => setActiveView(view),
    }));

    const playing = session.nowPlaying;
    const playback: PaletteCommand[] = [
      {
        id: 'playback:toggle',
        group: 'Playback',
        label: playing?.paused ? 'Resume' : 'Pause',
        disabled: !canControl || !playing,
        run: () => (playing?.paused ? actions.resume() : actions.pause()),
      },
      { id: 'playback:skip', group: 'Playback', label: 'Skip track', disabled: !canControl, run: () => actions.skip() },
      { id: 'playback:previous', group: 'Playback', label: 'Previous track', disabled: !canControl, run: () => actions.previous() },
      { id: 'playback:replay', group: 'Playback', label: 'Replay track', disabled: !canControl, run: () => actions.replay() },
      { id: 'queue:shuffle', group: 'Queue', label: 'Shuffle queue', disabled: !canControl, run: () => actions.shuffle() },
      { id: 'queue:clear', group: 'Queue', label: 'Clear queue', disabled: !canControl, run: () => actions.clear() },
      {
        id: 'queue:export',
        group: 'Queue',
        label: 'Export queue as CSV',
        run: () => downloadDashboardQueue(guildName, session.nowPlaying, session.queue),
      },
      {
        id: 'playback:loop',
        group: 'Playback',
        label: 'Cycle loop mode',
        hint: loopMode,
        disabled: !canControl,
        run: cycleLoop,
      },
      {
        id: 'playback:autoplay',
        group: 'Playback',
        label: session.autoplayEnabled ? 'Disable autoplay' : 'Enable autoplay',
        disabled: !canControl,
        run: () => actions.setAutoplay(!session.autoplayEnabled),
      },
      {
        id: 'track:favorite',
        group: 'Track',
        label: 'Toggle favorite',
        disabled: !playing,
        run: () => {
          if (playing) actions.favoriteCurrent(playing.id, currentFavorite);
        },
      },
    ];

    const misc: PaletteCommand[] = [
      { id: 'tab:lyrics', group: 'Go to', label: 'Lyrics', run: () => { setActiveView('player'); setActiveTab('lyrics'); } },
      { id: 'tab:history', group: 'Go to', label: 'History', run: () => { setActiveView('player'); setActiveTab('history'); setHistoryPage(1); } },
      { id: 'tab:queue', group: 'Go to', label: 'Queue', run: () => { setActiveView('player'); setActiveTab('queue'); } },
    ];

    if (guildSettingsHook.settings?.canManage) {
      misc.push({ id: 'open:settings', group: 'Server', label: 'Open server settings', run: () => setSettingsOpen(true) });
    }

    return [...viewCommands, ...misc, ...playback];
  }, [
    actions,
    canControl,
    currentFavorite,
    cycleLoop,
    guildName,
    guildSettingsHook.settings?.canManage,
    loopMode,
    session.autoplayEnabled,
    session.nowPlaying,
    session.queue,
  ]);

  const accent = useCoverAccent(session.nowPlaying?.thumbnailUrl);
  const ambientGradient = useMemo(
    () => `radial-gradient(circle, ${accent} 0%, transparent 60%)`,
    [accent],
  );

  const queuedDurationLabel = useMemo(
    () => formatTime(session.queue.reduce((total, item) => total + item.durationSec, 0)),
    [session.queue],
  );

  const paused = Boolean(session.nowPlaying?.paused);
  const empty = !session.nowPlaying && session.queue.length === 0;

  useEffect(() => {
    document.body.classList.toggle('is-dj', canControl);
    document.body.classList.toggle('state-paused', paused);
    document.body.classList.toggle('state-empty', empty);
    return () => {
      document.body.classList.remove('is-dj', 'state-paused', 'state-empty');
    };
  }, [canControl, paused, empty]);

  useEffect(() => {
    if (!message) return undefined;
    const timer = window.setTimeout(clearMessage, 4500);
    return () => window.clearTimeout(timer);
  }, [message, clearMessage]);

  useEffect(() => {
    const language = guildSettingsHook.settings?.language ?? navigator.language ?? 'en';
    document.documentElement.lang = language;
  }, [guildSettingsHook.settings?.language]);

  const selectGuild = (guildId: string) => {
    const next: DevConnectSettings = {
      ...devSettings,
      guildId,
      voiceChannelId: '',
    };
    saveDevConnectSettings(next);
    setDevSettings(next);
  };

  const togglePause = () => {
    if (!session.nowPlaying) return;
    if (session.nowPlaying.paused) actions.resume();
    else actions.pause();
  };

  const nowPlayingRef = useRef(session.nowPlaying);
  nowPlayingRef.current = session.nowPlaying;
  const shortcutStateRef = useRef({ canControl, settingsOpen: settingsOpen || paletteOpen });
  shortcutStateRef.current = { canControl, settingsOpen: settingsOpen || paletteOpen };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const { canControl: allowed, settingsOpen: modalOpen } = shortcutStateRef.current;
      if (!allowed || modalOpen) return;
      const target = event.target as HTMLElement | null;
      if (target && (
        target.tagName === 'INPUT'
        || target.tagName === 'TEXTAREA'
        || target.tagName === 'SELECT'
        || target.isContentEditable
        || target.getAttribute('role') === 'slider'
      )) {
        return;
      }
      const track = nowPlayingRef.current;
      if (!track) return;

      if (event.key === ' ') {
        event.preventDefault();
        if (track.paused) actions.resume();
        else actions.pause();
        return;
      }
      if ((event.key === 'ArrowLeft' || event.key === 'ArrowRight') && track.seekable) {
        event.preventDefault();
        const current = progress.estimate();
        const next = event.key === 'ArrowLeft'
          ? Math.max(0, current - 5)
          : Math.min(track.durationSec, current + 5);
        actions.seek(next);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [actions, progress]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'k' && event.key !== 'K') return;
      if (!event.metaKey && !event.ctrlKey) return;
      event.preventDefault();
      setPaletteOpen((value) => !value);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const dragIndexRef = useRef<number | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const onQueueDragStart = useCallback((index: number) => {
    dragIndexRef.current = index;
  }, []);
  const onQueueDragEnter = useCallback((index: number) => {
    if (dragIndexRef.current == null) return;
    setDropIndex(index);
  }, []);
  const onQueueDrop = useCallback((index: number) => {
    const from = dragIndexRef.current;
    dragIndexRef.current = null;
    setDropIndex(null);
    if (from == null || from === index) return;
    actions.reorderQueueItem(from + 1, index + 1);
  }, [actions]);
  const onQueueDragEnd = useCallback(() => {
    dragIndexRef.current = null;
    setDropIndex(null);
  }, []);

  const onRemoveQueueItem = useCallback(
    (index: number) => actions.removeQueueItem(index + 1),
    [actions],
  );
  const onPlayQueueIndex = useCallback(
    (index: number) => actions.playQueueIndex(index + 1),
    [actions],
  );
  const onMoveQueueItem = useCallback(
    (fromIndex: number, toIndex: number) => actions.reorderQueueItem(fromIndex, toIndex),
    [actions],
  );

  const submitSearch = (playNext = false) => {
    const q = searchQuery.trim();
    if (!q || !canControl) return;
    actions.enqueue(q, playNext);
    setSearchQuery('');
  };

  const searchTracks = () => {
    const query = searchQuery.trim();
    if (!query || !canControl) return;
    actions.search(query);
  };

  useEffect(() => {
    const query = searchQuery.trim();
    if (mockEnabled || !canControl || query.length < 2) {
      clearSearchResults();
      return undefined;
    }
    const timer = window.setTimeout(() => actions.search(query), 450);
    return () => window.clearTimeout(timer);
  }, [actions, canControl, clearSearchResults, mockEnabled, searchQuery]);

  if (oauthEnabled && authLoading) {
    return <div className="vinto-gate"><div className="vinto-ambient" /></div>;
  }

  if (!settled && !mockEnabled && (!oauthEnabled || user)) {
    return <div className="vinto-gate"><div className="vinto-ambient" /></div>;
  }

  if (oauthEnabled && !user) {
    return (
      <>
        <div className="vinto-ambient" />
        <div className="vinto-gate">
          <div className="vinto-gate-card">
            <div className="vinto-gate-brand">
              <img src="/logo.png" alt="" width={56} height={56} />
              <span>Vinto</span>
            </div>
            <a href="/api/auth/login" className="vinto-btn vinto-btn-fluxer">
              <img src="/fluxer-mark.png" alt="" width={20} height={20} />
              Sign in with Fluxer
            </a>
          </div>
        </div>
      </>
    );
  }

  if (showConnect) {
    return (
      <>
        <div className="vinto-ambient" />
        {oauthEnabled ? (
          <GuildSidebar
            guilds={visibleGuilds}
            activeGuildId={devSettings.guildId}
            onSelectGuild={selectGuild}
          />
        ) : null}
        <div className="vinto-gate" style={{ flex: 1 }}>
          <div className="vinto-gate-card">
            <img src="/logo.png" alt="Vinto" width={64} height={64} />
            <div>
              <h1>{userInVoiceNow ? 'Ready when you are' : 'Join a voice channel'}</h1>
            </div>
            {userInVoiceNow ? (
              <button type="button" className="vinto-btn vinto-btn-primary" onClick={() => actions.join()}>
                Bring Vinto here
              </button>
            ) : null}
            {guildSettingsHook.settings?.canManage ? (
              <button type="button" className="vinto-btn vinto-btn-ghost" onClick={() => setSettingsOpen(true)}>
                <SlidersHorizontal size={17} /> Server settings
              </button>
            ) : null}
            {user ? (
              <button type="button" className="vinto-btn vinto-btn-ghost" onClick={() => void logout()}>
                Sign out
              </button>
            ) : null}
          </div>
        </div>
        <SettingsModal
          open={settingsOpen}
          guildName={guildName}
          settings={guildSettingsHook.settings}
          channelNames={channelNameMap}
          availableVoiceChannels={guildOverview?.directory?.voiceChannels ?? guildOverview?.voiceChannels ?? session.voiceChannels}
          availableTextChannels={guildOverview?.directory?.textChannels ?? []}
          availableRoles={guildOverview?.directory?.roles ?? []}
          onClose={() => setSettingsOpen(false)}
          onPatch={guildSettingsHook.patch}
        />
      </>
    );
  }

  if (!showPlayer) {
    return null;
  }

  const track = session.nowPlaying;
  return (
    <>
      <div
        className="vinto-ambient"
        style={{ opacity: track?.paused ? 0.15 : 0.5, background: ambientGradient }}
      />

      {oauthEnabled ? (
        <GuildSidebar
          guilds={visibleGuilds}
          activeGuildId={devSettings.guildId}
          onSelectGuild={selectGuild}
        />
      ) : null}

      <div className="vinto-app">
        <header className="vinto-header">
          <div className="vinto-header-left">
            <div className="vinto-logo">
              <img src="/logo.png" alt="" width={28} height={28} />
              Vinto
            </div>
            <div className="vinto-session-info">
              <span>{guildName}</span>
              <span className="vinto-session-separator">/</span>
              <span className="vinto-vc-badge">
                <SpeakerHigh size={14} weight="fill" />
                {vcName}
              </span>
            </div>
            <ListenerRow listeners={session.listeners} />
            <nav className="vinto-view-nav" aria-label="Dashboard sections">
              {(['player', 'library', 'sound', 'community', 'insights'] as const).map((view) => (
                <button
                  key={view}
                  type="button"
                  className={activeView === view ? 'active' : ''}
                  aria-current={activeView === view ? 'page' : undefined}
                  onClick={() => setActiveView(view)}
                >
                  {view[0]?.toUpperCase()}{view.slice(1)}
                </button>
              ))}
            </nav>
          </div>
          <div className="vinto-header-right">
            {guildSettingsHook.settings?.canManage ? (
              <button
                type="button"
                className="vinto-header-icon-btn"
                onClick={() => setSettingsOpen(true)}
                aria-label="Settings"
              >
                <SlidersHorizontal size={20} />
              </button>
            ) : null}
            {user ? (
              <button
                type="button"
                className={`vinto-user-profile${activeView === 'profile' ? ' active' : ''}`}
                onClick={() => setActiveView(activeView === 'profile' ? 'player' : 'profile')}
                aria-label={`Open profile for ${user.username}`}
                aria-pressed={activeView === 'profile'}
              >
                <UserProfileAvatar user={user} />
                <span>{user.username}</span>
              </button>
            ) : null}
          </div>
        </header>

        <main className="vinto-main">
          <section className="vinto-player-section">
            <div className={`vinto-cover-wrap${track && !track.paused ? ' playing' : ''}`}>
              <Visualizer store={spectrum} accent={accent} />
              {track?.thumbnailUrl ? (
                <img src={track.thumbnailUrl} alt="" className="vinto-cover" decoding="async" />
              ) : (
                <div className="vinto-cover" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <MusicNotes size={64} color="var(--text-muted)" />
                </div>
              )}
            </div>

            <div className="vinto-track-info">
              <MarqueeTitle text={track?.title ?? 'Nothing playing'} />
              <div className="vinto-track-artist">{track?.artist ?? '—'}</div>
              {track ? (
                <div className="vinto-track-meta">
                  <TrackSourceBadge source={track.source} />
                  {track.requestedBy ? (
                    <>
                      <span>·</span>
                      <RequesterBadge
                        userId={track.requestedBy}
                        name={track.requestedByName}
                        avatarUrl={track.requestedByAvatarUrl}
                      />
                    </>
                  ) : null}
                  <button
                    type="button"
                    className={`vinto-meta-action${currentFavorite ? ' active' : ''}`}
                    onClick={() => actions.favoriteCurrent(track.id, currentFavorite)}
                    aria-label={currentFavorite ? 'Remove current track from favorites' : 'Add current track to favorites'}
                    aria-pressed={currentFavorite}
                  >
                      <Heart size={15} weight={currentFavorite ? 'fill' : 'regular'} /> Favorite
                    </button>
                </div>
              ) : null}
            </div>

            <div className="vinto-playback">
              <PlaybackProgressRow store={progress} canControl={canControl} onSeek={actions.seek} />

              <div
                className={`vinto-main-controls${canControl ? '' : ' vinto-locked'}`}
                {...(canControl ? {} : { inert: true })}
              >
                <button
                  type="button"
                  className="vinto-control-btn dj-only"
                  onClick={() => actions.shuffle()}
                  aria-label="Shuffle queue"
                >
                  <Shuffle size={24} />
                </button>
                <button
                  type="button"
                  className="vinto-control-btn dj-only"
                  onClick={() => actions.previous()}
                  aria-label="Play previous track"
                >
                  <SkipBack size={24} weight="fill" />
                </button>
                <button type="button" className="vinto-control-btn play-btn dj-only" onClick={togglePause} aria-label={track?.paused ? 'Resume' : 'Pause'}>
                  {track?.paused ? <Play size={32} weight="fill" /> : <Pause size={32} weight="fill" />}
                </button>
                <button type="button" className="vinto-control-btn dj-only" onClick={() => actions.skip()} aria-label="Skip track">
                  <SkipForward size={24} weight="fill" />
                </button>
                <button type="button" className="vinto-control-btn dj-only" onClick={() => actions.replay()} aria-label="Replay track">
                  <ArrowClockwise size={22} />
                </button>
                <button
                  type="button"
                  className={`vinto-control-btn dj-only${loopActive ? ' active' : ''}`}
                  onClick={cycleLoop}
                  aria-label={`Loop ${loopMode}`}
                  title={`Loop: ${loopMode}`}
                >
                  <Repeat size={24} />
                </button>
                <button
                  type="button"
                  className={`vinto-control-btn dj-only${session.autoplayEnabled ? ' active' : ''}`}
                  onClick={() => actions.setAutoplay(!session.autoplayEnabled)}
                  aria-label={`Last.fm autoplay ${session.autoplayEnabled ? 'on' : 'off'}`}
                  aria-pressed={session.autoplayEnabled}
                  title={`Last.fm autoplay: ${session.autoplayEnabled ? 'on' : 'off'}`}
                >
                  <Sparkle size={22} weight={session.autoplayEnabled ? 'fill' : 'regular'} />
                </button>
                <div className="vinto-volume-wrap dj-only">
                  {track && track.volumePercent === 0 ? (
                    <SpeakerSlash size={18} color="var(--text-muted)" />
                  ) : (
                    <SpeakerHigh size={18} color="var(--text-muted)" />
                  )}
                  <input
                    type="range"
                    className="vinto-volume-slider"
                    min={0}
                    max={200}
                    value={track?.volumePercent ?? 100}
                    style={{
                      '--volume-pct': `${((track?.volumePercent ?? 100) / 200) * 100}%`,
                    } as CSSProperties}
                    onChange={(e) => actions.setVolume(Number(e.target.value))}
                    aria-label="Playback volume"
                  />
                </div>
              </div>
            </div>
          </section>

          <aside className="vinto-sidebar">
            {activeView === 'player' ? (
              <>
            <div className="vinto-sidebar-header">
              <div
                className={`vinto-search-bar${canControl ? '' : ' vinto-locked'}`}
                {...(canControl ? {} : { inert: true })}
              >
                <MagnifyingGlass size={18} color="var(--text-muted)" />
                <input
                  type="text"
                  placeholder="Search or paste URL"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      searchTracks();
                    }
                  }}
                  aria-label="Search for a track or paste a URL"
                />
                <button type="button" onClick={() => submitSearch(false)} aria-label="Add to queue">Add</button>
                <button type="button" onClick={() => submitSearch(true)} aria-label="Play next">Next</button>
              </div>
              {searching || searchResults.length > 0 ? (
                <div className="vinto-search-results" aria-label="Search results">
                  <div className="vinto-search-results-title">
                    <span>{searching ? 'Searching…' : `${searchResults.length} results`}</span>
                    <button type="button" onClick={clearSearchResults}>Close</button>
                  </div>
                  {searchResults.map((result) => (
                    <div className="vinto-library-row" key={result.id}>
                      <div><strong>{result.title}</strong><small>{result.artist}</small></div>
                      <div className="vinto-inline-actions">
                        <button type="button" aria-label={`Add ${result.title}`} onClick={() => actions.enqueue(result.url || `${result.title} ${result.artist}`, false)}><Plus size={15} /></button>
                        <button type="button" aria-label={`Play ${result.title} next`} onClick={() => actions.enqueue(result.url || `${result.title} ${result.artist}`, true)}><Play size={15} /></button>
                      </div>
                    </div>
                  ))}
                </div>
              ) : null}
              <div className="vinto-tabs">
                <button
                  type="button"
                  className={`vinto-tab${activeTab === 'queue' ? ' active' : ''}`}
                  onClick={() => setActiveTab('queue')}
                  role="tab"
                  aria-selected={activeTab === 'queue'}
                >
                  Queue ({session.queue.length})
                </button>
                <button
                  type="button"
                  className={`vinto-tab${activeTab === 'history' ? ' active' : ''}`}
                  onClick={() => {
                    setActiveTab('history');
                    setHistoryPage(1);
                  }}
                  role="tab"
                  aria-selected={activeTab === 'history'}
                >
                  History
                </button>
                <button
                  type="button"
                  className={`vinto-tab${activeTab === 'lyrics' ? ' active' : ''}`}
                  onClick={() => setActiveTab('lyrics')}
                  role="tab"
                  aria-selected={activeTab === 'lyrics'}
                >
                  Lyrics
                </button>
              </div>
            </div>

            <div className="vinto-tab-content">
              {activeTab === 'queue' ? (
                session.queue.length === 0 ? (
                  <div className="vinto-empty-msg">
                    <MusicNotes size={32} style={{ opacity: 0.5, marginBottom: 12 }} />
                    <br />
                    Queue is empty
                  </div>
                ) : (
                  <>
                  <div className="vinto-queue-toolbar dj-only">
                    <span>{queuedDurationLabel} queued</span>
                    <button type="button" onClick={() => downloadDashboardQueue(guildName, session.nowPlaying, session.queue)}><DownloadSimple size={15} /> Export</button>
                    <button type="button" onClick={() => actions.clear()}><Broom size={15} /> Clear</button>
                  </div>
                  {session.queue.map((item, queueIndex) => (
                    <QueueRow
                      key={item.id}
                      item={item}
                      index={queueIndex}
                      total={session.queue.length}
                      canControl={canControl}
                      dropTarget={dropIndex === queueIndex}
                      onRemove={onRemoveQueueItem}
                      onPlayNext={onPlayQueueIndex}
                      onMove={onMoveQueueItem}
                      onDragStart={onQueueDragStart}
                      onDragEnter={onQueueDragEnter}
                      onDrop={onQueueDrop}
                      onDragEnd={onQueueDragEnd}
                    />
                  ))}
                  </>
                )
              ) : null}

              {activeTab === 'history' ? (
                historyHook.loading ? (
                  <div className="vinto-empty-msg">Loading history…</div>
                ) : historyHook.error ? (
                  <div className="vinto-empty-msg">
                    {historyHook.error === 'not_in_voice'
                      ? 'Voice state is still syncing. Switch tabs or try again in a moment.'
                      : historyHook.error}
                  </div>
                ) : !historyHook.history || historyHook.history.items.length === 0 ? (
                  <div className="vinto-empty-msg">No playback history yet</div>
                ) : (
                  <>
                    {historyHook.history.items.map((item, index) => (
                      <div key={`${item.id}-${index}`} className="vinto-queue-item">
                        {item.thumbnailUrl ? (
                          <img src={item.thumbnailUrl} alt="" className="vinto-queue-cover" loading="lazy" decoding="async" />
                        ) : (
                          <div className="vinto-queue-cover" />
                        )}
                        <div className="vinto-queue-info">
                          <div className="vinto-queue-title">{item.title}</div>
                          <div className="vinto-queue-meta">
                            <TrackSourceBadge source={item.source} />
                            <span>{item.artist}</span>
                            <span>{formatTime(item.durationSec)}</span>
                          </div>
                        </div>
                        {canControl ? (
                          <div className="vinto-queue-actions dj-only">
                            <button
                              type="button"
                              className="vinto-action-btn"
                              onClick={() => actions.enqueue(item.url || `${item.title} ${item.artist}`, false)}
                              aria-label={`Add ${item.title} to queue`}
                              title="Add to queue"
                            >
                              <Plus size={16} />
                            </button>
                            <button
                              type="button"
                              className="vinto-action-btn"
                              onClick={() => actions.playHistory(item.url || `${item.title} ${item.artist}`)}
                              aria-label={`Play ${item.title} again`}
                              title="Play again"
                            >
                              <Play size={16} />
                            </button>
                          </div>
                        ) : null}
                      </div>
                    ))}
                    {historyHook.history.totalPages > 1 ? (
                      <div className="vinto-history-pagination">
                        <button
                          type="button"
                          className="vinto-tab"
                          disabled={historyPage <= 1}
                          onClick={() => setHistoryPage((page) => Math.max(1, page - 1))}
                        >
                          Previous
                        </button>
                        <span className="vinto-history-page-label">
                          {historyHook.history.page} / {historyHook.history.totalPages}
                        </span>
                        <button
                          type="button"
                          className="vinto-tab"
                          disabled={historyPage >= historyHook.history.totalPages}
                          onClick={() => setHistoryPage((page) => page + 1)}
                        >
                          Next
                        </button>
                      </div>
                    ) : null}
                  </>
                )
              ) : null}

              {activeTab === 'lyrics' ? (
                !session.nowPlaying ? (
                  <div className="vinto-empty-msg">Nothing playing</div>
                ) : lyricsHook.loading ? (
                  <div className="vinto-empty-msg">Loading lyrics…</div>
                ) : lyricsHook.error ? (
                  <div className="vinto-empty-msg">{lyricsHook.error}</div>
                ) : !lyricsHook.lyrics ? (
                  <div className="vinto-empty-msg">No lyrics found</div>
                ) : (
                  <SyncedLyrics
                    store={progress}
                    source={lyricsHook.lyrics.source}
                    plain={lyricsHook.lyrics.lyrics}
                    synced={lyricsHook.lyrics.syncedLyrics ?? null}
                    canSeek={canControl && Boolean(track?.seekable)}
                    onSeek={actions.seek}
                  />
                )
              ) : null}
            </div>
              </>
            ) : activeView === 'sound' ? (
              <SoundPanel effects={session.effects} canControl={canControl} onChange={actions.setEffects} />
            ) : activeView === 'profile' ? (
              <ProfilePanel
                user={user}
                data={hubHook.data}
                loading={hubHook.loading}
                canControl={canControl}
                hasCurrentTrack={Boolean(track)}
                onPlay={(query, playNext) => actions.enqueue(query, playNext)}
                onLibraryPlay={actions.libraryPlay}
                onFavoriteRename={actions.favoriteRename}
                onFavoriteRemove={actions.favoriteRemove}
                lastFmAuthUrl={lastFmAuthUrl}
                onLastFm={actions.lastFm}
                onSignOut={user ? () => void logout() : null}
              />
            ) : activeView === 'library' || activeView === 'insights' ? (
              <DashboardHubPanel
                view={activeView}
                data={hubHook.data}
                loading={hubHook.loading}
                error={hubHook.error}
                canControl={canControl}
                hasCurrentTrack={Boolean(track)}
                onReload={() => void hubHook.reload()}
                onPlay={(query, playNext) => actions.enqueue(query, playNext)}
                onLibraryPlay={actions.libraryPlay}
                onSaveTemplate={actions.saveTemplate}
                onPlaylistCreate={actions.playlistCreate}
                onPlaylistDelete={actions.playlistDelete}
                onPlaylistAddCurrent={actions.playlistAddCurrent}
                onTemplateDelete={actions.templateDelete}
                onStationCreate={actions.stationCreate}
                onStationDelete={actions.stationDelete}
              />
            ) : (
              <CommunityPanel
                session={session}
                canControl={canControl}
                canManage={Boolean(guildSettingsHook.settings?.canManage)}
                hasTrack={Boolean(track)}
                onVoteSkip={actions.voteSkip}
                onHandoff={actions.handoff}
                onLeave={actions.leave}
                party={hubHook.data?.party ?? null}
                onParty={actions.party}
                members={guildOverview?.directory?.members ?? []}
              />
            )}
          </aside>
        </main>
      </div>

      <SettingsModal
        open={settingsOpen}
        guildName={guildName}
        settings={guildSettingsHook.settings}
        channelNames={channelNameMap}
        availableVoiceChannels={guildOverview?.directory?.voiceChannels ?? guildOverview?.voiceChannels ?? session.voiceChannels}
        availableTextChannels={guildOverview?.directory?.textChannels ?? []}
        availableRoles={guildOverview?.directory?.roles ?? []}
        onClose={() => setSettingsOpen(false)}
        onPatch={guildSettingsHook.patch}
      />
      <CommandPalette
        open={paletteOpen}
        commands={paletteCommands}
        onClose={() => setPaletteOpen(false)}
        onSearch={canControl ? ((query: string) => actions.enqueue(query, false)) : null}
      />
      {message ? (
        <button type="button" className={`vinto-toast ${message.tone}`} onClick={clearMessage} role="status">
          {message.text}
        </button>
      ) : null}
    </>
  );
}

const TrackSourceBadge = memo(function TrackSourceBadge({ source }: { source: string | null | undefined }) {
  const iconUrl = sourceBrandIconUrl(source);
  if (!iconUrl) return null;

  return (
    <span
      className="vinto-source-badge"
      style={{ background: sourceBrandColor(source) }}
      title={sourceBrandLabel(source)}
    >
      <img src={iconUrl} alt="" className="vinto-source-icon" loading="lazy" decoding="async" />
    </span>
  );
});

const QueueRow = memo(function QueueRow({
  item,
  index,
  total,
  canControl,
  dropTarget,
  onRemove,
  onPlayNext,
  onMove,
  onDragStart,
  onDragEnter,
  onDrop,
  onDragEnd,
}: {
  item: QueueTrack;
  index: number;
  total: number;
  canControl: boolean;
  dropTarget: boolean;
  onRemove: (index: number) => void;
  onPlayNext: (index: number) => void;
  onMove: (fromIndex: number, toIndex: number) => void;
  onDragStart: (index: number) => void;
  onDragEnter: (index: number) => void;
  onDrop: (index: number) => void;
  onDragEnd: () => void;
}) {
  return (
    <div
      className={`vinto-queue-item${dropTarget ? ' drop-target' : ''}`}
      draggable={canControl}
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', String(index));
        onDragStart(index);
      }}
      onDragEnter={() => onDragEnter(index)}
      onDragOver={(event) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
      }}
      onDrop={(event) => {
        event.preventDefault();
        onDrop(index);
      }}
      onDragEnd={onDragEnd}
    >
      {item.thumbnailUrl ? (
        <img src={item.thumbnailUrl} alt="" className="vinto-queue-cover" loading="lazy" decoding="async" />
      ) : (
        <div className="vinto-queue-cover" />
      )}
      <div className="vinto-queue-info">
        <div className="vinto-queue-title">{item.title}</div>
        <div className="vinto-queue-meta">
          <TrackSourceBadge source={item.source} />
          <span>{formatTime(item.durationSec)}</span>
          {item.requestedBy ? (
            <>
              <span>·</span>
              <RequesterBadge
                userId={item.requestedBy}
                name={item.requestedByName}
                avatarUrl={item.requestedByAvatarUrl}
                compact
              />
            </>
          ) : null}
        </div>
      </div>
      {canControl ? (
        <div className="vinto-queue-actions dj-only">
          <button
            type="button"
            className="vinto-action-btn"
            disabled={index <= 0}
            onClick={() => onMove(index + 1, index)}
            aria-label="Move up"
          >
            <ArrowUp size={16} />
          </button>
          <button
            type="button"
            className="vinto-action-btn"
            disabled={index >= total - 1}
            onClick={() => onMove(index + 1, index + 2)}
            aria-label="Move down"
          >
            <ArrowDown size={16} />
          </button>
          <button type="button" className="vinto-action-btn" onClick={() => onPlayNext(index)} aria-label="Play next">
            <Play size={16} />
          </button>
          <button type="button" className="vinto-action-btn" onClick={() => onRemove(index)} aria-label="Remove">
            <Trash size={16} />
          </button>
        </div>
      ) : null}
    </div>
  );
});
