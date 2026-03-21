import { ValidationError } from '../../core/errors.ts';

function toBool(value: unknown, fallback: boolean) {
  if (typeof value === 'boolean') return value;
  if (value == null) return fallback;

  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on', 'enabled'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off', 'disabled'].includes(normalized)) return false;
  return fallback;
}

function toPositiveInt(value: unknown, fallback: number) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function toRatio(value: unknown, fallback: number) {
  const parsed = Number.parseFloat(String(value ?? ''));
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 1 ? parsed : fallback;
}

function normalizePrefix(value: unknown, fallback: string) {
  if (value == null) return fallback;

  const prefix = String(value).trim();
  if (!prefix) {
    throw new ValidationError('Prefix cannot be empty.');
  }
  if (prefix.length > 5) {
    throw new ValidationError('Prefix must be at most 5 characters.');
  }
  if (/\s/.test(prefix)) {
    throw new ValidationError('Prefix cannot contain whitespace.');
  }

  return prefix;
}

function normalizeRoleIds(values: unknown) {
  if (!Array.isArray(values)) return [];

  const set = new Set<string>();
  for (const value of values) {
    const roleId = String(value ?? '').trim();
    if (!/^\d{6,}$/.test(roleId)) continue;
    set.add(roleId);
  }

  return [...set].sort();
}

function normalizeChannelId(value: unknown) {
  if (value == null) return null;
  const normalized = String(value).trim();
  if (!normalized) return null;
  return /^\d{6,}$/.test(normalized) ? normalized : null;
}

function normalizeVolumePercent(value: unknown, fallback: number) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 200 ? parsed : fallback;
}

function cloneConfig(config: GuildConfigDocument) {
  return {
    guildId: config.guildId,
    prefix: config.prefix,
      settings: {
        dedupeEnabled: config.settings.dedupeEnabled,
        stayInVoiceEnabled: config.settings.stayInVoiceEnabled,
        volumePercent: config.settings.volumePercent,
        voteSkipRatio: config.settings.voteSkipRatio,
        voteSkipMinVotes: config.settings.voteSkipMinVotes,
        djRoleIds: [...config.settings.djRoleIds],
      musicLogChannelId: config.settings.musicLogChannelId,
    },
    createdAt: config.createdAt,
    updatedAt: config.updatedAt,
  };
}

function toDateOrNull(value: unknown) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date;
}

type GuildConfigPatch = {
  prefix?: unknown;
  settings?: {
    dedupeEnabled?: unknown;
    stayInVoiceEnabled?: unknown;
    volumePercent?: unknown;
    voteSkipRatio?: unknown;
    voteSkipMinVotes?: unknown;
    djRoleIds?: unknown;
    musicLogChannelId?: unknown;
  } | null;
};

type GuildConfigDocLike = {
  prefix?: unknown;
  settings?: {
    dedupeEnabled?: unknown;
    stayInVoiceEnabled?: unknown;
    volumePercent?: unknown;
    voteSkipRatio?: unknown;
    voteSkipMinVotes?: unknown;
    djRoleIds?: unknown;
    musicLogChannelId?: unknown;
  } | null;
  createdAt?: unknown;
  updatedAt?: unknown;
} | null | undefined;

function normalizeStoredPrefix(value: unknown, fallback: string, logger: LoggerLike | undefined, guildId: string) {
  try {
    return normalizePrefix(value, fallback);
  } catch {
    logger?.warn?.('Invalid stored guild prefix, falling back to default', {
      guildId,
      invalidPrefix: value,
      fallback,
    });
    return fallback;
  }
}

export class GuildConfigStore {
  [key: string]: unknown;
  collection: GuildConfigCollection;
  logger: LoggerLike | undefined;
  defaults: { prefix: string; settings: GuildConfigSettings };
  cache: Map<string, CachedGuildConfig>;
  inFlightGets: Map<string, Promise<GuildConfigDocument>>;
  cacheTtlMs: number;
  maxCacheSize: number;

  constructor(options: GuildConfigStoreOptions) {
    this.collection = options.collection;
    this.logger = options.logger ?? undefined;

    this.defaults = {
      prefix: options.defaults?.prefix ?? '!',
      settings: {
        dedupeEnabled: Boolean(options.defaults?.settings?.dedupeEnabled),
        stayInVoiceEnabled: Boolean(options.defaults?.settings?.stayInVoiceEnabled),
        volumePercent: normalizeVolumePercent(options.defaults?.settings?.volumePercent, 100),
        voteSkipRatio: toRatio(options.defaults?.settings?.voteSkipRatio, 0.5),
        voteSkipMinVotes: toPositiveInt(options.defaults?.settings?.voteSkipMinVotes, 2),
        djRoleIds: normalizeRoleIds(options.defaults?.settings?.djRoleIds ?? []) as string[],
        musicLogChannelId: normalizeChannelId(options.defaults?.settings?.musicLogChannelId),
      },
    };

    this.cache = new Map();
    this.inFlightGets = new Map();
    this.cacheTtlMs = options.cacheTtlMs ?? 60_000;
    this.maxCacheSize = options.maxCacheSize ?? 5_000;
  }

  async init() {
    await this.collection.createIndex({ guildId: 1 }, { unique: true });
    await this.collection.createIndex({ updatedAt: 1 });

    this.logger?.info?.('Guild config store ready', {
      cacheTtlMs: this.cacheTtlMs,
      maxCacheSize: this.maxCacheSize,
    });
  }

  async get(guildId: unknown) {
    const key = String(guildId ?? '').trim();
    if (!key) {
      throw new ValidationError('guildId is required for config lookup.');
    }

    const cached = this._getCached(key);
    if (cached) {
      return cached;
    }

    const pending = this.inFlightGets.get(key);
    if (pending) {
      const resolved = await pending;
      return cloneConfig(resolved);
    }

    const loadPromise = (async () => {
      const doc = await this.collection.findOne({ guildId: key });
      const normalized = this._normalizeDocument(key, doc);
      this._setCached(key, normalized);
      return normalized;
    })();

    this.inFlightGets.set(key, loadPromise);
    try {
      const resolved = await loadPromise;
      return cloneConfig(resolved);
    } finally {
      this.inFlightGets.delete(key);
    }
  }

  async update(guildId: unknown, patch: GuildConfigPatch = {}) {
    const key = String(guildId ?? '').trim();
    if (!key) {
      throw new ValidationError('guildId is required for config update.');
    }

    const current = await this.get(key);
    const next = this._applyPatch(current, patch);

    if (this._isSameConfig(current, next)) {
      return cloneConfig(next);
    }

    const now = new Date();
    await this.collection.updateOne(
      { guildId: key },
      {
        $setOnInsert: {
          guildId: key,
          createdAt: current.createdAt ?? now,
        },
        $set: {
          prefix: next.prefix,
          settings: {
            dedupeEnabled: next.settings.dedupeEnabled,
            stayInVoiceEnabled: next.settings.stayInVoiceEnabled,
            volumePercent: next.settings.volumePercent,
            voteSkipRatio: next.settings.voteSkipRatio,
            voteSkipMinVotes: next.settings.voteSkipMinVotes,
            djRoleIds: [...next.settings.djRoleIds],
            musicLogChannelId: next.settings.musicLogChannelId,
          },
          updatedAt: now,
        },
      },
      { upsert: true }
    );

    const saved = {
      ...next,
      updatedAt: now,
      createdAt: current.createdAt ?? now,
    };

    this._setCached(key, saved);
    return cloneConfig(saved);
  }

  _applyPatch(current: GuildConfigDocument, patch: GuildConfigPatch) {
    const next = cloneConfig(current);

    if (patch.prefix !== undefined) {
      next.prefix = normalizePrefix(patch.prefix, this.defaults.prefix);
    }

    const settingsPatch = patch.settings ?? null;
    if (settingsPatch && typeof settingsPatch === 'object') {
      if (settingsPatch.dedupeEnabled !== undefined) {
        next.settings.dedupeEnabled = toBool(settingsPatch.dedupeEnabled, next.settings.dedupeEnabled);
      }

      if (settingsPatch.stayInVoiceEnabled !== undefined) {
        next.settings.stayInVoiceEnabled = toBool(settingsPatch.stayInVoiceEnabled, next.settings.stayInVoiceEnabled);
      }

      if (settingsPatch.volumePercent !== undefined) {
        const volume = Number.parseInt(String(settingsPatch.volumePercent), 10);
        if (!Number.isFinite(volume) || volume < 0 || volume > 200) {
          throw new ValidationError('Volume must be an integer between 0 and 200.');
        }
        next.settings.volumePercent = volume;
      }

      if (settingsPatch.voteSkipRatio !== undefined) {
        const ratio = Number.parseFloat(String(settingsPatch.voteSkipRatio));
        if (!Number.isFinite(ratio) || ratio <= 0 || ratio > 1) {
          throw new ValidationError('Vote-skip ratio must be a number between 0 and 1.');
        }
        next.settings.voteSkipRatio = ratio;
      }

      if (settingsPatch.voteSkipMinVotes !== undefined) {
        const min = Number.parseInt(String(settingsPatch.voteSkipMinVotes), 10);
        if (!Number.isFinite(min) || min <= 0 || min > 100) {
          throw new ValidationError('Vote-skip minimum votes must be an integer between 1 and 100.');
        }
        next.settings.voteSkipMinVotes = min;
      }

      if (settingsPatch.djRoleIds !== undefined) {
        next.settings.djRoleIds = normalizeRoleIds(settingsPatch.djRoleIds);
      }

      if (settingsPatch.musicLogChannelId !== undefined) {
        next.settings.musicLogChannelId = normalizeChannelId(settingsPatch.musicLogChannelId);
      }
    }

    return next;
  }

  _normalizeDocument(guildId: string, doc: GuildConfigDocLike) {
    const settings = doc?.settings ?? {};
    const createdAt = toDateOrNull(doc?.createdAt);
    const updatedAt = toDateOrNull(doc?.updatedAt);

    return {
      guildId,
      prefix: normalizeStoredPrefix(doc?.prefix, this.defaults.prefix, this.logger, guildId),
      settings: {
        dedupeEnabled: toBool(settings.dedupeEnabled, this.defaults.settings.dedupeEnabled),
        stayInVoiceEnabled: toBool(settings.stayInVoiceEnabled, this.defaults.settings.stayInVoiceEnabled),
        volumePercent: normalizeVolumePercent(settings.volumePercent, this.defaults.settings.volumePercent),
        voteSkipRatio: toRatio(settings.voteSkipRatio, this.defaults.settings.voteSkipRatio),
        voteSkipMinVotes: toPositiveInt(settings.voteSkipMinVotes, this.defaults.settings.voteSkipMinVotes),
        djRoleIds: normalizeRoleIds(settings.djRoleIds),
        musicLogChannelId: normalizeChannelId(settings.musicLogChannelId),
      },
      createdAt,
      updatedAt,
    };
  }

  _isSameConfig(a: GuildConfigDocument, b: GuildConfigDocument) {
    if (a.prefix !== b.prefix) return false;

    const as = a.settings;
    const bs = b.settings;

    if (as.dedupeEnabled !== bs.dedupeEnabled) return false;
    if (as.stayInVoiceEnabled !== bs.stayInVoiceEnabled) return false;
    if (as.volumePercent !== bs.volumePercent) return false;
    if (as.voteSkipRatio !== bs.voteSkipRatio) return false;
    if (as.voteSkipMinVotes !== bs.voteSkipMinVotes) return false;
    if (as.musicLogChannelId !== bs.musicLogChannelId) return false;

    if (as.djRoleIds.length !== bs.djRoleIds.length) return false;
    for (let i = 0; i < as.djRoleIds.length; i += 1) {
      if (as.djRoleIds[i] !== bs.djRoleIds[i]) return false;
    }

    return true;
  }

  _getCached(guildId: string) {
    const entry = this.cache.get(guildId);
    if (!entry) return null;

    if (entry.expiresAt <= Date.now()) {
      this.cache.delete(guildId);
      return null;
    }

    return cloneConfig(entry.value);
  }

  _setCached(guildId: string, value: GuildConfigDocument) {
    this.cache.delete(guildId);
    this.cache.set(guildId, {
      value: cloneConfig(value),
      expiresAt: Date.now() + this.cacheTtlMs,
    });

    while (this.cache.size > this.maxCacheSize) {
      const oldest = this.cache.keys().next().value as string | undefined;
      if (!oldest) break;
      this.cache.delete(oldest);
    }
  }
}


import type { LoggerLike } from '../../types/core.ts';

type GuildConfigSettings = {
  dedupeEnabled: boolean;
  stayInVoiceEnabled: boolean;
  volumePercent: number;
  voteSkipRatio: number;
  voteSkipMinVotes: number;
  djRoleIds: string[];
  musicLogChannelId?: string | null | undefined;
};

type GuildConfigDocument = {
  guildId: string;
  prefix: string;
  settings: GuildConfigSettings;
  createdAt: Date | null;
  updatedAt: Date | null;
};

type GuildConfigCollection = {
  createIndex: (spec: Record<string, number>, options?: Record<string, unknown>) => Promise<unknown>;
  findOne: (query: { guildId: string }) => Promise<GuildConfigDocLike>;
  updateOne: (
    query: { guildId: string },
    update: Record<string, unknown>,
    options?: { upsert?: boolean }
  ) => Promise<unknown>;
};

type GuildConfigStoreOptions = {
  collection: GuildConfigCollection;
  logger?: LoggerLike | undefined;
  defaults?: Partial<GuildConfigDocument> | undefined;
  cacheTtlMs?: number;
  maxCacheSize?: number;
};

type CachedGuildConfig = {
  value: GuildConfigDocument;
  expiresAt: number;
};
