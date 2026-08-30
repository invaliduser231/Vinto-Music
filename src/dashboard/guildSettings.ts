import type { GuildConfig } from '../types/domain.ts';

type GuildConfigInput = {
  prefix: string;
  settings: {
    dedupeEnabled?: boolean;
    stayInVoiceEnabled?: boolean;
    earrapeProtectionEnabled?: boolean;
    minimalMode?: boolean;
    autoplayEnabled?: boolean;
    volumePercent?: number;
    voteSkipRatio?: number;
    voteSkipMinVotes?: number;
    djRoleIds?: Set<string> | string[];
    musicLogChannelId?: string | null | undefined;
    language?: string | null | undefined;
  };
};

export type DashboardQueueGuardPayload = {
  enabled: boolean;
  maxPerRequesterWindow: number;
  windowSize: number;
  maxArtistStreak: number;
};

export type DashboardVoiceProfilePayload = {
  channelId: string;
  stayInVoiceEnabled: boolean | null;
  autoplayEnabled: boolean | null;
  moodPreset: string | null;
};

export type DashboardGuildSettingsPayload = {
  canManage: boolean;
  prefix: string;
  language: string | null;
  minimalMode: boolean;
  dedupeEnabled: boolean;
  earrapeProtectionEnabled: boolean;
  volumePercent: number;
  voteSkipRatio: number;
  voteSkipMinVotes: number;
  djRoleIds: string[];
  musicLogChannelId: string | null;
  autoplayEnabled: boolean;
  webhookUrl: string | null;
  recapChannelId: string | null;
  queueGuard: DashboardQueueGuardPayload;
  voiceProfiles: DashboardVoiceProfilePayload[];
};

export type GuildConfigStoreLike = {
  get: (guildId: string) => Promise<GuildConfigInput | null>;
  update: (guildId: string, patch: {
    prefix?: string;
    settings?: Partial<GuildConfig['settings']>;
  }) => Promise<GuildConfigInput>;
};

type FeatureConfigLike = {
  webhookUrl?: string | null;
  recapChannelId?: string | null;
  queueGuard?: {
    enabled?: boolean;
    maxPerRequesterWindow?: number;
    windowSize?: number;
    maxArtistStreak?: number;
  };
  voiceProfiles?: Array<{
    channelId?: string;
    stayInVoiceEnabled?: boolean | null;
    autoplayEnabled?: boolean | null;
    moodPreset?: string | null;
  }>;
};

type MusicLibraryLike = {
  getGuildFeatureConfig: (guildId: string) => Promise<FeatureConfigLike>;
  patchGuildFeatureConfig: (guildId: string, patch: Record<string, unknown>) => Promise<unknown>;
  setVoiceProfile: (
    guildId: string,
    channelId: string,
    patch: Record<string, unknown>,
  ) => Promise<unknown>;
};

function normalizeVoiceProfiles(
  profiles: FeatureConfigLike['voiceProfiles'],
): DashboardVoiceProfilePayload[] {
  if (!Array.isArray(profiles)) return [];
  return profiles
    .map((entry) => {
      const channelId = String(entry?.channelId ?? '').trim();
      if (!channelId) return null;
      const mood = entry?.moodPreset == null ? null : String(entry.moodPreset).trim() || null;
      const stay = typeof entry?.stayInVoiceEnabled === 'boolean' ? entry.stayInVoiceEnabled : null;
      const autoplay = typeof entry?.autoplayEnabled === 'boolean' ? entry.autoplayEnabled : null;
      return { channelId, stayInVoiceEnabled: stay, autoplayEnabled: autoplay, moodPreset: mood };
    })
    .filter((entry): entry is DashboardVoiceProfilePayload => entry != null);
}

export function buildGuildSettingsPayload(
  guildConfig: GuildConfigInput | null,
  features: FeatureConfigLike,
  canManage: boolean,
): DashboardGuildSettingsPayload {
  const settings = guildConfig?.settings ?? {};
  const queueGuard = features.queueGuard ?? {};
  return {
    canManage,
    prefix: guildConfig?.prefix ?? '!',
    language: settings.language ?? null,
    minimalMode: Boolean(settings.minimalMode),
    dedupeEnabled: Boolean(settings.dedupeEnabled),
    earrapeProtectionEnabled: Boolean(settings.earrapeProtectionEnabled),
    volumePercent: Number(settings.volumePercent ?? 100),
    voteSkipRatio: Number(settings.voteSkipRatio ?? 0.5),
    voteSkipMinVotes: Number(settings.voteSkipMinVotes ?? 2),
    djRoleIds: [...(settings.djRoleIds instanceof Set
      ? settings.djRoleIds
      : settings.djRoleIds ?? [])],
    musicLogChannelId: settings.musicLogChannelId ?? null,
    autoplayEnabled: Boolean(settings.autoplayEnabled),
    webhookUrl: features.webhookUrl ?? null,
    recapChannelId: features.recapChannelId ?? null,
    queueGuard: {
      enabled: Boolean(queueGuard.enabled),
      maxPerRequesterWindow: Number(queueGuard.maxPerRequesterWindow ?? 5),
      windowSize: Number(queueGuard.windowSize ?? 25),
      maxArtistStreak: Number(queueGuard.maxArtistStreak ?? 3),
    },
    voiceProfiles: normalizeVoiceProfiles(features.voiceProfiles),
  };
}

export type DashboardGuildSettingsPatch = {
  prefix?: string;
  language?: string | null;
  minimalMode?: boolean;
  dedupeEnabled?: boolean;
  earrapeProtectionEnabled?: boolean;
  volumePercent?: number;
  voteSkipRatio?: number;
  voteSkipMinVotes?: number;
  djRoleIds?: string[];
  musicLogChannelId?: string | null;
  autoplayEnabled?: boolean;
  webhookUrl?: string | null;
  recapChannelId?: string | null;
  queueGuard?: Partial<DashboardQueueGuardPayload>;
  voiceProfiles?: DashboardVoiceProfilePayload[];
};

export async function applyGuildSettingsPatch(
  guildId: string,
  patch: DashboardGuildSettingsPatch,
  guildConfigs: GuildConfigStoreLike,
  library: MusicLibraryLike,
): Promise<DashboardGuildSettingsPayload> {
  const settingsPatch: Partial<GuildConfig['settings']> = {};
  if (patch.language !== undefined) settingsPatch.language = patch.language;
  if (patch.minimalMode !== undefined) settingsPatch.minimalMode = patch.minimalMode;
  if (patch.dedupeEnabled !== undefined) settingsPatch.dedupeEnabled = patch.dedupeEnabled;
  if (patch.earrapeProtectionEnabled !== undefined) {
    settingsPatch.earrapeProtectionEnabled = patch.earrapeProtectionEnabled;
  }
  if (patch.volumePercent !== undefined) settingsPatch.volumePercent = patch.volumePercent;
  if (patch.voteSkipRatio !== undefined) settingsPatch.voteSkipRatio = patch.voteSkipRatio;
  if (patch.voteSkipMinVotes !== undefined) settingsPatch.voteSkipMinVotes = patch.voteSkipMinVotes;
  if (patch.djRoleIds !== undefined) settingsPatch.djRoleIds = patch.djRoleIds;
  if (patch.musicLogChannelId !== undefined) settingsPatch.musicLogChannelId = patch.musicLogChannelId;
  if (patch.autoplayEnabled !== undefined) settingsPatch.autoplayEnabled = patch.autoplayEnabled;

  const configPatch: { prefix?: string; settings?: Partial<GuildConfig['settings']> } = {};
  if (patch.prefix !== undefined) configPatch.prefix = patch.prefix;
  if (Object.keys(settingsPatch).length > 0) configPatch.settings = settingsPatch;

  const guildConfig = Object.keys(configPatch).length > 0
    ? await guildConfigs.update(guildId, configPatch)
    : await guildConfigs.get(guildId);

  const featurePatch: Record<string, unknown> = {};
  if (patch.webhookUrl !== undefined) featurePatch.webhookUrl = patch.webhookUrl;
  if (patch.recapChannelId !== undefined) featurePatch.recapChannelId = patch.recapChannelId;
  if (patch.queueGuard) {
    const current = await library.getGuildFeatureConfig(guildId);
    featurePatch.queueGuard = { ...(current.queueGuard ?? {}), ...patch.queueGuard };
  }
  if (patch.voiceProfiles) {
    featurePatch.voiceProfiles = patch.voiceProfiles.map((profile) => ({
      channelId: profile.channelId,
      stayInVoiceEnabled: profile.stayInVoiceEnabled,
      autoplayEnabled: profile.autoplayEnabled,
      moodPreset: profile.moodPreset,
      updatedAt: new Date(),
    }));
  }

  const features = Object.keys(featurePatch).length > 0
    ? await library.patchGuildFeatureConfig(guildId, featurePatch) as FeatureConfigLike
    : await library.getGuildFeatureConfig(guildId);

  if (!guildConfig) {
    throw new Error('guild config missing after update');
  }

  return buildGuildSettingsPayload(guildConfig, features, true);
}
