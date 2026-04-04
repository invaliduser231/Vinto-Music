import { ValidationError } from '../../core/errors.ts';
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
  ensureGuild: (ctx: Pick<CommandContextLike, 'guildId'>) => void;
  requireLibrary: (ctx: CommandContextLike) => LibraryLike;
  getGuildConfigOrThrow: (ctx: CommandContextLike) => Promise<GuildConfigLike>;
  ensureDjAccessByConfig: (ctx: CommandContextLike, guildConfig: GuildConfigLike, actionLabel: string) => void;
  parseRequiredInteger: (value: unknown, label: string) => number;
  normalizeIndex: (value: unknown, label: string) => number;
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
  ctx.sessions.bindTextChannel(ctx.guildId, ctx.channelId, {
    voiceChannelId: ctx.activeVoiceChannelId,
    textChannelId: ctx.channelId,
  });

  const preview = await session.player.previewTracks(url, {
    requestedBy: ctx.authorId,
    limit: 1,
  });
  const track = preview[0] ?? null;
  if (!track) {
    throw new ValidationError('No playable stream found for that station URL.');
  }

  if (String(track.source ?? '').trim().toLowerCase() !== 'radio-stream') {
    throw new ValidationError('That URL resolved to a normal track/file, not a live radio stream.');
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
      const enforceWriteAccess = () => ensureDjAccessByConfig(ctx, guildConfig, 'manage playlists');

      if (action === 'list') {
        const page = ctx.args[1] ? parseRequiredInteger(ctx.args[1], 'Page') : 1;
        const result = await library.listGuildPlaylists(ctx.guildId, page, h.PLAYLIST_PAGE_SIZE);
        if (!result.items.length) {
          await ctx.reply.warning('No playlists in this guild yet.');
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
            `Playlists page **${result.page}/${result.totalPages}** • Total: **${result.total}**`,
            [{ name: 'Guild playlists', value: pages[0]! }]
          );
          return;
        }

        await typedCtx.sendPaginated(pages.map((value, idx) => buildSingleFieldInfoPayload(
          ctx,
          `Guild playlists (${idx + 1}/${pages.length})`,
          `Page **${result.page}/${result.totalPages}** • Total: **${result.total}**`,
          'Guild playlists',
          value
        )));
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

        const totalPages = Math.max(1, Math.ceil(playlist.tracks.length / h.PLAYLIST_PAGE_SIZE));
        const safePage = Math.max(1, Math.min(page, totalPages));
        const start = (safePage - 1) * h.PLAYLIST_PAGE_SIZE;
        const items = playlist.tracks.slice(start, start + h.PLAYLIST_PAGE_SIZE);

        const lines = items.map((track: TrackDataLike, idx: number) => `${start + idx + 1}. ${trackLabel(toTrackLike(track))}`);
        const pages = chunkLines(lines, 1000);
        if (pages.length === 1) {
          await ctx.reply.info(
            `Playlist **${playlist.name}** • Page **${safePage}/${totalPages}** • Tracks: **${playlist.tracks.length}**`,
            [{ name: 'Tracks', value: pages[0]! }]
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
          throw new ValidationError(`Usage: ${ctx.prefix}playlist add <name> <query|url>`);
        }

        await typedCtx.safeTyping?.();
        const session = await ctx.sessions.ensure(ctx.guildId, ctx.guildConfig, {
          voiceChannelId: ctx.activeVoiceChannelId,
          textChannelId: ctx.channelId,
        });
        ctx.sessions.bindTextChannel(ctx.guildId, ctx.channelId, {
          voiceChannelId: ctx.activeVoiceChannelId,
          textChannelId: ctx.channelId,
        });
        const resolved = await session.player.previewTracks(query, {
          requestedBy: ctx.authorId,
          ...(typeof ctx.config.maxPlaylistTracks === 'number' ? { limit: ctx.config.maxPlaylistTracks } : {}),
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
        await ctx.reply.success(`Removed from **${name}**: ${trackLabel(toTrackLike(removed))}`);
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
          await ctx.reply.warning('No tracks were added (likely duplicates with dedupe enabled).');
          return;
        }

        if (!session.player.playing) {
          await session.player.play();
        }

        typedCtx.sessions.markSnapshotDirty?.(session, true);
        await ctx.reply.success(`Queued **${added.length}** track(s) from playlist **${playlist.name}**.`);
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
      const page = pageProvided ? parseRequiredInteger(args.pop(), 'Page') : 1;
      const query = args.join(' ').trim();
      const guildStations = await library.listGuildStations?.(ctx.guildId).catch(() => []) ?? [];
      const stations = listAvailableRadioStations(guildStations, query);
      if (!stations.length) {
        await ctx.reply.warning(
          query
            ? `No radio stations matched **${query}**.`
            : 'No radio stations are available yet.'
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
              ? `Stations for **${query}** • Page **${next.page}/${next.totalPages}** • Total: **${next.total}**`
              : `Radio stations • Page **${next.page}/${next.totalPages}** • Total: **${next.total}**`;
            payloads.push(buildInfoPayload(ctx, 'Stations', summary, [
              { name: 'Stations', value: lines.join('\n') || '-' },
              { name: 'Use', value: `\`${ctx.prefix}radio <number|name|url>\`` },
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
        ? `Stations for **${query}** • Page **${result.page}/${result.totalPages}** • Total: **${result.total}**`
        : `Radio stations • Page **${result.page}/${result.totalPages}** • Total: **${result.total}**`;

      if (pages.length === 1) {
        await ctx.reply.info(summary, [
          { name: 'Stations', value: pages[0]! },
          { name: 'Use', value: `\`${ctx.prefix}radio <number|name|url>\`` },
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
      const enforceWriteAccess = () => ensureDjAccessByConfig(ctx, guildConfig, 'manage radio presets');

      if (action === 'list') {
        const pageProvided = Boolean(ctx.args[1]);
        const page = pageProvided ? parseRequiredInteger(ctx.args[1], 'Page') : 1;
        const guildStations = await library.listGuildStations?.(ctx.guildId).catch(() => []) ?? [];
        if (!guildStations.length) {
          await ctx.reply.warning('No guild radio presets saved yet.');
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
          await ctx.reply.info(summary, [{ name: 'Presets', value: pages[0]! }]);
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
          throw new ValidationError(`Usage: ${ctx.prefix}station show <name>`);
        }

        const guildStations = await library.listGuildStations?.(ctx.guildId).catch(() => []) ?? [];
        const selection = resolveRadioStationSelection(guildStations, query);
        if (!selection.station) {
          if (selection.matches.length) {
            await ctx.reply.info(`Multiple stations matched **${query}**.`, [
              { name: 'Matches', value: selection.matches.map((station, idx) => formatStationLine(station, idx + 1)).join('\n') },
            ]);
            return;
          }
          await ctx.reply.warning(`Station **${query}** not found.`);
          return;
        }

        const station = selection.station;
        await ctx.reply.info(`Station: **${station.name}**`, [
          { name: 'Source', value: station.scope === 'guild' ? 'Guild preset' : 'Built-in preset', inline: true },
          { name: 'Tags', value: station.tags.length ? station.tags.join(', ') : '-', inline: true },
          { name: 'URL', value: station.url },
          ...(station.description ? [{ name: 'Description', value: station.description }] : []),
        ]);
        return;
      }

      if (action === 'save') {
        enforceWriteAccess();
        const url = String(ctx.args[ctx.args.length - 1] ?? '').trim();
        const name = ctx.args.slice(1, -1).join(' ').trim();
        if (!name || !isHttpUrl(url)) {
          throw new ValidationError(`Usage: ${ctx.prefix}station save <name> <http(s) url>`);
        }

        await typedCtx.safeTyping?.();
        const validatedTrack = await validateRadioStationUrl(ctx, url);
        const saved = await library.setGuildStation?.(ctx.guildId, name, {
          url: String(validatedTrack.url ?? url).trim() || url,
          description: null,
          tags: [],
        }, ctx.authorId);
        if (!saved) {
          throw new ValidationError('Guild station storage is unavailable.');
        }

        await ctx.reply.success(`Saved radio preset **${saved.name ?? name}**.`, [
          { name: 'Resolved Stream', value: String(validatedTrack.url ?? url).trim() || url },
        ]);
        return;
      }

      if (action === 'delete') {
        enforceWriteAccess();
        const name = ctx.args.slice(1).join(' ').trim();
        if (!name) {
          throw new ValidationError(`Usage: ${ctx.prefix}station delete <name>`);
        }

        const removed = await library.deleteGuildStation?.(ctx.guildId, name);
        if (!removed) {
          await ctx.reply.warning(`Guild radio preset **${name}** not found.`);
          return;
        }

        await ctx.reply.success(`Deleted radio preset **${name}**.`);
        return;
      }

      throw new ValidationError(`Usage: ${ctx.prefix}station <list|show|save|delete> ...`);
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
        throw new ValidationError('Cannot resolve your user id for favorites.');
      }

      let baseTrack = null;
      const query = ctx.args.join(' ').trim();

      if (query) {
        ensureGuild(ctx);
        const session = await ctx.sessions.ensure(ctx.guildId, ctx.guildConfig, {
          voiceChannelId: ctx.activeVoiceChannelId,
          textChannelId: ctx.channelId,
        });
        ctx.sessions.bindTextChannel(ctx.guildId, ctx.channelId, {
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
        throw new ValidationError('Nothing to favorite. Play a track or provide a query.');
      }

      const result = await library.addUserFavorite(ctx.authorId, baseTrack);
      if (!result.added) {
        await ctx.reply.info('Track is already in your favorites.');
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

      await ctx.reply.success(`Saved to favorites: ${trackLabel(toTrackLike(result.track))}`);
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
        throw new ValidationError('Cannot resolve your user id for favorites.');
      }

      const page = ctx.args.length ? parseRequiredInteger(ctx.args[0], 'Page') : 1;
      const result = await library.listUserFavorites(ctx.authorId, page, h.FAVORITES_PAGE_SIZE);
      if (!result.items.length) {
        await ctx.reply.warning('You have no favorite tracks yet.');
        return;
      }

      const lines = result.items.map((track: TrackDataLike, idx: number) => `${(result.page - 1) * result.pageSize + idx + 1}. ${trackLabel(toTrackLike(track))}`);
      const pages = chunkLines(lines, 1000);
      if (pages.length === 1) {
        await ctx.reply.info(
          `Favorites page **${result.page}/${result.totalPages}** • Total: **${result.total}**`,
          [{ name: 'Your favorites', value: pages[0]! }]
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
    name: 'ufav',
    aliases: ['unfav'],
    description: 'Remove a favorite by index.',
    usage: 'ufav <index>',
    async execute(ctx: CommandContextLike) {
      const library = requireLibrary(ctx) as PlaylistLibrary;
      if (!ctx.authorId) {
        throw new ValidationError('Cannot resolve your user id for favorites.');
      }

      const index = normalizeIndex(ctx.args[0], 'Index');
      const removed = await library.removeUserFavorite(ctx.authorId, index);
      if (!removed) {
        await ctx.reply.warning('Favorite index out of range.');
        return;
      }

      await ctx.reply.success(`Removed favorite: ${trackLabel(toTrackLike(removed))}`);
    },
  }));

  registry.register(createCommand({
    name: 'favplay',
    aliases: ['fp'],
    description: 'Queue one of your favorites by index.',
    usage: 'favplay <index>',
    async execute(ctx: CommandContextLike) {
      const typedCtx = ctx as LibraryCommandContext;
      ensureGuild(ctx);
      const library = requireLibrary(ctx) as PlaylistLibrary;
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
        await ctx.reply.warning('Favorite is already in queue (dedupe enabled).');
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


