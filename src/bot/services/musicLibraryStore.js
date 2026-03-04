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
  const thumbnailUrlRaw = String(track?.thumbnailUrl ?? track?.thumbnail_url ?? track?.thumbnail ?? '').trim();
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
    thumbnailUrl: /^https?:\/\//i.test(thumbnailUrlRaw) ? thumbnailUrlRaw.slice(0, 2048) : null,
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
    this.guildFeatures = options.guildFeaturesCollection ?? null;
    this.userProfiles = options.userProfilesCollection ?? null;
    this.guildRecaps = options.guildRecapsCollection ?? null;
    this.logger = options.logger;

    this.maxPlaylistsPerGuild = toPositiveInt(options.maxPlaylistsPerGuild, 100);
    this.maxTracksPerPlaylist = toPositiveInt(options.maxTracksPerPlaylist, 500);
    this.maxSavedTracksPerPlaylist = toPositiveInt(
      options.maxSavedTracksPerPlaylist,
      this.maxTracksPerPlaylist
    );
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

    if (this.guildFeatures) {
      await this.guildFeatures.createIndex({ guildId: 1 }, { unique: true });
      await this.guildFeatures.createIndex({ updatedAt: -1 });
    }

    if (this.userProfiles) {
      await this.userProfiles.createIndex({ userId: 1 }, { unique: true });
      await this.userProfiles.createIndex({ updatedAt: -1 });
    }

    if (this.guildRecaps) {
      await this.guildRecaps.createIndex({ guildId: 1 }, { unique: true });
      await this.guildRecaps.createIndex({ updatedAt: -1 });
    }

    this.logger?.info?.('Music library store ready', {
      maxPlaylistsPerGuild: this.maxPlaylistsPerGuild,
      maxTracksPerPlaylist: this.maxTracksPerPlaylist,
      maxSavedTracksPerPlaylist: this.maxSavedTracksPerPlaylist,
      maxFavoritesPerUser: this.maxFavoritesPerUser,
      maxHistoryTracks: this.maxHistoryTracks,
      featureCollectionsEnabled: Boolean(this.guildFeatures && this.userProfiles && this.guildRecaps),
    });
  }

  _ensureFeatureCollection(collection, label) {
    if (!collection) {
      throw new ValidationError(`${label} collection is unavailable.`);
    }
    return collection;
  }

  _sanitizeFeaturePatch(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const next = {};
    for (const [key, entry] of Object.entries(value)) {
      if (!key || key.startsWith('$') || key.includes('.')) continue;
      next[key] = entry;
    }
    return next;
  }

  _defaultGuildFeatureConfig(guildId) {
    return {
      guildId,
      recapChannelId: null,
      webhookUrl: null,
      sessionPanelChannelId: null,
      sessionPanelMessageId: null,
      queueTemplates: [],
      voiceProfiles: [],
      queueGuard: {
        enabled: false,
        maxPerRequesterWindow: 5,
        windowSize: 25,
        maxArtistStreak: 3,
      },
      updatedAt: null,
      createdAt: null,
    };
  }

  async getGuildFeatureConfig(guildId) {
    const normalizedGuildId = normalizeGuildId(guildId);
    if (!this.guildFeatures) {
      return this._defaultGuildFeatureConfig(normalizedGuildId);
    }

    const doc = await this.guildFeatures.findOne(
      { guildId: normalizedGuildId },
      { projection: { _id: 0 } }
    );
    if (!doc) return this._defaultGuildFeatureConfig(normalizedGuildId);

    return {
      ...this._defaultGuildFeatureConfig(normalizedGuildId),
      ...doc,
      queueTemplates: Array.isArray(doc.queueTemplates) ? doc.queueTemplates : [],
      voiceProfiles: Array.isArray(doc.voiceProfiles) ? doc.voiceProfiles : [],
      queueGuard: {
        ...this._defaultGuildFeatureConfig(normalizedGuildId).queueGuard,
        ...(doc.queueGuard ?? {}),
      },
    };
  }

  async patchGuildFeatureConfig(guildId, patch) {
    const normalizedGuildId = normalizeGuildId(guildId);
    const collection = this._ensureFeatureCollection(this.guildFeatures, 'Guild features');
    const safePatch = this._sanitizeFeaturePatch(patch);
    const now = new Date();

    const setPatch = {};
    for (const [key, value] of Object.entries(safePatch)) {
      if (value === undefined) continue;
      setPatch[key] = value;
    }
    setPatch.updatedAt = now;

    await collection.updateOne(
      { guildId: normalizedGuildId },
      {
        $setOnInsert: {
          guildId: normalizedGuildId,
          createdAt: now,
        },
        $set: setPatch,
      },
      { upsert: true }
    );

    return this.getGuildFeatureConfig(normalizedGuildId);
  }

  async setQueueTemplate(guildId, name, tracks, createdBy = null) {
    const normalizedGuildId = normalizeGuildId(guildId);
    const templateName = normalizePlaylistName(name);
    const templateKey = normalizePlaylistNameKey(name);
    const normalizedTracks = (Array.isArray(tracks) ? tracks : []).map((track) => normalizeTrack(track, createdBy));
    if (!normalizedTracks.length) {
      throw new ValidationError('Template requires at least one track.');
    }

    const config = await this.getGuildFeatureConfig(normalizedGuildId);
    const templates = Array.isArray(config.queueTemplates) ? [...config.queueTemplates] : [];
    const existingIndex = templates.findIndex((entry) => entry?.key === templateKey);
    const payload = {
      key: templateKey,
      name: templateName,
      tracks: normalizedTracks.slice(0, this.maxSavedTracksPerPlaylist),
      updatedBy: createdBy ? String(createdBy) : null,
      updatedAt: new Date(),
    };

    if (existingIndex >= 0) {
      templates[existingIndex] = payload;
    } else {
      templates.push(payload);
    }

    await this.patchGuildFeatureConfig(normalizedGuildId, {
      queueTemplates: templates,
    });

    return payload;
  }

  async listQueueTemplates(guildId) {
    const config = await this.getGuildFeatureConfig(guildId);
    return Array.isArray(config.queueTemplates) ? config.queueTemplates : [];
  }

  async getQueueTemplate(guildId, name) {
    const templateKey = normalizePlaylistNameKey(name);
    const templates = await this.listQueueTemplates(guildId);
    return templates.find((entry) => entry?.key === templateKey) ?? null;
  }

  async deleteQueueTemplate(guildId, name) {
    const templateKey = normalizePlaylistNameKey(name);
    const config = await this.getGuildFeatureConfig(guildId);
    const templates = Array.isArray(config.queueTemplates) ? config.queueTemplates : [];
    const next = templates.filter((entry) => entry?.key !== templateKey);
    if (next.length === templates.length) return false;

    await this.patchGuildFeatureConfig(guildId, { queueTemplates: next });
    return true;
  }

  async setVoiceProfile(guildId, channelId, patch) {
    const normalizedGuildId = normalizeGuildId(guildId);
    const normalizedChannelId = normalizeGuildId(channelId);
    const config = await this.getGuildFeatureConfig(normalizedGuildId);
    const profiles = Array.isArray(config.voiceProfiles) ? [...config.voiceProfiles] : [];
    const idx = profiles.findIndex((entry) => entry?.channelId === normalizedChannelId);
    const next = {
      channelId: normalizedChannelId,
      ...(idx >= 0 ? profiles[idx] : {}),
      ...this._sanitizeFeaturePatch(patch),
      updatedAt: new Date(),
    };
    if (idx >= 0) profiles[idx] = next;
    else profiles.push(next);

    await this.patchGuildFeatureConfig(normalizedGuildId, { voiceProfiles: profiles });
    return next;
  }

  async getVoiceProfile(guildId, channelId) {
    const normalizedChannelId = normalizeGuildId(channelId);
    const config = await this.getGuildFeatureConfig(guildId);
    const profiles = Array.isArray(config.voiceProfiles) ? config.voiceProfiles : [];
    return profiles.find((entry) => entry?.channelId === normalizedChannelId) ?? null;
  }

  _tokensFromTrack(track) {
    const title = String(track?.title ?? '').toLowerCase();
    const artist = String(track?.artist ?? track?.requestedByArtist ?? '').toLowerCase();
    const words = `${title} ${artist}`
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((word) => word.length >= 3 && !['official', 'video', 'lyrics', 'audio', 'feat'].includes(word));
    return words.slice(0, 8);
  }

  _applyUserProfileSignal(profile, guildId, signal, track = null) {
    const safeGuildId = normalizeGuildId(guildId);
    const safeSignal = String(signal ?? '').toLowerCase();
    const next = profile && typeof profile === 'object' ? { ...profile } : {};
    const now = new Date();

    const guildStats = Array.isArray(next.guildStats) ? [...next.guildStats] : [];
    let stats = guildStats.find((entry) => entry.guildId === safeGuildId);
    if (!stats) {
      stats = { guildId: safeGuildId, plays: 0, skips: 0, favorites: 0, score: 0 };
      guildStats.push(stats);
    }

    if (safeSignal === 'play') {
      stats.plays += 1;
      stats.score += 1;
    } else if (safeSignal === 'skip') {
      stats.skips += 1;
      stats.score -= 1;
    } else if (safeSignal === 'favorite') {
      stats.favorites += 1;
      stats.score += 2;
    }

    const tokens = this._tokensFromTrack(track);
    const taste = Array.isArray(next.taste) ? [...next.taste] : [];
    for (const token of tokens) {
      const row = taste.find((entry) => entry.term === token);
      if (row) {
        row.count += 1;
      } else {
        taste.push({ term: token, count: 1 });
      }
    }
    taste.sort((a, b) => b.count - a.count);

    return {
      ...next,
      guildStats,
      taste: taste.slice(0, 80),
      updatedAt: now,
    };
  }

  async recordUserSignal(guildId, userId, signal, track = null) {
    const normalizedGuildId = normalizeGuildId(guildId);
    const normalizedUserId = normalizeUserId(userId);
    const collection = this._ensureFeatureCollection(this.userProfiles, 'User profiles');
    const current = await collection.findOne({ userId: normalizedUserId }, { projection: { _id: 0 } });
    const next = this._applyUserProfileSignal(current, normalizedGuildId, signal, track);
    next.userId = normalizedUserId;
    if (!next.createdAt) next.createdAt = new Date();
    await collection.updateOne(
      { userId: normalizedUserId },
      { $set: next, $setOnInsert: { createdAt: next.createdAt } },
      { upsert: true }
    );
    return next;
  }

  async getUserProfile(userId, guildId = null) {
    const normalizedUserId = normalizeUserId(userId);
    if (!this.userProfiles) {
      return { userId: normalizedUserId, guildScore: 0, guildStats: null, taste: [] };
    }

    const doc = await this.userProfiles.findOne({ userId: normalizedUserId }, { projection: { _id: 0 } });
    if (!doc) {
      return { userId: normalizedUserId, guildScore: 0, guildStats: null, taste: [] };
    }

    let guildStats = null;
    if (guildId) {
      const safeGuildId = normalizeGuildId(guildId);
      guildStats = (Array.isArray(doc.guildStats) ? doc.guildStats : []).find((entry) => entry.guildId === safeGuildId) ?? null;
    }

    return {
      userId: normalizedUserId,
      guildScore: guildStats?.score ?? 0,
      guildStats,
      taste: Array.isArray(doc.taste) ? doc.taste : [],
    };
  }

  async getGuildTopTracks(guildId, days = 7, limit = 10) {
    const normalizedGuildId = normalizeGuildId(guildId);
    const safeDays = Math.max(1, Math.min(90, toPositiveInt(days, 7)));
    const safeLimit = Math.max(1, Math.min(50, toPositiveInt(limit, 10)));
    const since = Date.now() - (safeDays * 24 * 60 * 60 * 1000);

    const doc = await this.guildHistory.findOne(
      { guildId: normalizedGuildId },
      { projection: { _id: 0, tracks: 1 } }
    );
    const tracks = Array.isArray(doc?.tracks) ? doc.tracks : [];
    const map = new Map();
    for (const track of tracks) {
      const playedAtTs = track?.playedAt ? Date.parse(track.playedAt) : NaN;
      if (Number.isFinite(playedAtTs) && playedAtTs < since) continue;
      const key = String(track?.url ?? '').trim().toLowerCase() || String(track?.title ?? '').trim().toLowerCase();
      if (!key) continue;
      const entry = map.get(key) ?? {
        title: track?.title ?? 'Unknown title',
        url: track?.url ?? '',
        duration: track?.duration ?? 'Unknown',
        thumbnailUrl: track?.thumbnailUrl ?? null,
        plays: 0,
      };
      entry.plays += 1;
      map.set(key, entry);
    }

    return [...map.values()]
      .sort((a, b) => b.plays - a.plays)
      .slice(0, safeLimit);
  }

  async buildGuildRecap(guildId, days = 7) {
    const normalizedGuildId = normalizeGuildId(guildId);
    const safeDays = Math.max(1, Math.min(30, toPositiveInt(days, 7)));
    const topTracks = await this.getGuildTopTracks(normalizedGuildId, safeDays, 10);
    const doc = await this.guildHistory.findOne(
      { guildId: normalizedGuildId },
      { projection: { _id: 0, tracks: 1 } }
    );
    const tracks = Array.isArray(doc?.tracks) ? doc.tracks : [];
    const since = Date.now() - (safeDays * 24 * 60 * 60 * 1000);
    const requesterMap = new Map();
    let playCount = 0;

    for (const track of tracks) {
      const playedAtTs = track?.playedAt ? Date.parse(track.playedAt) : NaN;
      if (Number.isFinite(playedAtTs) && playedAtTs < since) continue;
      playCount += 1;
      const requester = String(track?.requestedBy ?? '').trim();
      if (!requester) continue;
      requesterMap.set(requester, (requesterMap.get(requester) ?? 0) + 1);
    }

    const topRequesters = [...requesterMap.entries()]
      .map(([userId, plays]) => ({ userId, plays }))
      .sort((a, b) => b.plays - a.plays)
      .slice(0, 5);

    return {
      guildId: normalizedGuildId,
      days: safeDays,
      playCount,
      topTracks,
      topRequesters,
      generatedAt: new Date(),
    };
  }

  async getRecapState(guildId) {
    const normalizedGuildId = normalizeGuildId(guildId);
    if (!this.guildRecaps) {
      return { guildId: normalizedGuildId, lastWeeklyRecapAt: null };
    }

    const doc = await this.guildRecaps.findOne(
      { guildId: normalizedGuildId },
      { projection: { _id: 0 } }
    );
    return {
      guildId: normalizedGuildId,
      lastWeeklyRecapAt: doc?.lastWeeklyRecapAt ?? null,
      updatedAt: doc?.updatedAt ?? null,
    };
  }

  async markRecapSent(guildId, sentAt = new Date()) {
    const normalizedGuildId = normalizeGuildId(guildId);
    const collection = this._ensureFeatureCollection(this.guildRecaps, 'Guild recaps');
    await collection.updateOne(
      { guildId: normalizedGuildId },
      {
        $setOnInsert: {
          guildId: normalizedGuildId,
          createdAt: new Date(),
        },
        $set: {
          lastWeeklyRecapAt: sentAt,
          updatedAt: new Date(),
        },
      },
      { upsert: true }
    );
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
