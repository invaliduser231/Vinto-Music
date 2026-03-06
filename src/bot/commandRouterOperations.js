import { SEARCH_PICK_EMOJIS, applyReplyOptionsToPayload, summarizeTrack } from './commandRouterUtils.js';

export async function registerHelpPagination(router, channelId, messageId, pages) {
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

export async function runWeeklyRecapSweep(router) {
  if (!router.rest?.listCurrentUserGuilds || !router.library?.buildGuildRecap) return;

  const guilds = [];
  let before = null;
  for (let page = 0; page < 100; page += 1) {
    const chunk = await router.rest.listCurrentUserGuilds({ limit: 200, before }).catch(() => []);
    if (!Array.isArray(chunk) || chunk.length === 0) break;
    guilds.push(...chunk);
    if (chunk.length < 200) break;

    const lastId = chunk[chunk.length - 1]?.id;
    if (!lastId) break;
    before = String(lastId);
  }

  for (const guild of guilds) {
    const guildId = String(guild?.id ?? '').trim();
    if (!guildId) continue;

    const features = await router.library.getGuildFeatureConfig(guildId).catch(() => null);
    if (!features?.recapChannelId) continue;

    const state = await router.library.getRecapState(guildId).catch(() => null);
    const lastAt = state?.lastWeeklyRecapAt ? Date.parse(state.lastWeeklyRecapAt) : NaN;
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

export async function sendPaginated(router, channelId, pages, replyOptions = null) {
  if (!Array.isArray(pages) || pages.length === 0) return null;

  const firstPayload = applyReplyOptionsToPayload(pages[0], replyOptions);
  const sent = await router.rest.sendMessage(channelId, firstPayload).catch(() => null);
  const messageId = sent?.id ?? sent?.message?.id ?? null;
  if (messageId && pages.length > 1) {
    await registerHelpPagination(router, channelId, messageId, pages);
  }
  return sent;
}

export async function registerSearchReactionSelection(router, {
  guildId,
  channelId,
  messageId,
  userId,
  tracks,
  timeoutMs = null,
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
    await router.rest.addReactionToMessage(safeChannelId, safeMessageId, SEARCH_PICK_EMOJIS[i]).catch(() => null);
  }
}

export async function applySearchReactionSelection(router, state, pickedIndex, userId) {
  const session = router.sessions.get(state.guildId);
  if (!session) {
    await safeReply(router, state.channelId, 'warning', 'No active player session. Run the search again.');
    return;
  }

  const userVoiceChannel = router.voiceStateStore.resolveMemberVoiceChannel({
    guild_id: state.guildId,
    author: { id: String(userId) },
  });
  if (session.connection?.channelId && userVoiceChannel !== session.connection.channelId) {
    await safeReply(router, state.channelId, 'warning', 'You must be in the same voice channel as the bot.');
    return;
  }

  const selected = state.tracks[pickedIndex - 1];
  if (!selected) return;

  await router._withGuildOpLock(state.guildId, 'search-reaction-pick', async () => {
    const queueGuard = router.library?.getGuildFeatureConfig
      ? (await router.library.getGuildFeatureConfig(state.guildId).catch(() => null))?.queueGuard ?? null
      : null;

    const track = session.player.createTrackFromData(selected, String(userId));
    const added = session.player.enqueueResolvedTracks([track], {
      dedupe: session.settings.dedupeEnabled,
      queueGuard,
    });
    if (!added.length) {
      await safeReply(router, state.channelId, 'warning', 'Track already exists in queue (dedupe enabled).');
      return;
    }

    if (!session.player.playing) {
      await session.player.play();
    }
    await safeReply(router, state.channelId, 'success', `Added to queue: ${summarizeTrack(added[0])}`);
  });
}

export async function safeReply(router, channelId, type, text, fields = null, replyOptions = null, embedOptions = null) {
  try {
    if (type === 'info') return await router.responder.info(channelId, text, fields, replyOptions, embedOptions);
    if (type === 'success') return await router.responder.success(channelId, text, fields, replyOptions, embedOptions);
    if (type === 'warning') return await router.responder.warning(channelId, text, fields, replyOptions, embedOptions);
    if (type === 'error') return await router.responder.error(channelId, text, fields, replyOptions, embedOptions);
    return await router.responder.plain(channelId, text, replyOptions);
  } catch (err) {
    const isUnknownGuild = (
      err?.status === 404
      && (
        String(err?.code ?? '').toUpperCase() === 'UNKNOWN_GUILD'
        || String(err?.message ?? '').toUpperCase().includes('UNKNOWN_GUILD')
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

export function handleUnknownGuildForChannel(router, channelId) {
  const target = String(channelId ?? '').trim();
  if (!target) return;

  for (const [guildId, session] of router.sessions.sessions.entries()) {
    const textMatch = String(session?.textChannelId ?? '') === target;
    const logMatch = String(session?.settings?.musicLogChannelId ?? '') === target;
    if (!textMatch && !logMatch) continue;

    session.textChannelId = null;
    if (session.settings) {
      session.settings.musicLogChannelId = null;
    }

    router.sessions.destroy(guildId, 'unknown_guild').catch(() => null);
  }
}
