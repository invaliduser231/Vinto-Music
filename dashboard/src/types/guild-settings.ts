export type GuildQueueGuard = {
  enabled: boolean;
  maxPerRequesterWindow: number;
  windowSize: number;
  maxArtistStreak: number;
};

export type GuildVoiceProfile = {
  channelId: string;
  stayInVoiceEnabled: boolean | null;
  autoplayEnabled: boolean | null;
  moodPreset: string | null;
};

export type GuildSettings = {
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
  queueGuard: GuildQueueGuard;
  voiceProfiles: GuildVoiceProfile[];
};
