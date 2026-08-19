import { ValidationError } from '../../core/errors.ts';
import type { TranslationKey, Translator } from '../../i18n/index.ts';
import { buildInfoPayload, buildSingleFieldInfoPayload } from './responseUtils.ts';
import {
  listAvailableRadioStations,
  resolveRadioStationSelection,
  type RadioStationRecord,
  type ResolvedRadioStation,
} from './helpers/radioStations.ts';
import type { CommandRegistry } from '../commandRegistry.ts';
import type { TrackLike } from '../../types/core.ts';
import type { CommandContextLike, GuildConfigLike, LibraryLike, QueueGuardLike, SessionLike, TrackDataLike } from './helpers/types.ts';

type PlaylistListItem = { name: string; trackCount?: number | null };
type PlaylistLike = { name: string; tracks: TrackDataLike[] };
type SavedStationInput = { url: string; description?: string | null; tags?: string[] | null };
type PlaylistLibrary = LibraryLike & {
  listGuildPlaylists: (guildId: string, page: number, pageSize: number) => Promise<{
    items: PlaylistListItem[];
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
  }>;
  createGuildPlaylist: (guildId: string, name: string, createdBy: string) => Promise<{ name: string }>;
  deleteGuildPlaylist: (guildId: string, name: string) => Promise<boolean>;
  getGuildPlaylist: (guildId: string, name: string) => Promise<PlaylistLike | null>;
  addTracksToGuildPlaylist: (guildId: string, name: string, tracks: TrackDataLike[], addedBy: string) => Promise<{
    addedCount: number;
    droppedCount: number;
    playlistName: string;
  }>;
  removeTrackFromGuildPlaylist: (guildId: string, name: string, index: number) => Promise<TrackDataLike | null>;
  listUserFavorites: (userId: string, page: number, pageSize: number) => Promise<{
    items: TrackDataLike[];
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
  }>;
  addUserFavorite: (userId: string, track: TrackDataLike) => Promise<{
    added: boolean;
    track: TrackDataLike;
  }>;
  removeUserFavorite: (userId: string, index: number) => Promise<TrackDataLike | null>;
  getUserFavorite: (userId: string, index: number) => Promise<TrackDataLike | null>;
  getUserFavoriteByAlias: (userId: string, alias: string) => Promise<TrackDataLike | null>;
  renameUserFavorite: (userId: string, index: number, alias: string) => Promise<TrackDataLike | null>;
  listGuildStations?: (guildId: string) => Promise<RadioStationRecord[]>;
  getGuildStation?: (guildId: string, name: string) => Promise<RadioStationRecord | null>;
  setGuildStation?: (guildId: string, name: string, station: SavedStationInput, authorId?: string | null) => Promise<RadioStationRecord>;
  deleteGuildStation?: (guildId: string, name: string) => Promise<boolean>;
  recordUserSignal?: (guildId: string, userId: string, signal: string, track?: TrackDataLike | null) => Promise<unknown>;
};
type LibraryCommandContext = CommandContextLike & {
  safeTyping?: () => Promise<unknown>;
  sessions: CommandContextLike['sessions'] & {
    markSnapshotDirty?: (session: SessionLike, flushSoon?: boolean) => void;
  };
};
type LibraryHelperBundle = {
  PLAYLIST_PAGE_SIZE: number;
  FAVORITES_PAGE_SIZE: number;
  createCommand: <T extends {
    name: string;
    aliases?: string[];
    description?: string;
    usage?: string;
    hidden?: boolean;
    execute?: (ctx: CommandContextLike) => unknown;
  }>(definition: T) => Readonly<T>;
  ensureGuild: (ctx: Pick<CommandContextLike, 'guildId' | 't'>) => void;
  requireLibrary: (ctx: CommandContextLike) => LibraryLike;
  getGuildConfigOrThrow: (ctx: CommandContextLike) => Promise<GuildConfigLike>;
  ensureDjAccessByConfig: (ctx: CommandContextLike, guildConfig: GuildConfigLike, actionLabel: TranslationKey) => void;
  userHasDjAccessByConfig: (ctx: CommandContextLike, guildConfig: GuildConfigLike) => boolean;
  ensureManageGuildAccess: (ctx: CommandContextLike, actionLabel: TranslationKey) => Promise<void>;
  parseRequiredInteger: (value: unknown, label: TranslationKey, t: Translator) => number;
  normalizeIndex: (value: unknown, label: TranslationKey, t: Translator) => number;
  trackLabel: (track: TrackLike) => string;
  ensureConnectedSession: (ctx: CommandContextLike) => Promise<SessionLike>;
  resolveQueueGuard: (ctx: CommandContextLike) => Promise<QueueGuardLike | null>;
  applyVoiceProfileIfConfigured: (ctx: CommandContextLike, session: SessionLike) => Promise<void>;
};

function toTrackLike(track: TrackDataLike | null | undefined): TrackLike {
  return {
    ...(track?.title != null ? { title: track.title } : {}),
    ...(track?.duration != null ? { duration: track.duration } : {}),
    requestedBy: track?.requestedBy ?? null,
  };
}

function formatFavoriteLine(track: TrackDataLike, absoluteIndex: number): string {
  const alias = String(track?.alias ?? '').trim();
  const title = String(track?.title ?? '').trim() || 'Unknown title';
  const duration = String(track?.duration ?? '').trim() || 'Unknown';
  const value = alias || title;
  return `${absoluteIndex}. ${value} (${duration})`;
}

function chunkLines(lines: unknown, maxChars = 1000): string[] {
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

function isHttpUrl(value: string) {
  return /^https?:\/\//i.test(value);
}

function formatStationLine(station: ResolvedRadioStation, index: number) {
  const scope = station.scope === 'guild' ? 'Guild' : 'Built-in';
  const tags = station.tags.length ? ` - ${station.tags.join(', ')}` : '';
  return `${index}. **${station.name}** [${scope}]${tags}`;
}

function paginate<T>(items: T[], page: number, pageSize: number) {
  const total = items.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.max(1, Math.min(page, totalPages));
  const start = (safePage - 1) * pageSize;
  return {
    items: items.slice(start, start + pageSize),
    page: safePage,
    pageSize,
    total,
    totalPages,
    start,
  };
}

async function validateRadioStationUrl(ctx: CommandContextLike, url: string) {
  const session = await ctx.sessions.ensure(ctx.guildId, ctx.guildConfig, {
    voiceChannelId: ctx.activeVoiceChannelId,
    textChannelId: ctx.channelId,
  });

  const preview = await session.player.previewTracks(url, {
    requestedBy: ctx.authorId,
    limit: 1,
  });
  const track = preview[0] ?? null;
  if (!track) {
    throw new ValidationError(ctx.t('station.noPlayableStream'));
  }

  if (String(track.source ?? '').trim().toLowerCase() !== 'radio-stream') {
    throw new ValidationError(ctx.t('station.notLiveStream'));
  }

  return track;
}

export function registerLibraryCommands(registry: CommandRegistry, h: LibraryHelperBundle) {
  const {
    createCommand,
    ensureGuild,
    requireLibrary,
    getGuildConfigOrThrow,
    ensureDjAccessByConfig,
    userHasDjAccessByConfig,
    ensureManageGuildAccess,
    parseRequiredInteger,
    normalizeIndex,
    trackLabel,
    ensureConnectedSession,
    resolveQueueGuard,
    applyVoiceProfileIfConfigured,
  } = h;

  registry.register(createCommand({
    name: 'playlist',
    aliases: ['pl'],
    description: 'Manage persistent guild playlists.',
    usage: 'playlist <create|add|remove|show|list|delete|play> ...',
    async execute(ctx: CommandContextLike) {
      const typedCtx = ctx as LibraryCommandContext;
      ensureGuild(ctx);
      const library = requireLibrary(ctx) as PlaylistLibrary;

      const action = String(ctx.args[0] ?? 'list').toLowerCase();
      const guildConfig = await getGuildConfigOrThrow(ctx);
      const enforceWriteAccess = () => ensureDjAccessByConfig(ctx, guildConfig, 'access.managePlaylists');

      if (action === 'list') {
        const page = ctx.args[1] ? parseRequiredInteger(ctx.args[1], 'field.page', ctx.t) : 1;
        const result = await library.listGuildPlaylists(ctx.guildId, page, h.PLAYLIST_PAGE_SIZE);
        if (!result.items.length) {
          await ctx.reply.warning(ctx.t('playlist.none'));
          return;
        }

        const lines = result.items.map((entry: PlaylistListItem, idx: number) => {
          const absolute = (result.page - 1) * result.pageSize + idx + 1;
          const suffix = Number.isFinite(entry.trackCount) ? ` (${entry.trackCount} tracks)` : '';
          return `${absolute}. **${entry.name}**${suffix}`;
        });
        const pages = chunkLines(lines, 1000);
        if (pages.length === 1) {
          await ctx.reply.info(
            ctx.t('playlist.listSummary', { page: result.page, totalPages: result.totalPages, total: result.total }),
            [{ name: ctx.t('playlist.guildPlaylists'), value: pages[0]! }]
          );
          return;
        }

        await typedCtx.sendPaginated(pages.map((value, idx) => buildSingleFieldInfoPayload(
          ctx,
          ctx.t('playlist.listTitlePaged', { current: idx + 1, total: pages.length }),
          ctx.t('playlist.pageSummary', { page: result.page, totalPages: result.totalPages, total: result.total }),
          'Guild playlists',
          value
        )));
        return;
      }

      if (action === 'create') {
        enforceWriteAccess();
        const name = ctx.args.slice(1).join(' ').trim();
        if (!name) {
          throw new ValidationError(ctx.t('playlist.usageCreate', { prefix: ctx.prefix }));
        }

        const created = await library.createGuildPlaylist(ctx.guildId, name, ctx.authorId);
        await ctx.reply.success(ctx.t('playlist.created', { name: created.name }));
        return;
      }

      if (action === 'delete') {
        enforceWriteAccess();
        const name = String(ctx.args[1] ?? '').trim();
        if (!name) {
          throw new ValidationError(ctx.t('playlist.usageDelete', { prefix: ctx.prefix }));
        }

        const removed = await library.deleteGuildPlaylist(ctx.guildId, name);
        if (!removed) {
          await ctx.reply.warning(ctx.t('playlist.notFound', { name }));
          return;
        }

        await ctx.reply.success(ctx.t('playlist.deleted', { name }));
        return;
      }

      if (action === 'show') {
        const name = String(ctx.args[1] ?? '').trim();
        if (!name) {
          throw new ValidationError(ctx.t('playlist.usageShow', { prefix: ctx.prefix }));
        }

        const page = ctx.args[2] ? parseRequiredInteger(ctx.args[2], 'field.page', ctx.t) : 1;
        const playlist = await library.getGuildPlaylist(ctx.guildId, name);
        if (!playlist) {
          await ctx.reply.warning(ctx.t('playlist.notFound', { name }));
          return;
        }

        if (!playlist.tracks.length) {
          await ctx.reply.info(ctx.t('playlist.empty', { name: playlist.name }));
          return;
        }

        const totalPages = Math.max(1, Math.ceil(playlist.tracks.length / h.PLAYLIST_PAGE_SIZE));
        const safePage = Math.max(1, Math.min(page, totalPages));
        const start = (safePage - 1) * h.PLAYLIST_PAGE_SIZE;
        const items = playlist.tracks.slice(start, start + h.PLAYLIST_PAGE_SIZE);

        const lines = items.map((track: TrackDataLike, idx: number) => `${start + idx + 1}. ${trackLabel(toTrackLike(track))}`);
        const pages = chunkLines(lines, 1000);
        if (pages.length === 1) {
          await ctx.reply.info(
            ctx.t('playlist.showSummary', { name: playlist.name, page: safePage, totalPages, count: playlist.tracks.length }),
            [{ name: ctx.t('common.tracks'), value: pages[0]! }]
          );
          return;
        }

        await typedCtx.sendPaginated(pages.map((value, idx) => buildSingleFieldInfoPayload(
          ctx,
          `Playlist ${playlist.name} (${idx + 1}/${pages.length})`,
          `Page **${safePage}/${totalPages}** • Tracks: **${playlist.tracks.length}**`,
          'Tracks',
          value
        )));
        return;
      }

      if (action === 'add') {
        enforceWriteAccess();
        const name = String(ctx.args[1] ?? '').trim();
        const query = ctx.args.slice(2).join(' ').trim();
        if (!name || !query) {
          throw new ValidationError(ctx.t('playlist.usageAdd', { prefix: ctx.prefix }));
        }

        await typedCtx.safeTyping?.();
        const session = await ctx.sessions.ensure(ctx.guildId, ctx.guildConfig, {
          voiceChannelId: ctx.activeVoiceChannelId,
          textChannelId: ctx.channelId,
        });
        const resolved = await session.player.previewTracks(query, {
          requestedBy: ctx.authorId,
          ...(typeof ctx.config.maxPlaylistTracks === 'number' ? { limit: ctx.config.maxPlaylistTracks } : {}),
        });

        if (!resolved.length) {
          await ctx.reply.warning(ctx.t('playlist.noTracksFound'));
          return;
        }

        const addResult = await library.addTracksToGuildPlaylist(ctx.guildId, name, resolved, ctx.authorId);
        await ctx.reply.success(
          ctx.t('playlist.added', { count: addResult.addedCount, name: addResult.playlistName }),
          addResult.droppedCount > 0
            ? [{ name: ctx.t('playlist.skipped'), value: ctx.t('playlist.overLimit', { count: addResult.droppedCount }) }]
            : null
        );
        return;
      }

      if (action === 'remove') {
        enforceWriteAccess();
        const name = String(ctx.args[1] ?? '').trim();
        const index = normalizeIndex(ctx.args[2], 'field.trackIndex', ctx.t);
        if (!name) {
          throw new ValidationError(ctx.t('playlist.usageRemove', { prefix: ctx.prefix }));
        }

        const removed = await library.removeTrackFromGuildPlaylist(ctx.guildId, name, index);
        await ctx.reply.success(ctx.t('playlist.removed', { name, track: trackLabel(toTrackLike(removed)) }));
        return;
      }

      if (action === 'play') {
        const name = String(ctx.args[1] ?? '').trim();
        if (!name) {
          throw new ValidationError(ctx.t('playlist.usagePlay', { prefix: ctx.prefix }));
        }

        const playlist = await library.getGuildPlaylist(ctx.guildId, name);
        if (!playlist) {
          await ctx.reply.warning(ctx.t('playlist.notFound', { name }));
          return;
        }

        if (!playlist.tracks.length) {
          await ctx.reply.warning(ctx.t('playlist.empty', { name: playlist.name }));
          return;
        }

        const session = await ensureConnectedSession(ctx);
        if (applyVoiceProfileIfConfigured) {
          await applyVoiceProfileIfConfigured(ctx, session);
        }
        const queueTracks = playlist.tracks.map((track: TrackDataLike) => session.player.createTrackFromData(track, ctx.authorId));
        const queueGuard = resolveQueueGuard ? await resolveQueueGuard(ctx) : null;
        const added = session.player.enqueueResolvedTracks(queueTracks, {
          dedupe: session.settings.dedupeEnabled,
          queueGuard,
        });

        if (!added.length) {
          await ctx.reply.warning(ctx.t('playlist.noneAdded'));
          return;
        }

        if (!session.player.playing) {
          await session.player.play();
        }

        typedCtx.sessions.markSnapshotDirty?.(session, true);
        await ctx.reply.success(ctx.t('playlist.queued', { count: added.length, name: playlist.name }));
        return;
      }

      throw new ValidationError(
        `Usage: ${ctx.prefix}playlist <create|add|remove|show|list|delete|play> ...`
      );
    },
  }));

  registry.register(createCommand({
    name: 'stations',
    aliases: ['radiolist'],
    description: 'Browse built-in and guild-saved radio presets.',
    usage: 'stations [filter] [page]',
    async execute(ctx: CommandContextLike) {
      const typedCtx = ctx as LibraryCommandContext;
      ensureGuild(ctx);
      const library = requireLibrary(ctx) as PlaylistLibrary;
      const args = [...ctx.args];
      const maybePage = args.length ? String(args[args.length - 1] ?? '').trim() : '';
      const pageProvided = /^\d+$/.test(maybePage);
      const page = pageProvided ? parseRequiredInteger(args.pop(), 'field.page', ctx.t) : 1;
      const query = args.join(' ').trim();
      const guildStations = await library.listGuildStations?.(ctx.guildId).catch(() => []) ?? [];
      const stations = listAvailableRadioStations(guildStations, query);
      if (!stations.length) {
        await ctx.reply.warning(
          query
            ? ctx.t('station.noMatch', { query })
            : ctx.t('radio.noneAvailable')
        );
        return;
      }

      if (!pageProvided) {
        const totalPages = Math.max(1, Math.ceil(stations.length / h.PLAYLIST_PAGE_SIZE));
        if (totalPages > 1) {
          const payloads = [];
          for (let nextPage = 1; nextPage <= totalPages; nextPage += 1) {
            const next = paginate(stations, nextPage, h.PLAYLIST_PAGE_SIZE);
            const lines = next.items.map((station, idx) => formatStationLine(station, next.start + idx + 1));
            const summary = query
              ? ctx.t('station.listSummaryQuery', { query, page: next.page, totalPages: next.totalPages, total: next.total })
              : ctx.t('station.listSummary', { page: next.page, totalPages: next.totalPages, total: next.total });
            payloads.push(buildInfoPayload(ctx, ctx.t('station.stations'), summary, [
              { name: ctx.t('station.stations'), value: lines.join('\n') || '-' },
              { name: ctx.t('station.use'), value: `\`${ctx.prefix}radio <number|name|url>\`` },
            ]));
          }

          await typedCtx.sendPaginated(payloads);
          return;
        }
      }

      const result = paginate(stations, page, h.PLAYLIST_PAGE_SIZE);
      const lines = result.items.map((station, idx) => formatStationLine(station, result.start + idx + 1));
      const pages = chunkLines(lines, 1000);
      const summary = query
        ? ctx.t('station.listSummaryQuery', { query, page: result.page, totalPages: result.totalPages, total: result.total })
        : ctx.t('station.listSummary', { page: result.page, totalPages: result.totalPages, total: result.total });

      if (pages.length === 1) {
        await ctx.reply.info(summary, [
          { name: ctx.t('station.stations'), value: pages[0]! },
          { name: ctx.t('station.use'), value: `\`${ctx.prefix}radio <number|name|url>\`` },
        ]);
        return;
      }

      await typedCtx.sendPaginated(pages.map((value, idx) => buildSingleFieldInfoPayload(
        ctx,
        `Stations (${idx + 1}/${pages.length})`,
        summary,
        'Stations',
        value
      )));
    },
  }));

  registry.register(createCommand({
    name: 'station',
    aliases: ['presetstation'],
    description: 'Manage guild radio station presets.',
    usage: 'station <list|show|save|delete> ...',
    async execute(ctx: CommandContextLike) {
      const typedCtx = ctx as LibraryCommandContext;
      ensureGuild(ctx);
      const library = requireLibrary(ctx) as PlaylistLibrary;
      const action = String(ctx.args[0] ?? 'list').trim().toLowerCase();
      const guildConfig = await getGuildConfigOrThrow(ctx);
      const enforceWriteAccess = async () => {
        const configuredDjRoles = guildConfig?.settings?.djRoleIds;
        const hasConfiguredDjRoles = Array.isArray(configuredDjRoles) && configuredDjRoles.length > 0;
        if (hasConfiguredDjRoles && userHasDjAccessByConfig(ctx, guildConfig)) return;
        await ensureManageGuildAccess(ctx, 'access.manageStations');
      };

      if (action === 'list') {
        const pageProvided = Boolean(ctx.args[1]);
        const page = pageProvided ? parseRequiredInteger(ctx.args[1], 'field.page', ctx.t) : 1;
        const guildStations = await library.listGuildStations?.(ctx.guildId).catch(() => []) ?? [];
        if (!guildStations.length) {
          await ctx.reply.warning(ctx.t('station.noneSaved'));
          return;
        }

        const resolved = listAvailableRadioStations(guildStations)
          .filter((station) => station.scope === 'guild');
        if (!pageProvided) {
          const totalPages = Math.max(1, Math.ceil(resolved.length / h.PLAYLIST_PAGE_SIZE));
          if (totalPages > 1) {
            const payloads = [];
            for (let nextPage = 1; nextPage <= totalPages; nextPage += 1) {
              const next = paginate(resolved, nextPage, h.PLAYLIST_PAGE_SIZE);
              const value = next.items.map((station, idx) => formatStationLine(station, next.start + idx + 1)).join('\n') || '-';
              payloads.push(buildSingleFieldInfoPayload(
                ctx,
                'Guild radio presets',
                `Page **${next.page}/${next.totalPages}** • Total: **${next.total}**`,
                'Presets',
                value
              ));
            }
            await typedCtx.sendPaginated(payloads);
            return;
          }
        }

        const result = paginate(resolved, page, h.PLAYLIST_PAGE_SIZE);
        const lines = result.items.map((station, idx) => formatStationLine(station, result.start + idx + 1));
        const pages = chunkLines(lines, 1000);
        const summary = `Guild radio presets • Page **${result.page}/${result.totalPages}** • Total: **${result.total}**`;

        if (pages.length === 1) {
          await ctx.reply.info(summary, [{ name: ctx.t('station.presets'), value: pages[0]! }]);
          return;
        }

        await typedCtx.sendPaginated(pages.map((value, idx) => buildSingleFieldInfoPayload(
          ctx,
          `Guild radio presets (${idx + 1}/${pages.length})`,
          summary,
          'Presets',
          value
        )));
        return;
      }

      if (action === 'show') {
        const query = ctx.args.slice(1).join(' ').trim();
        if (!query) {
          throw new ValidationError(ctx.t('station.usageShow', { prefix: ctx.prefix }));
        }

        const guildStations = await library.listGuildStations?.(ctx.guildId).catch(() => []) ?? [];
        const selection = resolveRadioStationSelection(guildStations, query);
        if (!selection.station) {
          if (selection.matches.length) {
            await ctx.reply.info(ctx.t('radio.multipleMatches', { query }), [
              { name: ctx.t('radio.matches'), value: selection.matches.map((station, idx) => formatStationLine(station, idx + 1)).join('\n') },
            ]);
            return;
          }
          await ctx.reply.warning(ctx.t('station.notFound', { name: query }));
          return;
        }

        const station = selection.station;
        await ctx.reply.info(ctx.t('station.showTitle', { name: station.name }), [
          { name: ctx.t('common.source'), value: station.scope === 'guild' ? ctx.t('station.guildPreset') : ctx.t('station.builtinPreset'), inline: true },
          { name: ctx.t('station.tags'), value: station.tags.length ? station.tags.join(', ') : '-', inline: true },
          { name: ctx.t('station.url'), value: station.url },
          ...(station.description ? [{ name: ctx.t('station.description'), value: station.description }] : []),
        ]);
        return;
      }

      if (action === 'save') {
        await enforceWriteAccess();
        const url = String(ctx.args[ctx.args.length - 1] ?? '').trim();
        const name = ctx.args.slice(1, -1).join(' ').trim();
        if (!name || !isHttpUrl(url)) {
          throw new ValidationError(ctx.t('station.usageSave', { prefix: ctx.prefix }));
        }

        await typedCtx.safeTyping?.();
        const validatedTrack = await validateRadioStationUrl(ctx, url);
        const saved = await library.setGuildStation?.(ctx.guildId, name, {
          url: String(validatedTrack.url ?? url).trim() || url,
          description: null,
          tags: [],
        }, ctx.authorId);
        if (!saved) {
          throw new ValidationError(ctx.t('station.storageUnavailable'));
        }

        await ctx.reply.success(ctx.t('station.saved', { name: saved.name ?? name }), [
          { name: ctx.t('station.resolvedStream'), value: String(validatedTrack.url ?? url).trim() || url },
        ]);
        return;
      }

      if (action === 'delete') {
        await enforceWriteAccess();
        const name = ctx.args.slice(1).join(' ').trim();
        if (!name) {
          throw new ValidationError(ctx.t('station.usageDelete', { prefix: ctx.prefix }));
        }

        const removed = await library.deleteGuildStation?.(ctx.guildId, name);
        if (!removed) {
          await ctx.reply.warning(ctx.t('station.presetNotFound', { name }));
          return;
        }

        await ctx.reply.success(ctx.t('station.deleted', { name }));
        return;
      }

      throw new ValidationError(ctx.t('station.usage', { prefix: ctx.prefix }));
    },
  }));

  registry.register(createCommand({
    name: 'fav',
    aliases: ['favorite'],
    description: 'Save current track (or query) to your persistent favorites.',
    usage: 'fav [query|url]',
    async execute(ctx: CommandContextLike) {
      const library = requireLibrary(ctx) as PlaylistLibrary;
      if (!ctx.authorId) {
        throw new ValidationError(ctx.t('favorites.userIdUnresolved'));
      }

      let baseTrack = null;
      const query = ctx.args.join(' ').trim();

      if (query) {
        ensureGuild(ctx);
        const session = await ctx.sessions.ensure(ctx.guildId, ctx.guildConfig, {
          voiceChannelId: ctx.activeVoiceChannelId,
          textChannelId: ctx.channelId,
        });
        const preview = await session.player.previewTracks(query, {
          requestedBy: ctx.authorId,
          limit: 1,
        });
        baseTrack = preview[0] ?? null;
      } else if (ctx.guildId) {
        const session = ctx.sessions.get(ctx.guildId, {
          voiceChannelId: ctx.activeVoiceChannelId,
          textChannelId: ctx.channelId,
        });
        baseTrack = session?.player?.currentTrack ?? null;
      }

      if (!baseTrack) {
        throw new ValidationError(ctx.t('favorites.nothingToSave'));
      }

      const result = await library.addUserFavorite(ctx.authorId, baseTrack);
      if (!result.added) {
        await ctx.reply.info(ctx.t('favorites.alreadySaved'));
        return;
      }

      if (library.recordUserSignal) {
        await library.recordUserSignal?.(
          ctx.guildId ?? '000000',
          ctx.authorId,
          'favorite',
          baseTrack
        ).catch(() => null);
      }

      await ctx.reply.success(ctx.t('favorites.saved', { track: trackLabel(toTrackLike(result.track)) }));
    },
  }));

  registry.register(createCommand({
    name: 'favs',
    aliases: ['favorites'],
    description: 'List your persistent favorites.',
    usage: 'favs [page]',
    async execute(ctx: CommandContextLike) {
      const typedCtx = ctx as LibraryCommandContext;
      const library = requireLibrary(ctx) as PlaylistLibrary;
      if (!ctx.authorId) {
        throw new ValidationError(ctx.t('favorites.userIdUnresolved'));
      }

      const page = ctx.args.length ? parseRequiredInteger(ctx.args[0], 'field.page', ctx.t) : 1;
      const result = await library.listUserFavorites(ctx.authorId, page, h.FAVORITES_PAGE_SIZE);
      if (!result.items.length) {
        await ctx.reply.warning(ctx.t('favorites.empty'));
        return;
      }

      const lines = result.items.map((track: TrackDataLike, idx: number) => formatFavoriteLine(
        track,
        (result.page - 1) * result.pageSize + idx + 1
      ));
      const pages = chunkLines(lines, 1000);
      if (pages.length === 1) {
        await ctx.reply.info(
          `Favorites page **${result.page}/${result.totalPages}** • Total: **${result.total}**`,
          [{ name: ctx.t('favorites.yours'), value: pages[0]! }]
        );
        return;
      }

      await typedCtx.sendPaginated(pages.map((value, idx) => buildSingleFieldInfoPayload(
        ctx,
        `Favorites (${idx + 1}/${pages.length})`,
        `Page **${result.page}/${result.totalPages}** • Total: **${result.total}**`,
        'Your favorites',
        value
      )));
    },
  }));

  registry.register(createCommand({
    name: 'favname',
    aliases: ['fn'],
    description: 'Set a custom alias name for one of your favorites.',
    usage: 'favname <index> <alias>',
    async execute(ctx: CommandContextLike) {
      const library = requireLibrary(ctx) as PlaylistLibrary;
      if (!ctx.authorId) {
        throw new ValidationError(ctx.t('favorites.userIdUnresolved'));
      }

      const index = normalizeIndex(ctx.args[0], 'field.index', ctx.t);
      const alias = ctx.args.slice(1).join(' ').trim();
      if (!alias) {
        throw new ValidationError(ctx.t('favorites.usageRename', { prefix: ctx.prefix }));
      }

      const renamed = await library.renameUserFavorite(ctx.authorId, index, alias);
      if (!renamed) {
        await ctx.reply.warning(ctx.t('favorites.indexOutOfRange'));
        return;
      }

      await ctx.reply.success(ctx.t('favorites.aliasUpdated', { alias: String(renamed.alias ?? alias).trim() }));
    },
  }));

  registry.register(createCommand({
    name: 'ufav',
    aliases: ['unfav'],
    description: 'Remove a favorite by index.',
    usage: 'ufav <index>',
    async execute(ctx: CommandContextLike) {
      const library = requireLibrary(ctx) as PlaylistLibrary;
      if (!ctx.authorId) {
        throw new ValidationError(ctx.t('favorites.userIdUnresolved'));
      }

      const index = normalizeIndex(ctx.args[0], 'field.index', ctx.t);
      const removed = await library.removeUserFavorite(ctx.authorId, index);
      if (!removed) {
        await ctx.reply.warning(ctx.t('favorites.indexOutOfRange'));
        return;
      }

      await ctx.reply.success(ctx.t('favorites.removed', { track: trackLabel(toTrackLike(removed)) }));
    },
  }));

  registry.register(createCommand({
    name: 'favplay',
    aliases: ['fp'],
    description: 'Queue one of your favorites by index or alias.',
    usage: 'favplay <index|alias>',
    async execute(ctx: CommandContextLike) {
      const typedCtx = ctx as LibraryCommandContext;
      ensureGuild(ctx);
      const library = requireLibrary(ctx) as PlaylistLibrary;
      if (!ctx.authorId) {
        throw new ValidationError(ctx.t('favorites.userIdUnresolved'));
      }

      const selector = ctx.args.join(' ').trim();
      if (!selector) {
        throw new ValidationError(ctx.t('favorites.usagePlay', { prefix: ctx.prefix }));
      }
      const favorite = /^\d+$/.test(selector)
        ? await library.getUserFavorite(ctx.authorId, normalizeIndex(selector, 'field.index', ctx.t))
        : await library.getUserFavoriteByAlias(ctx.authorId, selector);
      if (!favorite) {
        await ctx.reply.warning(/^\d+$/.test(selector) ? ctx.t('favorites.indexOutOfRange') : ctx.t('favorites.aliasNotFound'));
        return;
      }

      const session = await ensureConnectedSession(ctx);
      if (applyVoiceProfileIfConfigured) {
        await applyVoiceProfileIfConfigured(ctx, session);
      }
      const track = session.player.createTrackFromData(favorite, ctx.authorId);
      const queueGuard = resolveQueueGuard ? await resolveQueueGuard(ctx) : null;
      const added = session.player.enqueueResolvedTracks([track], {
        dedupe: session.settings.dedupeEnabled,
        queueGuard,
      });
      if (!added.length) {
        await ctx.reply.warning(ctx.t('favorites.duplicate'));
        return;
      }

      if (!session.player.playing) {
        await session.player.play();
      }

      typedCtx.sessions.markSnapshotDirty?.(session, true);
      await ctx.reply.success(`Added favorite to queue: ${trackLabel(toTrackLike(added[0] ?? null))}`);
    },
  }));
}


