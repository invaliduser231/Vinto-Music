import type { Session, Track } from '../types/domain.ts';
import type { VoiceStateStore } from '../bot/voiceStateStore.ts';
import { parseTrackDurationSeconds } from './duration.ts';
import {
  applyViewerRestrictions,
  filterVoiceChannelsForUser,
  getUserVoiceChannelId,
} from './viewerAccess.ts';

export type DashboardTrackPayload = {
  id: string;
  title: string;
  artist: string;
  durationSec: number;
  thumbnailUrl: string | null;
  source: string;
  requestedBy: string | null;
  requestedByName: string | null;
  requestedByAvatarUrl: string | null;
  url: string | null;
};

export type DashboardVoiceChannelPayload = {
  id: string;
  name: string;
  active: boolean;
  listenerCount: number;
};

export type DashboardListenerPayload = {
  id: string;
  name: string | null;
  avatarUrl: string | null;
  isBot: boolean;
};

export type DashboardSessionPayload = {
  guildId: string;
  guildName: string;
  voiceChannelId: string;
  voiceChannelName: string;
  userInChannel: boolean;
  canControl: boolean;
  autoplayEnabled: boolean;
  nowPlaying: (DashboardTrackPayload & {
    positionSec: number;
    paused: boolean;
    loopMode: 'off' | 'track' | 'queue';
    volumePercent: number;
    seekable: boolean;
  }) | null;
  queue: DashboardTrackPayload[];
  voiceChannels: DashboardVoiceChannelPayload[];
  listeners: DashboardListenerPayload[];
  effects: {
    filterPreset: string;
    eqPreset: string;
    tempoRatio: number;
    pitchSemitones: number;
  };
  voteSkip: {
    votes: number;
    required: number;
  };
  handoff: { userId: string; expiresAt: number } | null;
};

type SessionLike = Session & {
  tempDjHandoff?: { userId: string; expiresAt: number } | null;
};

type PlayerLike = Session['player'] & {
  getProgressSeconds?: () => number;
  canSeekCurrentTrack?: () => boolean;
  removeFromQueue?: (index: number) => Track | null;
  filterPreset?: string;
  eqPreset?: string;
  tempoRatio?: number;
  pitchSemitones?: number;
};

function voteSkipRequired(session: Session, listenerCount: number): number {
  const ratio = Math.max(0.1, Math.min(1, Number(session.settings?.voteSkipRatio ?? 0.5)));
  const minimum = Math.max(1, Number(session.settings?.voteSkipMinVotes ?? 2));
  return Math.max(minimum, Math.ceil(Math.max(1, listenerCount) * ratio));
}

function trackId(track: Track, fallbackIndex: number): string {
  const explicit = String(track.id ?? '').trim();
  if (explicit) return explicit;
  const url = String(track.url ?? '').trim();
  if (url) return url;
  return `track-${fallbackIndex}-${String(track.title ?? 'unknown')}`;
}

export function serializeTrack(track: Track, fallbackIndex: number): DashboardTrackPayload {
  return {
    id: trackId(track, fallbackIndex),
    title: String(track.title ?? 'Unknown title').trim() || 'Unknown title',
    artist: String(track.artist ?? '').trim() || 'Unknown artist',
    durationSec: parseTrackDurationSeconds(track.duration),
    thumbnailUrl: track.thumbnailUrl ?? null,
    source: String(track.source ?? 'unknown').trim() || 'unknown',
    requestedBy: track.requestedBy ? String(track.requestedBy) : null,
    requestedByName: null,
    requestedByAvatarUrl: null,
    url: String(track.url ?? '').trim() || null,
  };
}

function normalizeLoopMode(value: unknown): 'off' | 'track' | 'queue' {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (normalized === 'track' || normalized === 'queue') return normalized;
  return 'off';
}

export function userHasDjAccessForSession(
  session: SessionLike,
  userId: string,
  roleIds: string[],
): boolean {
  const handoff = session.tempDjHandoff ?? null;
  if (handoff && Number.isFinite(handoff.expiresAt) && handoff.expiresAt > Date.now()) {
    return String(handoff.userId) === String(userId);
  }

  const djRoles = session.settings?.djRoleIds;
  if (!djRoles || djRoles.size === 0) return true;
  return roleIds.some((roleId) => djRoles.has(roleId));
}

export function buildDashboardSessionPayload(options: {
  guildId: string;
  guildName: string;
  session: Session;
  userId: string;
  roleIds: string[];
  voiceStateStore: VoiceStateStore;
  botUserId: string | null;
  channelName?: string | null;
}): DashboardSessionPayload | null {
  const voiceChannelId = String(
    options.session.connection?.channelId
    ?? options.session.targetVoiceChannelId
    ?? '',
  ).trim();
  if (!voiceChannelId) return null;

  const userChannel = options.voiceStateStore.guildVoiceStates
    .get(options.guildId)
    ?.get(String(options.userId)) ?? null;
  const userInChannel = userChannel === voiceChannelId;
  const canControl = userInChannel && userHasDjAccessForSession(
    options.session as SessionLike,
    options.userId,
    options.roleIds,
  );

  const player = options.session.player as PlayerLike;
  const currentTrack = player.currentTrack as Track | null | undefined;
  const pendingTracks = (player.pendingTracks ?? []) as Track[];
  const progressSec = typeof player.getProgressSeconds === 'function'
    ? Math.max(0, Math.floor(player.getProgressSeconds()))
    : 0;

  const nowPlaying = currentTrack
    ? {
      ...serializeTrack(currentTrack, 0),
      positionSec: progressSec,
      paused: Boolean(player.paused),
      loopMode: normalizeLoopMode(player.loopMode),
      volumePercent: Number(player.volumePercent ?? 100),
      seekable: typeof player.canSeekCurrentTrack === 'function'
        ? player.canSeekCurrentTrack()
        : false,
    }
    : null;

  const listenerCount = options.voiceStateStore.countUsersInChannel(
    options.guildId,
    voiceChannelId,
    options.botUserId ? [options.botUserId] : [],
  );
  const votes = options.session.votes?.voters instanceof Set
    ? options.session.votes.voters.size
    : 0;
  const handoff = (options.session as SessionLike).tempDjHandoff ?? null;
  const activeHandoff = handoff && handoff.expiresAt > Date.now()
    ? { userId: String(handoff.userId), expiresAt: Number(handoff.expiresAt) }
    : null;

  const voiceChannels = buildVoiceChannelList({
    guildId: options.guildId,
    sessions: [options.session],
    voiceStateStore: options.voiceStateStore,
    botUserId: options.botUserId,
    channelNames: new Map([[voiceChannelId, options.channelName ?? voiceChannelId]]),
  });

  return {
    guildId: options.guildId,
    guildName: options.guildName,
    voiceChannelId,
    voiceChannelName: String(options.channelName ?? voiceChannelId).trim() || voiceChannelId,
    userInChannel,
    canControl,
    autoplayEnabled: Boolean(options.session.settings?.autoplayEnabled),
    nowPlaying,
    queue: pendingTracks.map((track, index) => serializeTrack(track, index + 1)),
    voiceChannels,
    listeners: options.voiceStateStore
      .getUsersInChannel(options.guildId, voiceChannelId)
      .map((id) => String(id))
      .filter((id) => id !== String(options.botUserId ?? ''))
      .map((id) => ({ id, name: null, avatarUrl: null, isBot: false })),
    effects: {
      filterPreset: String(player.filterPreset ?? 'off'),
      eqPreset: String(player.eqPreset ?? 'flat'),
      tempoRatio: Number(player.tempoRatio ?? 1),
      pitchSemitones: Number(player.pitchSemitones ?? 0),
    },
    voteSkip: {
      votes,
      required: voteSkipRequired(options.session, listenerCount),
    },
    handoff: activeHandoff,
  };
}

export function buildVoiceChannelList(options: {
  guildId: string;
  sessions: Session[];
  voiceStateStore: VoiceStateStore;
  botUserId: string | null;
  channelNames?: Map<string, string>;
}): DashboardVoiceChannelPayload[] {
  const excluded = options.botUserId ? [options.botUserId] : [];
  const names = options.channelNames ?? new Map<string, string>();
  const entries: DashboardVoiceChannelPayload[] = [];

  for (const session of options.sessions) {
    const channelId = String(
      session.connection?.channelId ?? session.targetVoiceChannelId ?? '',
    ).trim();
    if (!channelId) continue;

    const player = session.player;
    const active = Boolean(player?.playing || player?.currentTrack);
    entries.push({
      id: channelId,
      name: names.get(channelId) ?? channelId,
      active,
      listenerCount: options.voiceStateStore.countUsersInChannel(
        options.guildId,
        channelId,
        excluded,
      ),
    });
  }

  return entries;
}

export type DashboardGuildOverviewPayload = {
  guildId: string;
  guildName: string;
  userVoiceChannelId: string | null;
  voiceChannels: DashboardVoiceChannelPayload[];
};

export function buildGuildOverviewPayload(options: {
  guildId: string;
  guildName: string;
  sessions: Session[];
  voiceStateStore: VoiceStateStore;
  botUserId: string | null;
  userId: string;
  channelNames?: Map<string, string>;
}): DashboardGuildOverviewPayload {
  const guildId = String(options.guildId ?? '').trim();
  const userId = String(options.userId ?? '').trim();
  const userVoiceChannelId = getUserVoiceChannelId(options.voiceStateStore, guildId, userId);
  const voiceChannels = filterVoiceChannelsForUser(
    buildVoiceChannelList({
      guildId,
      sessions: options.sessions,
      voiceStateStore: options.voiceStateStore,
      botUserId: options.botUserId,
      ...(options.channelNames ? { channelNames: options.channelNames } : {}),
    }),
    userVoiceChannelId,
  );

  return {
    guildId,
    guildName: options.guildName,
    userVoiceChannelId,
    voiceChannels,
  };
}

export function buildGuildDashboardSessionPayload(options: {
  guildId: string;
  guildName: string;
  sessions: Session[];
  voiceChannelId: string;
  userId: string;
  roleIds: string[];
  voiceStateStore: VoiceStateStore;
  botUserId: string | null;
  channelNames?: Map<string, string>;
}): DashboardSessionPayload | null {
  const safeGuildId = String(options.guildId ?? '').trim();
  const voiceChannelId = String(options.voiceChannelId ?? '').trim();
  if (!safeGuildId || !voiceChannelId) return null;

  const session = options.sessions.find((entry) => {
    const channelId = String(
      entry.connection?.channelId ?? entry.targetVoiceChannelId ?? '',
    ).trim();
    return channelId === voiceChannelId;
  }) ?? null;

  if (!session) {
    const userVoiceChannelId = getUserVoiceChannelId(
      options.voiceStateStore,
      safeGuildId,
      options.userId,
    );
    return applyViewerRestrictions({
      guildId: safeGuildId,
      guildName: options.guildName,
      voiceChannelId,
      voiceChannelName: options.channelNames?.get(voiceChannelId) ?? voiceChannelId,
      userInChannel: false,
      canControl: false,
      autoplayEnabled: false,
      nowPlaying: null,
      queue: [],
      listeners: [],
      voiceChannels: filterVoiceChannelsForUser(
        buildVoiceChannelList({
          guildId: safeGuildId,
          sessions: options.sessions,
          voiceStateStore: options.voiceStateStore,
          botUserId: options.botUserId,
          ...(options.channelNames ? { channelNames: options.channelNames } : {}),
        }),
        userVoiceChannelId,
      ),
      effects: {
        filterPreset: 'off',
        eqPreset: 'flat',
        tempoRatio: 1,
        pitchSemitones: 0,
      },
      voteSkip: { votes: 0, required: 1 },
      handoff: null,
    }, userVoiceChannelId);
  }

  const payload = buildDashboardSessionPayload({
    guildId: safeGuildId,
    guildName: options.guildName,
    session,
    userId: options.userId,
    roleIds: options.roleIds,
    voiceStateStore: options.voiceStateStore,
    botUserId: options.botUserId,
    channelName: options.channelNames?.get(voiceChannelId) ?? voiceChannelId,
  });
  if (!payload) return null;

  payload.voiceChannels = buildVoiceChannelList({
    guildId: safeGuildId,
    sessions: options.sessions,
    voiceStateStore: options.voiceStateStore,
    botUserId: options.botUserId,
    ...(options.channelNames ? { channelNames: options.channelNames } : {}),
  });

  const userVoiceChannelId = getUserVoiceChannelId(
    options.voiceStateStore,
    safeGuildId,
    options.userId,
  );
  return applyViewerRestrictions(payload, userVoiceChannelId);
}
