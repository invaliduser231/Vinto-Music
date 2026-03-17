import { ValidationError } from '../../core/errors.js';
import { buildSingleFieldInfoPayload } from './responseUtils.js';

function chunkLines(lines, maxChars = 1000) {
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

export function registerLibraryCommands(registry, h) {
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
    async execute(ctx) {
      ensureGuild(ctx);
      const library = requireLibrary(ctx);

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

        const lines = result.items.map((entry, idx) => {
          const absolute = (result.page - 1) * result.pageSize + idx + 1;
          const suffix = Number.isFinite(entry.trackCount) ? ` (${entry.trackCount} tracks)` : '';
          return `${absolute}. **${entry.name}**${suffix}`;
        });
        const pages = chunkLines(lines, 1000);
        if (pages.length === 1) {
          await ctx.reply.info(
            `Playlists page **${result.page}/${result.totalPages}** • Total: **${result.total}**`,
            [{ name: 'Guild playlists', value: pages[0] }]
          );
          return;
        }

        await ctx.sendPaginated(pages.map((value, idx) => buildSingleFieldInfoPayload(
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

        const lines = items.map((track, idx) => `${start + idx + 1}. ${trackLabel(track)}`);
        const pages = chunkLines(lines, 1000);
        if (pages.length === 1) {
          await ctx.reply.info(
            `Playlist **${playlist.name}** • Page **${safePage}/${totalPages}** • Tracks: **${playlist.tracks.length}**`,
            [{ name: 'Tracks', value: pages[0] }]
          );
          return;
        }

        await ctx.sendPaginated(pages.map((value, idx) => buildSingleFieldInfoPayload(
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

        await ctx.safeTyping();
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
        if (applyVoiceProfileIfConfigured) {
          await applyVoiceProfileIfConfigured(ctx, session);
        }
        const queueTracks = playlist.tracks.map((track) => session.player.createTrackFromData(track, ctx.authorId));
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

        ctx.sessions.markSnapshotDirty?.(session, true);
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
        await library.recordUserSignal(
          ctx.guildId ?? '000000',
          ctx.authorId,
          'favorite',
          baseTrack
        ).catch(() => null);
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
      const result = await library.listUserFavorites(ctx.authorId, page, h.FAVORITES_PAGE_SIZE);
      if (!result.items.length) {
        await ctx.reply.warning('You have no favorite tracks yet.');
        return;
      }

      const lines = result.items.map((track, idx) => `${(result.page - 1) * result.pageSize + idx + 1}. ${trackLabel(track)}`);
      const pages = chunkLines(lines, 1000);
      if (pages.length === 1) {
        await ctx.reply.info(
          `Favorites page **${result.page}/${result.totalPages}** • Total: **${result.total}**`,
          [{ name: 'Your favorites', value: pages[0] }]
        );
        return;
      }

      await ctx.sendPaginated(pages.map((value, idx) => buildSingleFieldInfoPayload(
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

      await ctx.reply.success(`Added favorite to queue: ${trackLabel(added[0])}`);
    },
  }));
}
