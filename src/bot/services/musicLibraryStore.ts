import { ValidationError } from '../../core/errors.ts';
import type { LoggerLike } from '../../types/core.ts';
import {
  DEFAULT_PAGE_SIZE,
  applyUserProfileSignal,
  defaultGuildFeatureConfig,
  normalizeChannelId,
  normalizeGuildId,
  normalizePlaylistName,
  normalizePlaylistNameKey,
  normalizeStationName,
  normalizeStationNameKey,
  normalizeStationTags,
  normalizeStationUrl,
  normalizeTrack,
  normalizeUserId,
  paginateList,
  sanitizeFeaturePatch,
  toPositiveInt,
  toTimestamp,
} from './musicLibraryStoreHelpers.ts';

interface StoredTrack {
  title: string;
  url: string;
  duration: string;
  source: string;
  thumbnailUrl: string | null;
  requestedBy: string | null;
  savedAt: Date;
  artist?: string | null;
  playedAt?: string | Date | null;
  [key: string]: unknown;
}

interface QueueTemplate {
  key: string;
  name: string;
  tracks: StoredTrack[];
  updatedBy: string | null;
  updatedAt: Date;
}

interface VoiceProfile {
  channelId: string;
  updatedAt?: Date;
  [key: string]: unknown;
}

interface RadioStationPreset {
  key: string;
  name: string;
  url: string;
  description: string | null;
  tags: string[];
  updatedBy: string | null;
  updatedAt: Date;
}

interface QueueGuardConfig {
  enabled: boolean;
  maxPerRequesterWindow: number;
  windowSize: number;
  maxArtistStreak: number;
}

interface FeatureConfigDoc {
  guildId: string;
  recapChannelId: string | null;
  webhookUrl: string | null;
  persistentVoiceConnections: Array<{ voiceChannelId?: string | null; textChannelId?: string | null }>;
  restartRecoveryConnections: Array<{ voiceChannelId?: string | null; textChannelId?: string | null }>;
  persistentVoiceChannelId: string | null;
  persistentTextChannelId: string | null;
  persistentVoiceUpdatedAt: Date | null;
  stations: RadioStationPreset[];
  queueTemplates: QueueTemplate[];
  voiceProfiles: VoiceProfile[];
  queueGuard: QueueGuardConfig;
  updatedAt: Date | null;
  createdAt: Date | null;
  [key: string]: unknown;
}

interface SessionSnapshotDoc {
  guildId: string;
  voiceChannelId: string;
  createdAt?: Date;
  updatedAt?: Date;
  [key: string]: unknown;
}

interface GuildPlaylistDoc {
  guildId: string;
  name: string;
  nameKey: string;
  tracks: StoredTrack[];
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

interface UserFavoritesDoc {
  userId: string;
  tracks?: StoredTrack[];
  updatedAt?: Date;
  createdAt?: Date;
  [key: string]: unknown;
}

interface GuildHistoryDoc {
  guildId: string;
  tracks?: StoredTrack[];
  updatedAt?: Date;
  createdAt?: Date;
  [key: string]: unknown;
}

interface UserGuildStats {
  guildId: string;
  plays: number;
  skips: number;
  favorites: number;
  score: number;
}

interface TasteRow {
  term: string;
  count: number;
}

interface UserProfileDoc {
  userId: string;
  guildStats?: UserGuildStats[];
  taste?: TasteRow[];
  createdAt?: Date;
  updatedAt?: Date;
  [key: string]: unknown;
}

type TrackInputLike = Parameters<typeof normalizeTrack>[0];
type TrackRequesterLike = Parameters<typeof normalizeTrack>[1];
type NormalizedStoredTrack = ReturnType<typeof normalizeTrack>;
type UserSignalTrack = Parameters<typeof applyUserProfileSignal>[3];

function normalizeStoredStation(station: unknown): RadioStationPreset | null {
  if (!station || typeof station !== 'object' || Array.isArray(station)) return null;
  const safeStation = station as Record<string, unknown>;
  const name = normalizeStationName(safeStation.name ?? safeStation.key ?? '');
  return {
    key: normalizeStationNameKey(safeStation.key ?? name),
    name,
    url: normalizeStationUrl(safeStation.url),
    description: safeStation.description != null ? String(safeStation.description).trim() || null : null,
    tags: normalizeStationTags(safeStation.tags),
    updatedBy: safeStation.updatedBy != null ? String(safeStation.updatedBy) : null,
    updatedAt: safeStation.updatedAt instanceof Date
      ? safeStation.updatedAt
      : new Date(safeStation.updatedAt != null ? String(safeStation.updatedAt) : Date.now()),
  };
}

interface GuildRecapDoc {
  guildId: string;
  lastWeeklyRecapAt?: Date | null;
  updatedAt?: Date | null;
  createdAt?: Date;
  [key: string]: unknown;
}

interface MusicLibraryStoreOptions {
  guildPlaylistsCollection: CollectionLike<GuildPlaylistDoc>;
  userFavoritesCollection: CollectionLike<UserFavoritesDoc>;
  guildHistoryCollection: CollectionLike<GuildHistoryDoc>;
  guildFeaturesCollection?: CollectionLike<FeatureConfigDoc> | null;
  guildSessionSnapshotsCollection?: CollectionLike<SessionSnapshotDoc> | null;
  userProfilesCollection?: CollectionLike<UserProfileDoc> | null;
  guildRecapsCollection?: CollectionLike<GuildRecapDoc> | null;
  logger?: LoggerLike;
  maxPlaylistsPerGuild?: number;
  maxTracksPerPlaylist?: number;
  maxSavedTracksPerPlaylist?: number;
  maxFavoritesPerUser?: number;
  maxHistoryTracks?: number;
}

interface CursorLike<T> {
  sort(sortSpec: Record<string, 1 | -1>): CursorLike<T>;
  skip(count: number): CursorLike<T>;
  limit(count: number): CursorLike<T>;
  toArray(): Promise<T[]>;
}

interface CollectionLike<T> {
  createIndex?: (index: Record<string, number>, options?: Record<string, unknown>) => Promise<unknown> | unknown;
  findOne(filter: Record<string, unknown>, options?: Record<string, unknown>): Promise<T | null>;
  updateOne(
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
    options?: Record<string, unknown>,
  ): Promise<{ deletedCount?: number } | { acknowledged?: boolean } | unknown> | { deletedCount?: number } | { acknowledged?: boolean } | unknown;
  deleteOne?: (filter: Record<string, unknown>) => Promise<{ deletedCount?: number }>;
  find?: (filter: Record<string, unknown>, options?: Record<string, unknown>) => CursorLike<T>;
  countDocuments?: (filter: Record<string, unknown>) => Promise<number>;
  insertOne?: (document: T) => Promise<unknown>;
}

export class MusicLibraryStore {
  guildPlaylists: CollectionLike<GuildPlaylistDoc>;
  userFavorites: CollectionLike<UserFavoritesDoc>;
  guildHistory: CollectionLike<GuildHistoryDoc>;
  guildFeatures: CollectionLike<FeatureConfigDoc> | null;
  guildSessionSnapshots: CollectionLike<SessionSnapshotDoc> | null;
  userProfiles: CollectionLike<UserProfileDoc> | null;
  guildRecaps: CollectionLike<GuildRecapDoc> | null;
  logger: LoggerLike | undefined;
  maxPlaylistsPerGuild: number;
  maxTracksPerPlaylist: number;
  maxSavedTracksPerPlaylist: number;
  maxFavoritesPerUser: number;
  maxHistoryTracks: number;

  constructor(options: MusicLibraryStoreOptions) {
    this.guildPlaylists = options.guildPlaylistsCollection;
    this.userFavorites = options.userFavoritesCollection;
    this.guildHistory = options.guildHistoryCollection;
    this.guildFeatures = options.guildFeaturesCollection ?? null;
    this.guildSessionSnapshots = options.guildSessionSnapshotsCollection ?? null;
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
    await this.guildPlaylists.createIndex!({ guildId: 1, nameKey: 1 }, { unique: true });
    await this.guildPlaylists.createIndex!({ guildId: 1, updatedAt: -1 });

    await this.userFavorites.createIndex!({ userId: 1 }, { unique: true });
    await this.userFavorites.createIndex!({ updatedAt: -1 });

    await this.guildHistory.createIndex!({ guildId: 1 }, { unique: true });
    await this.guildHistory.createIndex!({ updatedAt: -1 });

    if (this.guildFeatures) {
      await this.guildFeatures.createIndex!({ guildId: 1 }, { unique: true });
      await this.guildFeatures.createIndex!({ updatedAt: -1 });
    }

    if (this.guildSessionSnapshots) {
      await this.guildSessionSnapshots.createIndex!({ guildId: 1, voiceChannelId: 1 }, { unique: true });
      await this.guildSessionSnapshots.createIndex!({ updatedAt: -1 });
    }

    if (this.userProfiles) {
      await this.userProfiles.createIndex!({ userId: 1 }, { unique: true });
      await this.userProfiles.createIndex!({ updatedAt: -1 });
    }

    if (this.guildRecaps) {
      await this.guildRecaps.createIndex!({ guildId: 1 }, { unique: true });
      await this.guildRecaps.createIndex!({ updatedAt: -1 });
    }

    this.logger?.info?.('Music library store ready', {
      maxPlaylistsPerGuild: this.maxPlaylistsPerGuild,
      maxTracksPerPlaylist: this.maxTracksPerPlaylist,
      maxSavedTracksPerPlaylist: this.maxSavedTracksPerPlaylist,
      maxFavoritesPerUser: this.maxFavoritesPerUser,
      maxHistoryTracks: this.maxHistoryTracks,
      featureCollectionsEnabled: Boolean(this.guildFeatures && this.userProfiles && this.guildRecaps),
      sessionSnapshotsEnabled: Boolean(this.guildSessionSnapshots),
    });
  }

  _ensureFeatureCollection<T>(collection: CollectionLike<T> | null, label: string): CollectionLike<T> {
    if (!collection) {
      throw new ValidationError(`${label} collection is unavailable.`);
    }
    return collection;
  }

  async getGuildFeatureConfig(guildId: unknown): Promise<FeatureConfigDoc> {
    const normalizedGuildId = normalizeGuildId(guildId);
    if (!this.guildFeatures) {
      return defaultGuildFeatureConfig(normalizedGuildId);
    }

    const doc = await this.guildFeatures.findOne(
      { guildId: normalizedGuildId },
      { projection: { _id: 0 } }
    );
    if (!doc) return defaultGuildFeatureConfig(normalizedGuildId);

    return {
      ...defaultGuildFeatureConfig(normalizedGuildId),
      ...doc,
      stations: Array.isArray(doc.stations)
        ? doc.stations
          .map((station) => {
            try {
              return normalizeStoredStation(station);
            } catch {
              return null;
            }
          })
          .filter((station): station is RadioStationPreset => station != null)
        : [],
      queueTemplates: Array.isArray(doc.queueTemplates) ? doc.queueTemplates : [],
      voiceProfiles: Array.isArray(doc.voiceProfiles) ? doc.voiceProfiles : [],
      queueGuard: {
        ...defaultGuildFeatureConfig(normalizedGuildId).queueGuard,
        ...(doc.queueGuard ?? {}),
      },
    };
  }

  async patchGuildFeatureConfig(guildId: unknown, patch: unknown): Promise<FeatureConfigDoc> {
    const normalizedGuildId = normalizeGuildId(guildId);
    const collection = this._ensureFeatureCollection(this.guildFeatures, 'Guild features');
    const safePatch = sanitizeFeaturePatch(patch);
    const now = new Date();

    const setPatch: Record<string, unknown> = {};
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

  async setQueueTemplate(guildId: unknown, name: unknown, tracks: unknown[], createdBy: unknown = null) {
    const normalizedGuildId = normalizeGuildId(guildId);
    const templateName = normalizePlaylistName(name);
    const templateKey = normalizePlaylistNameKey(name);
    const normalizedTracks = (Array.isArray(tracks) ? tracks : []).map((track) => normalizeTrack(track as TrackInputLike, createdBy as TrackRequesterLike));
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

  async setGuildStation(
    guildId: unknown,
    name: unknown,
    station: { url: unknown; description?: unknown; tags?: unknown },
    createdBy: unknown = null,
  ) {
    const normalizedGuildId = normalizeGuildId(guildId);
    const stationName = normalizeStationName(name);
    const stationKey = normalizeStationNameKey(name);
    const payload: RadioStationPreset = {
      key: stationKey,
      name: stationName,
      url: normalizeStationUrl(station.url),
      description: station.description != null ? String(station.description).trim() || null : null,
      tags: normalizeStationTags(station.tags),
      updatedBy: createdBy ? String(createdBy) : null,
      updatedAt: new Date(),
    };

    const config = await this.getGuildFeatureConfig(normalizedGuildId);
    const stations = Array.isArray(config.stations) ? [...config.stations] : [];
    const existingIndex = stations.findIndex((entry) => entry?.key === stationKey);
    if (existingIndex >= 0) {
      stations[existingIndex] = payload;
    } else {
      stations.push(payload);
    }

    await this.patchGuildFeatureConfig(normalizedGuildId, { stations });
    return payload;
  }

  async listGuildStations(guildId: unknown) {
    const config = await this.getGuildFeatureConfig(guildId);
    return Array.isArray(config.stations) ? config.stations : [];
  }

  async getGuildStation(guildId: unknown, name: unknown) {
    const stationKey = normalizeStationNameKey(name);
    const stations = await this.listGuildStations(guildId);
    return stations.find((entry) => entry?.key === stationKey) ?? null;
  }

  async deleteGuildStation(guildId: unknown, name: unknown) {
    const stationKey = normalizeStationNameKey(name);
    const config = await this.getGuildFeatureConfig(guildId);
    const stations = Array.isArray(config.stations) ? config.stations : [];
    const next = stations.filter((entry) => entry?.key !== stationKey);
    if (next.length === stations.length) return false;

    await this.patchGuildFeatureConfig(guildId, { stations: next });
    return true;
  }

  async listQueueTemplates(guildId: unknown) {
    const config = await this.getGuildFeatureConfig(guildId);
    return Array.isArray(config.queueTemplates) ? config.queueTemplates : [];
  }

  async getQueueTemplate(guildId: unknown, name: unknown) {
    const templateKey = normalizePlaylistNameKey(name);
    const templates = await this.listQueueTemplates(guildId);
    return templates.find((entry) => entry?.key === templateKey) ?? null;
  }

  async deleteQueueTemplate(guildId: unknown, name: unknown) {
    const templateKey = normalizePlaylistNameKey(name);
    const config = await this.getGuildFeatureConfig(guildId);
    const templates = Array.isArray(config.queueTemplates) ? config.queueTemplates : [];
    const next = templates.filter((entry) => entry?.key !== templateKey);
    if (next.length === templates.length) return false;

    await this.patchGuildFeatureConfig(guildId, { queueTemplates: next });
    return true;
  }

  async setVoiceProfile(guildId: unknown, channelId: unknown, patch: unknown) {
    const normalizedGuildId = normalizeGuildId(guildId);
    const normalizedChannelId = normalizeChannelId(channelId);
    const config = await this.getGuildFeatureConfig(normalizedGuildId);
    const profiles = Array.isArray(config.voiceProfiles) ? [...config.voiceProfiles] : [];
    const idx = profiles.findIndex((entry) => entry?.channelId === normalizedChannelId);
    const next = {
      channelId: normalizedChannelId,
      ...(idx >= 0 ? profiles[idx] : {}),
      ...sanitizeFeaturePatch(patch),
      updatedAt: new Date(),
    };
    if (idx >= 0) profiles[idx] = next;
    else profiles.push(next);

    await this.patchGuildFeatureConfig(normalizedGuildId, { voiceProfiles: profiles });
    return next;
  }

  async getVoiceProfile(guildId: unknown, channelId: unknown) {
    const normalizedChannelId = normalizeChannelId(channelId);
    const config = await this.getGuildFeatureConfig(guildId);
    const profiles = Array.isArray(config.voiceProfiles) ? config.voiceProfiles : [];
    return profiles.find((entry) => entry?.channelId === normalizedChannelId) ?? null;
  }

  async listPersistentVoiceConnections() {
    if (!this.guildFeatures) return [];

    const rows = await this.guildFeatures.find!(
      {
        $or: [
          { persistentVoiceChannelId: { $type: 'string', $ne: '' } },
          { persistentVoiceConnections: { $exists: true, $ne: [] } },
          { restartRecoveryConnections: { $exists: true, $ne: [] } },
        ],
      },
      {
        projection: {
          _id: 0,
          guildId: 1,
          persistentVoiceConnections: 1,
          restartRecoveryConnections: 1,
          persistentVoiceChannelId: 1,
          persistentTextChannelId: 1,
          persistentVoiceUpdatedAt: 1,
        },
      }
    ).toArray();

    const results = [];
    for (const row of rows) {
      const guildId = normalizeGuildId(row.guildId);
      const persistentBindings = Array.isArray(row.persistentVoiceConnections) && row.persistentVoiceConnections.length
        ? row.persistentVoiceConnections
        : [{
            voiceChannelId: row.persistentVoiceChannelId,
            textChannelId: row.persistentTextChannelId,
          }];
      const recoveryBindings = Array.isArray(row.restartRecoveryConnections)
        ? row.restartRecoveryConnections
        : [];
      const bindings = [...persistentBindings, ...recoveryBindings];
      const seen = new Set();

      for (const binding of bindings) {
        const voiceChannelId = binding?.voiceChannelId
          ? normalizeChannelId(binding.voiceChannelId, 'voice channel id')
          : null;
        if (!voiceChannelId) continue;
        if (seen.has(voiceChannelId)) continue;
        seen.add(voiceChannelId);
        results.push({
          guildId,
          voiceChannelId,
          textChannelId: binding?.textChannelId
            ? normalizeChannelId(binding.textChannelId, 'text channel id')
            : null,
          updatedAt: row.persistentVoiceUpdatedAt ?? null,
        });
      }
    }

    return results;
  }

  async upsertSessionSnapshot(guildId: unknown, voiceChannelId: unknown, snapshot: unknown) {
    const normalizedGuildId = normalizeGuildId(guildId);
    const normalizedVoiceChannelId = normalizeChannelId(voiceChannelId, 'voice channel id');
    const collection = this._ensureFeatureCollection(this.guildSessionSnapshots, 'Guild session snapshots');
    const safePatch = sanitizeFeaturePatch(snapshot);

    delete safePatch.guildId;
    delete safePatch.voiceChannelId;
    delete safePatch.createdAt;
    delete safePatch.updatedAt;
    const now = new Date();

    await collection.updateOne(
      { guildId: normalizedGuildId, voiceChannelId: normalizedVoiceChannelId },
      {
        $setOnInsert: {
          guildId: normalizedGuildId,
          voiceChannelId: normalizedVoiceChannelId,
          createdAt: now,
        },
        $set: {
          ...safePatch,
          updatedAt: now,
        },
      },
      { upsert: true }
    );

    return this.getSessionSnapshot(normalizedGuildId, normalizedVoiceChannelId);
  }

  async getSessionSnapshot(guildId: unknown, voiceChannelId: unknown) {
    const normalizedGuildId = normalizeGuildId(guildId);
    const normalizedVoiceChannelId = normalizeChannelId(voiceChannelId, 'voice channel id');
    if (!this.guildSessionSnapshots) return null;

    return this.guildSessionSnapshots.findOne(
      { guildId: normalizedGuildId, voiceChannelId: normalizedVoiceChannelId },
      { projection: { _id: 0 } }
    );
  }

  async deleteSessionSnapshot(guildId: unknown, voiceChannelId: unknown) {
    const normalizedGuildId = normalizeGuildId(guildId);
    const normalizedVoiceChannelId = normalizeChannelId(voiceChannelId, 'voice channel id');
    if (!this.guildSessionSnapshots) return false;

    const result = await this.guildSessionSnapshots.deleteOne!({
      guildId: normalizedGuildId,
      voiceChannelId: normalizedVoiceChannelId,
    });
    return (result?.deletedCount ?? 0) > 0;
  }

  async recordUserSignal(guildId: unknown, userId: unknown, signal: unknown, track: unknown = null) {
    const normalizedGuildId = normalizeGuildId(guildId);
    const normalizedUserId = normalizeUserId(userId);
    const collection = this._ensureFeatureCollection(this.userProfiles, 'User profiles');
    const current = await collection.findOne({ userId: normalizedUserId }, { projection: { _id: 0 } });
    const next: UserProfileDoc = {
      ...(applyUserProfileSignal(
        current,
        normalizedGuildId,
        signal,
        track as UserSignalTrack
      ) as Omit<UserProfileDoc, 'userId'>),
      userId: normalizedUserId,
    };
    if (!next.createdAt) next.createdAt = new Date();
    await collection.updateOne(
      { userId: normalizedUserId },
      { $set: next, $setOnInsert: { createdAt: next.createdAt } },
      { upsert: true }
    );
    return next;
  }

  async getUserProfile(userId: unknown, guildId: unknown = null) {
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

  async getGuildTopTracks(guildId: unknown, days: number = 7, limit: number = 10) {
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
      const playedAtTs = toTimestamp(track?.playedAt ?? null);
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

  async buildGuildRecap(guildId: unknown, days: number = 7) {
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
      const playedAtTs = toTimestamp(track?.playedAt ?? null);
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

  async getRecapState(guildId: unknown) {
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

  async markRecapSent(guildId: unknown, sentAt: Date = new Date()) {
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

  async createGuildPlaylist(guildId: unknown, name: unknown, createdBy: unknown) {
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

    const count = await this.guildPlaylists.countDocuments!({ guildId: normalizedGuildId });
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

    await this.guildPlaylists.insertOne!(doc);
    return {
      ...doc,
      tracks: [],
    };
  }

  async deleteGuildPlaylist(guildId: unknown, name: unknown) {
    const normalizedGuildId = normalizeGuildId(guildId);
    const nameKey = normalizePlaylistNameKey(name);
    const result = await this.guildPlaylists.deleteOne!({
      guildId: normalizedGuildId,
      nameKey,
    });
    return (result?.deletedCount ?? 0) > 0;
  }

  async listGuildPlaylists(guildId: unknown, page: number = 1, pageSize: number = DEFAULT_PAGE_SIZE) {
    const normalizedGuildId = normalizeGuildId(guildId);
    const safePage = toPositiveInt(page, 1);
    const safePageSize = toPositiveInt(pageSize, DEFAULT_PAGE_SIZE);

    const total = await this.guildPlaylists.countDocuments!({ guildId: normalizedGuildId });
    const totalPages = Math.max(1, Math.ceil(total / safePageSize));
    const boundedPage = Math.max(1, Math.min(safePage, totalPages));
    const skip = (boundedPage - 1) * safePageSize;

    const docs = await this.guildPlaylists
      .find!({ guildId: normalizedGuildId }, { projection: { _id: 0 } })
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

  async getGuildPlaylist(guildId: unknown, name: unknown) {
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

  async addTracksToGuildPlaylist(guildId: unknown, name: unknown, tracks: unknown[], addedBy: unknown = null) {
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

    const sanitized: NormalizedStoredTrack[] = [];
    for (const track of nextTracks) {
      sanitized.push(normalizeTrack(track as TrackInputLike, addedBy as TrackRequesterLike));
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

  async removeTrackFromGuildPlaylist(guildId: unknown, name: unknown, index: unknown) {
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

  async addUserFavorite(userId: unknown, track: unknown) {
    const normalizedUserId = normalizeUserId(userId);
    const normalizedTrack = normalizeTrack(track as TrackInputLike, normalizedUserId as TrackRequesterLike);

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

  async listUserFavorites(userId: unknown, page: number = 1, pageSize: number = DEFAULT_PAGE_SIZE) {
    const normalizedUserId = normalizeUserId(userId);
    const doc = await this.userFavorites.findOne(
      { userId: normalizedUserId },
      { projection: { _id: 0, tracks: 1 } }
    );
    const tracks = Array.isArray(doc?.tracks) ? doc.tracks : [];
    return paginateList(tracks, toPositiveInt(page, 1), toPositiveInt(pageSize, DEFAULT_PAGE_SIZE));
  }

  async getUserFavorite(userId: unknown, index: unknown) {
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

  async removeUserFavorite(userId: unknown, index: unknown) {
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

  async appendGuildHistory(guildId: unknown, track: unknown) {
    const normalizedGuildId = normalizeGuildId(guildId);
    const normalizedTrack = normalizeTrack(track as TrackInputLike);

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

  async listGuildHistory(guildId: unknown, page: number = 1, pageSize: number = DEFAULT_PAGE_SIZE) {
    const normalizedGuildId = normalizeGuildId(guildId);
    const doc = await this.guildHistory.findOne(
      { guildId: normalizedGuildId },
      { projection: { _id: 0, tracks: 1 } }
    );
    const tracks = Array.isArray(doc?.tracks) ? doc.tracks : [];
    const newestFirst = tracks.slice().reverse();
    return paginateList(newestFirst, toPositiveInt(page, 1), toPositiveInt(pageSize, DEFAULT_PAGE_SIZE));
  }

  async getLastGuildHistoryTrack(guildId: unknown) {
    const normalizedGuildId = normalizeGuildId(guildId);
    const doc = await this.guildHistory.findOne(
      { guildId: normalizedGuildId },
      { projection: { _id: 0, tracks: { $slice: -1 } } }
    );
    if (!Array.isArray(doc?.tracks) || !doc.tracks.length) return null;
    return doc.tracks[0];
  }
}




