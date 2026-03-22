import type { BivariantCallback, LoggerLike } from './core.ts';
import type { AppConfig } from '../config.ts';

export type ChannelId = string | null;
export type UserId = string | null;

type VoiceServerUpdate = {
  guild_id?: string;
  endpoint?: string;
  token?: string;
};

export interface Track {
  id?: string;
  title?: string;
  url?: string;
  duration?: string | number;
  thumbnailUrl?: string | null;
  requestedBy?: UserId;
  source?: string;
  artist?: string | null;
  soundcloudTrackId?: string | null;
  audiusTrackId?: string | null;
  deezerTrackId?: string | null;
  deezerPreviewUrl?: string | null;
  deezerFullStreamUrl?: string | null;
  spotifyTrackId?: string | null;
  spotifyPreviewUrl?: string | null;
  isPreview?: boolean;
  isLive?: boolean;
  queuedAt?: number;
  seekStartSec?: number;
}

export type TrackInput = Partial<Track> & Record<string, unknown>;

export interface VoiceProfileSettings {
  stayInVoiceEnabled: boolean | null;
}

export interface SessionSettings {
  dedupeEnabled?: boolean;
  stayInVoiceEnabled?: boolean;
  minimalMode?: boolean;
  volumePercent?: number;
  voteSkipRatio?: number;
  voteSkipMinVotes?: number;
  djRoleIds?: Set<string>;
  musicLogChannelId?: ChannelId;
}

export interface GuildConfig {
  guildId: string;
  prefix: string;
  settings: {
    dedupeEnabled?: boolean;
    stayInVoiceEnabled?: boolean;
    minimalMode?: boolean;
    volumePercent?: number;
    voteSkipRatio?: number;
    voteSkipMinVotes?: number;
    djRoleIds?: string[];
    musicLogChannelId?: ChannelId;
  };
  createdAt?: Date | null;
  updatedAt?: Date | null;
}

export interface SnapshotState {
  playing: boolean;
  paused: boolean;
  loopMode: string;
  volumePercent: number;
  progressSec: number;
}

export interface SessionSnapshotDocument {
  guildId: string;
  voiceChannelId: string;
  textChannelId: ChannelId;
  state: SnapshotState;
  currentTrack: Track | null;
  pendingTracks: Track[];
  updatedAt: Date;
}

export interface PersistentVoiceBinding {
  guildId?: string;
  voiceChannelId?: string | null;
  textChannelId?: string | null;
}

export interface SessionSelector {
  sessionId?: string;
  voiceChannelId?: string | null;
  textChannelId?: string | null;
  allowAnyGuildSession?: boolean;
  skipSnapshotPersist?: boolean;
}

export interface SessionVotes {
  trackId: string | null;
  voters: Set<string>;
}

export interface SessionDiagnosticsState {
  timer: unknown;
  inFlight: boolean;
}

export interface SessionSnapshotState {
  dirty: boolean;
  lastPersistAt: number;
  inFlight: boolean;
}

export interface SessionRestoreState {
  inProgress?: boolean;
  suppressStartupErrors?: boolean;
}

export interface VoiceConnectionLike {
  connected?: boolean;
  channelId?: string | null;
  currentAudioStream?: unknown;
  isStreaming?: boolean;
  connect?: (channelId: string) => Promise<unknown>;
  disconnect?: () => Promise<unknown>;
  sendAudio?: (stream: unknown) => Promise<unknown>;
  stopAudio?: () => unknown;
  pauseAudio?: () => unknown;
  resumeAudio?: () => unknown;
  getDiagnostics?: () => Promise<unknown>;
}

export interface MusicPlayerQueueLike {
  pendingSize?: number;
  current?: unknown;
}

export interface MusicPlayerLike {
  playing?: boolean;
  paused?: boolean;
  currentTrack?: unknown;
  pendingTracks?: unknown[];
  loopMode?: string;
  volumePercent?: number;
  queue?: MusicPlayerQueueLike;
  on?: (event: string, listener: BivariantCallback<unknown[], void>) => unknown;
  off?: (event: string, listener: BivariantCallback<unknown[], void>) => unknown;
  emit?: (event: string, ...args: unknown[]) => unknown;
  play?: () => Promise<unknown>;
  pause?: () => unknown;
  stop?: () => unknown;
  clearQueue?: () => unknown;
  setVolumePercent?: (value: number) => unknown;
  setLoopMode?: (value: string) => unknown;
  getProgressSeconds?: () => number;
  canSeekCurrentTrack?: () => boolean;
  getDiagnostics?: () => unknown;
  getState?: () => unknown;
  createTrackFromData?: BivariantCallback<[unknown, (string | null | undefined)?], unknown>;
  enqueueResolvedTracks?: BivariantCallback<[unknown[], (Record<string, unknown> | undefined)?], unknown[]>;
  previewTracks?: BivariantCallback<
    [string, { requestedBy?: string | null; limit?: number }],
    Promise<unknown[]>
  >;
}

export interface Session {
  sessionId?: string | null;
  guildId: string;
  targetVoiceChannelId?: string | null;
  voiceProfileSettings?: VoiceProfileSettings;
  connection: VoiceConnectionLike;
  player: MusicPlayerLike;
  settings: SessionSettings;
  votes?: SessionVotes;
  createdAt?: number;
  lastActivityAt?: number;
  textChannelId?: string | null;
  idleTimer?: unknown;
  idleTimeoutIgnoreListeners?: boolean;
  diagnostics?: SessionDiagnosticsState;
  snapshot?: SessionSnapshotState;
  restoreState?: SessionRestoreState;
}

export interface SessionManagerConfigLike extends Partial<AppConfig> {
  defaultDedupeEnabled?: boolean;
  defaultStayInVoiceEnabled?: boolean;
  defaultVolumePercent?: number;
  voteSkipRatio?: number;
  voteSkipMinVotes?: number;
  sessionIdleMs?: number;
}

export interface SessionManagerOptions {
  gateway: {
    joinVoice: (guildId: string, channelId: string) => void;
    leaveVoice: (guildId: string) => void;
    on: (event: string, listener: BivariantCallback<[VoiceServerUpdate], void>) => void;
    off: (event: string, listener: BivariantCallback<[VoiceServerUpdate], void>) => void;
  };
  config: SessionManagerConfigLike;
  logger?: LoggerLike | null | undefined;
  guildConfigs?: GuildConfigStoreLike | null;
  library?: LibraryStoreLike | null;
  rest?: RestAdapterLike | null;
  voiceStateStore?: VoiceStateStoreLike | null;
  botUserId?: string | null;
}

export interface GuildConfigStoreLike {
  get: (guildId: string) => Promise<GuildConfig | null>;
}

export interface VoiceProfileDocument {
  stayInVoiceEnabled?: boolean | null;
  [key: string]: unknown;
}

export interface GuildFeatureConfigDocument {
  persistentVoiceConnections?: PersistentVoiceBinding[];
  restartRecoveryConnections?: PersistentVoiceBinding[];
}

export interface LibraryStoreLike {
  recordUserSignal?: (guildId: string, userId: string, signal: string, track?: unknown) => Promise<unknown>;
  patchGuildFeatureConfig?: (guildId: string, patch: Record<string, unknown>) => Promise<unknown>;
  listPersistentVoiceConnections?: () => Promise<PersistentVoiceBinding[]>;
  upsertSessionSnapshot?: (guildId: string, voiceChannelId: string, snapshot: SessionSnapshotDocument) => Promise<unknown>;
  deleteSessionSnapshot?: (guildId: string, voiceChannelId: string) => Promise<unknown>;
  getSessionSnapshot?: (guildId: string, voiceChannelId: string) => Promise<unknown>;
  getVoiceProfile?: (guildId: string, voiceChannelId: string) => Promise<VoiceProfileDocument | null>;
  getGuildFeatureConfig?: (guildId: string) => Promise<GuildFeatureConfigDocument | null>;
}

export interface RestAdapterLike {
  getChannel?: (channelId: string) => Promise<unknown>;
}

export interface VoiceStateStoreLike {
  countUsersInChannel?: (guildId: string, channelId: string, excludedUserIds?: string[]) => number;
}

export interface PipelineProcess {
  pid?: number;
  stdin?: {
    destroy?: (error?: Error) => unknown;
    on?: (event: string, listener: BivariantCallback<unknown[], void>) => unknown;
    off?: (event: string, listener: BivariantCallback<unknown[], void>) => unknown;
    write?: BivariantCallback<unknown[], unknown>;
    end?: BivariantCallback<unknown[], unknown>;
    unpipe?: BivariantCallback<[(NodeJS.WritableStream | undefined)?], unknown>;
  } | null;
  stdout?: {
    destroy?: (error?: Error) => unknown;
    on?: (event: string, listener: BivariantCallback<unknown[], void>) => unknown;
    off?: (event: string, listener: BivariantCallback<unknown[], void>) => unknown;
    pipe?: BivariantCallback<[(NodeJS.WritableStream | null | undefined), ({ end?: boolean } | undefined)?], unknown>;
    unpipe?: BivariantCallback<[(NodeJS.WritableStream | undefined)?], unknown>;
    setEncoding?: (encoding: BufferEncoding) => unknown;
    [Symbol.asyncIterator]?: () => AsyncIterator<unknown>;
  } | null;
  stderr?: {
    destroy?: (error?: Error) => unknown;
    on?: (event: string, listener: BivariantCallback<unknown[], void>) => unknown;
    off?: (event: string, listener: BivariantCallback<unknown[], void>) => unknown;
    pipe?: BivariantCallback<[(NodeJS.WritableStream | null | undefined), ({ end?: boolean } | undefined)?], unknown>;
    unpipe?: BivariantCallback<[(NodeJS.WritableStream | undefined)?], unknown>;
    setEncoding?: (encoding: BufferEncoding) => unknown;
    [Symbol.asyncIterator]?: () => AsyncIterator<unknown>;
  } | null;
  kill?: (signal?: NodeJS.Signals | number | string) => unknown;
  once?: (event: string, listener: BivariantCallback<unknown[], void>) => unknown;
}
