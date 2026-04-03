import { ValidationError } from '../../../core/errors.ts';
import { applyMoodPreset } from '../advancedCommands.ts';
import type { CommandContextLike, GuildConfigLike, LibraryLike, SessionLike } from './types.ts';

type VoiceStateLike = {
  self_deaf?: boolean;
  selfDeaf?: boolean;
};

type MemberLike = {
  voice_state?: VoiceStateLike;
  voiceState?: VoiceStateLike;
  voice?: VoiceStateLike;
  member?: {
    voice_state?: VoiceStateLike;
    voiceState?: VoiceStateLike;
    voice?: VoiceStateLike;
  };
};

export function ensureGuild(ctx: Pick<CommandContextLike, 'guildId'>): void {
  if (!ctx.guildId) {
    throw new ValidationError('This command can only be used in a guild channel.');
  }
}

export function getSessionOrThrow(ctx: CommandContextLike): SessionLike {
  const session = ctx.sessions.get(ctx.guildId, {
    voiceChannelId: ctx.activeVoiceChannelId,
    textChannelId: ctx.channelId,
  });
  if (!session) {
    throw new ValidationError('No active player in this channel.');
  }
  return session;
}

export async function getGuildConfigOrThrow(ctx: CommandContextLike): Promise<GuildConfigLike> {
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

export async function updateGuildConfig(ctx: CommandContextLike, patch: Record<string, unknown>): Promise<GuildConfigLike> {
  ensureGuild(ctx);
  if (!ctx.guildConfigs) {
    throw new ValidationError('Guild config store is not available.');
  }

  const updated = await ctx.guildConfigs.update(ctx.guildId, patch);
  ctx.guildConfig = updated;
  ctx.sessions.applyGuildConfig(ctx.guildId, updated);
  return updated;
}

function extractVoiceStateFromMemberPayload(member: MemberLike | null | undefined): VoiceStateLike | null {
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

function isVoiceStateDeafened(voiceState: VoiceStateLike | null | undefined): boolean {
  if (!voiceState || typeof voiceState !== 'object') return false;

  return [
    voiceState.self_deaf,
    voiceState.selfDeaf,
  ].some((value) => value === true);
}

async function isBotCurrentlyDeafened(ctx: CommandContextLike): Promise<boolean> {
  if (!ctx?.guildId || !ctx?.botUserId) {
    return false;
  }

  if (typeof ctx?.rest?.getGuildMember !== 'function') {
    return false;
  }

  try {
    const botMember = await ctx.rest.getGuildMember(ctx.guildId, ctx.botUserId);
    return isVoiceStateDeafened(extractVoiceStateFromMemberPayload(botMember as MemberLike | null | undefined));
  } catch {
    return false;
  }
}

export async function resolveActiveVoiceChannelOrThrow(ctx: CommandContextLike, options: { fallbackCommand?: string | null } = {}) {
  const fallbackCommand = String(options.fallbackCommand ?? 'play').trim() || 'play';
  let resolvedVoice = ctx.voiceStateStore.resolveMemberVoiceChannel(ctx.message);
  if (!resolvedVoice && ctx.voiceStateStore.resolveMemberVoiceChannelWithFallback) {
    resolvedVoice = await ctx.voiceStateStore.resolveMemberVoiceChannelWithFallback(ctx.message, ctx.rest, 2_500);
  }
  if (resolvedVoice) return resolvedVoice;

  const prefix = ctx.prefix ?? ctx.config.prefix;
  throw new ValidationError(
    `You are not connected to a voice channel. Join one first, or target one explicitly with \`${prefix}${fallbackCommand} <#voice-channel> <query>\`.`
  );
}

export async function ensureConnectedSession(ctx: CommandContextLike, explicitChannelId: string | null = null): Promise<SessionLike> {
  const resolvedVoice = explicitChannelId ?? await resolveActiveVoiceChannelOrThrow(ctx, { fallbackCommand: 'play' });

  if (ctx.permissionService?.canBotJoinAndSpeak) {
    const canVoice = await ctx.permissionService.canBotJoinAndSpeak(ctx.guildId, resolvedVoice);
    if (canVoice === false) {
      throw new ValidationError('I do not have permission to connect and speak in that voice channel.');
    }
  }

  if (await isBotCurrentlyDeafened(ctx)) {
    throw new ValidationError('Cannot connect to VC because I am Deafened - please undeafen me.');
  }

  const selector = { voiceChannelId: resolvedVoice };
  const hadSession = ctx.sessions.has(ctx.guildId, selector);
  const concurrentGuildSessions = Array.isArray(ctx.sessions.listByGuild?.(ctx.guildId))
    ? ctx.sessions.listByGuild(ctx.guildId).filter((session) => {
      const hasTargetChannel = Boolean(session?.targetVoiceChannelId);
      const hasConnectedChannel = Boolean(session?.connection?.channelId);
      return hasTargetChannel || hasConnectedChannel;
    })
    : [];
  const maxConcurrentVoiceChannels = Number.parseInt(
    String(ctx.config?.maxConcurrentVoiceChannelsPerGuild ?? 5),
    10
  ) || 5;
  if (!hadSession && concurrentGuildSessions.length >= maxConcurrentVoiceChannels) {
    throw new ValidationError(
      `This server already has the maximum number of active voice sessions (${maxConcurrentVoiceChannels}).`
    );
  }

  const session = await ctx.sessions.ensure(ctx.guildId, ctx.guildConfig, {
    voiceChannelId: resolvedVoice,
    textChannelId: ctx.channelId,
  });

  const hasUsablePlayer = typeof session.connection?.hasUsablePlayer === 'function'
    ? session.connection.hasUsablePlayer()
    : true;

  ctx.sessions.bindTextChannel(ctx.guildId, ctx.channelId, selector);
  if (session.connection.connected && hasUsablePlayer) return session;

  try {
    await session.connection.connect?.(resolvedVoice);
    ctx.sessions.adoptVoiceChannel?.(session, resolvedVoice);
    await ctx.sessions.syncPersistentVoiceState?.(ctx.guildId);
  } catch (err: unknown) {
    const message = String((err as { message?: string })?.message ?? '').toLowerCase();
    const shouldResetSession = (
      !hadSession
      || !hasUsablePlayer
      || message.includes('already been destroyed')
      || message.includes('wait_pc_connection timed out')
      || message.includes('timeout waiting for voice_server_update')
    );
    if (shouldResetSession) {
      await ctx.sessions.destroy(ctx.guildId, 'connect_failed', { sessionId: session.sessionId }).catch(() => null);
    }
    if (await isBotCurrentlyDeafened(ctx)) {
      throw new ValidationError('Cannot connect to VC because I am Deafened - please undeafen me.');
    }
    throw err;
  }

  return session;
}

export async function applyVoiceProfileIfConfigured(ctx: CommandContextLike, session: SessionLike, explicitChannelId: string | null = null) {
  if (!ctx.library?.getVoiceProfile) return;
  const channelId = explicitChannelId ?? session?.connection?.channelId ?? null;
  if (!channelId || !ctx.guildId) return;

  const profile = await ctx.library.getVoiceProfile(ctx.guildId, channelId).catch(() => null);
  const moodPreset = String(profile?.moodPreset ?? '').trim().toLowerCase();
  if (moodPreset) {
    applyMoodPreset(session.player, moodPreset);
  }
}

export async function resolveQueueGuard(ctx: CommandContextLike) {
  if (!ctx.library?.getGuildFeatureConfig || !ctx.guildId) return null;
  const cfg = await ctx.library.getGuildFeatureConfig(ctx.guildId).catch(() => null);
  return cfg?.queueGuard ?? null;
}

export function requireLibrary(ctx: CommandContextLike): LibraryLike {
  if (!ctx.library) {
    throw new ValidationError('Music library storage is unavailable.');
  }
  return ctx.library;
}

export function ensureSessionTrack(_ctx: CommandContextLike, session: SessionLike): void {
  const current = session?.player?.displayTrack ?? session?.player?.currentTrack ?? null;
  if (!current) {
    throw new ValidationError('Nothing is currently playing.');
  }
}

export function computeVoteSkipRequirement(ctx: CommandContextLike, session: SessionLike): number {
  const channelId = session.connection.channelId;
  if (!channelId) return 1;

  const listeners = ctx.voiceStateStore.countUsersInChannel(
    ctx.guildId,
    channelId,
    ctx.botUserId ? [ctx.botUserId] : []
  );

  if (listeners <= 1) return 1;
  const ratio = Number.isFinite(session.settings.voteSkipRatio) ? session.settings.voteSkipRatio : (ctx.config.voteSkipRatio ?? 0.5);
  const minVotes = Number.isFinite(session.settings.voteSkipMinVotes) ? session.settings.voteSkipMinVotes : (ctx.config.voteSkipMinVotes ?? 2);
  return Math.max(minVotes, Math.ceil(listeners * ratio));
}

export function isUserInPlaybackChannel(ctx: CommandContextLike, session: SessionLike): boolean {
  const userChannelId = ctx.voiceStateStore.resolveMemberVoiceChannel(ctx.message);
  return Boolean(userChannelId && session.connection.channelId && userChannelId === session.connection.channelId);
}




