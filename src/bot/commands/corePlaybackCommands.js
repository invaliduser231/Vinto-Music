import { ValidationError } from '../../core/errors.js';
import {
  HISTORY_PAGE_SIZE,
  SEARCH_RESULT_DEFAULT_LIMIT,
  SUPPORT_SERVER_URL,
  createCommand,
  buildHelpPages,
  parseVoiceChannelArgument,
  ensureGuild,
  ensureConnectedSession,
  ensureDjAccess,
  enforcePlayCooldown,
  applyVoiceProfileIfConfigured,
  resolveQueueGuard,
  trackLabel,
  saveSearchSelection,
  normalizeIndex,
  consumeSearchSelection,
  clearSearchSelection,
  getSessionOrThrow,
  ensureSessionTrack,
  isUserInPlaybackChannel,
  computeVoteSkipRequirement,
  parseDurationToSeconds,
  buildProgressBar,
  formatSeconds,
  parseRequiredInteger,
  formatQueuePage,
  formatHistoryPage,
  requireLibrary,
} from './commandHelpers.js';
import { buildEmbed } from '../messageFormatter.js';

function resolveGatewayLatencyMs(gateway) {
  if (!gateway) return null;

  if (typeof gateway.getHeartbeatLatencyMs === 'function') {
    const fromMethod = gateway.getHeartbeatLatencyMs();
    if (Number.isFinite(fromMethod) && fromMethod >= 0) {
      return Math.round(fromMethod);
    }
  }

  const fromProperty = gateway.heartbeatLatencyMs;
  if (Number.isFinite(fromProperty) && fromProperty >= 0) {
    return Math.round(fromProperty);
  }

  return null;
}

function buildCommandMessageReference(ctx) {
  const messageId = String(ctx?.message?.id ?? ctx?.message?.message_id ?? '').trim();
  if (!messageId) return null;

  const reference = { message_id: messageId };
  const channelId = String(ctx?.channelId ?? '').trim();
  const guildId = String(ctx?.guildId ?? '').trim();
  if (channelId) reference.channel_id = channelId;
  if (guildId) reference.guild_id = guildId;
  return reference;
}

function withCommandReplyReference(ctx, payload) {
  const reference = buildCommandMessageReference(ctx);
  if (!reference) return payload;

  return {
    ...(payload ?? {}),
    message_reference: reference,
    allowed_mentions: {
      parse: [],
      users: [],
      roles: [],
      ...(payload?.allowed_mentions ?? {}),
      replied_user: false,
    },
  };
}

function buildPingPayload(ctx, fields) {
  if (ctx.config?.enableEmbeds === false) {
    const lines = fields.map((field) => `${field.name}: ${field.value}`);
    return { content: ['Pong!', ...lines].join('\n') };
  }

  return {
    embeds: [
      buildEmbed({
        title: 'Pong!',
        fields,
      }),
    ],
    allowed_mentions: {
      parse: [],
      users: [],
      roles: [],
      replied_user: false,
    },
  };
}

export function registerCorePlaybackCommands(registry) {
  registry.register(createCommand({
    name: 'help',
    aliases: ['h'],
    description: 'Show all available commands.',
    usage: 'help',
    async execute(ctx) {
      const pages = buildHelpPages(ctx);
      const first = await ctx.rest.sendMessage(ctx.channelId, withCommandReplyReference(ctx, pages[0]));
      const messageId = first?.id ?? first?.message?.id ?? null;
      if (messageId && ctx.registerHelpPagination) {
        await ctx.registerHelpPagination(ctx.channelId, messageId, pages);
      }
    },
  }));
registry.register(createCommand({
    name: 'support',
    aliases: ['discord', 'server'],
    description: 'Get the support server invite link.',
    usage: 'support',
    async execute(ctx) {
      await ctx.reply.info('Support server', [
        { name: 'Invite', value: SUPPORT_SERVER_URL },
      ]);
    },
  }));

  registry.register(createCommand({
    name: 'ping',
    description: 'Show current latency.',
    usage: 'ping',
    async execute(ctx) {
      const canMeasure =
        Boolean(ctx.channelId)
        && typeof ctx.rest?.sendMessage === 'function'
        && typeof ctx.rest?.editMessage === 'function';

      if (!canMeasure) {
        const gatewayLatencyMs = resolveGatewayLatencyMs(ctx.gateway);
        await ctx.reply.success('Pong!', [
          { name: 'Round-trip', value: 'n/a', inline: true },
          { name: 'Gateway', value: gatewayLatencyMs == null ? 'n/a' : `${gatewayLatencyMs}ms`, inline: true },
        ]);
        return;
      }

      const gatewayLatencyPromise = (async () => {
        const cached = resolveGatewayLatencyMs(ctx.gateway);
        if (cached != null) return cached;
        if (typeof ctx.gateway?.sampleHeartbeatLatency === 'function') {
          return await ctx.gateway.sampleHeartbeatLatency(2_500);
        }
        return null;
      })();

      const roundTripStartedAt = Date.now();
      const probeMessage = await ctx.rest.sendMessage(
        ctx.channelId,
        withCommandReplyReference(ctx, { content: 'Pinging...' })
      );
      const roundTripMs = Math.max(0, Date.now() - roundTripStartedAt);
      const gatewayLatencyMs = await gatewayLatencyPromise;

      const fields = [
        { name: 'Round-trip', value: `${roundTripMs}ms`, inline: true },
        { name: 'Gateway', value: gatewayLatencyMs == null ? 'n/a' : `${Math.round(gatewayLatencyMs)}ms`, inline: true },
      ];
      const payload = buildPingPayload(ctx, fields);
      const messageId = probeMessage?.id ?? probeMessage?.message?.id ?? null;

      if (messageId) {
        try {
          await ctx.rest.editMessage(ctx.channelId, messageId, payload);
          return;
        } catch {
          // Fall back to regular reply if edit fails.
        }
      }

      await ctx.reply.success('Pong!', fields);
    },
  }));

  registry.register(createCommand({
    name: 'join',
    aliases: ['summon'],
    description: 'Join your voice channel (or a specified channel).',
    usage: 'join [#voice-channel]',
    async execute(ctx) {
      ensureGuild(ctx);

      const { channelId: explicitChannelId } = parseVoiceChannelArgument(ctx.args);
      const session = await ensureConnectedSession(ctx, explicitChannelId);

      await ctx.reply.success('Connected to voice.', [
        { name: 'Guild', value: session.guildId, inline: true },
      ]);
    },
  }));

  registry.register(createCommand({
    name: 'leave',
    aliases: ['disconnect', 'dc', 'stop'],
    description: 'Stop playback, clear queue, and leave voice.',
    usage: 'leave',
    async execute(ctx) {
      ensureGuild(ctx);
      const existing = ctx.sessions.get(ctx.guildId);
      if (existing) {
        ensureDjAccess(ctx, existing, 'disconnect the bot');
      }
      const removed = await ctx.sessions.destroy(ctx.guildId, 'manual_command');
      if (!removed) {
        await ctx.reply.warning('No active player in this guild.');
        return;
      }

      await ctx.reply.success('Disconnected from voice and cleared session.');
    },
  }));

  registry.register(createCommand({
    name: 'play',
    aliases: ['p'],
    description: 'Queue a song or URL.',
    usage: 'play <query | url>',
    async execute(ctx) {
      ensureGuild(ctx);

      const { channelId: explicitChannelId, rest } = parseVoiceChannelArgument(ctx.args);
      const query = rest.join(' ').trim();
      if (!query) {
        throw new ValidationError(`Usage: ${ctx.prefix}play <query>`);
      }
      enforcePlayCooldown(ctx);

      await ctx.withGuildOpLock('play', async () => {
        await ctx.safeTyping();
        const session = await ensureConnectedSession(ctx, explicitChannelId);
        await applyVoiceProfileIfConfigured(ctx, session, explicitChannelId);

        const queueGuard = await resolveQueueGuard(ctx);
        const preview = await session.player.previewTracks(query, {
          requestedBy: ctx.authorId,
          limit: ctx.config.maxPlaylistTracks,
        });
        const tracks = preview.map((track) => session.player.createTrackFromData(track, ctx.authorId));
        const added = session.player.enqueueResolvedTracks(tracks, {
          dedupe: session.settings.dedupeEnabled,
          queueGuard,
        });

        if (!added.length) {
          await ctx.reply.warning('No tracks found for that query.');
          return;
        }

        if (!session.player.playing) {
          await session.player.play();
        }

        if (added.length === 1) {
          await ctx.reply.success(`Added to queue: ${trackLabel(added[0])}`);
        } else {
          await ctx.reply.success(`Added **${added.length}** tracks from playlist.`, [
            { name: 'First Track', value: trackLabel(added[0]) },
          ]);
        }
      });
    },
  }));

  registry.register(createCommand({
    name: 'playnext',
    aliases: ['pn', 'next'],
    description: 'Queue a song to play right after the current one.',
    usage: 'playnext <query | url>',
    async execute(ctx) {
      ensureGuild(ctx);

      const query = ctx.args.join(' ').trim();
      if (!query) {
        throw new ValidationError(`Usage: ${ctx.prefix}playnext <query>`);
      }
      enforcePlayCooldown(ctx);

      await ctx.withGuildOpLock('playnext', async () => {
        await ctx.safeTyping();
        const session = await ensureConnectedSession(ctx);
        await applyVoiceProfileIfConfigured(ctx, session);
        const queueGuard = await resolveQueueGuard(ctx);
        const preview = await session.player.previewTracks(query, {
          requestedBy: ctx.authorId,
          limit: ctx.config.maxPlaylistTracks,
        });
        const tracks = preview.map((track) => session.player.createTrackFromData(track, ctx.authorId));
        const added = session.player.enqueueResolvedTracks(tracks, {
          requestedBy: ctx.authorId,
          playNext: true,
          dedupe: session.settings.dedupeEnabled,
          queueGuard,
        });

        if (!added.length) {
          await ctx.reply.warning('No tracks found for that query.');
          return;
        }

        if (!session.player.playing) {
          await session.player.play();
        }

        if (added.length === 1) {
          await ctx.reply.success(`Queued next: ${trackLabel(added[0])}`);
        } else {
          await ctx.reply.success(`Queued **${added.length}** playlist tracks at the front.`);
        }
      });
    },
  }));

  registry.register(createCommand({
    name: 'search',
    aliases: ['find'],
    description: 'Search YouTube and pick one of the top results.',
    usage: 'search <query>',
    async execute(ctx) {
      ensureGuild(ctx);
      const query = ctx.args.join(' ').trim();
      if (!query) {
        throw new ValidationError(`Usage: ${ctx.prefix}search <query>`);
      }

      enforcePlayCooldown(ctx);
      await ctx.withGuildOpLock('search', async () => {
        await ctx.safeTyping();

        const session = await ensureConnectedSession(ctx);
        const limit = Math.max(
          1,
          Math.min(10, Number.parseInt(String(ctx.config.searchResultLimit ?? SEARCH_RESULT_DEFAULT_LIMIT), 10) || SEARCH_RESULT_DEFAULT_LIMIT)
        );

        const results = await session.player.searchCandidates(query, limit, {
          requestedBy: ctx.authorId,
        });
        if (!results.length) {
          await ctx.reply.warning('No search results found.');
          return;
        }

        const ttlMs = saveSearchSelection(ctx, results);
        const lines = results.map((track, idx) => `${idx + 1}. ${trackLabel(track)}`);
        await ctx.reply.info(`Search results for **${query}**`, [
          { name: 'Pick one', value: lines.join('\n').slice(0, 1000) },
          { name: 'Next step', value: `Use \`${ctx.prefix}pick <1-${results.length}>\` within ${Math.ceil(ttlMs / 1000)}s.` },
        ]);
      });
    },
  }));

  registry.register(createCommand({
    name: 'pick',
    aliases: ['choose'],
    description: 'Pick a result from your latest search.',
    usage: 'pick <index>',
    async execute(ctx) {
      ensureGuild(ctx);
      const index = normalizeIndex(ctx.args[0], 'Index');

      const selection = consumeSearchSelection(ctx);
      if (!selection) {
        throw new ValidationError(`No active search selection. Use \`${ctx.prefix}search <query>\` first.`);
      }

      const selected = selection[index - 1];
      if (!selected) {
        throw new ValidationError(`Index out of range. Choose 1-${selection.length}.`);
      }

      await ctx.withGuildOpLock('pick', async () => {
        const session = await ensureConnectedSession(ctx);
        await applyVoiceProfileIfConfigured(ctx, session);
        const queueGuard = await resolveQueueGuard(ctx);
        const track = session.player.createTrackFromData(selected, ctx.authorId);
        const added = session.player.enqueueResolvedTracks([track], {
          dedupe: session.settings.dedupeEnabled,
          queueGuard,
        });

        if (!added.length) {
          await ctx.reply.warning('Track already exists in queue (dedupe enabled).');
          return;
        }

        if (!session.player.playing) {
          await session.player.play();
        }

        clearSearchSelection(ctx);
        await ctx.reply.success(`Added to queue: ${trackLabel(added[0])}`);
      });
    },
  }));

  registry.register(createCommand({
    name: 'skip',
    aliases: ['s'],
    description: 'Skip current track (DJ or vote-skip).',
    usage: 'skip',
    async execute(ctx) {
      ensureGuild(ctx);
      const session = getSessionOrThrow(ctx);
      ensureSessionTrack(ctx, session);
      if (!isUserInPlaybackChannel(ctx, session)) {
        throw new ValidationError('You must be in the same voice channel as the bot to vote-skip.');
      }

      if (userHasDjAccess(ctx, session)) {
        session.player.skip();
        await ctx.reply.success('Skipped current track.');
        return;
      }

      const voteState = ctx.sessions.registerVoteSkip(ctx.guildId, ctx.authorId);
      if (!voteState) {
        await ctx.reply.warning('Could not register vote-skip right now.');
        return;
      }

      if (!voteState.added) {
        await ctx.reply.info('You already voted to skip this track.');
        return;
      }

      const requiredVotes = computeVoteSkipRequirement(ctx, session);
      if (voteState.votes >= requiredVotes) {
        session.player.skip();
        ctx.sessions.clearVoteSkips(ctx.guildId);
        await ctx.reply.success(`Vote-skip passed (${voteState.votes}/${requiredVotes}). Skipping track.`);
        return;
      }

      await ctx.reply.info(`Vote registered: **${voteState.votes}/${requiredVotes}** needed to skip.`);
    },
  }));

  registry.register(createCommand({
    name: 'pause',
    description: 'Pause playback.',
    usage: 'pause',
    async execute(ctx) {
      ensureGuild(ctx);
      const session = getSessionOrThrow(ctx);
      ensureDjAccess(ctx, session, 'pause playback');

      if (!session.player.pause()) {
        await ctx.reply.warning('Cannot pause right now.');
        return;
      }

      await ctx.reply.success('Playback paused.');
    },
  }));

  registry.register(createCommand({
    name: 'resume',
    aliases: ['unpause'],
    description: 'Resume playback.',
    usage: 'resume',
    async execute(ctx) {
      ensureGuild(ctx);
      const session = getSessionOrThrow(ctx);
      ensureDjAccess(ctx, session, 'resume playback');

      if (!session.player.resume()) {
        await ctx.reply.warning('Cannot resume right now.');
        return;
      }

      await ctx.reply.success('Playback resumed.');
    },
  }));

  registry.register(createCommand({
    name: 'now',
    aliases: ['np', 'nowplaying'],
    description: 'Show the currently playing track.',
    usage: 'now',
    async execute(ctx) {
      ensureGuild(ctx);
      const session = getSessionOrThrow(ctx);
      const current = session.player.currentTrack;

      if (!current) {
        await ctx.reply.warning('Nothing is currently playing.');
        return;
      }

      const totalSec = parseDurationToSeconds(current.duration);
      const progressSec = session.player.getProgressSeconds();

      await ctx.reply.info(`Now playing: ${trackLabel(current)}`, [
        { name: 'Progress', value: buildProgressBar(progressSec, totalSec ?? Number.NaN) },
        { name: 'Source', value: current.source ?? 'unknown', inline: true },
        { name: 'Loop', value: session.player.loopMode, inline: true },
        { name: 'Volume', value: `${session.player.volumePercent}%`, inline: true },
        { name: 'Queued', value: String(session.player.pendingTracks.length), inline: true },
      ]);
    },
  }));

  registry.register(createCommand({
    name: 'seek',
    aliases: ['jump'],
    description: 'Seek in current track (seconds or mm:ss or hh:mm:ss).',
    usage: 'seek <seconds|mm:ss|hh:mm:ss>',
    async execute(ctx) {
      ensureGuild(ctx);
      const session = getSessionOrThrow(ctx);
      ensureDjAccess(ctx, session, 'seek');

      if (!ctx.args.length) {
        throw new ValidationError(`Usage: ${ctx.prefix}seek <seconds|mm:ss|hh:mm:ss>`);
      }

      const raw = String(ctx.args[0]).trim();
      let targetSec;
      if (raw.includes(':')) {
        targetSec = parseDurationToSeconds(raw);
      } else {
        const parsed = Number.parseInt(raw, 10);
        targetSec = Number.isFinite(parsed) ? parsed : null;
      }

      if (targetSec == null || targetSec < 0) {
        throw new ValidationError('Invalid seek position.');
      }

      const finalTarget = session.player.seekTo(targetSec);
      await ctx.reply.success(`Seeking to **${formatSeconds(finalTarget)}**...`);
    },
  }));

  registry.register(createCommand({
    name: 'previous',
    aliases: ['prev', 'back'],
    description: 'Queue the previous track again.',
    usage: 'previous',
    async execute(ctx) {
      ensureGuild(ctx);
      const session = getSessionOrThrow(ctx);
      ensureDjAccess(ctx, session, 'play previous tracks');

      const previous = session.player.queuePreviousTrack();
      if (!previous) {
        await ctx.reply.warning('No previous track found in history.');
        return;
      }

      if (!session.player.playing) {
        await session.player.play();
      }

      await ctx.reply.success(`Queued previous track: ${trackLabel(previous)}`);
    },
  }));

  registry.register(createCommand({
    name: 'replay',
    aliases: ['restart'],
    description: 'Restart current track or replay the last played track.',
    usage: 'replay',
    async execute(ctx) {
      ensureGuild(ctx);
      const session = getSessionOrThrow(ctx);
      ensureDjAccess(ctx, session, 'replay tracks');

      if (session.player.replayCurrentTrack()) {
        await ctx.reply.success('Restarting current track...');
        return;
      }

      const previous = session.player.queuePreviousTrack();
      if (!previous) {
        const library = ctx.library;
        const persisted = library ? await library.getLastGuildHistoryTrack(ctx.guildId).catch(() => null) : null;
        if (persisted) {
          const replayTrack = session.player.createTrackFromData(persisted, ctx.authorId);
          session.player.enqueueResolvedTracks([replayTrack], {
            playNext: true,
            dedupe: false,
          });
          if (!session.player.playing) {
            await session.player.play();
          }
          await ctx.reply.success(`Replaying from persistent history: ${trackLabel(replayTrack)}`);
          return;
        }

        await ctx.reply.warning('No track available to replay.');
        return;
      }

      if (!session.player.playing) {
        await session.player.play();
      }

      await ctx.reply.success(`Replaying: ${trackLabel(previous)}`);
    },
  }));

  registry.register(createCommand({
    name: 'queue',
    aliases: ['q'],
    description: 'Show queue contents.',
    usage: 'queue [page]',
    async execute(ctx) {
      ensureGuild(ctx);
      const session = getSessionOrThrow(ctx);

      const page = ctx.args.length ? parseRequiredInteger(ctx.args[0], 'Page') : 1;
      const queueData = formatQueuePage(session, page);

      await ctx.reply.info(queueData.description, queueData.fields);
    },
  }));

  registry.register(createCommand({
    name: 'history',
    aliases: ['recent'],
    description: 'Show recently played tracks.',
    usage: 'history [page]',
    async execute(ctx) {
      ensureGuild(ctx);
      const page = ctx.args.length ? parseRequiredInteger(ctx.args[0], 'Page') : 1;
      const session = ctx.sessions.get(ctx.guildId);
      if (session?.player?.historyTracks?.length) {
        const historyData = formatHistoryPage(session, page);
        await ctx.reply.info(historyData.description, historyData.fields);
        return;
      }

      const library = requireLibrary(ctx);
      const persisted = await library.listGuildHistory(ctx.guildId, page, HISTORY_PAGE_SIZE);
      if (!persisted.items.length) {
        await ctx.reply.warning('No playback history yet.');
        return;
      }

      await ctx.reply.info(
        `Persistent history page **${persisted.page}/${persisted.totalPages}** â€¢ Total tracks: **${persisted.total}**`,
        [{
          name: 'Recently Played',
          value: persisted.items
            .map((track, idx) => `${(persisted.page - 1) * persisted.pageSize + idx + 1}. ${trackLabel(track)}`)
            .join('\n')
            .slice(0, 1000),
        }]
      );
    },
  }));
}

