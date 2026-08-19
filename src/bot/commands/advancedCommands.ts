import { ValidationError } from '../../core/errors.ts';
import { createTranslator, type Translator } from '../../i18n/index.ts';
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

function applyMoodPreset(player: SessionLike['player'], presetName: unknown, t?: Translator): MoodPreset {
  const preset = MOOD_PRESETS[String(presetName ?? '').toLowerCase() as keyof typeof MOOD_PRESETS];
  if (!preset) {
    const translate = t ?? createTranslator();
    throw new ValidationError(translate('mood.unknown', { preset: String(presetName ?? '') }));
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

function formatTaste(t: Translator, taste: Array<{ term?: string; count?: number }> | null | undefined, limit: number = 8) {
  if (!Array.isArray(taste) || !taste.length) return t('taste.empty');
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
      ensureDjAccess(ctx, session, 'access.applyMoodPresets');

      const presetName = String(ctx.args[0] ?? '').trim().toLowerCase();
      if (!presetName) {
        await ctx.reply.info(ctx.t('mood.title'), [
          { name: ctx.t('common.available'), value: Object.keys(MOOD_PRESETS).join(', ') },
        ]);
        return;
      }

      const preset = applyMoodPreset(session.player, presetName, ctx.t);
      await ctx.reply.success(ctx.t('mood.applied', { preset: presetName }), [
        { name: ctx.t('effects.filter'), value: preset.filter, inline: true },
        { name: ctx.t('effects.eq'), value: preset.eq, inline: true },
        { name: ctx.t('effects.tempo'), value: `${preset.tempo}x`, inline: true },
      ]);
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
            ? ctx.t('webhook.configured')
            : ctx.t('webhook.disabled')
        );
        return;
      }

      await ensureManageGuildAccess(ctx, 'access.configureWebhooks');
      if (action === 'off') {
        await library.patchGuildFeatureConfig(ctx.guildId, { webhookUrl: null });
        await ctx.reply.success(ctx.t('webhook.turnedOff'));
        return;
      }

      if (action !== 'set') {
        throw new ValidationError(ctx.t('webhook.usage', { prefix: ctx.prefix }));
      }

      const url = String(ctx.args[1] ?? '').trim();
      if (!/^https?:\/\//.test(url)) {
        throw new ValidationError(ctx.t('webhook.invalidUrl'));
      }

      await library.patchGuildFeatureConfig(ctx.guildId, { webhookUrl: url });
      await ctx.reply.success(ctx.t('webhook.saved'));
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
        await ctx.reply.info(ctx.t('queueguard.title'), [
          { name: ctx.t('common.enabled'), value: queueGuard.enabled ? ctx.t('common.on') : ctx.t('common.off'), inline: true },
          { name: ctx.t('queueguard.maxPerWindow'), value: String(queueGuard.maxPerRequesterWindow), inline: true },
          { name: ctx.t('queueguard.windowSize'), value: String(queueGuard.windowSize), inline: true },
          { name: ctx.t('queueguard.maxArtistStreak'), value: String(queueGuard.maxArtistStreak), inline: true },
        ]);
        return;
      }

      await ensureManageGuildAccess(ctx, 'access.configureQueueGuard');
      const next = { ...(cfg.queueGuard ?? {}) };
      if (action === 'on') next.enabled = true;
      else if (action === 'off') next.enabled = false;
      else if (action === 'maxperwindow') next.maxPerRequesterWindow = parseRequiredInteger(ctx.args[1], 'field.value', ctx.t);
      else if (action === 'window') next.windowSize = parseRequiredInteger(ctx.args[1], 'field.value', ctx.t);
      else if (action === 'maxartiststreak') next.maxArtistStreak = parseRequiredInteger(ctx.args[1], 'field.value', ctx.t);
      else throw new ValidationError(ctx.t('queueguard.usage', { prefix: ctx.prefix }));

      await library.patchGuildFeatureConfig(ctx.guildId, { queueGuard: next });
      await ctx.reply.success(ctx.t('queueguard.updated'));
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
          await ctx.reply.warning(ctx.t('template.none'));
          return;
        }
        const lines = templates.map((entry, idx) => `${idx + 1}. ${entry.name} (${entry.tracks.length} tracks)`);
        const pages = chunkLines(lines, 1000);
        if (pages.length === 1) {
          await ctx.reply.info(ctx.t('template.listTitle'), [{ name: ctx.t('template.field'), value: pages[0] ?? '-' }]);
          return;
        }

        await ctx.sendPaginated(pages.map((value, idx) => buildSingleFieldInfoPayload(
          ctx,
          ctx.t('template.listTitlePaged', { current: idx + 1, total: pages.length }),
          '',
          ctx.t('template.field'),
          value
        )));
        return;
      }

      if (action === 'save') {
        const session = getSessionOrThrow(ctx);
        ensureDjAccess(ctx, session, 'access.saveTemplates');
        const name = ctx.args.slice(1).join(' ').trim();
        if (!name) throw new ValidationError(ctx.t('template.usageSave', { prefix: ctx.prefix }));
        const tracks = [session.player.currentTrack, ...session.player.pendingTracks].filter(Boolean);
        if (!tracks.length) throw new ValidationError(ctx.t('template.queueEmpty'));
        const saved = await library.setQueueTemplate(ctx.guildId, name, tracks, ctx.authorId);
        await ctx.reply.success(ctx.t('template.saved', { name: saved.name, count: saved.tracks.length }));
        return;
      }

      if (action === 'delete') {
        await ensureManageGuildAccess(ctx, 'access.deleteTemplates');
        const name = ctx.args.slice(1).join(' ').trim();
        if (!name) throw new ValidationError(ctx.t('template.usageDelete', { prefix: ctx.prefix }));
        const removed = await library.deleteQueueTemplate(ctx.guildId, name);
        if (!removed) {
          await ctx.reply.warning(ctx.t('template.notFound'));
          return;
        }
        await ctx.reply.success(ctx.t('template.deleted'));
        return;
      }

      if (action === 'show') {
        const name = ctx.args.slice(1).join(' ').trim();
        if (!name) throw new ValidationError(ctx.t('template.usageShow', { prefix: ctx.prefix }));
        const tpl = await library.getQueueTemplate(ctx.guildId, name);
        if (!tpl) {
          await ctx.reply.warning(ctx.t('template.notFound'));
          return;
        }
        const lines = tpl.tracks.map((track, idx) => `${idx + 1}. ${trackLabel(track)}`);
        const pages = chunkLines(lines, 1000);
        if (pages.length === 1) {
          await ctx.reply.info(ctx.t('template.showTitle', { name: tpl.name }), [{ name: ctx.t('common.tracks'), value: pages[0] ?? '-' }]);
          return;
        }

        await ctx.sendPaginated(pages.map((value, idx) => buildSingleFieldInfoPayload(
          ctx,
          ctx.t('template.showTitlePaged', { name: tpl.name, current: idx + 1, total: pages.length }),
          '',
          ctx.t('common.tracks'),
          value
        )));
        return;
      }

      if (action === 'play') {
        const name = ctx.args.slice(1).join(' ').trim();
        if (!name) throw new ValidationError(ctx.t('template.usagePlay', { prefix: ctx.prefix }));
        const tpl = await library.getQueueTemplate(ctx.guildId, name);
        if (!tpl) throw new ValidationError(ctx.t('template.notFound'));
        const session = await ensureConnectedSession(ctx);
        const tracks = tpl.tracks.map((track) => session.player.createTrackFromData(track, ctx.authorId));
        const features = await library.getGuildFeatureConfig(ctx.guildId);
        const added = session.player.enqueueResolvedTracks(tracks, {
          dedupe: session.settings.dedupeEnabled,
          queueGuard: features.queueGuard,
        });
        if (!added.length) {
          await ctx.reply.warning(ctx.t('template.noneAdded'));
          return;
        }
        if (!session.player.playing) await session.player.play();
        await ctx.reply.success(ctx.t('template.queued', { name: tpl.name, count: added.length }));
        return;
      }

      throw new ValidationError(ctx.t('template.usage', { prefix: ctx.prefix }));
    },
  }));

  registry.register(createCommand({
    name: 'charts',
    description: 'Show top played tracks in this guild.',
    usage: 'charts [days]',
    async execute(ctx: CommandContextLike) {
      ensureGuild(ctx);
      const library = requireLibrary(ctx);
      const days = ctx.args[0] ? parseRequiredInteger(ctx.args[0], 'field.days', ctx.t) : 7;
      const top = await library.getGuildTopTracks(ctx.guildId, days, 10);
      if (!top.length) {
        await ctx.reply.warning(ctx.t('charts.empty'));
        return;
      }
      const lines = top.map((entry, idx) => `${idx + 1}. ${entry.title} (${entry.plays})`);
      const pages = chunkLines(lines, 1000);
      if (pages.length === 1) {
        await ctx.reply.info(ctx.t('charts.title', { days }), [{ name: ctx.t('common.tracks'), value: pages[0] ?? '-' }]);
        return;
      }

      await ctx.sendPaginated(pages.map((value, idx) => buildSingleFieldInfoPayload(
        ctx,
        ctx.t('charts.titlePaged', { days, current: idx + 1, total: pages.length }),
        '',
        ctx.t('common.tracks'),
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
        await ctx.reply.info(ctx.t('recap.statusTitle'), [
          { name: ctx.t('recap.channel'), value: cfg.recapChannelId ? `<#${cfg.recapChannelId}>` : ctx.t('common.disabledLower') },
          { name: ctx.t('recap.lastSent'), value: state.lastWeeklyRecapAt ? String(state.lastWeeklyRecapAt) : ctx.t('recap.never') },
        ]);
        return;
      }

      if (action === 'now') {
        const recap = await library.buildGuildRecap(ctx.guildId, 7);
        const tracks = chunkLines(
          recap.topTracks.slice(0, 5).map((entry, idx) => `${idx + 1}. ${entry.title} (${entry.plays})`),
          1000
        )[0] || ctx.t('common.noData');
        const req = chunkLines(
          recap.topRequesters.slice(0, 5).map((entry, idx) => `${idx + 1}. <@${entry.userId}> (${entry.plays})`),
          1000
        )[0] || ctx.t('common.noData');
        await ctx.reply.info(ctx.t('recap.previewTitle'), [
          { name: ctx.t('recap.totalPlays'), value: String(recap.playCount), inline: true },
          { name: ctx.t('recap.topTracks'), value: tracks },
          { name: ctx.t('recap.topRequesters'), value: req },
        ]);
        return;
      }

      await ensureManageGuildAccess(ctx, 'access.configureRecap');
      if (action === 'off') {
        await library.patchGuildFeatureConfig(ctx.guildId, { recapChannelId: null });
        await ctx.reply.success(ctx.t('recap.disabled'));
        return;
      }

      if (action !== 'set') {
        throw new ValidationError(ctx.t('recap.usage', { prefix: ctx.prefix }));
      }
      const channelId = parseTextChannelId(ctx.args[1] ?? null) ?? parseChannelId(ctx.args[1], null);
      if (!channelId) throw new ValidationError(ctx.t('errors.provideChannel'));
      await library.patchGuildFeatureConfig(ctx.guildId, { recapChannelId: channelId });
      await ctx.reply.success(ctx.t('recap.channelSet', { channel: `<#${channelId}>` }));
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
        if (!targetChannel) throw new ValidationError(ctx.t('errors.provideOrJoinChannel'));
        const profile = await library.getVoiceProfile(ctx.guildId, targetChannel);
        if (!profile) {
          await ctx.reply.warning(ctx.t('voiceprofile.none'));
          return;
        }
        await ctx.reply.info(ctx.t('voiceprofile.title', { channel: `<#${targetChannel}>` }), [
          { name: ctx.t('voiceprofile.mood'), value: profile.moodPreset ?? ctx.t('common.noneLower'), inline: true },
        ]);
        return;
      }

      await ensureManageGuildAccess(ctx, 'access.configureVoiceProfiles');
      const targetChannel = channelId ?? ctx.voiceStateStore.resolveMemberVoiceChannel(ctx.message);
      if (!targetChannel) throw new ValidationError(ctx.t('errors.provideOrJoinChannel'));

      if (action === 'clear') {
        await library.setVoiceProfile(ctx.guildId, targetChannel, { moodPreset: null });
        await ctx.reply.success(ctx.t('voiceprofile.cleared', { channel: `<#${targetChannel}>` }));
        return;
      }

      if (action !== 'set') {
        throw new ValidationError(ctx.t('voiceprofile.usage', { prefix: ctx.prefix }));
      }

      const mood = String(ctx.args[2] ?? '').trim().toLowerCase();
      if (!MOOD_PRESETS[mood]) {
        throw new ValidationError(ctx.t('mood.unknownAvailable', { presets: Object.keys(MOOD_PRESETS).join(', ') }));
      }
      await library.setVoiceProfile(ctx.guildId, targetChannel, { moodPreset: mood });
      await ctx.reply.success(ctx.t('voiceprofile.set', { channel: `<#${targetChannel}>`, mood }));
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
      if (!userId) throw new ValidationError(ctx.t('errors.userIdUnresolved'));
      const profile = await library.getUserProfile(userId, ctx.guildId);
      const stats = profile.guildStats ?? { plays: 0, skips: 0, favorites: 0, score: 0 };
      await ctx.reply.info(ctx.t('reputation.title', { user: `<@${userId}>` }), [
        { name: ctx.t('reputation.score'), value: String(stats.score ?? 0), inline: true },
        { name: ctx.t('reputation.plays'), value: String(stats.plays ?? 0), inline: true },
        { name: ctx.t('reputation.skips'), value: String(stats.skips ?? 0), inline: true },
        { name: ctx.t('reputation.favorites'), value: String(stats.favorites ?? 0), inline: true },
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
      if (!userId) throw new ValidationError(ctx.t('errors.userIdUnresolved'));
      const profile = await library.getUserProfile(userId, ctx.guildId);
      await ctx.reply.info(ctx.t('taste.title', { user: `<@${userId}>` }), [
        { name: ctx.t('taste.topTerms'), value: formatTaste(ctx.t, profile.taste) },
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
      await ensureManageGuildAccess(ctx, 'access.configureHandoff');

      const mode = String(ctx.args[0] ?? 'show').trim().toLowerCase();
      if (mode === 'show') {
        const handoff = session.tempDjHandoff ?? null;
        if (!handoff || handoff.expiresAt <= Date.now()) {
          await ctx.reply.info(ctx.t('handoff.none'));
          return;
        }
        await ctx.reply.info(ctx.t('handoff.active', { user: `<@${handoff.userId}>` }), [
          { name: ctx.t('handoff.expires'), value: new Date(handoff.expiresAt).toISOString() },
        ]);
        return;
      }

      if (mode === 'off') {
        session.tempDjHandoff = null;
        await ctx.reply.success(ctx.t('handoff.cleared'));
        return;
      }

      const userId = parseUserId(mode, null);
      if (!userId) throw new ValidationError(ctx.t('handoff.usage'));
      const minutes = ctx.args[1] ? parseRequiredInteger(ctx.args[1], 'field.minutes', ctx.t) : 15;
      session.tempDjHandoff = {
        userId,
        expiresAt: Date.now() + (minutes * 60 * 1000),
      };
      await ctx.reply.success(ctx.t('handoff.granted', { user: `<@${userId}>`, minutes }));
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
        await ctx.reply.success(ctx.t('party.started'));
        return;
      }

      if (action === 'end') {
        partyStates.delete(guildId);
        await ctx.reply.success(ctx.t('party.ended'));
        return;
      }

      if (!partyStates.has(guildId)) {
        throw new ValidationError(ctx.t('party.notActive'));
      }

      if (action === 'join') {
        const team = String(ctx.args[1] ?? '').toLowerCase() as 'a' | 'b';
        if (!['a', 'b'].includes(team)) throw new ValidationError(ctx.t('party.invalidTeam'));
        state.teams.a.delete(String(ctx.authorId));
        state.teams.b.delete(String(ctx.authorId));
        state.teams[team].add(String(ctx.authorId));
        partyStates.set(guildId, state);
        await ctx.reply.success(ctx.t('party.joined', { team: team.toUpperCase() }));
        return;
      }

      if (action === 'vote') {
        const team = String(ctx.args[1] ?? '').toLowerCase() as 'a' | 'b';
        if (!['a', 'b'].includes(team)) throw new ValidationError(ctx.t('party.invalidTeam'));
        const voteKey = `${ctx.authorId}:${new Date().toISOString().slice(0, 10)}`;
        if (state.votes.has(voteKey)) {
          await ctx.reply.warning(ctx.t('party.alreadyVoted'));
          return;
        }
        state.votes.add(voteKey);
        state.scores[team] += 1;
        partyStates.set(guildId, state);
        await ctx.reply.success(ctx.t('party.voteCounted', { team: team.toUpperCase() }));
        return;
      }

      if (action === 'status') {
        await ctx.reply.info(ctx.t('party.statusTitle'), [
          { name: ctx.t('party.teamA'), value: ctx.t('party.points', { count: state.scores.a }), inline: true },
          { name: ctx.t('party.teamB'), value: ctx.t('party.points', { count: state.scores.b }), inline: true },
          { name: ctx.t('party.membersA'), value: `${state.teams.a.size}`, inline: true },
          { name: ctx.t('party.membersB'), value: `${state.teams.b.size}`, inline: true },
        ]);
        return;
      }

      throw new ValidationError(ctx.t('party.usage', { prefix: ctx.prefix }));
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
        await ctx.reply.success(ctx.t('import.canceled'));
        return;
      }

      if (action === 'preview') {
        const templateName = String(ctx.args[1] ?? '').trim();
        const query = ctx.args.slice(2).join(' ').trim();
        if (!templateName || !query) {
          throw new ValidationError(ctx.t('import.usagePreview', { prefix: ctx.prefix }));
        }

        const session = await ensureConnectedSession(ctx);
        const previewOptions = ctx.config.maxPlaylistTracks == null
          ? { requestedBy: ctx.authorId }
          : { requestedBy: ctx.authorId, limit: ctx.config.maxPlaylistTracks };
        const resolved = await session.player.previewTracks(query, previewOptions);
        if (!resolved.length) {
          await ctx.reply.warning(ctx.t('import.noneResolved'));
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
        await ctx.reply.info(ctx.t('import.previewTitle'), [
          { name: ctx.t('import.template'), value: templateName, inline: true },
          { name: ctx.t('import.resolved'), value: String(resolved.length), inline: true },
          { name: ctx.t('import.conflicts'), value: String(conflictCount), inline: true },
          { name: ctx.t('import.next'), value: ctx.t('import.nextHint', { prefix: ctx.prefix }) },
        ]);
        return;
      }

      if (action === 'apply') {
        const mode = String(ctx.args[1] ?? 'append').toLowerCase();
        if (!['append', 'replace'].includes(mode)) {
          throw new ValidationError(ctx.t('import.usageApply', { prefix: ctx.prefix }));
        }
        const pending = pendingImports.get(pendingImportKey(ctx));
        if (!pending) throw new ValidationError(ctx.t('import.noPending'));

        let tracks = pending.tracks;
        if (mode === 'append') {
          const current = await library.getQueueTemplate(ctx.guildId, pending.templateName);
          tracks = [...(current?.tracks ?? []), ...pending.tracks];
        }
        await library.setQueueTemplate(ctx.guildId, pending.templateName, tracks, ctx.authorId);
        pendingImports.delete(pendingImportKey(ctx));
        await ctx.reply.success(ctx.t('import.applied', { mode, name: pending.templateName }));
        return;
      }

      throw new ValidationError(ctx.t('import.usage', { prefix: ctx.prefix }));
    },
  }));
}

export { MOOD_PRESETS, applyMoodPreset };


