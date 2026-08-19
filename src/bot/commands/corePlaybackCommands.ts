import { ValidationError } from '../../core/errors.ts';
import {
  HISTORY_PAGE_SIZE,
  PENDING_PAGE_SIZE,
  SEARCH_RESULT_DEFAULT_LIMIT,
  SUPPORT_SERVER_URL,
  createCommand,
  buildHelpPages,
  parseVoiceChannelArgument,
  ensureGuild,
  prepareSessionConnection,
  connectPreparedSession,
  ensureConnectedSession,
  ensureDjAccess,
  userHasDjAccess,
  enforcePlayCooldown,
  applyVoiceProfileIfConfigured,
  resolveQueueGuard,
  trackLabel,
  trackLabelWithLink,
  buildTrackAuthor,
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
} from './commandHelpers.ts';
import { buildEmbed, sourceColor } from '../messageFormatter.ts';
import type { Translator } from '../../i18n/index.ts';
import {
  buildInfoPayload,
  createProgressReporter,
  withCommandReplyReference,
} from './responseUtils.ts';
import {
  listAvailableRadioStations,
  pickRandomRadioStation,
  resolveRadioStationIndexSelection,
  resolveRadioStationSelection,
  type ResolvedRadioStation,
} from './helpers/radioStations.ts';
import { detectRadioNowPlaying } from './helpers/radioNowPlaying.ts';
import type { CommandRegistry } from '../commandRegistry.ts';
import type { EmbedField, MessagePayload } from '../../types/core.ts';
import type { CommandContextLike, SessionLike, TrackDataLike } from './helpers/types.ts';
import { buildCommandUsage, buildHelpPayload } from './helpers/formatting.ts';

const RADIO_RECOGNITION_SUPPORT_FOOTER = 'Radio recognition costs money to run. Support: https://ko-fi.com/Q5Q31VDH1Z';
const DIRECT_YOUTUBE_METADATA_GRACE_MS = 150;
const DIRECT_YOUTUBE_MESSAGE_GRACE_MS = 500;

type SearchTrack = { title?: string | null; duration?: string | null; thumbnailUrl?: string | null };
type SentMessageLike = { id?: string | null; message?: { id?: string | null } | null };
type GatewayLike = {
  getHeartbeatLatencyMs?: () => number | null;
  sampleHeartbeatLatency?: (timeoutMs?: number) => Promise<number | null>;
  heartbeatLatencyMs?: number | null;
} | null | undefined;
type PlaybackCommandContext = CommandContextLike & {
  gateway?: GatewayLike;
  rest: NonNullable<CommandContextLike['rest']>;
  logger?: { debug?: (message: string, meta?: Record<string, unknown>) => void } | null;
  library?: CommandContextLike['library'] & {
    getLastGuildHistoryTrack?: (guildId: string) => Promise<TrackDataLike | null>;
  };
  withGuildOpLock: (label: string, task: () => Promise<void>) => Promise<void>;
  safeTyping: () => Promise<unknown>;
  registerHelpPagination?: (channelId: string, messageId: string, pages: MessagePayload[], index?: number) => Promise<unknown>;
  registerSearchReactionSelection?: (messageId: string, results: TrackDataLike[], ttlMs: number) => Promise<unknown>;
  sessions: CommandContextLike['sessions'] & {
    markSnapshotDirty?: (session: unknown, flushSoon?: boolean) => void;
    registerVoteSkip?: (
      guildId: string,
      userId: string,
      selector?: { sessionId?: string | null } | null
    ) => { added: boolean; votes: number } | null;
    clearVoteSkips?: (guildId: string, selector?: { sessionId?: string | null } | null) => void;
  };
};

function isYouTubeMixPlaceholderTrack(track: TrackDataLike | null | undefined) {
  return String(track?.source ?? '').trim().toLowerCase() === 'youtube'
    && String(track?.title ?? '').trim() === 'YouTube Mix Track'
    && String(track?.duration ?? '').trim().toLowerCase() === 'unknown';
}

function toCanonicalYouTubeWatchUrlFromValue(value: string | null | undefined) {
  try {
    const parsed = new URL(String(value ?? ''));
    const host = parsed.hostname.toLowerCase();
    const isYouTubeHost = host === 'youtube.com' || host.endsWith('.youtube.com');
    if (!isYouTubeHost && host !== 'youtu.be') return null;

    if (host === 'youtu.be') {
      const segment = String(parsed.pathname ?? '').split('/').filter(Boolean)[0];
      return segment ? `https://www.youtube.com/watch?v=${encodeURIComponent(segment.trim())}` : null;
    }

    const videoId = String(parsed.searchParams.get('v') ?? '').trim();
    return videoId ? `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}` : null;
  } catch {
    return null;
  }
}

function splitMultiUrlQuery(query: string): string[] | null {
  const tokens = String(query ?? '').trim().split(/\s+/).filter(Boolean);
  if (tokens.length < 2) return null;

  const urls: string[] = [];
  for (const token of tokens) {
    try {
      const parsed = new URL(token);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
      urls.push(token);
    } catch {
      return null;
    }
  }
  return urls;
}

async function enqueueAdditionalUrls(
  session: SessionLike,
  urls: string[],
  requestedBy: string | null,
  options: { dedupe: unknown; queueGuard: unknown; limit: number | null },
): Promise<void> {
  for (const url of urls) {
    try {
      const preview = await session.player.previewTracks(url, {
        requestedBy,
        ...(options.limit != null ? { limit: options.limit } : {}),
      });
      if (!preview.length) continue;

      const tracks = preview.map((track) => session.player.createTrackFromData(track, requestedBy));
      session.player.enqueueResolvedTracks(tracks, {
        dedupe: options.dedupe,
        queueGuard: options.queueGuard,
        playNext: false,
      });
    } catch {
    }
  }
}

function buildDeferredDirectYouTubeTrack(query: string, requestedBy: string | null): TrackDataLike | null {
  const watchUrl = toCanonicalYouTubeWatchUrlFromValue(query);
  if (!watchUrl) return null;

  return {
    title: 'YouTube Track',
    url: watchUrl,
    duration: 'Unknown',
    requestedBy,
    source: 'youtube',
    metadataDeferred: true,
  };
}

function normalizeRadioMatchValue(value: unknown): string {
  return String(value ?? '').trim().toLowerCase();
}

function isSameRadioSelection(
  track: TrackDataLike | null | undefined,
  station: Pick<ResolvedRadioStation, 'name' | 'url'> | null | undefined,
): boolean {
  if (!track || !station) return false;
  if (String(track.source ?? '').trim().toLowerCase() !== 'radio-stream') return false;

  const trackUrl = normalizeRadioMatchValue(track.url);
  const stationUrl = normalizeRadioMatchValue(station.url);
  if (trackUrl && stationUrl && trackUrl === stationUrl) return true;

  const trackTitle = normalizeRadioMatchValue(track.title);
  const stationName = normalizeRadioMatchValue(station.name);
  return Boolean(trackTitle && stationName && trackTitle === stationName);
}

function isDeferredTrackMetadata(track: TrackDataLike | null | undefined) {
  return track?.metadataDeferred === true;
}

function buildDeferredPlaybackStatusText(t: Translator, options: {
  shouldInterruptLivePlayback: boolean;
  addedCount: number;
  isPlaylistLoad: boolean;
}) {
  const { shouldInterruptLivePlayback, addedCount, isPlaylistLoad } = options;
  if (isPlaylistLoad && addedCount > 1) {
    return shouldInterruptLivePlayback
      ? t('play.status.deferredPlaylistInterrupted')
      : t('play.status.deferredPlaylist');
  }

  return shouldInterruptLivePlayback
    ? t('play.status.deferredInterrupted')
    : t('play.status.deferred');
}

function buildResolvedPlaybackStatusText(t: Translator, options: {
  shouldInterruptLivePlayback: boolean;
  addedCount: number;
  firstTrack: TrackDataLike;
}) {
  const { shouldInterruptLivePlayback, addedCount, firstTrack } = options;
  if (shouldInterruptLivePlayback && addedCount === 1) {
    return t('play.status.interruptedNowPlaying', { track: trackLabel(firstTrack) });
  }
  if (shouldInterruptLivePlayback) {
    return t('play.status.interruptedQueued', { count: addedCount });
  }
  if (addedCount === 1) {
    return t('play.status.added', { track: trackLabel(firstTrack) });
  }
  return t('play.status.addedPlaylist', { count: addedCount });
}

function wait(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitForDeferredTrackMessageMetadata(
  track: TrackDataLike | null | undefined,
  hydrationPromise: Promise<TrackDataLike | null> | null,
) {
  if (!track || !hydrationPromise || track.metadataDeferred !== true) return null;
  const hydrated = await Promise.race<TrackDataLike | null>([
    hydrationPromise,
    wait(DIRECT_YOUTUBE_MESSAGE_GRACE_MS).then(() => null),
  ]);
  return hydrateDeferredTrackMetadata(track, hydrated);
}

async function finalizeDeferredPlaybackStatus(
  t: Translator,
  progress: {
    success: (text: string, fields?: EmbedField[] | null) => Promise<unknown>;
  },
  options: {
    shouldInterruptLivePlayback: boolean;
    addedCount: number;
    firstTrack: TrackDataLike;
  },
) {
  const { shouldInterruptLivePlayback, addedCount, firstTrack } = options;
  const text = buildResolvedPlaybackStatusText(t, { shouldInterruptLivePlayback, addedCount, firstTrack });

  if (addedCount > 1) {
    await progress.success(text, [{ name: t('play.field.firstTrack'), value: trackLabel(firstTrack) }]);
    return;
  }

  await progress.success(text);
}

async function hydrateFirstYouTubeMixTrack(
  player: SessionLike['player'],
  track: TrackDataLike | null | undefined,
  requestedBy: string | null,
) {
  if (!track) return null;
  if (!isYouTubeMixPlaceholderTrack(track)) return null;
  const targetTrack = track;

  const watchUrl = toCanonicalYouTubeWatchUrlFromValue(String(targetTrack.url ?? '').trim());
  if (!watchUrl) return null;

  const resolved = await player.previewTracks(watchUrl, { requestedBy, limit: 1 }).catch(() => []);
  const hydrated = resolved[0] ? player.createTrackFromData(resolved[0], requestedBy) : null;
  if (!hydrated) return null;

  const preservedId = targetTrack.id ?? null;
  const preservedQueuedAt = targetTrack.queuedAt ?? null;
  Object.assign(targetTrack, hydrated);
  if (preservedId) targetTrack.id = preservedId;
  if (typeof preservedQueuedAt === 'number') targetTrack.queuedAt = preservedQueuedAt;
  return targetTrack;
}

async function hydrateDeferredTrackMetadata(
  track: TrackDataLike | null | undefined,
  hydrated: TrackDataLike | null | undefined,
) {
  if (!track || !hydrated) return null;

  const targetTrack = track;
  const preservedId = targetTrack.id ?? null;
  const preservedQueuedAt = targetTrack.queuedAt ?? null;
  const preservedRequestedBy = targetTrack.requestedBy ?? hydrated.requestedBy ?? null;
  const preservedSeekStartSec = Number.parseInt(String(targetTrack.seekStartSec ?? 0), 10) || 0;

  Object.assign(targetTrack, hydrated);
  if (preservedId) targetTrack.id = preservedId;
  if (typeof preservedQueuedAt === 'number') targetTrack.queuedAt = preservedQueuedAt;
  if (preservedRequestedBy) targetTrack.requestedBy = preservedRequestedBy;
  targetTrack.seekStartSec = preservedSeekStartSec;
  delete targetTrack.metadataDeferred;
  return targetTrack;
}

async function resolveAndHydrateDeferredTrackMetadata(
  player: SessionLike['player'],
  track: TrackDataLike | null | undefined,
  requestedBy: string | null,
) {
  if (!track) return null;
  const hydrated = await player.hydrateTrackMetadata?.(track, { requestedBy }).catch(() => null);
  return hydrateDeferredTrackMetadata(track, hydrated);
}

async function prepareTracksForPlaybackStart(
  player: SessionLike['player'],
  preview: TrackDataLike[],
  requestedBy: string | null,
  options: { prefetchFirstTrack?: boolean } = { prefetchFirstTrack: false },
) {
  const tracks = preview.map((track: TrackDataLike) => player.createTrackFromData(track, requestedBy));
  const firstTrack = tracks[0] ?? null;
  const firstTrackHydrationPromise = isYouTubeMixPlaceholderTrack(firstTrack)
    ? hydrateFirstYouTubeMixTrack(player, firstTrack, requestedBy).catch(() => null)
    : null;
  if (options.prefetchFirstTrack && firstTrack) {
    await player.prefetchTrackPlayback?.(firstTrack).catch(() => null);
  }
  return { tracks, firstTrackHydrationPromise };
}

function resolveGatewayLatencyMs(gateway: GatewayLike) {
  if (!gateway) return null;

  if (typeof gateway.getHeartbeatLatencyMs === 'function') {
    const fromMethod = gateway.getHeartbeatLatencyMs();
    if (fromMethod != null && Number.isFinite(fromMethod) && fromMethod >= 0) {
      return Math.round(fromMethod);
    }
  }

  const fromProperty = gateway.heartbeatLatencyMs;
  if (fromProperty != null && Number.isFinite(fromProperty) && fromProperty >= 0) {
    return Math.round(fromProperty);
  }

  return null;
}

function buildPingPayload(ctx: CommandContextLike, fields: EmbedField[]): MessagePayload {
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

function toSearchSelectionContext(ctx: PlaybackCommandContext) {
  return {
    guildId: ctx.guildId,
    authorId: ctx.authorId,
    config: {
      ...(typeof ctx.config.searchPickTimeoutMs === 'number'
        ? { searchPickTimeoutMs: ctx.config.searchPickTimeoutMs }
        : {}),
    },
  };
}

function formatSearchResultLine(track: SearchTrack, index: number) {
  const title = String(track?.title ?? 'Unknown title').trim() || 'Unknown title';
  const shortTitle = title.length > 72 ? `${title.slice(0, 69)}...` : title;
  const duration = String(track?.duration ?? 'Unknown');
  return `${index}. **${shortTitle}** (${duration})`;
}

function formatRadioStationSummary(station: ResolvedRadioStation, index: number) {
  const scope = station.scope === 'guild' ? 'Guild' : 'Built-in';
  const tags = station.tags.length ? ` - ${station.tags.join(', ')}` : '';
  return `${index}. **${station.name}** [${scope}]${tags}`;
}

function isLikelyPlaylistLoad(query: string) {
  const normalized = String(query ?? '').trim().toLowerCase();
  if (!/^https?:\/\//.test(normalized)) return false;
  return (
    normalized.includes('list=')
    || /open\.spotify\.com\/(playlist|album|artist)\//.test(normalized)
    || /deezer\.com\/.+\/(playlist|album)\//.test(normalized)
    || /soundcloud\.com\/.+\/sets\//.test(normalized)
    || /music\.apple\.com\/.+\/(album|playlist)\//.test(normalized)
    || /music\.amazon\.[^/]+\/.+\/(albums|playlists|artists)\//.test(normalized)
  );
}

function buildTrackIdentity(track: TrackDataLike | null | undefined) {
  const source = String(track?.source ?? '').trim().toLowerCase();
  const url = String(track?.url ?? '').trim().toLowerCase();
  const title = String(track?.title ?? '').trim().toLowerCase();
  const artist = String(track?.artist ?? '').trim().toLowerCase();
  return [source, url, title, artist].join('::');
}

function removeFirstMatchingTrack(tracks: TrackDataLike[], needle: TrackDataLike | null | undefined) {
  const target = buildTrackIdentity(needle);
  let removed = false;
  const filtered = tracks.filter((track) => {
    if (removed) return true;
    if (buildTrackIdentity(track) !== target) return true;
    removed = true;
    return false;
  });
  if (!removed && needle && tracks.length) {
    return tracks.slice(1);
  }
  return filtered;
}

async function enqueueTracksUntilFull(
  player: SessionLike['player'],
  tracks: TrackDataLike[],
  options: { dedupe?: boolean; playNext?: boolean; queueGuard?: unknown },
  onProgress?: ((state: { addedCount: number; totalCount: number; queueLimitReached: boolean }) => Promise<void> | void) | null
) {
  const added: TrackDataLike[] = [];
  let queueLimitReached = false;
  let lastReportedCount = 0;
  const totalCount = tracks.length;

  for (const track of tracks) {
    try {
      const next = player.enqueueResolvedTracks([track], options);
      if (next.length) {
        added.push(...next);
      }
    } catch (err) {
      if (err instanceof ValidationError && /Queue limit exceeded/i.test(err.message)) {
        queueLimitReached = true;
        if (onProgress) {
          await onProgress({ addedCount: added.length, totalCount, queueLimitReached });
        }
        break;
      }
      throw err;
    }

    if (onProgress) {
      const shouldReport =
        added.length === totalCount
        || added.length === 1
        || added.length >= (lastReportedCount + 5);
      if (shouldReport) {
        lastReportedCount = added.length;
        await onProgress({ addedCount: added.length, totalCount, queueLimitReached: false });
      }
    }
  }

  return { added, queueLimitReached };
}

export function registerCorePlaybackCommands(registry: CommandRegistry) {
  registry.register(createCommand({
    name: 'help',
    aliases: ['h'],
    description: 'Show usage for a command or for all available commands.',
    usage: 'help [command|page_number]',
    async execute(ctx: PlaybackCommandContext) {
      if (!ctx.rest?.sendMessage) {
        throw new ValidationError(ctx.t('errors.restUnavailable'));
      }

      const { args } = ctx;
      if (args.length === 0) {
        // if no arguments specified, print all pages
        const pages = buildHelpPages({ prefix: ctx.prefix, registry });
        const first = await ctx.rest.sendMessage(ctx.channelId, withCommandReplyReference(ctx, pages[0]!)) as SentMessageLike | null;
        const messageId = first?.id ?? first?.message?.id ?? null;
        if (messageId && ctx.registerHelpPagination) {
          await ctx.registerHelpPagination(ctx.channelId, messageId, pages);
        }
        return;
      }

      // if argument is specified, print single entry
      const arg = args[0]!.toLowerCase();

      if (/^\d+$/.test(arg)) {
        const pages = buildHelpPages({ prefix: ctx.prefix, registry });

        // `- 1` as help pages are one-indexed
        const pageIndex = parseInt(arg) - 1;
        if (!isNaN(pageIndex)) {
          if (pageIndex in pages) {
            const sentMessage = await ctx.rest.sendMessage(ctx.channelId, withCommandReplyReference(ctx, pages[pageIndex]!)) as SentMessageLike | null;
            const messageId = sentMessage?.id ?? sentMessage?.message?.id ?? null;
            if (messageId && ctx.registerHelpPagination) {
              await ctx.registerHelpPagination(ctx.channelId, messageId, pages, pageIndex);
            }

            return;
          }
        }

        await ctx.reply.error(ctx.t('help.unknownPage', { page: arg, max: pages.length }));
        return;
      }

      // will only acknowledge the first argument
      const command = registry.list().find(cmd => [cmd.name, ...(cmd.aliases ?? Array<string>())].includes(arg));
      if (!command) {
        await ctx.reply.error(ctx.t('help.unknownCommand', { command: arg }));
        return;
      }

      await ctx.rest.sendMessage(
        ctx.channelId,
        withCommandReplyReference(
          ctx,
          buildHelpPayload({
            title: ctx.t('help.title'),
            description: buildCommandUsage({ prefix: ctx.prefix, command }),
          })
        )
      );
    },
  }));

  registry.register(createCommand({
    name: 'support',
    aliases: ['discord', 'server'],
    description: 'Get the support server invite link.',
    usage: 'support',
    async execute(ctx: PlaybackCommandContext) {
      await ctx.reply.info(ctx.t('support.title'), [
        { name: ctx.t('support.invite'), value: SUPPORT_SERVER_URL },
      ]);
    },
  }));

  registry.register(createCommand({
    name: 'ping',
    description: 'Show current latency.',
    usage: 'ping',
    async execute(ctx: PlaybackCommandContext) {
      const rest = ctx.rest;
      if (!rest?.sendMessage || !rest?.editMessage) {
        throw new ValidationError(ctx.t('errors.restUnavailable'));
      }

      const canMeasure =
        Boolean(ctx.channelId)
        && typeof rest.sendMessage === 'function'
        && typeof rest.editMessage === 'function';

      if (!canMeasure) {
        const gatewayLatencyMs = resolveGatewayLatencyMs(ctx.gateway);
        await ctx.reply.success(ctx.t('ping.pong'), [
          { name: ctx.t('ping.roundTrip'), value: ctx.t('common.notAvailable'), inline: true },
          { name: ctx.t('ping.gateway'), value: gatewayLatencyMs == null ? ctx.t('common.notAvailable') : `${gatewayLatencyMs}ms`, inline: true },
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
      const probeMessage = await rest.sendMessage(
        ctx.channelId,
        withCommandReplyReference(ctx, { content: ctx.t('ping.pinging') })
      ) as SentMessageLike | null;
      const roundTripMs = Math.max(0, Date.now() - roundTripStartedAt);
      const gatewayLatencyMs = await gatewayLatencyPromise;

      const fields = [
        { name: ctx.t('ping.roundTrip'), value: `${roundTripMs}ms`, inline: true },
        { name: ctx.t('ping.gateway'), value: gatewayLatencyMs == null ? ctx.t('common.notAvailable') : `${Math.round(gatewayLatencyMs)}ms`, inline: true },
      ];
      const payload = buildPingPayload(ctx, fields);
      const messageId = probeMessage?.id ?? probeMessage?.message?.id ?? null;

      if (messageId) {
        try {
          await rest.editMessage(ctx.channelId, messageId, payload);
          return;
        } catch {
          // Fall back to regular reply if edit fails.
        }
      }

      await ctx.reply.success(ctx.t('ping.pong'), fields);
    },
  }));

  registry.register(createCommand({
    name: 'join',
    aliases: ['summon'],
    description: 'Join your voice channel (or a specified channel).',
    usage: 'join [#voice-channel]',
    async execute(ctx: PlaybackCommandContext) {
      ensureGuild(ctx);

      const { channelId: explicitChannelId } = parseVoiceChannelArgument(ctx.args);
      const session = await ensureConnectedSession(ctx, explicitChannelId);
      const connectedChannelId = session?.connection?.channelId ?? explicitChannelId ?? ctx.activeVoiceChannelId;

      await ctx.reply.success(
        connectedChannelId
          ? ctx.t('join.connectedTo', { channel: `<#${connectedChannelId}>` })
          : ctx.t('join.connected')
      );
    },
  }));

  registry.register(createCommand({
    name: 'leave',
    aliases: ['disconnect', 'dc', 'stop'],
    description: 'Stop playback, clear queue, and leave voice.',
    usage: 'leave',
    async execute(ctx: PlaybackCommandContext) {
      ensureGuild(ctx);
      const existing = ctx.sessions.get(ctx.guildId, {
        voiceChannelId: ctx.activeVoiceChannelId,
        textChannelId: ctx.channelId,
      });
      if (existing) {
        ensureDjAccess(ctx, existing, 'access.disconnectBot');
      }
      const removed = await ctx.sessions.destroy(ctx.guildId, 'manual_command', {
        sessionId: existing?.sessionId,
        voiceChannelId: existing?.connection?.channelId ?? ctx.activeVoiceChannelId,
      });
      if (!removed) {
        await ctx.reply.warning(ctx.t('errors.noActivePlayer'));
        return;
      }

      await ctx.reply.success(ctx.t('leave.disconnected'));
    },
  }));

  registry.register(createCommand({
    name: 'radio',
    description: 'Play a built-in or guild-saved radio station preset.',
    usage: 'radio <station|random|url>',
    async execute(ctx: PlaybackCommandContext) {
      ensureGuild(ctx);
      const rawQuery = ctx.args.join(' ').trim();
      const guildStations = await ctx.library?.listGuildStations?.(ctx.guildId).catch(() => []) ?? [];

      if (!rawQuery) {
        const featured = listAvailableRadioStations(guildStations).slice(0, 12);
        if (!featured.length) {
          await ctx.reply.info(ctx.t('radio.noPresets'), [
            { name: ctx.t('common.usage'), value: `\`${ctx.prefix}radio <number|station|random|url>\`\n\`${ctx.prefix}stations [filter] [page]\`` },
          ]);
          return;
        }

        await ctx.reply.info(ctx.t('radio.presets'), [
          { name: ctx.t('radio.tryOne'), value: featured.map((station, idx) => formatRadioStationSummary(station, idx + 1)).join('\n') },
          { name: ctx.t('common.usage'), value: `\`${ctx.prefix}radio <number|station|random|url>\`\n\`${ctx.prefix}stations [filter] [page]\`` },
        ]);
        return;
      }

      let targetStation: ResolvedRadioStation | null = null;
      let targetLabel = rawQuery;
      let targetUrl = rawQuery;
      if (!/^https?:\/\//i.test(rawQuery)) {
        if (/^random(?:\s+|$)/i.test(rawQuery)) {
          const filter = rawQuery.replace(/^random\b/i, '').trim();
          const randomStation = pickRandomRadioStation(guildStations, filter || null);
          if (!randomStation) {
            await ctx.reply.warning(
              filter
                ? ctx.t('radio.noRandomMatch', { filter })
                : ctx.t('radio.noRandomAvailable')
            );
            return;
          }
          targetStation = randomStation;
          targetLabel = randomStation.name;
          targetUrl = randomStation.url;
        } else if (/^\d+$/.test(rawQuery)) {
          const indexed = resolveRadioStationIndexSelection(guildStations, rawQuery);
          if (!indexed.station) {
            await ctx.reply.warning(
              indexed.total > 0
                ? ctx.t('radio.indexOutOfRange', { total: indexed.total, prefix: ctx.prefix })
                : ctx.t('radio.noneAvailable')
            );
            return;
          }

          targetStation = indexed.station;
          targetLabel = indexed.station.name;
          targetUrl = indexed.station.url;
        } else {
          const selection = resolveRadioStationSelection(guildStations, rawQuery);
          if (!selection.station) {
            if (selection.matches.length) {
              await ctx.reply.info(ctx.t('radio.multipleMatches', { query: rawQuery }), [
                { name: ctx.t('radio.matches'), value: selection.matches.map((station, idx) => formatRadioStationSummary(station, idx + 1)).join('\n') },
              ]);
              return;
            }
            await ctx.reply.warning(ctx.t('radio.noMatch', { query: rawQuery }));
            return;
          }

          targetStation = selection.station;
          targetLabel = selection.station.name;
          targetUrl = selection.station.url;
        }
      }

      await ctx.withGuildOpLock('radio', async () => {
        const progress = await createProgressReporter(ctx, ctx.t('radio.tuningIn', { station: targetLabel }), null, null, { replyReference: true });
        await ctx.safeTyping();

        const preparedSession = await prepareSessionConnection(ctx);
        const connectPromise = connectPreparedSession(ctx, preparedSession);
        const previewPromise = preparedSession.session.player.previewTracks(targetUrl, {
          requestedBy: ctx.authorId,
          limit: 1,
        });
        const [session, preview] = await Promise.all([connectPromise, previewPromise]);
        const resolved = preview[0] ?? null;

        if (!resolved) {
          await progress.warning(ctx.t('radio.noPlayableStream'));
          return;
        }

        if (String(resolved.source ?? '').trim().toLowerCase() !== 'radio-stream') {
          await progress.warning(ctx.t('radio.notLiveStream'));
          return;
        }

        resolved.title = targetLabel;
        await applyVoiceProfileIfConfigured(ctx, session);

        const activeTrack = session.player.currentTrack ?? null;
        const resolvedStation = targetStation ?? {
          name: targetLabel,
          url: String(resolved.url ?? targetUrl).trim() || targetUrl,
        };
        const queuedRadioDuplicate = Array.isArray(session.player.pendingTracks)
          ? session.player.pendingTracks.find((track) => isSameRadioSelection(track, resolvedStation))
          : null;
        if (isSameRadioSelection(activeTrack, resolvedStation)) {
          await progress.info(ctx.t('radio.alreadyTuned', { track: trackLabel(activeTrack ?? resolved) }));
          return;
        }
        if (queuedRadioDuplicate) {
          await progress.info(ctx.t('radio.alreadyQueued', { track: trackLabel(queuedRadioDuplicate) }));
          return;
        }
        const shouldInterruptLivePlayback = Boolean(
          session.player.playing
          && activeTrack
          && (
            activeTrack.isLive === true
            || String(activeTrack.source ?? '').startsWith('radio')
          )
        );

        const track = session.player.createTrackFromData(resolved, ctx.authorId);
        const added = session.player.enqueueResolvedTracks([track], {
          dedupe: false,
          playNext: shouldInterruptLivePlayback,
        });
        if (!added.length) {
          await progress.warning(ctx.t('radio.queueFailed'));
          return;
        }

        if (shouldInterruptLivePlayback) {
          session.player.skip();
          await progress.success(ctx.t('radio.interruptedTuning', { track: trackLabel(added[0] ?? track) }));
        } else if (!session.player.playing) {
          await session.player.play();
          await progress.success(ctx.t('radio.tuning', { track: trackLabel(added[0] ?? track) }));
        } else {
          await progress.success(ctx.t('radio.queued', { track: trackLabel(added[0] ?? track) }));
        }

        ctx.sessions.markSnapshotDirty?.(session, true);
      });
    },
  }));

  registry.register(createCommand({
    name: 'play',
    aliases: ['p'],
    description: 'Queue a song or URL.',
    usage: 'play <query|url>',
    async execute(ctx: PlaybackCommandContext) {
      ensureGuild(ctx);

      const { channelId: explicitChannelId, rest } = parseVoiceChannelArgument(ctx.args);
      const rawQuery = rest.join(' ').trim();
      if (!rawQuery) {
        throw new ValidationError(ctx.t('play.usage', { prefix: ctx.prefix }));
      }
      enforcePlayCooldown(ctx);
      const multiUrlQuery = splitMultiUrlQuery(rawQuery);
      const query = multiUrlQuery?.[0] ?? rawQuery;
      const extraQueryUrls = multiUrlQuery ? multiUrlQuery.slice(1) : [];

      await ctx.withGuildOpLock('play', async () => {
        const progress = await createProgressReporter(ctx, `Looking up: **${query}**`, null, null, { replyReference: true });
        await ctx.safeTyping();
        const preparedSession = await prepareSessionConnection(ctx, explicitChannelId, { bindTextChannel: true });
        const shouldLoadPlaylistInBackground = isLikelyPlaylistLoad(query);
        const nodeLinkStreaming = preparedSession.session.player.isNodeLinkStreamingEnabled?.() ?? false;
        const directYouTubeTrack = (shouldLoadPlaylistInBackground || nodeLinkStreaming)
          ? null
          : buildDeferredDirectYouTubeTrack(query, ctx.authorId);
        const connectPromise = connectPreparedSession(ctx, preparedSession);
        const directTrackHydrationPromise = directYouTubeTrack
          ? (preparedSession.session.player.hydrateTrackMetadata?.(directYouTubeTrack, { requestedBy: ctx.authorId }).catch(() => null) ?? Promise.resolve(null))
          : null;
        const previewPromise = directYouTubeTrack
          ? Promise.race<TrackDataLike | null>([
              directTrackHydrationPromise ?? Promise.resolve(null),
              (async () => {
                await connectPromise.catch(() => null);
                await wait(DIRECT_YOUTUBE_METADATA_GRACE_MS);
                return null;
              })(),
            ]).then((hydrated) => [hydrated ?? directYouTubeTrack])
          : preparedSession.session.player.previewTracks(query, {
              requestedBy: ctx.authorId,
              ...(shouldLoadPlaylistInBackground ? { limit: 1 } : (ctx.config.maxPlaylistTracks != null ? { limit: ctx.config.maxPlaylistTracks } : {})),
            });
        const preparedTracksPromise = previewPromise.then((preview) => prepareTracksForPlaybackStart(
          preparedSession.session.player,
          preview,
          ctx.authorId,
          { prefetchFirstTrack: !preparedSession.session.player.playing }
        ));
        const [session, preparedTracks] = await Promise.all([connectPromise, preparedTracksPromise]);
        const { tracks, firstTrackHydrationPromise } = preparedTracks;
        await applyVoiceProfileIfConfigured(ctx, session, explicitChannelId);

        const queueGuard = await resolveQueueGuard(ctx);
        const activeTrack = session.player.currentTrack ?? null;
        const hadActivePlaybackBeforeQueue = Boolean(session.player.playing);
        const shouldInterruptLivePlayback = Boolean(
          session.player.playing
          && activeTrack
          && (
            activeTrack.isLive === true
            || String(activeTrack.source ?? '').startsWith('radio')
          )
        );
        const added = session.player.enqueueResolvedTracks(tracks, {
          dedupe: session.settings.dedupeEnabled,
          queueGuard,
          playNext: shouldInterruptLivePlayback,
        });
        const startedPlaylistPlaybackNow = shouldInterruptLivePlayback || !hadActivePlaybackBeforeQueue;

        if (!added.length) {
          const dedupeBlocked = tracks.length > 0 && Boolean(session.settings.dedupeEnabled);
          await progress.warning(
            dedupeBlocked
              ? 'All matching tracks are already in the queue (dedupe enabled).'
              : 'No tracks found for that query.'
          );
          return;
        }

        if (shouldInterruptLivePlayback) {
          session.player.skip();
        } else if (!session.player.playing) {
          await session.player.play();
        }

        if (extraQueryUrls.length) {
          void enqueueAdditionalUrls(session, extraQueryUrls, ctx.authorId, {
            dedupe: session.settings.dedupeEnabled,
            queueGuard,
            limit: ctx.config.maxPlaylistTracks ?? null,
          });
        }

        const firstAdded = added[0];
        if (!firstAdded) {
          await progress.warning(ctx.t('play.noTracksAdded'));
          return;
        }

        await waitForDeferredTrackMessageMetadata(firstAdded, directTrackHydrationPromise);
        const shouldDelayFinalPlaybackMessage = isDeferredTrackMetadata(firstAdded);

        if (directTrackHydrationPromise) {
          void directTrackHydrationPromise.then(async (hydrated) => {
            const resolvedTrack = await hydrateDeferredTrackMetadata(firstAdded, hydrated);
            if (!resolvedTrack || !shouldDelayFinalPlaybackMessage || shouldLoadPlaylistInBackground) return;
            await finalizeDeferredPlaybackStatus(ctx.t, progress, {
              shouldInterruptLivePlayback,
              addedCount: added.length,
              firstTrack: resolvedTrack,
            }).catch(() => null);
          });
        } else {
          void resolveAndHydrateDeferredTrackMetadata(session.player, firstAdded, ctx.authorId);
        }

        if (!shouldLoadPlaylistInBackground) {
          if (shouldDelayFinalPlaybackMessage) {
            await progress.info(buildDeferredPlaybackStatusText(ctx.t, {
              shouldInterruptLivePlayback,
              addedCount: added.length,
              isPlaylistLoad: added.length > 1,
            }));
          } else {
            await finalizeDeferredPlaybackStatus(ctx.t, progress, {
              shouldInterruptLivePlayback,
              addedCount: added.length,
              firstTrack: firstAdded,
            });
          }
          return;
        }

        let firstTrackLabel = trackLabel(firstAdded);
        const requestedBy = ctx.authorId;
        const maxPlaylistTracks = ctx.config.maxPlaylistTracks;
        if (isYouTubeMixPlaceholderTrack(firstAdded) && firstTrackHydrationPromise) {
          await Promise.race([
            firstTrackHydrationPromise.catch(() => null),
            wait(DIRECT_YOUTUBE_METADATA_GRACE_MS),
          ]);
          firstTrackLabel = trackLabel(firstAdded);
        }
        await progress.info(
          startedPlaylistPlaybackNow
            ? (
                shouldInterruptLivePlayback
                  ? `Stopped live stream. Playing now: ${firstTrackLabel}\nLoading remaining playlist tracks in the background...`
                  : `Playing now: ${firstTrackLabel}\nLoading remaining playlist tracks in the background...`
              )
            : `Added to queue: ${firstTrackLabel}\nLoading remaining playlist tracks in the background...`
        );

        const initialPreviewTrack = tracks[0] ?? null;
        void (async () => {
          let resolved: TrackDataLike[] | null = null;
          let remainingResolved: TrackDataLike[] | null = null;
          let remainingTracks: TrackDataLike[] | null = null;
          try {
            const hydratedFirstTrack = await (
              firstTrackHydrationPromise
              ?? hydrateFirstYouTubeMixTrack(session.player, firstAdded, requestedBy).catch(() => null)
            );
            if (hydratedFirstTrack) {
              firstTrackLabel = trackLabel(hydratedFirstTrack);
              await progress.info(
                startedPlaylistPlaybackNow
                  ? (
                      shouldInterruptLivePlayback
                        ? `Stopped live stream. Playing now: ${firstTrackLabel}\nLoading remaining playlist tracks in the background...`
                        : `Playing now: ${firstTrackLabel}\nLoading remaining playlist tracks in the background...`
                    )
                  : `Added to queue: ${firstTrackLabel}\nLoading remaining playlist tracks in the background...`
              );
            }

            resolved = await session.player.previewTracks(query, {
              requestedBy,
              ...(maxPlaylistTracks != null ? { limit: maxPlaylistTracks } : {}),
            });
            const resolvedTotalCount = resolved.length;
            remainingResolved = removeFirstMatchingTrack(resolved, initialPreviewTrack);
            if (!remainingResolved.length) {
              await progress.success(
                startedPlaylistPlaybackNow
                  ? `Playing now: ${firstTrackLabel}\nQueued **${resolvedTotalCount}/${resolvedTotalCount}** playlist tracks.`
                  : `Added to queue: ${firstTrackLabel}\nQueued **${resolvedTotalCount}/${resolvedTotalCount}** playlist tracks.`
              );
              return;
            }

            remainingTracks = remainingResolved.map((track: TrackDataLike) => session.player.createTrackFromData(track, requestedBy));
            const backgroundResult = await enqueueTracksUntilFull(session.player, remainingTracks, {
              dedupe: session.settings.dedupeEnabled,
              playNext: false,
              queueGuard,
            }, async ({ addedCount, totalCount, queueLimitReached }) => {
              const loadedCount = 1 + addedCount;
              const statusText = queueLimitReached
                ? (
                    startedPlaylistPlaybackNow
                      ? `Playing now: ${firstTrackLabel}\nQueued **${loadedCount}/${resolvedTotalCount}** playlist tracks before the queue limit was reached.`
                      : `Added to queue: ${firstTrackLabel}\nQueued **${loadedCount}/${resolvedTotalCount}** playlist tracks before the queue limit was reached.`
                  )
                : (
                    startedPlaylistPlaybackNow
                      ? `Playing now: ${firstTrackLabel}\nLoading playlist tracks in the background... **${loadedCount}/${resolvedTotalCount}** queued.`
                      : `Added to queue: ${firstTrackLabel}\nLoading playlist tracks in the background... **${loadedCount}/${resolvedTotalCount}** queued.`
                  );
              await progress.info(statusText);
            });
            const totalAdded = 1 + backgroundResult.added.length;

            if (!backgroundResult.added.length) {
              await progress.success(
                startedPlaylistPlaybackNow
                  ? `Playing now: ${firstTrackLabel}`
                  : `Added to queue: ${firstTrackLabel}`,
                [{ name: ctx.t('play.field.playlistLoad'), value: ctx.t('play.playlistNoneQueued') }]
              );
              return;
            }

            const playlistLoadText = backgroundResult.queueLimitReached
              ? (
                  startedPlaylistPlaybackNow
                    ? `Playing now: ${firstTrackLabel}\nQueued **${totalAdded}/${resolvedTotalCount}** playlist tracks before the queue limit was reached.`
                    : `Added to queue: ${firstTrackLabel}\nQueued **${totalAdded}/${resolvedTotalCount}** playlist tracks before the queue limit was reached.`
                )
              : (
                  startedPlaylistPlaybackNow
                    ? `Playing now: ${firstTrackLabel}\nQueued **${totalAdded}/${resolvedTotalCount}** playlist tracks.`
                    : `Added to queue: ${firstTrackLabel}\nQueued **${totalAdded}/${resolvedTotalCount}** playlist tracks.`
                );
            await progress.success(
              playlistLoadText,
              backgroundResult.queueLimitReached
                ? [{ name: ctx.t('play.field.queueLimit'), value: ctx.t('play.playlistTruncated') }]
                : null
            );
          } catch (err) {
            await progress.warning(
              startedPlaylistPlaybackNow
                ? `Playing now: ${firstTrackLabel}\nBackground playlist loading failed.`
                : `Added to queue: ${firstTrackLabel}\nBackground playlist loading failed.`,
              [{ name: ctx.t('common.error'), value: String(err instanceof Error ? err.message : err).slice(0, 1000) || ctx.t('errors.unknown') }]
            );
          } finally {
            resolved = null;
            remainingResolved = null;
            remainingTracks = null;
          }
        })();
      });
    },
  }));

  registry.register(createCommand({
    name: 'playnext',
    aliases: ['pn', 'next'],
    description: 'Queue a song to play right after the current one.',
    usage: 'playnext <query|url>',
    async execute(ctx: PlaybackCommandContext) {
      ensureGuild(ctx);

      const query = ctx.args.join(' ').trim();
      if (!query) {
        throw new ValidationError(ctx.t('playnext.usage', { prefix: ctx.prefix }));
      }
      enforcePlayCooldown(ctx);

      await ctx.withGuildOpLock('playnext', async () => {
        const progress = await createProgressReporter(ctx, `Queueing next: **${query}**`, null, null, { replyReference: true });
        await ctx.safeTyping();
        const session = await ensureConnectedSession(ctx);
        await applyVoiceProfileIfConfigured(ctx, session);
        const queueGuard = await resolveQueueGuard(ctx);
        const preview = await session.player.previewTracks(query, {
          requestedBy: ctx.authorId,
          ...(ctx.config.maxPlaylistTracks != null ? { limit: ctx.config.maxPlaylistTracks } : {}),
        });
        const tracks = preview.map((track: TrackDataLike) => session.player.createTrackFromData(track, ctx.authorId));
        const added = session.player.enqueueResolvedTracks(tracks, {
          requestedBy: ctx.authorId,
          playNext: true,
          dedupe: session.settings.dedupeEnabled,
          queueGuard,
        });

        if (!added.length) {
          const dedupeBlocked = tracks.length > 0 && Boolean(session.settings.dedupeEnabled);
          await progress.warning(
            dedupeBlocked
              ? 'All matching tracks are already in the queue (dedupe enabled).'
              : 'No tracks found for that query.'
          );
          return;
        }

        if (!session.player.playing) {
          await session.player.play();
        }

        const firstAdded = added[0];
        if (!firstAdded) {
          await progress.warning(ctx.t('play.noTracksAdded'));
          return;
        }
        if (added.length === 1) {
          await progress.success(ctx.t('playnext.queuedNext', { track: trackLabel(firstAdded) }));
        } else {
          await progress.success(ctx.t('playnext.queuedPlaylist', { count: added.length }));
        }
      });
    },
  }));

  registry.register(createCommand({
    name: 'search',
    aliases: ['find'],
    description: 'Search YouTube and pick one of the top results.',
    usage: 'search <query>',
    async execute(ctx: PlaybackCommandContext) {
      ensureGuild(ctx);
      const query = ctx.args.join(' ').trim();
      if (!query) {
        throw new ValidationError(ctx.t('search.usage', { prefix: ctx.prefix }));
      }

      enforcePlayCooldown(ctx);
      await ctx.withGuildOpLock('search', async () => {
        const progress = await createProgressReporter(ctx, `Searching: **${query}**`, null, null, { replyReference: true });
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
          await progress.warning(ctx.t('search.noResults'));
          return;
        }

        const ttlMs = saveSearchSelection({
          guildId: ctx.guildId,
          authorId: ctx.authorId,
          config: {
            ...(typeof ctx.config.searchPickTimeoutMs === 'number'
              ? { searchPickTimeoutMs: ctx.config.searchPickTimeoutMs }
              : {}),
          },
        }, results);
        const lines = results.map((track: TrackDataLike, idx: number) => formatSearchResultLine(track, idx + 1));
        const payload = buildInfoPayload(
          ctx,
          `Search results for ${query}`,
          '',
          [
            { name: ctx.t('search.results'), value: lines.join('\n').slice(0, 1000) || '-' },
            { name: ctx.t('search.pick'), value: ctx.t('search.pickHint', { max: results.length, seconds: Math.ceil(ttlMs / 1000) }) },
          ],
          { thumbnailUrl: results[0]?.thumbnailUrl ?? null }
        );
        let messageId = await progress.replace(payload);
        if (!messageId) {
          if (!ctx.rest.sendMessage) {
            throw new ValidationError(ctx.t('errors.restUnavailable'));
          }
          const sent = await ctx.rest.sendMessage(ctx.channelId, withCommandReplyReference(ctx, payload)) as SentMessageLike | null;
          messageId = sent?.id ?? sent?.message?.id ?? null;
        }
        if (messageId && ctx.registerSearchReactionSelection) {
          await ctx.registerSearchReactionSelection(String(messageId), results, ttlMs);
        }
      });
    },
  }));

  registry.register(createCommand({
    name: 'pick',
    aliases: ['choose'],
    description: 'Pick a result from your latest search.',
    usage: 'pick <index>',
    async execute(ctx: PlaybackCommandContext) {
      ensureGuild(ctx);
      const index = normalizeIndex(ctx.args[0], 'field.index', ctx.t);

      const selection = consumeSearchSelection(toSearchSelectionContext(ctx));
      if (!selection) {
        throw new ValidationError(ctx.t('pick.noSelection', { prefix: ctx.prefix }));
      }

      const selected = selection[index - 1];
      if (!selected) {
        throw new ValidationError(ctx.t('pick.outOfRange', { max: selection.length }));
      }

      await ctx.withGuildOpLock('pick', async () => {
        const session = await ensureConnectedSession(ctx);
        await applyVoiceProfileIfConfigured(ctx, session);
        const queueGuard = await resolveQueueGuard(ctx);
        const track = session.player.createTrackFromData(selected, ctx.authorId);
        if (!session.player.playing) {
          await session.player.prefetchTrackPlayback?.(track).catch(() => null);
        }
        const added = session.player.enqueueResolvedTracks([track], {
          dedupe: session.settings.dedupeEnabled,
          queueGuard,
        });

        if (!added.length) {
          await ctx.reply.warning(ctx.t('play.duplicate'));
          return;
        }

        if (!session.player.playing) {
          await session.player.play();
        }

        clearSearchSelection(toSearchSelectionContext(ctx));
        const firstAdded = added[0];
        if (!firstAdded) {
          await ctx.reply.warning(ctx.t('play.noTracksAdded'));
          return;
        }
        await ctx.reply.success(ctx.t('play.status.added', { track: trackLabel(firstAdded) }));
      });
    },
  }));

  registry.register(createCommand({
    name: 'skip',
    aliases: ['s'],
    description: 'Skip current track (DJ or vote-skip).',
    usage: 'skip',
    async execute(ctx: PlaybackCommandContext) {
      ensureGuild(ctx);
      const session = getSessionOrThrow(ctx);
      ensureSessionTrack(ctx, session);
      if (!isUserInPlaybackChannel(ctx, session)) {
        throw new ValidationError(ctx.t('skip.sameChannelRequired'));
      }

      if (userHasDjAccess(ctx, session)) {
        session.player.skip();
        ctx.sessions.markSnapshotDirty?.(session, true);
        await ctx.reply.success(ctx.t('skip.skipped'));
        return;
      }

      const sessionSelector = session.sessionId != null ? { sessionId: session.sessionId } : null;
      const voteState = ctx.sessions.registerVoteSkip?.(ctx.guildId, ctx.authorId, sessionSelector);
      if (!voteState) {
        await ctx.reply.warning(ctx.t('skip.voteFailed'));
        return;
      }

      if (!voteState.added) {
        await ctx.reply.info(ctx.t('skip.alreadyVoted'));
        return;
      }

      const requiredVotes = computeVoteSkipRequirement(ctx, session);
      if (voteState.votes >= requiredVotes) {
        session.player.skip();
        ctx.sessions.clearVoteSkips?.(ctx.guildId, sessionSelector);
        await ctx.reply.success(ctx.t('skip.votePassed', { votes: voteState.votes, required: requiredVotes }));
        return;
      }

      await ctx.reply.info(ctx.t('skip.voteRegistered', { votes: voteState.votes, required: requiredVotes }));
    },
  }));

  registry.register(createCommand({
    name: 'pause',
    description: 'Pause playback.',
    usage: 'pause',
    async execute(ctx: PlaybackCommandContext) {
      ensureGuild(ctx);
      const session = getSessionOrThrow(ctx);
      ensureDjAccess(ctx, session, 'access.pausePlayback');

      if (!session.player.pause()) {
        await ctx.reply.warning(ctx.t('pause.cannot'));
        return;
      }

      ctx.sessions.markSnapshotDirty?.(session, true);
      await ctx.reply.success(ctx.t('pause.paused'));
    },
  }));

  registry.register(createCommand({
    name: 'resume',
    aliases: ['unpause'],
    description: 'Resume playback.',
    usage: 'resume',
    async execute(ctx: PlaybackCommandContext) {
      ensureGuild(ctx);
      const session = getSessionOrThrow(ctx);
      ensureDjAccess(ctx, session, 'access.resumePlayback');

      if (!session.player.resume()) {
        await ctx.reply.warning(ctx.t('resume.cannot'));
        return;
      }

      ctx.sessions.markSnapshotDirty?.(session, true);
      await ctx.reply.success(ctx.t('resume.resumed'));
    },
  }));

  registry.register(createCommand({
    name: 'now',
    aliases: ['np', 'nowplaying'],
    description: 'Show the currently playing track.',
    usage: 'now',
    async execute(ctx: PlaybackCommandContext) {
      ensureGuild(ctx);
      const session = getSessionOrThrow(ctx);
      const current = session.player.displayTrack ?? session.player.currentTrack;

      if (!current) {
        await ctx.reply.warning(ctx.t('errors.nothingPlaying'));
        return;
      }

      const totalSec = parseDurationToSeconds(current.duration);
      const progressSec = session.player.getProgressSeconds();
      const isRadio = current.source === 'radio-stream';
      const pendingTracks = session.player.pendingTracks ?? [];
      const fields: EmbedField[] = isRadio
        ? [
            { name: ctx.t('now.progress'), value: buildProgressBar(progressSec, totalSec ?? Number.NaN, 16, { isLive: true }) },
            {
              name: 'Station',
              value: current.url
                ? `[${String(current.title ?? 'Live Radio').trim() || 'Live Radio'}](${current.url})`
                : (String(current.title ?? 'Live Radio').trim() || 'Live Radio'),
              inline: true,
            },
          ]
        : [
            { name: ctx.t('now.progress'), value: buildProgressBar(progressSec, totalSec ?? Number.NaN, 16, { isLive: Boolean(current?.isLive) }) },
            { name: ctx.t('now.loop'), value: String(session.player.loopMode ?? 'off'), inline: true },
            { name: ctx.t('common.volume'), value: `${session.player.volumePercent ?? 100}%`, inline: true },
            { name: ctx.t('now.queued'), value: String(pendingTracks.length), inline: true },
          ];

      const pendingDurationSec = pendingTracks.reduce((sum, track) => {
        const parsed = parseDurationToSeconds(track?.duration);
        return parsed != null ? sum + parsed : sum;
      }, 0);
      const sessionFooter = isRadio
        ? RADIO_RECOGNITION_SUPPORT_FOOTER
        : [
          `Loop ${String(session.player.loopMode ?? 'off')}`,
          `Vol ${session.player.volumePercent ?? 100}%`,
          `Dedupe ${session.settings?.dedupeEnabled ? 'on' : 'off'}`,
          `24/7 ${session.settings?.stayInVoiceEnabled ? 'on' : 'off'}`,
        ].join(' | ');

      const buildNowPlayingPayload = (nextFields: EmbedField[]) => buildInfoPayload(
        ctx,
        'Now Playing',
        isRadio ? '' : trackLabelWithLink(current),
        nextFields,
        {
          thumbnailUrl: current.thumbnailUrl ?? null,
          imageUrl: current.thumbnailUrl ?? null,
          footer: sessionFooter,
          url: current.url ?? null,
          author: buildTrackAuthor(current),
          color: sourceColor(current.source),
        }
      );

      if (isRadio && current.url) {
        const pendingFields = [
          ...fields,
          { name: ctx.t('now.song'), value: ctx.t('now.detecting'), inline: true },
        ];
        const pendingPayload = buildNowPlayingPayload(pendingFields);
        const pendingMessage = await ctx.rest.sendMessage?.(
          ctx.channelId,
          withCommandReplyReference(ctx, pendingPayload)
        ).catch(() => null) as SentMessageLike | null | undefined;

        const detected = await detectRadioNowPlaying({
          url: current.url,
          auddApiToken: ctx.config?.auddApiToken ?? null,
          logger: ctx.logger ?? null,
        }).catch(() => null);

        const nextFields = [...fields];
        if (detected) {
          nextFields.unshift({
            name: 'Song',
            value: String(detected.title ?? 'Unknown title'),
          });
          nextFields.push({
            name: 'Artist',
            value: String(detected.artist ?? 'Unknown artist'),
            inline: true,
          });
        } else {
          nextFields.unshift({
            name: 'Song',
            value: ctx.config?.auddApiToken
              ? 'Could not detect the current song.'
              : 'No stream metadata available. Set `AUDD_API_TOKEN` for audio recognition fallback.',
          });
        }

        const finalPayload = buildNowPlayingPayload(nextFields);
        const pendingMessageId = pendingMessage?.id ?? pendingMessage?.message?.id ?? null;
        if (pendingMessageId) {
          try {
            await ctx.rest.editMessage?.(ctx.channelId, pendingMessageId, finalPayload);
            return;
          } catch {
            // Fall back to sending a new message if edit fails.
          }
        }

        await ctx.rest.sendMessage?.(ctx.channelId, withCommandReplyReference(ctx, finalPayload));
        return;
      }

      const payload = buildNowPlayingPayload(fields);
      await ctx.rest.sendMessage?.(ctx.channelId, withCommandReplyReference(ctx, payload));
    },
  }));

  registry.register(createCommand({
    name: 'seek',
    aliases: ['jump'],
    description: 'Seek in current track (seconds or mm:ss or hh:mm:ss).',
    usage: 'seek <seconds|mm:ss|hh:mm:ss>',
    async execute(ctx: PlaybackCommandContext) {
      ensureGuild(ctx);
      const session = getSessionOrThrow(ctx);
      ensureDjAccess(ctx, session, 'access.seek');

      if (!ctx.args.length) {
        throw new ValidationError(ctx.t('seek.usage', { prefix: ctx.prefix }));
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
        throw new ValidationError(ctx.t('seek.invalid'));
      }

      const finalTarget = session.player.seekTo(targetSec);
      ctx.sessions.markSnapshotDirty?.(session, true);
      await ctx.reply.success(ctx.t('seek.seeking', { position: formatSeconds(finalTarget) }));
    },
  }));

  registry.register(createCommand({
    name: 'previous',
    aliases: ['prev', 'back'],
    description: 'Queue the previous track again.',
    usage: 'previous',
    async execute(ctx: PlaybackCommandContext) {
      ensureGuild(ctx);
      const session = getSessionOrThrow(ctx);
      ensureDjAccess(ctx, session, 'access.playPrevious');

      const previous = session.player.queuePreviousTrack();
      if (!previous) {
        await ctx.reply.warning(ctx.t('previous.notFound'));
        return;
      }

      if (!session.player.playing) {
        await session.player.play();
      }

      ctx.sessions.markSnapshotDirty?.(session, true);
      await ctx.reply.success(ctx.t('previous.queued', { track: trackLabel(previous) }));
    },
  }));

  registry.register(createCommand({
    name: 'replay',
    aliases: ['restart'],
    description: 'Restart current track or replay the last played track.',
    usage: 'replay',
    async execute(ctx: PlaybackCommandContext) {
      ensureGuild(ctx);
      const session = getSessionOrThrow(ctx);
      ensureDjAccess(ctx, session, 'access.replayTracks');

      if (session.player.replayCurrentTrack()) {
        ctx.sessions.markSnapshotDirty?.(session, true);
        await ctx.reply.success(ctx.t('replay.restarting'));
        return;
      }

      const previous = session.player.queuePreviousTrack();
      if (!previous) {
        const library = ctx.library;
        const persisted = library?.getLastGuildHistoryTrack
          ? await library.getLastGuildHistoryTrack(ctx.guildId).catch(() => null)
          : null;
        if (persisted) {
          const replayTrack = session.player.createTrackFromData(persisted, ctx.authorId);
          session.player.enqueueResolvedTracks([replayTrack], {
            playNext: true,
            dedupe: false,
          });
          if (!session.player.playing) {
            await session.player.play();
          }
          ctx.sessions.markSnapshotDirty?.(session, true);
          await ctx.reply.success(ctx.t('replay.fromHistory', { track: trackLabel(replayTrack) }));
          return;
        }

        await ctx.reply.warning(ctx.t('replay.noTrack'));
        return;
      }

      if (!session.player.playing) {
        await session.player.play();
      }

      ctx.sessions.markSnapshotDirty?.(session, true);
      await ctx.reply.success(ctx.t('replay.replaying', { track: trackLabel(previous) }));
    },
  }));

  registry.register(createCommand({
    name: 'queue',
    aliases: ['q'],
    description: 'Show queue contents.',
    usage: 'queue [page]',
    async execute(ctx: PlaybackCommandContext) {
      ensureGuild(ctx);
      const session = getSessionOrThrow(ctx);

      if (ctx.args.length) {
        const page = parseRequiredInteger(ctx.args[0], 'field.page', ctx.t);
        const queueData = formatQueuePage(session, page);
        await ctx.reply.info(queueData.description, queueData.fields, { footer: queueData.footer ?? null });
        return;
      }

      const pendingCount = session.player.pendingTracks.length;
      const totalPages = Math.max(1, Math.ceil(pendingCount / PENDING_PAGE_SIZE));
      if (totalPages <= 1) {
        const queueData = formatQueuePage(session, 1);
        await ctx.reply.info(queueData.description, queueData.fields, { footer: queueData.footer ?? null });
        return;
      }

      const pages = [];
      for (let page = 1; page <= totalPages; page += 1) {
        const queueData = formatQueuePage(session, page);
        pages.push(buildInfoPayload(ctx, 'Queue', queueData.description, queueData.fields, { footer: queueData.footer ?? null }));
      }
      await ctx.sendPaginated(pages);
    },
  }));

  registry.register(createCommand({
    name: 'history',
    aliases: ['recent'],
    description: 'Show recently played tracks.',
    usage: 'history [page]',
    async execute(ctx: PlaybackCommandContext) {
      ensureGuild(ctx);
      const page = ctx.args.length ? parseRequiredInteger(ctx.args[0], 'field.page', ctx.t) : 1;
      const session = ctx.sessions.get(ctx.guildId, {
        voiceChannelId: ctx.activeVoiceChannelId,
        textChannelId: ctx.channelId,
      });
      if (session?.player?.historyTracks?.length) {
        const historyData = formatHistoryPage(session, page);
        await ctx.reply.info(historyData.description, historyData.fields);
        return;
      }

      const library = requireLibrary(ctx);
      const persisted = await library.listGuildHistory(ctx.guildId, page, HISTORY_PAGE_SIZE);
      if (!persisted.items.length) {
        await ctx.reply.warning(ctx.t('history.empty'));
        return;
      }

      const lines = persisted.items.map(
        (track: TrackDataLike, idx: number) => `${(persisted.page - 1) * persisted.pageSize + idx + 1}. ${trackLabel(track)}`
      );
      const linePages = chunkLines(lines, 1000);
      if (linePages.length === 1) {
        await ctx.reply.info(
          `Persistent history page **${persisted.page}/${persisted.totalPages}** • Total tracks: **${persisted.total}**`,
          [{ name: ctx.t('history.recentlyPlayed'), value: linePages[0] ?? '-' }]
        );
        return;
      }

      const pages = linePages.map((value, idx) => buildInfoPayload(
        ctx,
        `Persistent history ${idx + 1}/${linePages.length}`,
        `Page **${persisted.page}/${persisted.totalPages}** • Total tracks: **${persisted.total}**`,
        [{ name: ctx.t('history.recentlyPlayed'), value }]
      ));
      await ctx.sendPaginated(pages);
    },
  }));
}





