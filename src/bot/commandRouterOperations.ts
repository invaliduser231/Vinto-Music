import { SEARCH_PICK_EMOJIS, applyReplyOptionsToPayload, summarizeTrack } from './commandRouterUtils.ts';
import type { MessagePayload, ReplyOptions, ResponderEmbedOptions } from '../types/core.ts';

type ReplyField = { name: string; value: string; inline?: boolean };
type GuildLike = { id?: string | null };
type SentMessageLike = { id?: string | null; message?: { id?: string | null } | null };
type GuildFeatureConfigLike = {
  recapChannelId?: string | null;
  queueGuard?: unknown;
};
type GuildRecapLike = {
  playCount: number;
  topTracks: Array<{ title?: string | null; plays?: number | null }>;
  topRequesters: Array<{ userId?: string | null; plays?: number | null }>;
};
type SessionLike = {
  guildId?: string | null;
  sessionId?: string | null;
  textChannelId?: string | null;
  settings?: {
    musicLogChannelId?: string | null;
    dedupeEnabled?: boolean;
  };
  connection?: {
    channelId?: string | null;
  };
  player?: {
    createTrackFromData?: (track: unknown, requestedBy?: string | null) => unknown;
    enqueueResolvedTracks?: (tracks: unknown[], options?: Record<string, unknown>) => unknown[];
    play?: () => Promise<unknown>;
    playing?: boolean;
  };
};
type SearchSelectionState = {
  guildId: string;
  channelId: string;
  messageId: string;
  userId: string;
  tracks: unknown[];
  expiresAt?: number;
};

type RouterLike = {
  config: {
    searchPickTimeoutMs?: number;
  };
  rest: {
    addReactionToMessage?: (channelId: string, messageId: string, emoji: string) => Promise<unknown>;
    listCurrentUserGuilds?: (options?: { limit?: number; after?: string | null }) => Promise<unknown>;
    sendMessage: (channelId: string, payload: MessagePayload) => Promise<unknown>;
  };
  library?: {
    buildGuildRecap?: (guildId: string, days?: number) => Promise<GuildRecapLike | null>;
    getGuildFeatureConfig?: (guildId: string) => Promise<GuildFeatureConfigLike | null>;
    getRecapState?: (guildId: string) => Promise<{ lastWeeklyRecapAt?: string | Date | null } | null>;
    markRecapSent?: (guildId: string, sentAt?: Date) => Promise<unknown>;
  } | null;
  helpPaginations: Map<string, {
    channelId: string;
    messageId: string;
    pages: MessagePayload[];
    index: number;
    updatedAt: number;
  }>;
  searchReactionSelections: Map<string, SearchSelectionState>;
  voiceStateStore: {
    resolveMemberVoiceChannel?: (message: Record<string, unknown>) => string | null;
  };
  sessions: {
    get: (guildId: string, selector?: Record<string, unknown>) => SessionLike | null;
    destroy: (guildId: string, reason?: string, selector?: Record<string, unknown>) => Promise<unknown>;
    sessions: Map<string, SessionLike>;
  };
  responder: {
    info: (channelId: string, text: string, fields?: ReplyField[] | null, replyOptions?: ReplyOptions | null, embedOptions?: ResponderEmbedOptions | null) => Promise<unknown>;
    success: (channelId: string, text: string, fields?: ReplyField[] | null, replyOptions?: ReplyOptions | null, embedOptions?: ResponderEmbedOptions | null) => Promise<unknown>;
    warning: (channelId: string, text: string, fields?: ReplyField[] | null, replyOptions?: ReplyOptions | null, embedOptions?: ResponderEmbedOptions | null) => Promise<unknown>;
    error: (channelId: string, text: string, fields?: ReplyField[] | null, replyOptions?: ReplyOptions | null, embedOptions?: ResponderEmbedOptions | null) => Promise<unknown>;
    plain: (channelId: string, text: string, replyOptions?: ReplyOptions | null) => Promise<unknown>;
  };
  logger?: {
    warn?: (message: string, context?: Record<string, unknown>) => void;
  } | undefined;
  _withGuildOpLock: (guildId: string, key: string, fn: () => Promise<unknown>) => Promise<unknown>;
};

export async function registerHelpPagination(router: RouterLike, channelId: string, messageId: string, pages: MessagePayload[]) {
  if (!channelId || !messageId || !Array.isArray(pages) || pages.length <= 1) return;
  router.helpPaginations.set(String(messageId), {
    channelId: String(channelId),
    messageId: String(messageId),
    pages,
    index: 0,
    updatedAt: Date.now(),
  });

  if (!router.rest?.addReactionToMessage) return;
  await router.rest.addReactionToMessage(channelId, messageId, '\u2B05\uFE0F').catch(() => null);
  await router.rest.addReactionToMessage(channelId, messageId, '\u27A1\uFE0F').catch(() => null);
}

export async function runWeeklyRecapSweep(router: RouterLike) {
  if (!router.rest?.listCurrentUserGuilds || !router.library?.buildGuildRecap) return;

  const guilds: GuildLike[] = [];
  let after: string | null = null;
  for (let page = 0; page < 100; page += 1) {
    const chunk: GuildLike[] = await router.rest.listCurrentUserGuilds({ limit: 200, after })
      .then((value) => Array.isArray(value) ? value as GuildLike[] : [])
      .catch(() => []);
    if (!Array.isArray(chunk) || chunk.length === 0) break;
    guilds.push(...chunk);
    if (chunk.length < 200) break;

    const lastId: string | null = chunk[chunk.length - 1]?.id ?? null;
    if (!lastId) break;
    after = String(lastId);
  }

  for (const guild of guilds) {
    const guildId = String(guild?.id ?? '').trim();
    if (!guildId) continue;

    if (!router.library.getGuildFeatureConfig || !router.library.getRecapState || !router.library.buildGuildRecap || !router.library.markRecapSent) continue;

    const features = await router.library.getGuildFeatureConfig(guildId).catch(() => null);
    if (!features?.recapChannelId) continue;

    const state = await router.library.getRecapState(guildId).catch(() => null);
    const lastAtRaw = state?.lastWeeklyRecapAt;
    const lastAt = lastAtRaw ? Date.parse(String(lastAtRaw)) : NaN;
    if (Number.isFinite(lastAt) && (Date.now() - lastAt) < (6.5 * 24 * 60 * 60 * 1000)) continue;

    const recap = await router.library.buildGuildRecap(guildId, 7).catch(() => null);
    if (!recap || recap.playCount <= 0) continue;

    const trackLines = recap.topTracks.slice(0, 5).map((entry, i) => `${i + 1}. ${entry.title} (${entry.plays} plays)`);
    const userLines = recap.topRequesters.slice(0, 5).map((entry, i) => `${i + 1}. <@${entry.userId}> (${entry.plays})`);
    await safeReply(
      router,
      features.recapChannelId,
      'info',
      'Weekly music recap',
      [
        { name: 'Total Plays (7d)', value: String(recap.playCount), inline: true },
        { name: 'Top Tracks', value: trackLines.join('\n') || 'No data' },
        { name: 'Top Requesters', value: userLines.join('\n') || 'No data' },
      ]
    );

    await router.library.markRecapSent(guildId, new Date()).catch(() => null);
  }
}

export async function sendPaginated(
  router: RouterLike,
  channelId: string,
  pages: MessagePayload[],
  replyOptions: ReplyOptions | null = null
) {
  if (!Array.isArray(pages) || pages.length === 0) return null;

  const firstPayload = applyReplyOptionsToPayload(pages[0], replyOptions);
  const sent = await router.rest.sendMessage(channelId, firstPayload).catch(() => null);
  const sentMessage = sent as SentMessageLike | null;
  const messageId = sentMessage?.id ?? sentMessage?.message?.id ?? null;
  if (messageId && pages.length > 1) {
    await registerHelpPagination(router, channelId, messageId, pages);
  }
  return sentMessage;
}

export async function registerSearchReactionSelection(router: RouterLike, {
  guildId,
  channelId,
  messageId,
  userId,
  tracks,
  timeoutMs = null,
}: {
  guildId: string;
  channelId: string;
  messageId: string;
  userId: string;
  tracks: unknown[];
  timeoutMs?: number | null;
}) {
  const safeMessageId = String(messageId ?? '').trim();
  const safeGuildId = String(guildId ?? '').trim();
  const safeChannelId = String(channelId ?? '').trim();
  const safeUserId = String(userId ?? '').trim();
  if (!safeMessageId || !safeGuildId || !safeChannelId || !safeUserId) return;

  const items = Array.isArray(tracks) ? tracks.slice(0, 10) : [];
  if (!items.length) return;

  const ttlMs = Math.max(5_000, Number.parseInt(String(timeoutMs ?? router.config.searchPickTimeoutMs ?? 45_000), 10) || 45_000);
  router.searchReactionSelections.set(safeMessageId, {
    guildId: safeGuildId,
    channelId: safeChannelId,
    messageId: safeMessageId,
    userId: safeUserId,
    tracks: items,
    expiresAt: Date.now() + ttlMs,
  });

  if (!router.rest?.addReactionToMessage) return;
  const max = Math.min(items.length, SEARCH_PICK_EMOJIS.length);
  for (let i = 0; i < max; i += 1) {
    const emoji = SEARCH_PICK_EMOJIS[i];
    if (!emoji) continue;
    await router.rest.addReactionToMessage(safeChannelId, safeMessageId, emoji).catch(() => null);
  }
}

export async function applySearchReactionSelection(router: RouterLike, state: SearchSelectionState, pickedIndex: number, userId: string) {
  const userVoiceChannel = router.voiceStateStore.resolveMemberVoiceChannel?.({
    guild_id: state.guildId,
    author: { id: String(userId) },
  }) ?? null;
  const session = router.sessions.get(state.guildId, {
    voiceChannelId: userVoiceChannel,
    textChannelId: state.channelId,
    allowAnyGuildSession: true,
  });
  if (!session) {
    await safeReply(router, state.channelId, 'warning', 'No active player session. Run the search again.');
    return;
  }
  if (session.connection?.channelId && userVoiceChannel !== session.connection.channelId) {
    await safeReply(router, state.channelId, 'warning', 'You must be in the same voice channel as the bot.');
    return;
  }
  if (!session.player?.createTrackFromData || !session.player.enqueueResolvedTracks) {
    await safeReply(router, state.channelId, 'warning', 'Player session is not ready. Run the search again.');
    return;
  }
  const player = session.player;
  const createTrackFromData = player.createTrackFromData!;
  const enqueueResolvedTracks = player.enqueueResolvedTracks!;

  const selected = state.tracks[pickedIndex - 1];
  if (!selected) return;

  await router._withGuildOpLock(state.guildId, 'search-reaction-pick', async () => {
    const queueGuard = router.library?.getGuildFeatureConfig
      ? (await router.library.getGuildFeatureConfig(state.guildId).catch(() => null))?.queueGuard ?? null
      : null;

    const track = createTrackFromData(selected, String(userId));
    const added = enqueueResolvedTracks([track], {
      dedupe: session.settings?.dedupeEnabled,
      queueGuard,
    });
    if (!added.length) {
      await safeReply(router, state.channelId, 'warning', 'Track already exists in queue (dedupe enabled).');
      return;
    }

    if (!player.playing && player.play) {
      await player.play();
    }
    await safeReply(router, state.channelId, 'success', `Added to queue: ${summarizeTrack(added[0] as { title?: string; duration?: string; requestedBy?: string | null })}`);
  });
}

export async function safeReply(
  router: RouterLike,
  channelId: string,
  type: string,
  text: string,
  fields: ReplyField[] | null = null,
  replyOptions: ReplyOptions | null = null,
  embedOptions: ResponderEmbedOptions | null = null
) {
  try {
    if (type === 'info') return await router.responder.info(channelId, text, fields, replyOptions, embedOptions);
    if (type === 'success') return await router.responder.success(channelId, text, fields, replyOptions, embedOptions);
    if (type === 'warning') return await router.responder.warning(channelId, text, fields, replyOptions, embedOptions);
    if (type === 'error') return await router.responder.error(channelId, text, fields, replyOptions, embedOptions);
    return await router.responder.plain(channelId, text, replyOptions);
  } catch (err: unknown) {
    const errorLike = err as { status?: number; code?: string; message?: string };
    const isUnknownGuild = (
      errorLike?.status === 404
      && (
        String(errorLike?.code ?? '').toUpperCase() === 'UNKNOWN_GUILD'
        || String(errorLike?.message ?? '').toUpperCase().includes('UNKNOWN_GUILD')
      )
    );
    if (isUnknownGuild) {
      handleUnknownGuildForChannel(router, channelId);
    }

    router.logger?.warn?.('Failed to send command response', {
      channelId,
      type,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

export function handleUnknownGuildForChannel(router: RouterLike, channelId: string) {
  const target = String(channelId ?? '').trim();
  if (!target) return;

  for (const [, session] of router.sessions.sessions.entries()) {
    const textMatch = String(session?.textChannelId ?? '') === target;
    const logMatch = String(session?.settings?.musicLogChannelId ?? '') === target;
    if (!textMatch && !logMatch) continue;

    session.textChannelId = null;
    if (session.settings) {
      session.settings.musicLogChannelId = null;
    }

    const guildId = String(session?.guildId ?? '').trim();
    if (!guildId) continue;
    router.sessions.destroy(guildId, 'unknown_guild', { sessionId: session?.sessionId }).catch(() => null);
  }
}


