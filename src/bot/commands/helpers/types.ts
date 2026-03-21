import type { BivariantCallback, CommandDefinition, MessagePayload } from '../../../types/core.ts';

export type GuildConfigLike = {
  guildId?: string;
  prefix: string;
  settings: {
    dedupeEnabled: boolean;
    stayInVoiceEnabled: boolean;
    volumePercent: number;
    voteSkipRatio: number;
    voteSkipMinVotes: number;
    djRoleIds: string[];
    musicLogChannelId: string | null;
  };
};

export type QueueGuardLike = {
  enabled?: boolean;
  windowSize?: number;
  maxPerRequesterWindow?: number;
  maxArtistStreak?: number;
};

export type TrackDataLike = {
  id?: string | null;
  url?: string | null;
  title?: string | null;
  duration?: string | null;
  source?: string | null;
  requestedBy?: string | null;
  isLive?: boolean | null;
  thumbnailUrl?: string | null;
  [key: string]: unknown;
};

export type SessionLike = {
  guildId?: string | null;
  sessionId?: string | null;
  targetVoiceChannelId?: string | null;
  textChannelId?: string | null;
  tempDjHandoff?: { userId: string; expiresAt: number } | null;
  settings: {
    dedupeEnabled: boolean;
    stayInVoiceEnabled: boolean;
    voteSkipRatio: number;
    voteSkipMinVotes: number;
    djRoleIds: Set<string>;
    musicLogChannelId?: string | null;
    [key: string]: unknown;
  };
  connection: {
    channelId?: string | null;
    connected?: boolean;
    connect: (voiceChannelId: string) => Promise<unknown>;
    hasUsablePlayer: () => boolean;
    getDiagnostics: () => Record<string, unknown>;
    [key: string]: unknown;
  };
  player: {
    currentTrack?: TrackDataLike | null;
    displayTrack?: TrackDataLike | null;
    pendingTracks: TrackDataLike[];
    historyTracks?: TrackDataLike[];
    playing?: boolean;
    paused?: boolean;
    loopMode?: string;
    volumePercent?: number;
    filterPreset?: string;
    eqPreset?: string;
    createTrackFromData: (track: unknown, requestedBy?: string | null) => TrackDataLike;
    enqueueResolvedTracks: (tracks: unknown[], options?: Record<string, unknown>) => TrackDataLike[];
    play: () => Promise<unknown>;
    skip: () => Promise<unknown> | unknown;
    pause: () => unknown;
    resume: () => unknown;
    stop: () => Promise<unknown> | unknown;
    seekTo: (seconds: number) => number;
    removeFromQueue: (index: number) => unknown;
    clearQueue: () => unknown;
    shuffleQueue: () => unknown;
    setLoopMode: (mode: string) => unknown;
    setVolumePercent: (percent: number) => number;
    getAudioEffectsState: () => {
      filterPreset: string;
      eqPreset: string;
      tempoRatio: number;
      pitchSemitones: number;
      [key: string]: unknown;
    };
    getAvailableFilterPresets: () => string[];
    isLiveFilterPresetSupported: (preset: string) => boolean;
    getAvailableEqPresets: () => string[];
    setFilterPreset: (preset: string) => string;
    setEqPreset: (preset: string) => string;
    setTempoRatio: (ratio: number) => number;
    setPitchSemitones: (pitch: number) => number;
    refreshCurrentTrackProcessing: () => unknown;
    getDiagnostics: () => Record<string, unknown>;
    getState: () => Record<string, unknown>;
    replayCurrentTrack: () => Promise<unknown> | boolean;
    queuePreviousTrack: () => unknown;
    searchCandidates: (query: string, limit: number, options?: { requestedBy?: string | null }) => Promise<TrackDataLike[]>;
    getProgressSeconds: () => number;
    previewTracks: (query: string, options?: { requestedBy?: string | null; limit?: number }) => Promise<TrackDataLike[]>;
    on: (event: string, listener: BivariantCallback<unknown[], void | Promise<void>>) => unknown;
    off: (event: string, listener: BivariantCallback<unknown[], void | Promise<void>>) => unknown;
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

export type LibraryLike = {
  getGuildFeatureConfig: (guildId: string) => Promise<{
    webhookUrl?: string | null;
    recapChannelId?: string | null;
    queueGuard?: QueueGuardLike | null;
    [key: string]: unknown;
  }>;
  patchGuildFeatureConfig: (guildId: string, patch: Record<string, unknown>) => Promise<unknown>;
  getVoiceProfile: (guildId: string, channelId: string) => Promise<{ moodPreset?: string | null; stayInVoiceEnabled?: boolean | null } | null>;
  setVoiceProfile: (guildId: string, channelId: string, patch: Record<string, unknown>) => Promise<unknown>;
  listQueueTemplates: (guildId: string) => Promise<Array<{ name: string; tracks: TrackDataLike[] }>>;
  setQueueTemplate: (guildId: string, name: string, tracks: unknown[], authorId?: string | null) => Promise<{ name: string; tracks: TrackDataLike[] }>;
  deleteQueueTemplate: (guildId: string, name: string) => Promise<boolean>;
  getQueueTemplate: (guildId: string, name: string) => Promise<{ name: string; tracks: TrackDataLike[] } | null>;
  getGuildTopTracks: (guildId: string, days: number, limit: number) => Promise<Array<{ title?: string | null; plays?: number | null }>>;
  getRecapState: (guildId: string) => Promise<{ lastWeeklyRecapAt?: string | Date | null }>;
  buildGuildRecap: (guildId: string, days?: number) => Promise<{
    playCount: number;
    topTracks: Array<{ title?: string | null; plays?: number | null }>;
    topRequesters: Array<{ userId?: string | null; plays?: number | null }>;
  }>;
  getUserProfile: (userId: string, guildId: string) => Promise<{
    taste?: Array<{ term?: string; count?: number }>;
    guildStats?: { plays?: number; skips?: number; favorites?: number; score?: number };
  }>;
  listGuildHistory: (guildId: string, page?: number, pageSize?: number) => Promise<{
    items: TrackDataLike[];
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
  }>;
  [key: string]: unknown;
};

export type CommandContextLike = {
  prefix: string;
  args: string[];
  guildId: string;
  channelId: string;
  activeVoiceChannelId?: string | null;
  authorId: string;
  botUserId?: string | null;
  message: Record<string, unknown>;
  config: {
    prefix: string;
    enableEmbeds?: boolean;
    defaultStayInVoiceEnabled?: boolean;
    maxConcurrentVoiceChannelsPerGuild?: number;
    maxPlaylistTracks?: number;
    playCommandCooldownMs?: number;
    voteSkipRatio?: number;
    voteSkipMinVotes?: number;
    searchResultLimit?: number;
    [key: string]: unknown;
  };
  guildConfig?: GuildConfigLike | null;
  guildConfigs?: {
    get: (guildId: string) => Promise<GuildConfigLike>;
    update: (guildId: string, patch: Record<string, unknown>) => Promise<GuildConfigLike>;
  } | null;
  library?: LibraryLike | null;
  sessions: {
    get: (guildId: string, selector?: Record<string, unknown>) => SessionLike | null;
    has: (guildId: string, selector?: Record<string, unknown>) => boolean;
    ensure: (guildId: string, guildConfig?: GuildConfigLike | null, selector?: Record<string, unknown>) => Promise<SessionLike>;
    bindTextChannel: (guildId: string, channelId: string, selector?: Record<string, unknown>) => unknown;
    applyGuildConfig: (guildId: string, config: GuildConfigLike) => unknown;
    destroy: (guildId: string, reason?: string, selector?: Record<string, unknown>) => Promise<unknown>;
    listByGuild?: (guildId: string) => SessionLike[];
    adoptVoiceChannel?: (session: SessionLike, channelId: string) => unknown;
    syncPersistentVoiceState?: (guildId: string) => Promise<unknown>;
    refreshVoiceProfileSettings?: (guildId: string, selector?: Record<string, unknown>) => Promise<unknown>;
    [key: string]: unknown;
  };
  voiceStateStore: {
    resolveMemberVoiceChannel: (message: Record<string, unknown>) => string | null;
    resolveMemberVoiceChannelWithFallback?: (message: Record<string, unknown>, rest: unknown, timeoutMs?: number) => Promise<string | null>;
    countUsersInChannel: (guildId: string, channelId: string, excludedUserIds?: string[]) => number;
    [key: string]: unknown;
  };
  permissionService?: {
    canBotJoinAndSpeak?: (guildId: string, voiceChannelId: string) => Promise<boolean | null>;
  } | null;
  guildStateCache?: {
    resolveOwnerId?: (guildId: string) => string | null;
    computeManageGuildPermission?: (guildId: string, roleIds: string[], userId: string) => boolean | null;
  } | null;
  rest?: {
    sendMessage?: (channelId: string, payload: MessagePayload) => Promise<unknown>;
    editMessage?: (channelId: string, messageId: string, payload: MessagePayload) => Promise<unknown>;
    getGuildMember?: (guildId: string, userId: string) => Promise<unknown>;
    getGuild?: (guildId: string) => Promise<unknown>;
    listGuildRoles?: (guildId: string) => Promise<unknown>;
  } | null;
  reply: {
    info: (text: string, fields?: Array<{ name: string; value: string; inline?: boolean }> | null, options?: unknown) => Promise<unknown>;
    success: (text: string, fields?: Array<{ name: string; value: string; inline?: boolean }> | null, options?: unknown) => Promise<unknown>;
    warning: (text: string, fields?: Array<{ name: string; value: string; inline?: boolean }> | null, options?: unknown) => Promise<unknown>;
    error: (text: string, fields?: Array<{ name: string; value: string; inline?: boolean }> | null, options?: unknown) => Promise<unknown>;
  };
  sendPaginated: (pages: MessagePayload[]) => Promise<unknown>;
  [key: string]: unknown;
};

export type CommandHelperBundle = {
  createCommand: <T extends {
    name: string;
    aliases?: string[];
    description?: string;
    usage?: string;
    hidden?: boolean;
    execute?: (ctx: CommandContextLike) => unknown;
  }>(definition: T) => Readonly<T & CommandDefinition>;
  ensureGuild: (ctx: CommandContextLike) => void;
  getGuildConfigOrThrow: (ctx: CommandContextLike) => Promise<GuildConfigLike>;
  updateGuildConfig: (ctx: CommandContextLike, patch: Record<string, unknown>) => Promise<GuildConfigLike>;
  requireLibrary: (ctx: CommandContextLike) => LibraryLike;
  parseOnOff: (value: unknown, fallback?: boolean | null) => boolean | null;
  parseRoleId: (value: unknown) => string | null;
  parseTextChannelId: (value: unknown) => string | null;
  resolveActiveVoiceChannelOrThrow: (ctx: CommandContextLike, options?: { fallbackCommand?: string | null }) => Promise<string>;
  ensureManageGuildAccess: (ctx: CommandContextLike, actionLabel: string) => Promise<void>;
  getSessionOrThrow: (ctx: CommandContextLike) => SessionLike;
  ensureConnectedSession: (ctx: CommandContextLike, explicitChannelId?: string | null) => Promise<SessionLike>;
  ensureDjAccess: (ctx: CommandContextLike, session: SessionLike, actionLabel: string) => void;
  parseRequiredInteger: (value: unknown, label: string) => number;
};
