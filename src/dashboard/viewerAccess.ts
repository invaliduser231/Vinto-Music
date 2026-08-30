import type { VoiceStateStore } from '../bot/voiceStateStore.ts';
import type {
  DashboardSessionPayload,
  DashboardVoiceChannelPayload,
} from './sessionSnapshot.ts';

export function getUserVoiceChannelId(
  voiceStateStore: VoiceStateStore,
  guildId: string,
  userId: string,
): string | null {
  const safeGuildId = String(guildId ?? '').trim();
  const safeUserId = String(userId ?? '').trim();
  if (!safeGuildId || !safeUserId) return null;
  return voiceStateStore.guildVoiceStates.get(safeGuildId)?.get(safeUserId) ?? null;
}

export type UserVoiceBinding = {
  guildId: string;
  voiceChannelId: string;
};

export function findUserVoiceBinding(
  voiceStateStore: VoiceStateStore,
  userId: string,
  allowedGuildIds: readonly string[] = [],
): UserVoiceBinding | null {
  const safeUserId = String(userId ?? '').trim();
  if (!safeUserId) return null;

  const allowed = allowedGuildIds.length > 0
    ? new Set(allowedGuildIds.map((entry) => String(entry).trim()).filter(Boolean))
    : null;

  const orderedGuildIds = allowedGuildIds.length > 0
    ? allowedGuildIds.map((entry) => String(entry).trim()).filter(Boolean)
    : [...voiceStateStore.guildVoiceStates.keys()];

  for (const guildId of orderedGuildIds) {
    if (allowed && !allowed.has(guildId)) continue;
    const voiceChannelId = voiceStateStore.guildVoiceStates.get(guildId)?.get(safeUserId);
    if (voiceChannelId) {
      return { guildId, voiceChannelId };
    }
  }

  return null;
}

export function filterVoiceChannelsForUser(
  channels: DashboardVoiceChannelPayload[],
  userVoiceChannelId: string | null,
): DashboardVoiceChannelPayload[] {
  if (!userVoiceChannelId) return [];
  return channels.filter((channel) => channel.id === userVoiceChannelId);
}

export function applyViewerRestrictions(
  payload: DashboardSessionPayload,
  userVoiceChannelId: string | null,
): DashboardSessionPayload {
  const voiceChannels = filterVoiceChannelsForUser(payload.voiceChannels, userVoiceChannelId);
  const userInChannel = Boolean(
    userVoiceChannelId && userVoiceChannelId === payload.voiceChannelId,
  );

  if (userInChannel) {
    return {
      ...payload,
      userInChannel: true,
      voiceChannels,
    };
  }

  return {
    ...payload,
    userInChannel: false,
    canControl: false,
    autoplayEnabled: false,
    nowPlaying: null,
    queue: [],
    voiceChannels,
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
