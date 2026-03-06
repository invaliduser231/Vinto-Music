import { ValidationError } from '../../../core/errors.js';
import { applyMoodPreset } from '../advancedCommands.js';

export function ensureGuild(ctx) {
  if (!ctx.guildId) {
    throw new ValidationError('This command can only be used in a guild channel.');
  }
}

export function getSessionOrThrow(ctx) {
  const session = ctx.sessions.get(ctx.guildId);
  if (!session) {
    throw new ValidationError('No active player in this guild.');
  }
  return session;
}

export async function getGuildConfigOrThrow(ctx) {
  ensureGuild(ctx);
  if (!ctx.guildConfigs) {
    throw new ValidationError('Guild config store is not available.');
  }

  if (ctx.guildConfig && ctx.guildConfig.guildId === ctx.guildId) {
    return ctx.guildConfig;
  }

  const loaded = await ctx.guildConfigs.get(ctx.guildId);
  ctx.guildConfig = loaded;
  return loaded;
}

export async function updateGuildConfig(ctx, patch) {
  ensureGuild(ctx);
  if (!ctx.guildConfigs) {
    throw new ValidationError('Guild config store is not available.');
  }

  const updated = await ctx.guildConfigs.update(ctx.guildId, patch);
  ctx.guildConfig = updated;
  ctx.sessions.applyGuildConfig(ctx.guildId, updated);
  return updated;
}

function extractVoiceStateFromMemberPayload(member) {
  if (!member || typeof member !== 'object') return null;

  for (const candidate of [
    member.voice_state,
    member.voiceState,
    member.voice,
    member?.member?.voice_state,
    member?.member?.voiceState,
    member?.member?.voice,
  ]) {
    if (candidate && typeof candidate === 'object') return candidate;
  }

  return null;
}

function isVoiceStateDeafened(voiceState) {
  if (!voiceState || typeof voiceState !== 'object') return false;

  return [
    voiceState.deaf,
    voiceState.self_deaf,
    voiceState.selfDeaf,
    voiceState.is_deafened,
    voiceState.isDeafened,
  ].some((value) => value === true);
}

async function isBotCurrentlyDeafened(ctx) {
  if (!ctx?.guildId || !ctx?.botUserId || typeof ctx?.rest?.getGuildMember !== 'function') {
    return false;
  }

  try {
    const botMember = await ctx.rest.getGuildMember(ctx.guildId, ctx.botUserId);
    return isVoiceStateDeafened(extractVoiceStateFromMemberPayload(botMember));
  } catch {
    return false;
  }
}

export async function ensureConnectedSession(ctx, explicitChannelId = null) {
  let resolvedVoice = explicitChannelId ?? ctx.voiceStateStore.resolveMemberVoiceChannel(ctx.message);
  if (!resolvedVoice && !explicitChannelId && ctx.voiceStateStore.resolveMemberVoiceChannelWithFallback) {
    resolvedVoice = await ctx.voiceStateStore.resolveMemberVoiceChannelWithFallback(ctx.message, ctx.rest, 2_500);
  }
  if (!resolvedVoice) {
    const prefix = ctx.prefix ?? ctx.config.prefix;
    throw new ValidationError(`You are not in a voice channel. Use \`${prefix}play <#voice-channel> <query>\` as fallback.`);
  }

  if (ctx.permissionService) {
    const canVoice = await ctx.permissionService.canBotJoinAndSpeak(ctx.guildId, resolvedVoice);
    if (canVoice === false) {
      throw new ValidationError('I do not have permission to connect and speak in that voice channel.');
    }
  }

  if (await isBotCurrentlyDeafened(ctx)) {
    throw new ValidationError('Cannot connect to VC because I am Deafened - please undeafen me.');
  }

  const hadSession = ctx.sessions.has(ctx.guildId);
  const session = await ctx.sessions.ensure(ctx.guildId, ctx.guildConfig);
  ctx.sessions.bindTextChannel(ctx.guildId, ctx.channelId);

  const hasUsablePlayer = typeof session.connection?.hasUsablePlayer === 'function'
    ? session.connection.hasUsablePlayer()
    : true;
  if (session.connection.connected && hasUsablePlayer) return session;

  try {
    await session.connection.connect(resolvedVoice);
  } catch (err) {
    const shouldResetSession = !hadSession || String(err?.message ?? '').toLowerCase().includes('already been destroyed');
    if (shouldResetSession) {
      await ctx.sessions.destroy(ctx.guildId, 'connect_failed').catch(() => null);
    }
    if (await isBotCurrentlyDeafened(ctx)) {
      throw new ValidationError('Cannot connect to VC because I am Deafened - please undeafen me.');
    }
    throw err;
  }

  return session;
}

export async function applyVoiceProfileIfConfigured(ctx, session, explicitChannelId = null) {
  if (!ctx.library?.getVoiceProfile) return;
  const channelId = explicitChannelId ?? session?.connection?.channelId ?? null;
  if (!channelId || !ctx.guildId) return;

  const profile = await ctx.library.getVoiceProfile(ctx.guildId, channelId).catch(() => null);
  const moodPreset = String(profile?.moodPreset ?? '').trim().toLowerCase();
  if (moodPreset) {
    applyMoodPreset(session.player, moodPreset);
  }
}

export async function resolveQueueGuard(ctx) {
  if (!ctx.library?.getGuildFeatureConfig || !ctx.guildId) return null;
  const cfg = await ctx.library.getGuildFeatureConfig(ctx.guildId).catch(() => null);
  return cfg?.queueGuard ?? null;
}

export function requireLibrary(ctx) {
  if (!ctx.library) {
    throw new ValidationError('Music library storage is unavailable.');
  }
  return ctx.library;
}

export function ensureSessionTrack(_ctx, session) {
  const current = session?.player?.displayTrack ?? session?.player?.currentTrack ?? null;
  if (!current) {
    throw new ValidationError('Nothing is currently playing.');
  }
}

export function computeVoteSkipRequirement(ctx, session) {
  const channelId = session.connection.channelId;
  if (!channelId) return 1;

  const listeners = ctx.voiceStateStore.countUsersInChannel(
    ctx.guildId,
    channelId,
    ctx.botUserId ? [ctx.botUserId] : []
  );

  if (listeners <= 1) return 1;
  const ratio = Number.isFinite(session.settings.voteSkipRatio) ? session.settings.voteSkipRatio : ctx.config.voteSkipRatio;
  const minVotes = Number.isFinite(session.settings.voteSkipMinVotes) ? session.settings.voteSkipMinVotes : ctx.config.voteSkipMinVotes;
  return Math.max(minVotes, Math.ceil(listeners * ratio));
}

export function isUserInPlaybackChannel(ctx, session) {
  const userChannelId = ctx.voiceStateStore.resolveMemberVoiceChannel(ctx.message);
  return Boolean(userChannelId && session.connection.channelId && userChannelId === session.connection.channelId);
}
