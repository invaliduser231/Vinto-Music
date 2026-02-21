import { ValidationError } from '../../core/errors.js';

const VOICE_CHANNEL_PATTERN = /^<#(\d+)>$/;
const ROLE_MENTION_PATTERN = /^<@&(\d+)>$/;
const PENDING_PAGE_SIZE = 10;
const HISTORY_PAGE_SIZE = 10;
const PLAYLIST_PAGE_SIZE = 10;
const FAVORITES_PAGE_SIZE = 10;
const SEARCH_RESULT_DEFAULT_LIMIT = 5;
const playCooldowns = new Map();
const pendingSearchSelections = new Map();

function parseVoiceChannelArgument(args) {
  if (!args?.length) return { channelId: null, rest: args ?? [] };

  const first = args[0];
  const mention = String(first).match(VOICE_CHANNEL_PATTERN);
  if (mention) {
    return { channelId: mention[1], rest: args.slice(1) };
  }

  if (/^\d{10,}$/.test(String(first))) {
    return { channelId: String(first), rest: args.slice(1) };
  }

  return { channelId: null, rest: args };
}

function trackLabel(track) {
  const by = track.requestedBy ? ` • requested by <@${track.requestedBy}>` : '';
  return `**${track.title}** (${track.duration})${by}`;
}

function parseDurationToSeconds(value) {
  if (!value || typeof value !== 'string') return null;
  if (value.toLowerCase() === 'unknown') return null;

  const parts = value.split(':').map((part) => Number.parseInt(part, 10));
  if (!parts.every((part) => Number.isFinite(part) && part >= 0)) return null;

  if (parts.length === 2) {
    return parts[0] * 60 + parts[1];
  }
  if (parts.length === 3) {
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  }

  return null;
}

function formatSeconds(seconds) {
  const safe = Math.max(0, Math.floor(seconds));
  const h = Math.floor(safe / 3600);
  const m = Math.floor((safe % 3600) / 60);
  const s = safe % 60;

  if (h > 0) {
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
  return `${m}:${String(s).padStart(2, '0')}`;
}

function buildProgressBar(positionSec, totalSec, size = 16) {
  if (!Number.isFinite(totalSec) || totalSec <= 0) {
    return `${formatSeconds(positionSec)} • live/unknown`;
  }

  const clamped = Math.max(0, Math.min(positionSec, totalSec));
  const progress = clamped / totalSec;
  const marker = Math.min(size - 1, Math.max(0, Math.floor(progress * (size - 1))));

  const chars = [];
  for (let i = 0; i < size; i += 1) {
    chars.push(i === marker ? '●' : '━');
  }

  return `${formatSeconds(clamped)} ${chars.join('')} ${formatSeconds(totalSec)}`;
}

function sumTrackDurationsSeconds(tracks) {
  let total = 0;
  for (const track of tracks) {
    const parsed = parseDurationToSeconds(track?.duration);
    if (parsed == null) continue;
    total += parsed;
  }
  return total;
}

function ensureGuild(ctx) {
  if (!ctx.guildId) {
    throw new ValidationError('This command can only be used in a guild channel.');
  }
}

function getSessionOrThrow(ctx) {
  const session = ctx.sessions.get(ctx.guildId);
  if (!session) {
    throw new ValidationError('No active player in this guild.');
  }
  return session;
}

async function getGuildConfigOrThrow(ctx) {
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

async function updateGuildConfig(ctx, patch) {
  ensureGuild(ctx);
  if (!ctx.guildConfigs) {
    throw new ValidationError('Guild config store is not available.');
  }

  const updated = await ctx.guildConfigs.update(ctx.guildId, patch);
  ctx.guildConfig = updated;
  ctx.sessions.applyGuildConfig(ctx.guildId, updated);
  return updated;
}

function getDjRoleSet(guildConfig) {
  const roleIds = guildConfig?.settings?.djRoleIds ?? [];
  return new Set(roleIds.map((roleId) => String(roleId)));
}

async function ensureConnectedSession(ctx, explicitChannelId = null) {
  const resolvedVoice = explicitChannelId ?? ctx.voiceStateStore.resolveMemberVoiceChannel(ctx.message);
  if (!resolvedVoice) {
    const prefix = ctx.prefix ?? ctx.config.prefix;
    throw new ValidationError(
      `You are not in a voice channel. Use \`${prefix}play <#voice-channel> <query>\` as fallback.`
    );
  }

  const hadSession = ctx.sessions.has(ctx.guildId);
  const session = await ctx.sessions.ensure(ctx.guildId, ctx.guildConfig);
  ctx.sessions.bindTextChannel(ctx.guildId, ctx.channelId);

  if (session.connection.connected) return session;

  try {
    await session.connection.connect(resolvedVoice);
  } catch (err) {
    if (!hadSession) {
      await ctx.sessions.destroy(ctx.guildId, 'connect_failed').catch(() => null);
    }
    throw err;
  }

  return session;
}

function formatQueuePage(session, page) {
  const pending = session.player.pendingTracks;
  const current = session.player.currentTrack;

  if (!current && pending.length === 0) {
    return {
      description: 'Queue is empty.',
      fields: [],
    };
  }

  const totalPages = Math.max(1, Math.ceil(pending.length / PENDING_PAGE_SIZE));
  const safePage = Math.max(1, Math.min(page, totalPages));

  const start = (safePage - 1) * PENDING_PAGE_SIZE;
  const pageItems = pending.slice(start, start + PENDING_PAGE_SIZE);

  const fields = [];

  if (current) {
    const durationSec = parseDurationToSeconds(current.duration);
    const progressSec = session.player.getProgressSeconds();
    fields.push({
      name: 'Now Playing',
      value: `${trackLabel(current)}\n${buildProgressBar(progressSec, durationSec ?? Number.NaN)}`.slice(0, 1000),
    });
  }

  if (pageItems.length) {
    const lines = pageItems.map((track, i) => {
      const idx = start + i + 1;
      return `${idx}. ${trackLabel(track)}`;
    });

    fields.push({
      name: `Up Next (Page ${safePage}/${totalPages})`,
      value: lines.join('\n').slice(0, 1000),
    });
  }

  const pendingDurationSec = sumTrackDurationsSeconds(pending);
  return {
    description: `Loop: **${session.player.loopMode}** • Volume: **${session.player.volumePercent}%** • Pending duration: **${formatSeconds(pendingDurationSec)}** • Autoplay: **${session.settings.autoplayEnabled ? 'on' : 'off'}** • Dedupe: **${session.settings.dedupeEnabled ? 'on' : 'off'}** • 24/7: **${session.settings.stayInVoiceEnabled ? 'on' : 'off'}**`,
    fields,
  };
}

function formatHistoryPage(session, page) {
  const history = session.player.historyTracks;
  if (!history.length) {
    return {
      description: 'No playback history yet.',
      fields: [],
    };
  }

  const totalPages = Math.max(1, Math.ceil(history.length / HISTORY_PAGE_SIZE));
  const safePage = Math.max(1, Math.min(page, totalPages));

  const start = (safePage - 1) * HISTORY_PAGE_SIZE;
  const pageItems = history
    .slice()
    .reverse()
    .slice(start, start + HISTORY_PAGE_SIZE);

  return {
    description: `History page **${safePage}/${totalPages}** • Total tracks: **${history.length}**`,
    fields: [{
      name: 'Recently Played',
      value: pageItems
        .map((track, idx) => `${start + idx + 1}. ${trackLabel(track)}`)
        .join('\n')
        .slice(0, 1000),
    }],
  };
}

function parseRequiredInteger(value, label) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) {
    throw new ValidationError(`${label} must be an integer.`);
  }
  return parsed;
}

function parseOnOff(value, fallback = null) {
  if (value == null) return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['on', 'true', '1', 'yes', 'enable', 'enabled'].includes(normalized)) return true;
  if (['off', 'false', '0', 'no', 'disable', 'disabled'].includes(normalized)) return false;
  return fallback;
}

function enforcePlayCooldown(ctx) {
  const cooldownMs = Math.max(0, Number.parseInt(String(ctx.config.playCommandCooldownMs ?? 0), 10) || 0);
  if (cooldownMs <= 0) return;

  const userId = ctx.authorId ? String(ctx.authorId) : null;
  if (!userId) return;

  const guildPart = ctx.guildId ? String(ctx.guildId) : 'dm';
  const key = `${guildPart}:${userId}`;
  const now = Date.now();
  const last = playCooldowns.get(key) ?? 0;
  const remainingMs = cooldownMs - (now - last);
  if (remainingMs > 0) {
    const remainingSec = (remainingMs / 1000).toFixed(1);
    throw new ValidationError(`You are using play too quickly. Please wait ${remainingSec}s.`);
  }

  playCooldowns.set(key, now);

  if (playCooldowns.size > 10_000) {
    const staleBefore = now - Math.max(cooldownMs * 3, 60_000);
    for (const [entryKey, entryTs] of playCooldowns.entries()) {
      if (entryTs < staleBefore) {
        playCooldowns.delete(entryKey);
      }
    }
  }
}

function getMemberRoleIds(ctx) {
  const roles = ctx.message?.member?.roles;
  if (!Array.isArray(roles)) return [];
  return roles.map((roleId) => String(roleId));
}

function parseRoleId(value) {
  const raw = String(value ?? '').trim();
  const mention = raw.match(ROLE_MENTION_PATTERN);
  if (mention) return mention[1];
  if (/^\d{6,}$/.test(raw)) return raw;
  return null;
}

function parseTextChannelId(value) {
  const raw = String(value ?? '').trim();
  const mention = raw.match(VOICE_CHANNEL_PATTERN);
  if (mention) return mention[1];
  if (/^\d{6,}$/.test(raw)) return raw;
  return null;
}

function normalizeIndex(value, label) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new ValidationError(`${label} must be a positive integer.`);
  }
  return parsed;
}

function requireLibrary(ctx) {
  if (!ctx.library) {
    throw new ValidationError('Music library storage is unavailable.');
  }
  return ctx.library;
}

function searchSelectionKey(ctx) {
  const guildId = String(ctx.guildId ?? '');
  const userId = String(ctx.authorId ?? '');
  return `${guildId}:${userId}`;
}

function saveSearchSelection(ctx, tracks) {
  const key = searchSelectionKey(ctx);
  const ttl = Math.max(5_000, Number.parseInt(String(ctx.config.searchPickTimeoutMs ?? 45_000), 10) || 45_000);
  const now = Date.now();

  pendingSearchSelections.set(key, {
    tracks,
    expiresAt: now + ttl,
  });

  if (pendingSearchSelections.size > 10_000) {
    for (const [entryKey, entry] of pendingSearchSelections.entries()) {
      if (entry.expiresAt <= now) {
        pendingSearchSelections.delete(entryKey);
      }
    }
  }

  return ttl;
}

function consumeSearchSelection(ctx) {
  const key = searchSelectionKey(ctx);
  const entry = pendingSearchSelections.get(key);
  if (!entry) return null;

  if (entry.expiresAt <= Date.now()) {
    pendingSearchSelections.delete(key);
    return null;
  }

  return entry.tracks;
}

function clearSearchSelection(ctx) {
  pendingSearchSelections.delete(searchSelectionKey(ctx));
}

function userHasDjAccess(ctx, session) {
  const djRoles = session.settings.djRoleIds;
  if (!djRoles || djRoles.size === 0) return true;

  const roles = getMemberRoleIds(ctx);
  return roles.some((roleId) => djRoles.has(roleId));
}

function userHasDjAccessByConfig(ctx, guildConfig) {
  const djRoles = getDjRoleSet(guildConfig);
  if (djRoles.size === 0) return true;

  const roles = getMemberRoleIds(ctx);
  return roles.some((roleId) => djRoles.has(roleId));
}

function ensureDjAccess(ctx, session, actionLabel) {
  if (userHasDjAccess(ctx, session)) return;
  throw new ValidationError(`You need a DJ role to ${actionLabel}.`);
}

function ensureDjAccessByConfig(ctx, guildConfig, actionLabel) {
  if (userHasDjAccessByConfig(ctx, guildConfig)) return;
  throw new ValidationError(`You need a DJ role to ${actionLabel}.`);
}

function ensureSessionTrack(ctx, session) {
  if (!session.player.currentTrack) {
    throw new ValidationError('Nothing is currently playing.');
  }
}

function computeVoteSkipRequirement(ctx, session) {
  const channelId = session.connection.channelId;
  if (!channelId) return 1;

  const listeners = ctx.voiceStateStore.countUsersInChannel(
    ctx.guildId,
    channelId,
    ctx.botUserId ? [ctx.botUserId] : []
  );

  if (listeners <= 1) return 1;
  const ratio = Number.isFinite(session.settings.voteSkipRatio)
    ? session.settings.voteSkipRatio
    : ctx.config.voteSkipRatio;
  const minVotes = Number.isFinite(session.settings.voteSkipMinVotes)
    ? session.settings.voteSkipMinVotes
    : ctx.config.voteSkipMinVotes;

  return Math.max(
    minVotes,
    Math.ceil(listeners * ratio)
  );
}

function isUserInPlaybackChannel(ctx, session) {
  const userChannelId = ctx.voiceStateStore.resolveMemberVoiceChannel(ctx.message);
  return Boolean(userChannelId && session.connection.channelId && userChannelId === session.connection.channelId);
}

function createCommand(definition) {
  return Object.freeze(definition);
}

export function registerCommands(registry) {
  registry.register(createCommand({
    name: 'help',
    aliases: ['h'],
    description: 'Show all available commands.',
    usage: 'help',
    async execute(ctx) {
      const rows = ctx.registry.list().map((cmd) => {
        const aliases = cmd.aliases?.length ? ` (aliases: ${cmd.aliases.join(', ')})` : '';
        return `\`${ctx.prefix}${cmd.usage}\` - ${cmd.description}${aliases}`;
      });

      await ctx.reply.info('Commands', [{ name: 'Available', value: rows.join('\n').slice(0, 1000) }]);
    },
  }));

  registry.register(createCommand({
    name: 'ping',
    description: 'Show basic bot health.',
    usage: 'ping',
    async execute(ctx) {
      const uptimeMs = Date.now() - ctx.startedAt;
      const mem = process.memoryUsage();

      await ctx.reply.success('Bot is online.', [
        { name: 'Uptime', value: `${Math.floor(uptimeMs / 1000)}s`, inline: true },
        { name: 'Sessions', value: String(ctx.sessions.sessions.size), inline: true },
        { name: 'Memory RSS', value: `${Math.round(mem.rss / 1024 / 1024)} MB`, inline: true },
      ]);
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

      await ctx.safeTyping();
      const session = await ensureConnectedSession(ctx, explicitChannelId);

      const tracks = await session.player.enqueue(query, {
        requestedBy: ctx.authorId,
        dedupe: session.settings.dedupeEnabled,
      });

      if (!tracks.length) {
        await ctx.reply.warning('No tracks found for that query.');
        return;
      }

      if (!session.player.playing) {
        await session.player.play();
      }

      if (tracks.length === 1) {
        await ctx.reply.success(`Added to queue: ${trackLabel(tracks[0])}`);
      } else {
        await ctx.reply.success(`Added **${tracks.length}** tracks from playlist.`, [
          { name: 'First Track', value: trackLabel(tracks[0]) },
        ]);
      }
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

      await ctx.safeTyping();
      const session = await ensureConnectedSession(ctx);

      const tracks = await session.player.enqueue(query, {
        requestedBy: ctx.authorId,
        playNext: true,
        dedupe: session.settings.dedupeEnabled,
      });

      if (!tracks.length) {
        await ctx.reply.warning('No tracks found for that query.');
        return;
      }

      if (!session.player.playing) {
        await session.player.play();
      }

      if (tracks.length === 1) {
        await ctx.reply.success(`Queued next: ${trackLabel(tracks[0])}`);
      } else {
        await ctx.reply.success(`Queued **${tracks.length}** playlist tracks at the front.`);
      }
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

      const session = await ensureConnectedSession(ctx);
      const track = session.player.createTrackFromData(selected, ctx.authorId);
      const added = session.player.enqueueResolvedTracks([track], {
        dedupe: session.settings.dedupeEnabled,
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
        `Persistent history page **${persisted.page}/${persisted.totalPages}** • Total tracks: **${persisted.total}**`,
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

  registry.register(createCommand({
    name: 'playlist',
    aliases: ['pl'],
    description: 'Manage persistent guild playlists.',
    usage: 'playlist <create|add|remove|show|list|delete|play> ...',
    async execute(ctx) {
      ensureGuild(ctx);
      const library = requireLibrary(ctx);

      const action = String(ctx.args[0] ?? 'list').toLowerCase();
      const guildConfig = await getGuildConfigOrThrow(ctx);
      const enforceWriteAccess = () => ensureDjAccessByConfig(ctx, guildConfig, 'manage playlists');

      if (action === 'list') {
        const page = ctx.args[1] ? parseRequiredInteger(ctx.args[1], 'Page') : 1;
        const result = await library.listGuildPlaylists(ctx.guildId, page, PLAYLIST_PAGE_SIZE);
        if (!result.items.length) {
          await ctx.reply.warning('No playlists in this guild yet.');
          return;
        }

        await ctx.reply.info(
          `Playlists page **${result.page}/${result.totalPages}** • Total: **${result.total}**`,
          [{
            name: 'Guild playlists',
            value: result.items
              .map((entry, idx) => {
                const absolute = (result.page - 1) * result.pageSize + idx + 1;
                const suffix = Number.isFinite(entry.trackCount) ? ` (${entry.trackCount} tracks)` : '';
                return `${absolute}. **${entry.name}**${suffix}`;
              })
              .join('\n')
              .slice(0, 1000),
          }]
        );
        return;
      }

      if (action === 'create') {
        enforceWriteAccess();
        const name = ctx.args.slice(1).join(' ').trim();
        if (!name) {
          throw new ValidationError(`Usage: ${ctx.prefix}playlist create <name>`);
        }

        const created = await library.createGuildPlaylist(ctx.guildId, name, ctx.authorId);
        await ctx.reply.success(`Created playlist **${created.name}**.`);
        return;
      }

      if (action === 'delete') {
        enforceWriteAccess();
        const name = String(ctx.args[1] ?? '').trim();
        if (!name) {
          throw new ValidationError(`Usage: ${ctx.prefix}playlist delete <name>`);
        }

        const removed = await library.deleteGuildPlaylist(ctx.guildId, name);
        if (!removed) {
          await ctx.reply.warning(`Playlist **${name}** not found.`);
          return;
        }

        await ctx.reply.success(`Deleted playlist **${name}**.`);
        return;
      }

      if (action === 'show') {
        const name = String(ctx.args[1] ?? '').trim();
        if (!name) {
          throw new ValidationError(`Usage: ${ctx.prefix}playlist show <name> [page]`);
        }

        const page = ctx.args[2] ? parseRequiredInteger(ctx.args[2], 'Page') : 1;
        const playlist = await library.getGuildPlaylist(ctx.guildId, name);
        if (!playlist) {
          await ctx.reply.warning(`Playlist **${name}** not found.`);
          return;
        }

        if (!playlist.tracks.length) {
          await ctx.reply.info(`Playlist **${playlist.name}** is empty.`);
          return;
        }

        const totalPages = Math.max(1, Math.ceil(playlist.tracks.length / PLAYLIST_PAGE_SIZE));
        const safePage = Math.max(1, Math.min(page, totalPages));
        const start = (safePage - 1) * PLAYLIST_PAGE_SIZE;
        const items = playlist.tracks.slice(start, start + PLAYLIST_PAGE_SIZE);

        await ctx.reply.info(
          `Playlist **${playlist.name}** • Page **${safePage}/${totalPages}** • Tracks: **${playlist.tracks.length}**`,
          [{
            name: 'Tracks',
            value: items
              .map((track, idx) => `${start + idx + 1}. ${trackLabel(track)}`)
              .join('\n')
              .slice(0, 1000),
          }]
        );
        return;
      }

      if (action === 'add') {
        enforceWriteAccess();
        const name = String(ctx.args[1] ?? '').trim();
        const query = ctx.args.slice(2).join(' ').trim();
        if (!name || !query) {
          throw new ValidationError(`Usage: ${ctx.prefix}playlist add <name> <query|url>`);
        }

        await ctx.safeTyping();
        const session = await ctx.sessions.ensure(ctx.guildId, ctx.guildConfig);
        ctx.sessions.bindTextChannel(ctx.guildId, ctx.channelId);
        const resolved = await session.player.previewTracks(query, {
          requestedBy: ctx.authorId,
          limit: ctx.config.maxPlaylistTracks,
        });

        if (!resolved.length) {
          await ctx.reply.warning('No tracks found for this playlist add query.');
          return;
        }

        const addResult = await library.addTracksToGuildPlaylist(ctx.guildId, name, resolved, ctx.authorId);
        await ctx.reply.success(
          `Added **${addResult.addedCount}** track(s) to **${addResult.playlistName}**.`,
          addResult.droppedCount > 0
            ? [{ name: 'Skipped', value: `${addResult.droppedCount} over playlist limit.` }]
            : null
        );
        return;
      }

      if (action === 'remove') {
        enforceWriteAccess();
        const name = String(ctx.args[1] ?? '').trim();
        const index = normalizeIndex(ctx.args[2], 'Track index');
        if (!name) {
          throw new ValidationError(`Usage: ${ctx.prefix}playlist remove <name> <index>`);
        }

        const removed = await library.removeTrackFromGuildPlaylist(ctx.guildId, name, index);
        await ctx.reply.success(`Removed from **${name}**: ${trackLabel(removed)}`);
        return;
      }

      if (action === 'play') {
        const name = String(ctx.args[1] ?? '').trim();
        if (!name) {
          throw new ValidationError(`Usage: ${ctx.prefix}playlist play <name>`);
        }

        const playlist = await library.getGuildPlaylist(ctx.guildId, name);
        if (!playlist) {
          await ctx.reply.warning(`Playlist **${name}** not found.`);
          return;
        }

        if (!playlist.tracks.length) {
          await ctx.reply.warning(`Playlist **${playlist.name}** is empty.`);
          return;
        }

        const session = await ensureConnectedSession(ctx);
        const queueTracks = playlist.tracks.map((track) => session.player.createTrackFromData(track, ctx.authorId));
        const added = session.player.enqueueResolvedTracks(queueTracks, {
          dedupe: session.settings.dedupeEnabled,
        });

        if (!added.length) {
          await ctx.reply.warning('No tracks were added (likely duplicates with dedupe enabled).');
          return;
        }

        if (!session.player.playing) {
          await session.player.play();
        }

        await ctx.reply.success(`Queued **${added.length}** track(s) from playlist **${playlist.name}**.`);
        return;
      }

      throw new ValidationError(
        `Usage: ${ctx.prefix}playlist <create|add|remove|show|list|delete|play> ...`
      );
    },
  }));

  registry.register(createCommand({
    name: 'fav',
    aliases: ['favorite'],
    description: 'Save current track (or query) to your persistent favorites.',
    usage: 'fav [query|url]',
    async execute(ctx) {
      const library = requireLibrary(ctx);
      if (!ctx.authorId) {
        throw new ValidationError('Cannot resolve your user id for favorites.');
      }

      let baseTrack = null;
      const query = ctx.args.join(' ').trim();

      if (query) {
        ensureGuild(ctx);
        const session = await ctx.sessions.ensure(ctx.guildId, ctx.guildConfig);
        ctx.sessions.bindTextChannel(ctx.guildId, ctx.channelId);
        const preview = await session.player.previewTracks(query, {
          requestedBy: ctx.authorId,
          limit: 1,
        });
        baseTrack = preview[0] ?? null;
      } else if (ctx.guildId) {
        const session = ctx.sessions.get(ctx.guildId);
        baseTrack = session?.player?.currentTrack ?? null;
      }

      if (!baseTrack) {
        throw new ValidationError('Nothing to favorite. Play a track or provide a query.');
      }

      const result = await library.addUserFavorite(ctx.authorId, baseTrack);
      if (!result.added) {
        await ctx.reply.info('Track is already in your favorites.');
        return;
      }

      await ctx.reply.success(`Saved to favorites: ${trackLabel(result.track)}`);
    },
  }));

  registry.register(createCommand({
    name: 'favs',
    aliases: ['favorites'],
    description: 'List your persistent favorites.',
    usage: 'favs [page]',
    async execute(ctx) {
      const library = requireLibrary(ctx);
      if (!ctx.authorId) {
        throw new ValidationError('Cannot resolve your user id for favorites.');
      }

      const page = ctx.args.length ? parseRequiredInteger(ctx.args[0], 'Page') : 1;
      const result = await library.listUserFavorites(ctx.authorId, page, FAVORITES_PAGE_SIZE);
      if (!result.items.length) {
        await ctx.reply.warning('You have no favorite tracks yet.');
        return;
      }

      await ctx.reply.info(
        `Favorites page **${result.page}/${result.totalPages}** • Total: **${result.total}**`,
        [{
          name: 'Your favorites',
          value: result.items
            .map((track, idx) => `${(result.page - 1) * result.pageSize + idx + 1}. ${trackLabel(track)}`)
            .join('\n')
            .slice(0, 1000),
        }]
      );
    },
  }));

  registry.register(createCommand({
    name: 'ufav',
    aliases: ['unfav'],
    description: 'Remove a favorite by index.',
    usage: 'ufav <index>',
    async execute(ctx) {
      const library = requireLibrary(ctx);
      if (!ctx.authorId) {
        throw new ValidationError('Cannot resolve your user id for favorites.');
      }

      const index = normalizeIndex(ctx.args[0], 'Index');
      const removed = await library.removeUserFavorite(ctx.authorId, index);
      if (!removed) {
        await ctx.reply.warning('Favorite index out of range.');
        return;
      }

      await ctx.reply.success(`Removed favorite: ${trackLabel(removed)}`);
    },
  }));

  registry.register(createCommand({
    name: 'favplay',
    aliases: ['fp'],
    description: 'Queue one of your favorites by index.',
    usage: 'favplay <index>',
    async execute(ctx) {
      ensureGuild(ctx);
      const library = requireLibrary(ctx);
      if (!ctx.authorId) {
        throw new ValidationError('Cannot resolve your user id for favorites.');
      }

      const index = normalizeIndex(ctx.args[0], 'Index');
      const favorite = await library.getUserFavorite(ctx.authorId, index);
      if (!favorite) {
        await ctx.reply.warning('Favorite index out of range.');
        return;
      }

      const session = await ensureConnectedSession(ctx);
      const track = session.player.createTrackFromData(favorite, ctx.authorId);
      const added = session.player.enqueueResolvedTracks([track], {
        dedupe: session.settings.dedupeEnabled,
      });
      if (!added.length) {
        await ctx.reply.warning('Favorite is already in queue (dedupe enabled).');
        return;
      }

      if (!session.player.playing) {
        await session.player.play();
      }

      await ctx.reply.success(`Added favorite to queue: ${trackLabel(added[0])}`);
    },
  }));

  registry.register(createCommand({
    name: 'remove',
    aliases: ['rm'],
    description: 'Remove a queued track by index (from queue view).',
    usage: 'remove <index>',
    async execute(ctx) {
      ensureGuild(ctx);
      const session = getSessionOrThrow(ctx);
      ensureDjAccess(ctx, session, 'remove tracks');

      const index = parseRequiredInteger(ctx.args[0], 'Index');
      const removed = session.player.removeFromQueue(index);

      if (!removed) {
        await ctx.reply.warning('Invalid queue index.');
        return;
      }

      await ctx.reply.success(`Removed: ${trackLabel(removed)}`);
    },
  }));

  registry.register(createCommand({
    name: 'clear',
    aliases: ['cq'],
    description: 'Clear all pending tracks.',
    usage: 'clear',
    async execute(ctx) {
      ensureGuild(ctx);
      const session = getSessionOrThrow(ctx);
      ensureDjAccess(ctx, session, 'clear the queue');

      const removed = session.player.pendingTracks.length;
      session.player.clearQueue();

      await ctx.reply.success(`Cleared ${removed} pending track(s).`);
    },
  }));

  registry.register(createCommand({
    name: 'shuffle',
    aliases: ['mix'],
    description: 'Shuffle pending queue tracks.',
    usage: 'shuffle',
    async execute(ctx) {
      ensureGuild(ctx);
      const session = getSessionOrThrow(ctx);
      ensureDjAccess(ctx, session, 'shuffle the queue');

      const count = session.player.shuffleQueue();
      await ctx.reply.success(`Shuffled ${count} pending track(s).`);
    },
  }));

  registry.register(createCommand({
    name: 'loop',
    aliases: ['repeat'],
    description: 'Set loop mode: off, track, queue.',
    usage: 'loop <off|track|queue>',
    async execute(ctx) {
      ensureGuild(ctx);
      const session = getSessionOrThrow(ctx);
      ensureDjAccess(ctx, session, 'change loop mode');

      if (!ctx.args.length) {
        await ctx.reply.info(`Current loop mode: **${session.player.loopMode}**`);
        return;
      }

      const mode = session.player.setLoopMode(ctx.args[0]);
      await ctx.reply.success(`Loop mode set to **${mode}**.`);
    },
  }));

  registry.register(createCommand({
    name: 'volume',
    aliases: ['vol'],
    description: 'Get/set volume percentage.',
    usage: 'volume [0-200]',
    async execute(ctx) {
      ensureGuild(ctx);
      const session = getSessionOrThrow(ctx);
      ensureDjAccess(ctx, session, 'change volume');

      if (!ctx.args.length) {
        await ctx.reply.info(`Current volume: **${session.player.volumePercent}%**`);
        return;
      }

      const next = session.player.setVolumePercent(ctx.args[0]);
      await ctx.reply.success(`Volume set to **${next}%** (applies immediately to new tracks).`);
    },
  }));

  registry.register(createCommand({
    name: 'filter',
    aliases: ['fx'],
    description: 'Set audio filter preset.',
    usage: 'filter [off|bassboost|nightcore|vaporwave|8d|soft|karaoke|radio]',
    async execute(ctx) {
      ensureGuild(ctx);
      const session = getSessionOrThrow(ctx);
      ensureDjAccess(ctx, session, 'change audio filters');

      if (!ctx.args.length) {
        await ctx.reply.info(
          `Current filter: **${session.player.getAudioEffectsState().filterPreset}**`,
          [{ name: 'Available', value: session.player.getAvailableFilterPresets().join(', ').slice(0, 1000) }]
        );
        return;
      }

      const filter = session.player.setFilterPreset(ctx.args[0]);
      const restarted = session.player.refreshCurrentTrackProcessing();
      await ctx.reply.success(
        `Filter set to **${filter}**.${restarted ? ' Reapplying to current track...' : ''}`
      );
    },
  }));

  registry.register(createCommand({
    name: 'eq',
    description: 'Set EQ preset.',
    usage: 'eq [flat|pop|rock|edm|vocal]',
    async execute(ctx) {
      ensureGuild(ctx);
      const session = getSessionOrThrow(ctx);
      ensureDjAccess(ctx, session, 'change EQ');

      if (!ctx.args.length) {
        await ctx.reply.info(
          `Current EQ: **${session.player.getAudioEffectsState().eqPreset}**`,
          [{ name: 'Available', value: session.player.getAvailableEqPresets().join(', ').slice(0, 1000) }]
        );
        return;
      }

      const args = [...ctx.args];
      if (String(args[0]).toLowerCase() === 'preset') {
        args.shift();
      }

      const preset = session.player.setEqPreset(args[0]);
      const restarted = session.player.refreshCurrentTrackProcessing();
      await ctx.reply.success(
        `EQ preset set to **${preset}**.${restarted ? ' Reapplying to current track...' : ''}`
      );
    },
  }));

  registry.register(createCommand({
    name: 'tempo',
    description: 'Set playback tempo (0.5 - 2.0).',
    usage: 'tempo <0.5-2.0>',
    async execute(ctx) {
      ensureGuild(ctx);
      const session = getSessionOrThrow(ctx);
      ensureDjAccess(ctx, session, 'change tempo');

      const tempo = session.player.setTempoRatio(ctx.args[0]);
      const restarted = session.player.refreshCurrentTrackProcessing();
      await ctx.reply.success(
        `Tempo set to **${tempo.toFixed(2)}x**.${restarted ? ' Reapplying to current track...' : ''}`
      );
    },
  }));

  registry.register(createCommand({
    name: 'pitch',
    description: 'Set pitch shift in semitones (-12 to +12).',
    usage: 'pitch <-12..12>',
    async execute(ctx) {
      ensureGuild(ctx);
      const session = getSessionOrThrow(ctx);
      ensureDjAccess(ctx, session, 'change pitch');

      const pitch = session.player.setPitchSemitones(ctx.args[0]);
      const restarted = session.player.refreshCurrentTrackProcessing();
      const signed = pitch >= 0 ? `+${pitch}` : String(pitch);
      await ctx.reply.success(
        `Pitch set to **${signed} semitones**.${restarted ? ' Reapplying to current track...' : ''}`
      );
    },
  }));

  registry.register(createCommand({
    name: 'effects',
    aliases: ['fxstate'],
    description: 'Show current audio effect state.',
    usage: 'effects',
    async execute(ctx) {
      ensureGuild(ctx);
      const session = getSessionOrThrow(ctx);

      const state = session.player.getAudioEffectsState();
      await ctx.reply.info('Audio effects', [
        { name: 'Filter', value: state.filterPreset, inline: true },
        { name: 'EQ', value: state.eqPreset, inline: true },
        { name: 'Tempo', value: `${state.tempoRatio.toFixed(2)}x`, inline: true },
        { name: 'Pitch', value: String(state.pitchSemitones), inline: true },
      ]);
    },
  }));

  registry.register(createCommand({
    name: 'autoplay',
    aliases: ['ap'],
    description: 'Toggle autoplay when queue becomes empty.',
    usage: 'autoplay [on|off]',
    async execute(ctx) {
      ensureGuild(ctx);
      const guildConfig = await getGuildConfigOrThrow(ctx);
      ensureDjAccessByConfig(ctx, guildConfig, 'change autoplay');

      if (!ctx.args.length) {
        await ctx.reply.info(`Autoplay is currently **${guildConfig.settings.autoplayEnabled ? 'on' : 'off'}**.`);
        return;
      }

      const value = parseOnOff(ctx.args[0], null);
      if (value == null) {
        throw new ValidationError('Use `on` or `off`.');
      }

      await updateGuildConfig(ctx, {
        settings: { autoplayEnabled: value },
      });
      await ctx.reply.success(`Autoplay is now **${value ? 'on' : 'off'}**.`);
    },
  }));

  registry.register(createCommand({
    name: 'dedupe',
    description: 'Toggle duplicate prevention when adding tracks.',
    usage: 'dedupe [on|off]',
    async execute(ctx) {
      ensureGuild(ctx);
      const guildConfig = await getGuildConfigOrThrow(ctx);
      ensureDjAccessByConfig(ctx, guildConfig, 'change dedupe mode');

      if (!ctx.args.length) {
        await ctx.reply.info(`Dedupe is currently **${guildConfig.settings.dedupeEnabled ? 'on' : 'off'}**.`);
        return;
      }

      const value = parseOnOff(ctx.args[0], null);
      if (value == null) {
        throw new ValidationError('Use `on` or `off`.');
      }

      await updateGuildConfig(ctx, {
        settings: { dedupeEnabled: value },
      });
      await ctx.reply.success(`Dedupe is now **${value ? 'on' : 'off'}**.`);
    },
  }));

  registry.register(createCommand({
    name: '247',
    aliases: ['stay'],
    description: 'Toggle 24/7 mode (stay connected when idle).',
    usage: '247 [on|off]',
    async execute(ctx) {
      ensureGuild(ctx);
      const guildConfig = await getGuildConfigOrThrow(ctx);
      ensureDjAccessByConfig(ctx, guildConfig, 'change 24/7 mode');

      if (!ctx.args.length) {
        await ctx.reply.info(`24/7 mode is currently **${guildConfig.settings.stayInVoiceEnabled ? 'on' : 'off'}**.`);
        return;
      }

      const value = parseOnOff(ctx.args[0], null);
      if (value == null) {
        throw new ValidationError('Use `on` or `off`.');
      }

      await updateGuildConfig(ctx, {
        settings: { stayInVoiceEnabled: value },
      });
      await ctx.reply.success(`24/7 mode is now **${value ? 'on' : 'off'}**.`);
    },
  }));

  registry.register(createCommand({
    name: 'djrole',
    aliases: ['dj'],
    description: 'Manage DJ role restrictions for control commands.',
    usage: 'djrole [add|remove|clear|list] [@role|roleId]',
    async execute(ctx) {
      ensureGuild(ctx);
      const guildConfig = await getGuildConfigOrThrow(ctx);
      ensureDjAccessByConfig(ctx, guildConfig, 'manage DJ roles');

      const action = String(ctx.args[0] ?? 'list').toLowerCase();
      if (action === 'list') {
        const roles = [...guildConfig.settings.djRoleIds];
        if (!roles.length) {
          await ctx.reply.info('DJ role restriction is disabled (everyone can control playback).');
          return;
        }

        await ctx.reply.info('Configured DJ roles', [
          { name: 'Roles', value: roles.map((id) => `<@&${id}>`).join(', ') },
        ]);
        return;
      }

      if (action === 'clear') {
        await updateGuildConfig(ctx, {
          settings: { djRoleIds: [] },
        });
        await ctx.reply.success('Cleared all DJ role restrictions.');
        return;
      }

      if (!['add', 'remove'].includes(action)) {
        throw new ValidationError('Usage: `djrole [add|remove|clear|list] [@role|roleId]`');
      }

      const roleId = parseRoleId(ctx.args[1]);
      if (!roleId) {
        throw new ValidationError('Provide a role mention or role ID.');
      }

      const next = new Set(guildConfig.settings.djRoleIds);
      if (action === 'add') {
        next.add(roleId);
      } else {
        next.delete(roleId);
      }

      await updateGuildConfig(ctx, {
        settings: { djRoleIds: [...next] },
      });
      await ctx.reply.success(
        action === 'add'
          ? `Added DJ role <@&${roleId}>.`
          : `Removed DJ role <@&${roleId}>.`
      );
    },
  }));

  registry.register(createCommand({
    name: 'prefix',
    description: 'Show or set the guild command prefix.',
    usage: 'prefix [newPrefix]',
    async execute(ctx) {
      ensureGuild(ctx);
      const guildConfig = await getGuildConfigOrThrow(ctx);
      ensureDjAccessByConfig(ctx, guildConfig, 'change the command prefix');

      if (!ctx.args.length) {
        await ctx.reply.info(`Current prefix is **${guildConfig.prefix}**.`);
        return;
      }

      const nextPrefix = String(ctx.args[0] ?? '').trim();
      const updated = await updateGuildConfig(ctx, { prefix: nextPrefix });
      await ctx.reply.success(`Prefix updated to **${updated.prefix}**.`);
    },
  }));

  registry.register(createCommand({
    name: 'musiclog',
    aliases: ['logchannel'],
    description: 'Set a dedicated channel for player event logs.',
    usage: 'musiclog [off|#channel|channelId]',
    async execute(ctx) {
      ensureGuild(ctx);
      const guildConfig = await getGuildConfigOrThrow(ctx);
      ensureDjAccessByConfig(ctx, guildConfig, 'change music log channel');

      if (!ctx.args.length) {
        const current = guildConfig.settings.musicLogChannelId;
        await ctx.reply.info(
          current
            ? `Music log channel is <#${current}>.`
            : 'Music log channel is disabled (events are sent to the active command channel).'
        );
        return;
      }

      const raw = String(ctx.args[0] ?? '').trim().toLowerCase();
      if (raw === 'off' || raw === 'none' || raw === 'disable') {
        await updateGuildConfig(ctx, {
          settings: { musicLogChannelId: null },
        });
        await ctx.reply.success('Music log channel disabled.');
        return;
      }

      const channelId = parseTextChannelId(ctx.args[0]);
      if (!channelId) {
        throw new ValidationError('Provide `off`, a channel mention, or a channel id.');
      }

      await updateGuildConfig(ctx, {
        settings: { musicLogChannelId: channelId },
      });
      await ctx.reply.success(`Music log channel set to <#${channelId}>.`);
    },
  }));

  registry.register(createCommand({
    name: 'language',
    aliases: ['lang'],
    description: 'Set guild language baseline (`en`/`de`).',
    usage: 'language [en|de]',
    async execute(ctx) {
      ensureGuild(ctx);
      const guildConfig = await getGuildConfigOrThrow(ctx);
      ensureDjAccessByConfig(ctx, guildConfig, 'change language');

      if (!ctx.args.length) {
        await ctx.reply.info(`Current language: **${guildConfig.settings.language}**`);
        return;
      }

      const next = String(ctx.args[0] ?? '').trim().toLowerCase();
      if (!['en', 'de'].includes(next)) {
        throw new ValidationError('Language must be `en` or `de`.');
      }

      const updated = await updateGuildConfig(ctx, {
        settings: { language: next },
      });
      await ctx.reply.success(`Language updated to **${updated.settings.language}**.`);
    },
  }));

  registry.register(createCommand({
    name: 'voteskipcfg',
    aliases: ['vscfg'],
    description: 'Configure vote-skip threshold per guild.',
    usage: 'voteskipcfg [ratio <0..1>|min <number>]',
    async execute(ctx) {
      ensureGuild(ctx);
      const guildConfig = await getGuildConfigOrThrow(ctx);
      ensureDjAccessByConfig(ctx, guildConfig, 'configure vote-skip');

      if (!ctx.args.length) {
        await ctx.reply.info('Vote-skip configuration', [
          { name: 'Ratio', value: String(guildConfig.settings.voteSkipRatio), inline: true },
          { name: 'Minimum Votes', value: String(guildConfig.settings.voteSkipMinVotes), inline: true },
        ]);
        return;
      }

      const mode = String(ctx.args[0] ?? '').toLowerCase();
      if (mode === 'ratio') {
        const raw = Number.parseFloat(String(ctx.args[1] ?? ''));
        if (!Number.isFinite(raw) || raw <= 0 || raw > 1) {
          throw new ValidationError('Ratio must be a number between 0 and 1.');
        }

        const updated = await updateGuildConfig(ctx, {
          settings: { voteSkipRatio: raw },
        });
        await ctx.reply.success(`Vote-skip ratio updated to **${updated.settings.voteSkipRatio}**.`);
        return;
      }

      if (mode === 'min') {
        const raw = Number.parseInt(String(ctx.args[1] ?? ''), 10);
        if (!Number.isFinite(raw) || raw <= 0 || raw > 100) {
          throw new ValidationError('Minimum votes must be an integer between 1 and 100.');
        }

        const updated = await updateGuildConfig(ctx, {
          settings: { voteSkipMinVotes: raw },
        });
        await ctx.reply.success(`Vote-skip minimum updated to **${updated.settings.voteSkipMinVotes}**.`);
        return;
      }

      throw new ValidationError('Usage: `voteskipcfg [ratio <0..1>|min <number>]`');
    },
  }));

  registry.register(createCommand({
    name: 'settings',
    aliases: ['cfg', 'config'],
    description: 'Show effective guild music-bot settings.',
    usage: 'settings',
    async execute(ctx) {
      ensureGuild(ctx);
      const guildConfig = await getGuildConfigOrThrow(ctx);
      const session = ctx.sessions.get(ctx.guildId);
      const roles = guildConfig.settings.djRoleIds.length
        ? guildConfig.settings.djRoleIds.map((id) => `<@&${id}>`).join(', ')
        : 'none';

      await ctx.reply.info('Guild configuration', [
        { name: 'Prefix', value: guildConfig.prefix, inline: true },
        { name: 'Autoplay', value: guildConfig.settings.autoplayEnabled ? 'on' : 'off', inline: true },
        { name: 'Dedupe', value: guildConfig.settings.dedupeEnabled ? 'on' : 'off', inline: true },
        { name: '24/7', value: guildConfig.settings.stayInVoiceEnabled ? 'on' : 'off', inline: true },
        { name: 'Vote Ratio', value: String(guildConfig.settings.voteSkipRatio), inline: true },
        { name: 'Vote Min', value: String(guildConfig.settings.voteSkipMinVotes), inline: true },
        { name: 'Language', value: guildConfig.settings.language, inline: true },
        { name: 'DJ Roles', value: roles },
        { name: 'Music Log Channel', value: guildConfig.settings.musicLogChannelId ? `<#${guildConfig.settings.musicLogChannelId}>` : 'disabled' },
        { name: 'Session Active', value: session ? 'yes' : 'no', inline: true },
      ]);
    },
  }));

  registry.register(createCommand({
    name: 'voteskip',
    aliases: ['vs'],
    description: 'Show current vote-skip progress.',
    usage: 'voteskip',
    async execute(ctx) {
      ensureGuild(ctx);
      const session = getSessionOrThrow(ctx);
      ensureSessionTrack(ctx, session);

      const needed = computeVoteSkipRequirement(ctx, session);
      const current = ctx.sessions.getVoteCount(ctx.guildId);
      await ctx.reply.info(`Vote-skip progress: **${current}/${needed}**`);
    },
  }));

  registry.register(createCommand({
    name: 'lyrics',
    aliases: ['ly'],
    description: 'Show lyrics for current track or a query.',
    usage: 'lyrics [artist - title]',
    async execute(ctx) {
      const query = ctx.args.join(' ').trim();
      const session = ctx.guildId ? ctx.sessions.get(ctx.guildId) : null;
      const fallback = session?.player?.currentTrack?.title ?? null;
      const effectiveQuery = query || fallback;

      if (!effectiveQuery) {
        throw new ValidationError('Provide a song query or play a track first.');
      }

      await ctx.safeTyping();
      const result = await ctx.lyrics.search(effectiveQuery);
      if (!result) {
        await ctx.reply.warning(`No lyrics found for: **${effectiveQuery}**`);
        return;
      }

      await ctx.reply.info(`Lyrics for **${effectiveQuery}**`, [
        { name: `Source: ${result.source}`, value: result.lyrics.slice(0, 1000) },
      ]);
    },
  }));

  registry.register(createCommand({
    name: 'stats',
    description: 'Show runtime statistics.',
    usage: 'stats',
    async execute(ctx) {
      const uptimeSeconds = Math.floor((Date.now() - ctx.startedAt) / 1000);
      const mem = process.memoryUsage();

      await ctx.reply.info('Runtime statistics', [
        { name: 'Uptime', value: `${uptimeSeconds}s`, inline: true },
        { name: 'Guild sessions', value: String(ctx.sessions.sessions.size), inline: true },
        { name: 'Heap Used', value: `${Math.round(mem.heapUsed / 1024 / 1024)} MB`, inline: true },
      ]);
    },
  }));
}
