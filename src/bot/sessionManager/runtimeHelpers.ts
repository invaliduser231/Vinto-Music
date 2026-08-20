import { isHttpUrl, isYouTubeUrl } from '../../player/musicPlayer/trackUtils.ts';
import type {
  GuildConfig,
  SessionManagerConfigLike,
  SessionSettings,
  Track,
  VoiceProfileSettings,
} from '../../types/domain.ts';

export function now(): number {
  return Date.now();
}

export function toBool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

export function toPositiveInt(value: unknown, fallback: number): number {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function toVolumePercent(value: unknown, fallback: number): number {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 200 ? parsed : fallback;
}

export function toRatio(value: unknown, fallback: number): number {
  const parsed = Number.parseFloat(String(value ?? ''));
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 1 ? parsed : fallback;
}

export function toRoleSet(value: unknown): Set<string> {
  if (value instanceof Set) {
    return new Set([...value].map((id) => String(id)));
  }

  if (Array.isArray(value)) {
    return new Set(
      value
        .map((id) => String(id ?? '').trim())
        .filter((id) => /^\d{6,}$/.test(id))
    );
  }

  return new Set();
}

export function toChannelId(value: unknown): string | null {
  const normalized = String(value ?? '').trim();
  if (!normalized) return null;
  return /^\d{6,}$/.test(normalized) ? normalized : null;
}

export function normalizeSessionChannelId(value: unknown): string | null {
  const normalized = String(value ?? '').trim();
  return normalized || null;
}

export function hasPendingTracks(player: { pendingTracks?: unknown[]; queue?: { pendingSize?: number } } | null | undefined): boolean {
  const pendingTracks = player?.pendingTracks;
  if (Array.isArray(pendingTracks)) return pendingTracks.length > 0;
  return Number.parseInt(String(player?.queue?.pendingSize ?? 0), 10) > 0;
}

export function cloneTrackForSnapshot(track: Partial<Track> | null | undefined, seekStartSec = 0): Track | null {
  if (!track || typeof track !== 'object') return null;
  const queuedAt = typeof track.queuedAt === 'number' && Number.isFinite(track.queuedAt)
    ? track.queuedAt
    : Date.now();
  return {
    id: String(track.id ?? ''),
    title: track.title ?? 'Unknown title',
    url: String(track.url ?? ''),
    duration: track.duration ?? 'Unknown',
    thumbnailUrl: track.thumbnailUrl ?? null,
    requestedBy: track.requestedBy ?? null,
    source: track.source ?? 'unknown',
    artist: track.artist ?? null,
    soundcloudTrackId: track.soundcloudTrackId ?? null,
    audiusTrackId: track.audiusTrackId ?? null,
    deezerTrackId: track.deezerTrackId ?? null,
    deezerPreviewUrl: track.deezerPreviewUrl ?? null,
    deezerFullStreamUrl: track.deezerFullStreamUrl ?? null,
    spotifyTrackId: track.spotifyTrackId ?? null,
    spotifyPreviewUrl: track.spotifyPreviewUrl ?? null,
    isrc: track.isrc ?? null,
    nodelinkEncodedTrack: track.nodelinkEncodedTrack ?? null,
    nodelinkInfo: track.nodelinkInfo && typeof track.nodelinkInfo === 'object'
      ? { ...track.nodelinkInfo }
      : null,
    isPreview: track.isPreview === true,
    isLive: track.isLive === true,
    queuedAt,
    seekStartSec: Math.max(0, Number.parseInt(String(seekStartSec ?? 0), 10) || 0),
  };
}

export function buildSnapshotRestoreQuery(track: Partial<Track> | null | undefined): string {
  const url = String(track?.url ?? '').trim();
  if (url) return url;

  const artist = String(track?.artist ?? '').trim();
  const title = String(track?.title ?? '').trim();
  if (artist && title) return `${artist} - ${title}`;
  return title || artist || '';
}

export function isSnapshotTrackDirectlyPlayable(track: Partial<Track> | null | undefined): boolean {
  if (!track || typeof track !== 'object') return false;

  const source = String(track.source ?? '').trim().toLowerCase();
  const url = String(track.url ?? '').trim();

  if (track.nodelinkEncodedTrack) return true;
  if (isYouTubeUrl(url)) return true;
  if (track.deezerTrackId || source.startsWith('deezer')) return true;
  if (source.startsWith('audius')) return true;
  if (source.startsWith('soundcloud')) return true;
  if (source.startsWith('radio')) return false;
  if (track.isLive) return isHttpUrl(url);
  if ((source === 'http-audio' || source === 'url') && isHttpUrl(url)) return true;

  return false;
}

export function toSeekStartSec(value: unknown): number {
  return Math.max(0, Number.parseInt(String(value ?? 0), 10) || 0);
}

export function toSnapshotPersistOptions(options: unknown): { force: boolean; seekStartSec?: number } {
  if (!options || typeof options !== 'object') {
    return {
      force: false,
    };
  }

  const typedOptions = options as { force?: boolean; seekStartSec?: unknown };
  return {
    force: typedOptions.force === true,
    seekStartSec: toSeekStartSec(typedOptions.seekStartSec ?? 0),
  };
}

export function createSessionKey(guildId: unknown, voiceChannelId: unknown = null): string {
  const safeGuildId = String(guildId ?? '').trim();
  const safeVoiceChannelId = normalizeSessionChannelId(voiceChannelId);
  return safeVoiceChannelId
    ? `${safeGuildId}:${safeVoiceChannelId}`
    : `${safeGuildId}:preview`;
}

export function defaultSettings(config: SessionManagerConfigLike): SessionSettings {
  return {
    dedupeEnabled: Boolean(config.defaultDedupeEnabled),
    stayInVoiceEnabled: Boolean(config.defaultStayInVoiceEnabled),
    earrapeProtectionEnabled: false,
    minimalMode: false,
    volumePercent: toVolumePercent(config.defaultVolumePercent, 100),
    voteSkipRatio: toRatio(config.voteSkipRatio, 0.5),
    voteSkipMinVotes: toPositiveInt(config.voteSkipMinVotes, 2),
    djRoleIds: new Set(),
    musicLogChannelId: null,
  };
}

export function normalizeVoiceProfileSettings(profile: unknown): VoiceProfileSettings {
  if (!profile || typeof profile !== 'object') {
    return {
      stayInVoiceEnabled: null,
    };
  }

  const typedProfile = profile as { stayInVoiceEnabled?: unknown };
  return {
    stayInVoiceEnabled: typeof typedProfile.stayInVoiceEnabled === 'boolean'
      ? typedProfile.stayInVoiceEnabled
      : null,
  };
}

export function settingsFromGuildConfig(
  config: SessionManagerConfigLike,
  guildConfig: GuildConfig | null,
  voiceProfileSettings: VoiceProfileSettings | null = null
): SessionSettings {
  const defaults = defaultSettings(config);
  const fallbackDedupeEnabled = defaults.dedupeEnabled ?? false;
  const fallbackStayInVoiceEnabled = defaults.stayInVoiceEnabled ?? false;
  const fallbackEarrapeProtectionEnabled = defaults.earrapeProtectionEnabled ?? false;
  const fallbackVolumePercent = defaults.volumePercent ?? 100;
  const fallbackVoteSkipRatio = defaults.voteSkipRatio ?? 0.5;
  const fallbackVoteSkipMinVotes = defaults.voteSkipMinVotes ?? 2;
  const source: Partial<GuildConfig['settings']> = guildConfig?.settings ?? {};
  const profile = normalizeVoiceProfileSettings(voiceProfileSettings);

  return {
    dedupeEnabled: toBool(source.dedupeEnabled, fallbackDedupeEnabled),
    stayInVoiceEnabled: typeof profile.stayInVoiceEnabled === 'boolean'
      ? profile.stayInVoiceEnabled
      : toBool(source.stayInVoiceEnabled, fallbackStayInVoiceEnabled),
    earrapeProtectionEnabled: toBool(source.earrapeProtectionEnabled, fallbackEarrapeProtectionEnabled),
    minimalMode: toBool(source.minimalMode, defaults.minimalMode ?? false),
    volumePercent: toVolumePercent(source.volumePercent, fallbackVolumePercent),
    voteSkipRatio: toRatio(source.voteSkipRatio, fallbackVoteSkipRatio),
    voteSkipMinVotes: toPositiveInt(source.voteSkipMinVotes, fallbackVoteSkipMinVotes),
    djRoleIds: toRoleSet(source.djRoleIds),
    musicLogChannelId: toChannelId(source.musicLogChannelId),
  };
}
