import { ValidationError } from '../../core/errors.ts';
import { buildSingleFieldInfoPayload } from './responseUtils.ts';
import type { CommandContextLike, CommandHelperBundle, SessionLike, TrackDataLike } from './helpers/types.ts';

const USER_MENTION_PATTERN = /^<@!?(\d+)>$/;
const CHANNEL_MENTION_PATTERN = /^<#(\d+)>$/;
type AnyTrack = { id?: string | null; title?: string | null; duration?: string | null; source?: string | null };
type MoodPreset = { filter: string; eq: string; tempo: number; pitch: number };
type PartyState = {
  startedAt: number;
  teams: { a: Set<string>; b: Set<string> };
  scores: { a: number; b: number };
  votes: Set<string>;
};
type PendingImportState = {
  templateName: string;
  tracks: TrackDataLike[];
  createdAt: number;
};
type RegistryLike = {
  register: (definition: Readonly<{ name: string }>) => void;
};

type AdvancedCommandHelpers = Pick<
  CommandHelperBundle,
  'createCommand'
  | 'ensureGuild'
  | 'getSessionOrThrow'
  | 'ensureConnectedSession'
  | 'ensureManageGuildAccess'
  | 'ensureDjAccess'
  | 'parseRequiredInteger'
  | 'parseTextChannelId'
  | 'requireLibrary'
>;
const partyStates = new Map<string, PartyState>();
const pendingImports = new Map<string, PendingImportState>();
const PARTY_STATE_TTL_MS = 12 * 60 * 60 * 1000;
const PENDING_IMPORT_TTL_MS = 15 * 60 * 1000;
const EPHEMERAL_STATE_PRUNE_INTERVAL_MS = 5 * 60 * 1000;

const MOOD_PRESETS: Record<string, MoodPreset> = {
  chill: { filter: 'soft', eq: 'vocal', tempo: 0.95, pitch: 0 },
  hype: { filter: 'bassboost', eq: 'edm', tempo: 1.05, pitch: 0 },
  retro: { filter: 'vaporwave', eq: 'flat', tempo: 0.9, pitch: -1 },
  clean: { filter: 'off', eq: 'flat', tempo: 1.0, pitch: 0 },
  radio: { filter: 'radio', eq: 'rock', tempo: 1.0, pitch: 0 },
};

function parseUserId(value: unknown, fallback: string | null = null) {
  const raw = String(value ?? '').trim();
  if (!raw) return fallback;
  const mention = raw.match(USER_MENTION_PATTERN);
  if (mention) return mention[1] ?? fallback;
  if (/^\d{6,}$/.test(raw)) return raw;
  return fallback;
}

function parseChannelId(value: unknown, fallback: string | null = null) {
  const raw = String(value ?? '').trim();
  if (!raw) return fallback;
  const mention = raw.match(CHANNEL_MENTION_PATTERN);
  if (mention) return mention[1] ?? fallback;
  if (/^\d{6,}$/.test(raw)) return raw;
  return fallback;
}

function applyMoodPreset(player: SessionLike['player'], presetName: unknown): MoodPreset {
  const preset = MOOD_PRESETS[String(presetName ?? '').toLowerCase() as keyof typeof MOOD_PRESETS];
  if (!preset) {
    throw new ValidationError(`Unknown mood preset: ${presetName}.`);
  }
  player.setFilterPreset(preset.filter);
  player.setEqPreset(preset.eq);
  player.setTempoRatio(preset.tempo);
  player.setPitchSemitones(preset.pitch);
  player.refreshCurrentTrackProcessing();
  return preset;
}

function trackLabel(track: AnyTrack) {
  return `**${track.title}** (${track.duration})`;
}

function pendingImportKey(ctx: Pick<CommandContextLike, 'guildId' | 'authorId'>) {
  return `${String(ctx.guildId)}:${String(ctx.authorId)}`;
}

function pruneEphemeralState(now: number = Date.now()) {
  for (const [key, state] of partyStates.entries()) {
    if ((now - state.startedAt) > PARTY_STATE_TTL_MS) {
      partyStates.delete(key);
    }
  }

  for (const [key, state] of pendingImports.entries()) {
    if ((now - state.createdAt) > PENDING_IMPORT_TTL_MS) {
      pendingImports.delete(key);
    }
  }
}

const ephemeralStateSweepHandle = setInterval(() => {
  pruneEphemeralState();
}, EPHEMERAL_STATE_PRUNE_INTERVAL_MS);

ephemeralStateSweepHandle.unref?.();

function formatTaste(taste: Array<{ term?: string; count?: number }> | null | undefined, limit: number = 8) {
  if (!Array.isArray(taste) || !taste.length) return 'No taste profile yet.';
  return taste.slice(0, limit).map((entry) => `${entry.term} (${entry.count})`).join(', ');
}

function chunkLines(lines: unknown[], maxChars: number = 1000) {
  const normalized = Array.isArray(lines) ? lines.map((line) => String(line ?? '')) : [];
  if (!normalized.length) return ['-'];

  const pages = [];
  let current = '';
  for (const line of normalized) {
    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length <= maxChars) {
      current = candidate;
      continue;
    }
    if (current) pages.push(current);
    if (line.length <= maxChars) {
      current = line;
      continue;
    }
    for (let i = 0; i < line.length; i += maxChars) {
      pages.push(line.slice(i, i + maxChars));
    }
    current = '';
  }
  if (current) pages.push(current);
  return pages.length ? pages : ['-'];
}

export function registerAdvancedCommands(registry: RegistryLike, h: AdvancedCommandHelpers) {
  const {
    createCommand,
    ensureGuild,
    getSessionOrThrow,
    ensureConnectedSession,
    ensureManageGuildAccess,
    ensureDjAccess,
    parseRequiredInteger,
    parseTextChannelId,
    requireLibrary,
  } = h;

  registry.register(createCommand({
    name: 'mood',
    description: 'Apply a mood preset bundle (filter/eq/tempo/pitch).',
    usage: 'mood <chill|hype|retro|clean|radio>',
    async execute(ctx: CommandContextLike) {
      ensureGuild(ctx);
      const session = getSessionOrThrow(ctx);
      ensureDjAccess(ctx, session, 'apply mood presets');

      const presetName = String(ctx.args[0] ?? '').trim().toLowerCase();
      if (!presetName) {
        await ctx.reply.info('Mood presets', [
          { name: 'Available', value: Object.keys(MOOD_PRESETS).join(', ') },
        ]);
        return;
      }

      const preset = applyMoodPreset(session.player, presetName);
      await ctx.reply.success(`Mood preset applied: **${presetName}**`, [
        { name: 'Filter', value: preset.filter, inline: true },
        { name: 'EQ', value: preset.eq, inline: true },
        { name: 'Tempo', value: `${preset.tempo}x`, inline: true },
      ]);
    },
  }));

  registry.register(createCommand({
    name: 'panel',
    description: 'Configure/update the live session panel message.',
    usage: 'panel <setup|refresh|off> [#channel]',
    async execute(ctx: CommandContextLike) {
      ensureGuild(ctx);
      const library = requireLibrary(ctx);
      await ensureManageGuildAccess(ctx, 'disable session panel');
      await library.patchGuildFeatureConfig(ctx.guildId, {
        sessionPanelChannelId: null,
        sessionPanelMessageId: null,
      });
      await ctx.reply.info('Session panel is disabled and no longer used.');
    },
  }));

  registry.register(createCommand({
    name: 'musicwebhook',
    aliases: ['whmusic'],
    description: 'Configure webhook feed for music events.',
    usage: 'musicwebhook <set <url>|off|show>',
    async execute(ctx: CommandContextLike) {
      ensureGuild(ctx);
      const library = requireLibrary(ctx);
      const action = String(ctx.args[0] ?? 'show').toLowerCase();

      if (action === 'show') {
        const cfg = await library.getGuildFeatureConfig(ctx.guildId);
        await ctx.reply.info(
          cfg.webhookUrl
            ? `Webhook feed is configured.`
            : 'Webhook feed is disabled.'
        );
        return;
      }

      await ensureManageGuildAccess(ctx, 'configure music webhooks');
      if (action === 'off') {
        await library.patchGuildFeatureConfig(ctx.guildId, { webhookUrl: null });
        await ctx.reply.success('Webhook feed disabled.');
        return;
      }

      if (action !== 'set') {
        throw new ValidationError(`Usage: ${ctx.prefix}musicwebhook <set <url>|off|show>`);
      }

      const url = String(ctx.args[1] ?? '').trim();
      if (!/^https?:\/\//.test(url)) {
        throw new ValidationError('Webhook URL must start with http:// or https://');
      }

      await library.patchGuildFeatureConfig(ctx.guildId, { webhookUrl: url });
      await ctx.reply.success('Webhook feed configured.');
    },
  }));

  registry.register(createCommand({
    name: 'queueguard',
    description: 'Configure smart queue guard rules.',
    usage: 'queueguard <show|on|off|maxperwindow <n>|window <n>|maxartiststreak <n>>',
    async execute(ctx: CommandContextLike) {
      ensureGuild(ctx);
      const library = requireLibrary(ctx);
      const cfg = await library.getGuildFeatureConfig(ctx.guildId);
      const queueGuard = cfg.queueGuard ?? {};
      const action = String(ctx.args[0] ?? 'show').toLowerCase();

      if (action === 'show') {
        await ctx.reply.info('Queue guard', [
          { name: 'Enabled', value: queueGuard.enabled ? 'on' : 'off', inline: true },
          { name: 'Max/User Window', value: String(queueGuard.maxPerRequesterWindow), inline: true },
          { name: 'Window Size', value: String(queueGuard.windowSize), inline: true },
          { name: 'Max Artist Streak', value: String(queueGuard.maxArtistStreak), inline: true },
        ]);
        return;
      }

      await ensureManageGuildAccess(ctx, 'configure queue guard');
      const next = { ...(cfg.queueGuard ?? {}) };
      if (action === 'on') next.enabled = true;
      else if (action === 'off') next.enabled = false;
      else if (action === 'maxperwindow') next.maxPerRequesterWindow = parseRequiredInteger(ctx.args[1], 'Value');
      else if (action === 'window') next.windowSize = parseRequiredInteger(ctx.args[1], 'Value');
      else if (action === 'maxartiststreak') next.maxArtistStreak = parseRequiredInteger(ctx.args[1], 'Value');
      else throw new ValidationError(`Usage: ${ctx.prefix}queueguard <show|on|off|maxperwindow <n>|window <n>|maxartiststreak <n>>`);

      await library.patchGuildFeatureConfig(ctx.guildId, { queueGuard: next });
      await ctx.reply.success('Queue guard updated.');
    },
  }));

  registry.register(createCommand({
    name: 'template',
    description: 'Manage queue templates.',
    usage: 'template <save|play|list|show|delete> ...',
    async execute(ctx: CommandContextLike) {
      ensureGuild(ctx);
      const library = requireLibrary(ctx);
      const action = String(ctx.args[0] ?? 'list').toLowerCase();

      if (action === 'list') {
        const templates = await library.listQueueTemplates(ctx.guildId);
        if (!templates.length) {
          await ctx.reply.warning('No queue templates configured.');
          return;
        }
        const lines = templates.map((entry, idx) => `${idx + 1}. ${entry.name} (${entry.tracks.length} tracks)`);
        const pages = chunkLines(lines, 1000);
        if (pages.length === 1) {
          await ctx.reply.info('Queue templates', [{ name: 'Templates', value: pages[0] ?? '-' }]);
          return;
        }

        await ctx.sendPaginated(pages.map((value, idx) => buildSingleFieldInfoPayload(
          ctx,
          `Queue templates (${idx + 1}/${pages.length})`,
          '',
          'Templates',
          value
        )));
        return;
      }

      if (action === 'save') {
        const session = getSessionOrThrow(ctx);
        ensureDjAccess(ctx, session, 'save queue templates');
        const name = ctx.args.slice(1).join(' ').trim();
        if (!name) throw new ValidationError(`Usage: ${ctx.prefix}template save <name>`);
        const tracks = [session.player.currentTrack, ...session.player.pendingTracks].filter(Boolean);
        if (!tracks.length) throw new ValidationError('Queue is empty.');
        const saved = await library.setQueueTemplate(ctx.guildId, name, tracks, ctx.authorId);
        await ctx.reply.success(`Template saved: **${saved.name}** (${saved.tracks.length} tracks)`);
        return;
      }

      if (action === 'delete') {
        await ensureManageGuildAccess(ctx, 'delete queue templates');
        const name = ctx.args.slice(1).join(' ').trim();
        if (!name) throw new ValidationError(`Usage: ${ctx.prefix}template delete <name>`);
        const removed = await library.deleteQueueTemplate(ctx.guildId, name);
        if (!removed) {
          await ctx.reply.warning('Template not found.');
          return;
        }
        await ctx.reply.success('Template deleted.');
        return;
      }

      if (action === 'show') {
        const name = ctx.args.slice(1).join(' ').trim();
        if (!name) throw new ValidationError(`Usage: ${ctx.prefix}template show <name>`);
        const tpl = await library.getQueueTemplate(ctx.guildId, name);
        if (!tpl) {
          await ctx.reply.warning('Template not found.');
          return;
        }
        const lines = tpl.tracks.map((track, idx) => `${idx + 1}. ${trackLabel(track)}`);
        const pages = chunkLines(lines, 1000);
        if (pages.length === 1) {
          await ctx.reply.info(`Template **${tpl.name}**`, [{ name: 'Tracks', value: pages[0] ?? '-' }]);
          return;
        }

        await ctx.sendPaginated(pages.map((value, idx) => buildSingleFieldInfoPayload(
          ctx,
          `Template ${tpl.name} (${idx + 1}/${pages.length})`,
          '',
          'Tracks',
          value
        )));
        return;
      }

      if (action === 'play') {
        const name = ctx.args.slice(1).join(' ').trim();
        if (!name) throw new ValidationError(`Usage: ${ctx.prefix}template play <name>`);
        const tpl = await library.getQueueTemplate(ctx.guildId, name);
        if (!tpl) throw new ValidationError('Template not found.');
        const session = await ensureConnectedSession(ctx);
        const tracks = tpl.tracks.map((track) => session.player.createTrackFromData(track, ctx.authorId));
        const features = await library.getGuildFeatureConfig(ctx.guildId);
        const added = session.player.enqueueResolvedTracks(tracks, {
          dedupe: session.settings.dedupeEnabled,
          queueGuard: features.queueGuard,
        });
        if (!added.length) {
          await ctx.reply.warning('No tracks added (likely dedupe).');
          return;
        }
        if (!session.player.playing) await session.player.play();
        await ctx.reply.success(`Queued template: **${tpl.name}** (${added.length} tracks).`);
        return;
      }

      throw new ValidationError(`Usage: ${ctx.prefix}template <save|play|list|show|delete> ...`);
    },
  }));

  registry.register(createCommand({
    name: 'charts',
    description: 'Show top played tracks in this guild.',
    usage: 'charts [days]',
    async execute(ctx: CommandContextLike) {
      ensureGuild(ctx);
      const library = requireLibrary(ctx);
      const days = ctx.args[0] ? parseRequiredInteger(ctx.args[0], 'Days') : 7;
      const top = await library.getGuildTopTracks(ctx.guildId, days, 10);
      if (!top.length) {
        await ctx.reply.warning('No chart data yet.');
        return;
      }
      const lines = top.map((entry, idx) => `${idx + 1}. ${entry.title} (${entry.plays})`);
      const pages = chunkLines(lines, 1000);
      if (pages.length === 1) {
        await ctx.reply.info(`Top tracks (${days}d)`, [{ name: 'Tracks', value: pages[0] ?? '-' }]);
        return;
      }

      await ctx.sendPaginated(pages.map((value, idx) => buildSingleFieldInfoPayload(
        ctx,
        `Top tracks (${days}d) (${idx + 1}/${pages.length})`,
        '',
        'Tracks',
        value
      )));
    },
  }));

  registry.register(createCommand({
    name: 'recap',
    description: 'Configure and preview weekly recap.',
    usage: 'recap <show|set #channel|off|now>',
    async execute(ctx: CommandContextLike) {
      ensureGuild(ctx);
      const library = requireLibrary(ctx);
      const action = String(ctx.args[0] ?? 'show').toLowerCase();

      if (action === 'show') {
        const cfg = await library.getGuildFeatureConfig(ctx.guildId);
        const state = await library.getRecapState(ctx.guildId);
        await ctx.reply.info('Weekly recap status', [
          { name: 'Channel', value: cfg.recapChannelId ? `<#${cfg.recapChannelId}>` : 'disabled' },
          { name: 'Last Sent', value: state.lastWeeklyRecapAt ? String(state.lastWeeklyRecapAt) : 'never' },
        ]);
        return;
      }

      if (action === 'now') {
        const recap = await library.buildGuildRecap(ctx.guildId, 7);
        const tracks = chunkLines(
          recap.topTracks.slice(0, 5).map((entry, idx) => `${idx + 1}. ${entry.title} (${entry.plays})`),
          1000
        )[0] || 'No data';
        const req = chunkLines(
          recap.topRequesters.slice(0, 5).map((entry, idx) => `${idx + 1}. <@${entry.userId}> (${entry.plays})`),
          1000
        )[0] || 'No data';
        await ctx.reply.info('Weekly recap (preview)', [
          { name: 'Total Plays', value: String(recap.playCount), inline: true },
          { name: 'Top Tracks', value: tracks },
          { name: 'Top Requesters', value: req },
        ]);
        return;
      }

      await ensureManageGuildAccess(ctx, 'configure weekly recap');
      if (action === 'off') {
        await library.patchGuildFeatureConfig(ctx.guildId, { recapChannelId: null });
        await ctx.reply.success('Weekly recap disabled.');
        return;
      }

      if (action !== 'set') {
        throw new ValidationError(`Usage: ${ctx.prefix}recap <show|set #channel|off|now>`);
      }
      const channelId = parseTextChannelId(ctx.args[1] ?? null) ?? parseChannelId(ctx.args[1], null);
      if (!channelId) throw new ValidationError('Provide a channel mention or channel id.');
      await library.patchGuildFeatureConfig(ctx.guildId, { recapChannelId: channelId });
      await ctx.reply.success(`Weekly recap channel set to <#${channelId}>.`);
    },
  }));

  registry.register(createCommand({
    name: 'voiceprofile',
    aliases: ['vprofile'],
    description: 'Set voice-channel playback profile (auto mood).',
    usage: 'voiceprofile <set|show|clear> [#channel] [mood]',
    async execute(ctx: CommandContextLike) {
      ensureGuild(ctx);
      const library = requireLibrary(ctx);
      const action = String(ctx.args[0] ?? 'show').toLowerCase();
      const channelId = parseChannelId(ctx.args[1], null);

      if (action === 'show') {
        const targetChannel = channelId ?? ctx.voiceStateStore.resolveMemberVoiceChannel(ctx.message);
        if (!targetChannel) throw new ValidationError('Provide a channel or join a voice channel.');
        const profile = await library.getVoiceProfile(ctx.guildId, targetChannel);
        if (!profile) {
          await ctx.reply.warning('No voice profile configured for that channel.');
          return;
        }
        await ctx.reply.info(`Voice profile for <#${targetChannel}>`, [
          { name: 'Mood', value: profile.moodPreset ?? 'none', inline: true },
        ]);
        return;
      }

      await ensureManageGuildAccess(ctx, 'configure voice profiles');
      const targetChannel = channelId ?? ctx.voiceStateStore.resolveMemberVoiceChannel(ctx.message);
      if (!targetChannel) throw new ValidationError('Provide a channel or join a voice channel.');

      if (action === 'clear') {
        await library.setVoiceProfile(ctx.guildId, targetChannel, { moodPreset: null });
        await ctx.reply.success(`Voice profile cleared for <#${targetChannel}>.`);
        return;
      }

      if (action !== 'set') {
        throw new ValidationError(`Usage: ${ctx.prefix}voiceprofile <set|show|clear> [#channel] [mood]`);
      }

      const mood = String(ctx.args[2] ?? '').trim().toLowerCase();
      if (!MOOD_PRESETS[mood]) {
        throw new ValidationError(`Unknown mood preset. Available: ${Object.keys(MOOD_PRESETS).join(', ')}`);
      }
      await library.setVoiceProfile(ctx.guildId, targetChannel, { moodPreset: mood });
      await ctx.reply.success(`Voice profile set for <#${targetChannel}> -> **${mood}**.`);
    },
  }));

  registry.register(createCommand({
    name: 'reputation',
    aliases: ['rep'],
    description: 'Show requester reputation score.',
    usage: 'reputation [@user|id]',
    async execute(ctx: CommandContextLike) {
      ensureGuild(ctx);
      const library = requireLibrary(ctx);
      const userId = parseUserId(ctx.args[0], ctx.authorId);
      if (!userId) throw new ValidationError('Could not resolve user id.');
      const profile = await library.getUserProfile(userId, ctx.guildId);
      const stats = profile.guildStats ?? { plays: 0, skips: 0, favorites: 0, score: 0 };
      await ctx.reply.info(`Reputation for <@${userId}>`, [
        { name: 'Score', value: String(stats.score ?? 0), inline: true },
        { name: 'Plays', value: String(stats.plays ?? 0), inline: true },
        { name: 'Skips', value: String(stats.skips ?? 0), inline: true },
        { name: 'Favorites', value: String(stats.favorites ?? 0), inline: true },
      ]);
    },
  }));

  registry.register(createCommand({
    name: 'taste',
    description: 'Show personal taste memory terms.',
    usage: 'taste [@user|id]',
    async execute(ctx: CommandContextLike) {
      ensureGuild(ctx);
      const library = requireLibrary(ctx);
      const userId = parseUserId(ctx.args[0], ctx.authorId);
      if (!userId) throw new ValidationError('Could not resolve user id.');
      const profile = await library.getUserProfile(userId, ctx.guildId);
      await ctx.reply.info(`Taste profile for <@${userId}>`, [
        { name: 'Top terms', value: formatTaste(profile.taste) },
      ]);
    },
  }));

  registry.register(createCommand({
    name: 'handoff',
    description: 'Temporarily hand DJ control to one user.',
    usage: 'handoff <@user|id|off|show> [minutes]',
    async execute(ctx: CommandContextLike) {
      ensureGuild(ctx);
      const session = getSessionOrThrow(ctx);
      await ensureManageGuildAccess(ctx, 'configure DJ handoff');

      const mode = String(ctx.args[0] ?? 'show').trim().toLowerCase();
      if (mode === 'show') {
        const handoff = session.tempDjHandoff ?? null;
        if (!handoff || handoff.expiresAt <= Date.now()) {
          await ctx.reply.info('No active DJ handoff.');
          return;
        }
        await ctx.reply.info(`Active DJ handoff: <@${handoff.userId}>`, [
          { name: 'Expires', value: new Date(handoff.expiresAt).toISOString() },
        ]);
        return;
      }

      if (mode === 'off') {
        session.tempDjHandoff = null;
        await ctx.reply.success('DJ handoff cleared.');
        return;
      }

      const userId = parseUserId(mode, null);
      if (!userId) throw new ValidationError('Provide a user mention/id, `show`, or `off`.');
      const minutes = ctx.args[1] ? parseRequiredInteger(ctx.args[1], 'Minutes') : 15;
      session.tempDjHandoff = {
        userId,
        expiresAt: Date.now() + (minutes * 60 * 1000),
      };
      await ctx.reply.success(`DJ controls handed to <@${userId}> for ${minutes} minutes.`);
    },
  }));

  registry.register(createCommand({
    name: 'party',
    description: 'Party battle mode with team scoring.',
    usage: 'party <start|join|vote|status|end> ...',
    async execute(ctx: CommandContextLike) {
      ensureGuild(ctx);
      pruneEphemeralState();
      const action = String(ctx.args[0] ?? 'status').toLowerCase();
      const guildId = String(ctx.guildId);
      const state = partyStates.get(guildId) ?? {
        startedAt: Date.now(),
        teams: { a: new Set(), b: new Set() },
        scores: { a: 0, b: 0 },
        votes: new Set(),
      };

      if (action === 'start') {
        partyStates.set(guildId, {
          startedAt: Date.now(),
          teams: { a: new Set(), b: new Set() },
          scores: { a: 0, b: 0 },
          votes: new Set(),
        });
        await ctx.reply.success('Party battle started. Use `party join <a|b>` and `party vote <a|b>`.');
        return;
      }

      if (action === 'end') {
        partyStates.delete(guildId);
        await ctx.reply.success('Party battle ended.');
        return;
      }

      if (!partyStates.has(guildId)) {
        throw new ValidationError('Party mode is not active. Use `party start`.');
      }

      if (action === 'join') {
        const team = String(ctx.args[1] ?? '').toLowerCase() as 'a' | 'b';
        if (!['a', 'b'].includes(team)) throw new ValidationError('Team must be `a` or `b`.');
        state.teams.a.delete(String(ctx.authorId));
        state.teams.b.delete(String(ctx.authorId));
        state.teams[team].add(String(ctx.authorId));
        partyStates.set(guildId, state);
        await ctx.reply.success(`You joined Team ${team.toUpperCase()}.`);
        return;
      }

      if (action === 'vote') {
        const team = String(ctx.args[1] ?? '').toLowerCase() as 'a' | 'b';
        if (!['a', 'b'].includes(team)) throw new ValidationError('Team must be `a` or `b`.');
        const voteKey = `${ctx.authorId}:${new Date().toISOString().slice(0, 10)}`;
        if (state.votes.has(voteKey)) {
          await ctx.reply.warning('You already voted in this round window.');
          return;
        }
        state.votes.add(voteKey);
        state.scores[team] += 1;
        partyStates.set(guildId, state);
        await ctx.reply.success(`Vote counted for Team ${team.toUpperCase()}.`);
        return;
      }

      if (action === 'status') {
        await ctx.reply.info('Party battle status', [
          { name: 'Team A', value: `${state.scores.a} points`, inline: true },
          { name: 'Team B', value: `${state.scores.b} points`, inline: true },
          { name: 'Members A', value: `${state.teams.a.size}`, inline: true },
          { name: 'Members B', value: `${state.teams.b.size}`, inline: true },
        ]);
        return;
      }

      throw new ValidationError(`Usage: ${ctx.prefix}party <start|join|vote|status|end> ...`);
    },
  }));

  registry.register(createCommand({
    name: 'import',
    description: 'Preview/apply template import with conflict handling.',
    usage: 'import <preview|apply|cancel> ...',
    async execute(ctx: CommandContextLike) {
      ensureGuild(ctx);
      pruneEphemeralState();
      const library = requireLibrary(ctx);
      const action = String(ctx.args[0] ?? '').toLowerCase();

      if (action === 'cancel') {
        pendingImports.delete(pendingImportKey(ctx));
        await ctx.reply.success('Pending import canceled.');
        return;
      }

      if (action === 'preview') {
        const templateName = String(ctx.args[1] ?? '').trim();
        const query = ctx.args.slice(2).join(' ').trim();
        if (!templateName || !query) {
          throw new ValidationError(`Usage: ${ctx.prefix}import preview <template> <query|url>`);
        }

        const session = await ensureConnectedSession(ctx);
        const previewOptions = ctx.config.maxPlaylistTracks == null
          ? { requestedBy: ctx.authorId }
          : { requestedBy: ctx.authorId, limit: ctx.config.maxPlaylistTracks };
        const resolved = await session.player.previewTracks(query, previewOptions);
        if (!resolved.length) {
          await ctx.reply.warning('No tracks resolved for import.');
          return;
        }

        const tpl = await library.getQueueTemplate(ctx.guildId, templateName);
        const existing = new Set((tpl?.tracks ?? []).map((track) => String(track.url).toLowerCase()));
        const conflictCount = resolved.filter((track) => existing.has(String(track.url).toLowerCase())).length;
        pendingImports.set(pendingImportKey(ctx), {
          templateName,
          tracks: resolved,
          createdAt: Date.now(),
        });
        await ctx.reply.info('Import preview ready', [
          { name: 'Template', value: templateName, inline: true },
          { name: 'Resolved', value: String(resolved.length), inline: true },
          { name: 'Conflicts', value: String(conflictCount), inline: true },
          { name: 'Next', value: `Use \`${ctx.prefix}import apply append\` or \`${ctx.prefix}import apply replace\`.` },
        ]);
        return;
      }

      if (action === 'apply') {
        const mode = String(ctx.args[1] ?? 'append').toLowerCase();
        if (!['append', 'replace'].includes(mode)) {
          throw new ValidationError(`Usage: ${ctx.prefix}import apply <append|replace>`);
        }
        const pending = pendingImports.get(pendingImportKey(ctx));
        if (!pending) throw new ValidationError('No pending import. Use `import preview` first.');

        let tracks = pending.tracks;
        if (mode === 'append') {
          const current = await library.getQueueTemplate(ctx.guildId, pending.templateName);
          tracks = [...(current?.tracks ?? []), ...pending.tracks];
        }
        await library.setQueueTemplate(ctx.guildId, pending.templateName, tracks, ctx.authorId);
        pendingImports.delete(pendingImportKey(ctx));
        await ctx.reply.success(`Import applied (${mode}) to template **${pending.templateName}**.`);
        return;
      }

      throw new ValidationError(`Usage: ${ctx.prefix}import <preview|apply|cancel> ...`);
    },
  }));
}

export { MOOD_PRESETS, applyMoodPreset };


