import { ValidationError } from '../../core/errors.js';

const DEFAULT_PAGE_SIZE = 10;

function toPositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeGuildId(guildId) {
  const value = String(guildId ?? '').trim();
  if (!/^\d{6,}$/.test(value)) {
    throw new ValidationError('A valid guild id is required.');
  }
  return value;
}

function normalizeUserId(userId) {
  const value = String(userId ?? '').trim();
  if (!/^\d{6,}$/.test(value)) {
    throw new ValidationError('A valid user id is required.');
  }
  return value;
}

function normalizePlaylistName(name) {
  const value = String(name ?? '').trim();
  if (!value) {
    throw new ValidationError('Playlist name is required.');
  }
  if (value.length > 80) {
    throw new ValidationError('Playlist name must be at most 80 characters.');
  }
  return value;
}

function normalizePlaylistNameKey(name) {
  return normalizePlaylistName(name).toLowerCase();
}

function normalizeTrack(track, fallbackRequester = null) {
  const title = String(track?.title ?? '').trim() || 'Unknown title';
  const url = String(track?.url ?? '').trim();
  const duration = String(track?.duration ?? 'Unknown').trim() || 'Unknown';
  const source = String(track?.source ?? 'unknown').trim() || 'unknown';
  const requestedBy = track?.requestedBy != null
    ? String(track.requestedBy)
    : (fallbackRequester ? String(fallbackRequester) : null);

  if (!url) {
    throw new ValidationError('Track is missing URL.');
  }

  return {
    title: title.slice(0, 256),
    url: url.slice(0, 1024),
    duration: duration.slice(0, 32),
    source: source.slice(0, 64),
    requestedBy: requestedBy ? requestedBy.slice(0, 64) : null,
    savedAt: new Date(),
  };
}

function paginateList(items, page, pageSize) {
  const total = items.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.max(1, Math.min(page, totalPages));
  const start = (safePage - 1) * pageSize;
  const slice = items.slice(start, start + pageSize);

  return {
    items: slice,
    page: safePage,
    pageSize,
    total,
    totalPages,
  };
}

export class MusicLibraryStore {
  constructor(options = {}) {
    this.guildPlaylists = options.guildPlaylistsCollection;
    this.userFavorites = options.userFavoritesCollection;
    this.guildHistory = options.guildHistoryCollection;
    this.logger = options.logger;

    this.maxPlaylistsPerGuild = toPositiveInt(options.maxPlaylistsPerGuild, 100);
    this.maxTracksPerPlaylist = toPositiveInt(options.maxTracksPerPlaylist, 500);
    this.maxFavoritesPerUser = toPositiveInt(options.maxFavoritesPerUser, 500);
    this.maxHistoryTracks = toPositiveInt(options.maxHistoryTracks, 200);
  }

  async init() {
    await this.guildPlaylists.createIndex({ guildId: 1, nameKey: 1 }, { unique: true });
    await this.guildPlaylists.createIndex({ guildId: 1, updatedAt: -1 });

    await this.userFavorites.createIndex({ userId: 1 }, { unique: true });
    await this.userFavorites.createIndex({ updatedAt: -1 });

    await this.guildHistory.createIndex({ guildId: 1 }, { unique: true });
    await this.guildHistory.createIndex({ updatedAt: -1 });

    this.logger?.info?.('Music library store ready', {
      maxPlaylistsPerGuild: this.maxPlaylistsPerGuild,
      maxTracksPerPlaylist: this.maxTracksPerPlaylist,
      maxFavoritesPerUser: this.maxFavoritesPerUser,
      maxHistoryTracks: this.maxHistoryTracks,
    });
  }

  async createGuildPlaylist(guildId, name, createdBy) {
    const normalizedGuildId = normalizeGuildId(guildId);
    const normalizedName = normalizePlaylistName(name);
    const nameKey = normalizePlaylistNameKey(name);

    const existing = await this.guildPlaylists.findOne({
      guildId: normalizedGuildId,
      nameKey,
    });
    if (existing) {
      throw new ValidationError(`Playlist "${normalizedName}" already exists.`);
    }

    const count = await this.guildPlaylists.countDocuments({ guildId: normalizedGuildId });
    if (count >= this.maxPlaylistsPerGuild) {
      throw new ValidationError(`Playlist limit reached (${this.maxPlaylistsPerGuild} per guild).`);
    }

    const now = new Date();
    const doc = {
      guildId: normalizedGuildId,
      name: normalizedName,
      nameKey,
      tracks: [],
      createdBy: createdBy ? String(createdBy) : null,
      createdAt: now,
      updatedAt: now,
    };

    await this.guildPlaylists.insertOne(doc);
    return {
      ...doc,
      tracks: [],
    };
  }

  async deleteGuildPlaylist(guildId, name) {
    const normalizedGuildId = normalizeGuildId(guildId);
    const nameKey = normalizePlaylistNameKey(name);
    const result = await this.guildPlaylists.deleteOne({
      guildId: normalizedGuildId,
      nameKey,
    });
    return result.deletedCount > 0;
  }

  async listGuildPlaylists(guildId, page = 1, pageSize = DEFAULT_PAGE_SIZE) {
    const normalizedGuildId = normalizeGuildId(guildId);
    const safePage = toPositiveInt(page, 1);
    const safePageSize = toPositiveInt(pageSize, DEFAULT_PAGE_SIZE);

    const total = await this.guildPlaylists.countDocuments({ guildId: normalizedGuildId });
    const totalPages = Math.max(1, Math.ceil(total / safePageSize));
    const boundedPage = Math.max(1, Math.min(safePage, totalPages));
    const skip = (boundedPage - 1) * safePageSize;

    const docs = await this.guildPlaylists
      .find({ guildId: normalizedGuildId }, { projection: { _id: 0 } })
      .sort({ nameKey: 1 })
      .skip(skip)
      .limit(safePageSize)
      .toArray();

    return {
      items: docs.map((doc) => ({
        name: doc.name,
        createdBy: doc.createdBy ?? null,
        trackCount: Array.isArray(doc.tracks) ? doc.tracks.length : undefined,
        createdAt: doc.createdAt ?? null,
        updatedAt: doc.updatedAt ?? null,
      })),
      total,
      page: boundedPage,
      pageSize: safePageSize,
      totalPages,
    };
  }

  async getGuildPlaylist(guildId, name) {
    const normalizedGuildId = normalizeGuildId(guildId);
    const nameKey = normalizePlaylistNameKey(name);
    const doc = await this.guildPlaylists.findOne({
      guildId: normalizedGuildId,
      nameKey,
    }, {
      projection: { _id: 0 },
    });

    if (!doc) return null;
    return {
      guildId: doc.guildId,
      name: doc.name,
      tracks: Array.isArray(doc.tracks) ? doc.tracks : [],
      createdBy: doc.createdBy ?? null,
      createdAt: doc.createdAt ?? null,
      updatedAt: doc.updatedAt ?? null,
    };
  }

  async addTracksToGuildPlaylist(guildId, name, tracks, addedBy = null) {
    const normalizedGuildId = normalizeGuildId(guildId);
    const normalizedName = normalizePlaylistName(name);
    const nameKey = normalizePlaylistNameKey(name);

    const current = await this.guildPlaylists.findOne({
      guildId: normalizedGuildId,
      nameKey,
    });
    if (!current) {
      throw new ValidationError(`Playlist "${normalizedName}" does not exist.`);
    }

    const nextTracks = Array.isArray(tracks) ? tracks : [];
    if (!nextTracks.length) {
      throw new ValidationError('No tracks to add.');
    }

    const sanitized = [];
    for (const track of nextTracks) {
      sanitized.push(normalizeTrack(track, addedBy));
    }

    const currentTracks = Array.isArray(current.tracks) ? current.tracks : [];
    const remainingSlots = this.maxTracksPerPlaylist - currentTracks.length;
    if (remainingSlots <= 0) {
      throw new ValidationError(`Playlist track limit reached (${this.maxTracksPerPlaylist}).`);
    }

    const toAdd = sanitized.slice(0, remainingSlots);
    const now = new Date();

    await this.guildPlaylists.updateOne(
      { guildId: normalizedGuildId, nameKey },
      {
        $push: { tracks: { $each: toAdd } },
        $set: { updatedAt: now },
      }
    );

    return {
      playlistName: current.name,
      addedCount: toAdd.length,
      droppedCount: sanitized.length - toAdd.length,
      totalTracks: currentTracks.length + toAdd.length,
    };
  }

  async removeTrackFromGuildPlaylist(guildId, name, index) {
    const normalizedGuildId = normalizeGuildId(guildId);
    const normalizedName = normalizePlaylistName(name);
    const nameKey = normalizePlaylistNameKey(name);
    const safeIndex = toPositiveInt(index, 0);
    if (safeIndex <= 0) {
      throw new ValidationError('Track index must be a positive integer.');
    }

    const current = await this.guildPlaylists.findOne({ guildId: normalizedGuildId, nameKey });
    if (!current) {
      throw new ValidationError(`Playlist "${normalizedName}" does not exist.`);
    }

    const tracks = Array.isArray(current.tracks) ? [...current.tracks] : [];
    if (safeIndex > tracks.length) {
      throw new ValidationError('Track index out of range.');
    }

    const [removed] = tracks.splice(safeIndex - 1, 1);
    await this.guildPlaylists.updateOne(
      { guildId: normalizedGuildId, nameKey },
      {
        $set: {
          tracks,
          updatedAt: new Date(),
        },
      }
    );

    return removed ?? null;
  }

  async addUserFavorite(userId, track) {
    const normalizedUserId = normalizeUserId(userId);
    const normalizedTrack = normalizeTrack(track, normalizedUserId);

    const current = await this.userFavorites.findOne({ userId: normalizedUserId });
    const existingTracks = Array.isArray(current?.tracks) ? current.tracks : [];

    const duplicate = existingTracks.some((item) => item.url === normalizedTrack.url);
    if (duplicate) {
      return {
        added: false,
        reason: 'duplicate',
        track: normalizedTrack,
        total: existingTracks.length,
      };
    }

    if (existingTracks.length >= this.maxFavoritesPerUser) {
      throw new ValidationError(`Favorite limit reached (${this.maxFavoritesPerUser}).`);
    }

    const now = new Date();
    await this.userFavorites.updateOne(
      { userId: normalizedUserId },
      {
        $setOnInsert: {
          userId: normalizedUserId,
          createdAt: now,
        },
        $set: { updatedAt: now },
        $push: { tracks: normalizedTrack },
      },
      { upsert: true }
    );

    return {
      added: true,
      track: normalizedTrack,
      total: existingTracks.length + 1,
    };
  }

  async listUserFavorites(userId, page = 1, pageSize = DEFAULT_PAGE_SIZE) {
    const normalizedUserId = normalizeUserId(userId);
    const doc = await this.userFavorites.findOne(
      { userId: normalizedUserId },
      { projection: { _id: 0, tracks: 1 } }
    );
    const tracks = Array.isArray(doc?.tracks) ? doc.tracks : [];
    return paginateList(tracks, toPositiveInt(page, 1), toPositiveInt(pageSize, DEFAULT_PAGE_SIZE));
  }

  async getUserFavorite(userId, index) {
    const normalizedUserId = normalizeUserId(userId);
    const safeIndex = toPositiveInt(index, 0);
    if (safeIndex <= 0) {
      throw new ValidationError('Favorite index must be a positive integer.');
    }

    const doc = await this.userFavorites.findOne(
      { userId: normalizedUserId },
      { projection: { _id: 0, tracks: 1 } }
    );
    const tracks = Array.isArray(doc?.tracks) ? doc.tracks : [];
    return tracks[safeIndex - 1] ?? null;
  }

  async removeUserFavorite(userId, index) {
    const normalizedUserId = normalizeUserId(userId);
    const safeIndex = toPositiveInt(index, 0);
    if (safeIndex <= 0) {
      throw new ValidationError('Favorite index must be a positive integer.');
    }

    const current = await this.userFavorites.findOne({ userId: normalizedUserId });
    const tracks = Array.isArray(current?.tracks) ? [...current.tracks] : [];
    if (safeIndex > tracks.length) {
      return null;
    }

    const [removed] = tracks.splice(safeIndex - 1, 1);
    await this.userFavorites.updateOne(
      { userId: normalizedUserId },
      {
        $set: {
          tracks,
          updatedAt: new Date(),
        },
      }
    );
    return removed ?? null;
  }

  async appendGuildHistory(guildId, track) {
    const normalizedGuildId = normalizeGuildId(guildId);
    const normalizedTrack = normalizeTrack(track);
    normalizedTrack.playedAt = new Date();

    const now = new Date();
    await this.guildHistory.updateOne(
      { guildId: normalizedGuildId },
      {
        $setOnInsert: {
          guildId: normalizedGuildId,
          createdAt: now,
        },
        $set: {
          updatedAt: now,
        },
        $push: {
          tracks: {
            $each: [normalizedTrack],
            $slice: -this.maxHistoryTracks,
          },
        },
      },
      { upsert: true }
    );
  }

  async listGuildHistory(guildId, page = 1, pageSize = DEFAULT_PAGE_SIZE) {
    const normalizedGuildId = normalizeGuildId(guildId);
    const doc = await this.guildHistory.findOne(
      { guildId: normalizedGuildId },
      { projection: { _id: 0, tracks: 1 } }
    );
    const tracks = Array.isArray(doc?.tracks) ? doc.tracks : [];
    const newestFirst = tracks.slice().reverse();
    return paginateList(newestFirst, toPositiveInt(page, 1), toPositiveInt(pageSize, DEFAULT_PAGE_SIZE));
  }

  async getLastGuildHistoryTrack(guildId) {
    const normalizedGuildId = normalizeGuildId(guildId);
    const doc = await this.guildHistory.findOne(
      { guildId: normalizedGuildId },
      { projection: { _id: 0, tracks: { $slice: -1 } } }
    );
    if (!Array.isArray(doc?.tracks) || !doc.tracks.length) return null;
    return doc.tracks[0];
  }
}
