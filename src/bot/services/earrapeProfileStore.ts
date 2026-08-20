import type { LoggerLike } from '../../types/core.ts';
import type { EarrapeProfileSnapshot, EarrapeProfileStoreLike, EarrapeProfileUpdate } from '../../types/domain.ts';

const OFFENSE_SCORE_DECAY_HALFLIFE_MS = 6 * 60 * 60 * 1000;
const MAX_OFFENSE_SCORE = 8;
const MAX_OFFENSE_EVENTS = 8;
const CALM_BASELINE_ALPHA = 0.08;
const CALM_BASELINE_MAX_RMS = 0.4;

type EarrapeProfileDoc = {
  guildId: string;
  userId: string;
  offenseScore?: number;
  offenseEvents?: number[];
  lastOffenseAtMs?: number | null;
  calmRmsBaseline?: number | null;
  createdAt?: Date;
  updatedAt?: Date;
};

type EarrapeProfileCollection = {
  createIndex: (spec: Record<string, number>, options?: Record<string, unknown>) => Promise<unknown>;
  findOne: (query: { guildId: string; userId: string }) => Promise<EarrapeProfileDoc | null>;
  updateOne: (
    query: { guildId: string; userId: string },
    update: Record<string, unknown>,
    options?: { upsert?: boolean }
  ) => Promise<unknown>;
};

type EarrapeProfileStoreOptions = {
  collection: EarrapeProfileCollection;
  logger?: LoggerLike | null | undefined;
};

function toFiniteNumber(value: unknown, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeEventTimestamps(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  const deduped = new Set<number>();
  for (const item of value) {
    const ts = Math.trunc(toFiniteNumber(item, 0));
    if (ts > 0) deduped.add(ts);
  }
  return [...deduped].sort((a, b) => a - b).slice(-MAX_OFFENSE_EVENTS);
}

function decayOffenseScore(score: number, lastOffenseAtMs: number | null, nowMs: number) {
  const safeScore = Math.max(0, toFiniteNumber(score, 0));
  if (!safeScore || !lastOffenseAtMs || nowMs <= lastOffenseAtMs) return safeScore;
  const elapsed = nowMs - lastOffenseAtMs;
  const factor = 2 ** (-elapsed / OFFENSE_SCORE_DECAY_HALFLIFE_MS);
  return Number((safeScore * factor).toFixed(4));
}

function clamp01(value: unknown) {
  const parsed = toFiniteNumber(value, NaN);
  if (!Number.isFinite(parsed)) return null;
  return Math.max(0, Math.min(1, parsed));
}

function normalizeDoc(doc: EarrapeProfileDoc | null | undefined, nowMs: number): EarrapeProfileSnapshot {
  const offenseEvents = normalizeEventTimestamps(doc?.offenseEvents ?? []);
  const lastOffenseAtMs = offenseEvents.length > 0
    ? offenseEvents[offenseEvents.length - 1] ?? null
    : Math.trunc(toFiniteNumber(doc?.lastOffenseAtMs, 0)) || null;
  const decayedOffense = decayOffenseScore(toFiniteNumber(doc?.offenseScore, 0), lastOffenseAtMs, nowMs);
  const calmRmsBaseline = clamp01(doc?.calmRmsBaseline);

  return {
    offenseScore: Math.max(0, Math.min(MAX_OFFENSE_SCORE, decayedOffense)),
    offenseEvents,
    offenseEventCount: offenseEvents.length,
    lastOffenseAtMs,
    calmRmsBaseline,
  };
}

export class EarrapeProfileStore implements EarrapeProfileStoreLike {
  collection: EarrapeProfileCollection;
  logger?: LoggerLike | undefined;

  constructor(options: EarrapeProfileStoreOptions) {
    this.collection = options.collection;
    this.logger = options.logger ?? undefined;
  }

  async init() {
    await this.collection.createIndex({ guildId: 1, userId: 1 }, { unique: true });
    await this.collection.createIndex({ guildId: 1, updatedAt: -1 });
    this.logger?.info?.('Earrape profile store ready');
  }

  async getProfile(guildId: string, userId: string, nowMs = Date.now()): Promise<EarrapeProfileSnapshot> {
    const safeGuildId = String(guildId ?? '').trim();
    const safeUserId = String(userId ?? '').trim();
    if (!safeGuildId || !safeUserId) {
      return {
        offenseScore: 0,
        offenseEvents: [],
        offenseEventCount: 0,
        lastOffenseAtMs: null,
        calmRmsBaseline: null,
      };
    }

    const doc = await this.collection.findOne({ guildId: safeGuildId, userId: safeUserId }).catch(() => null);
    return normalizeDoc(doc, nowMs);
  }

  async updateProfile(
    guildId: string,
    userId: string,
    update: EarrapeProfileUpdate,
    nowMs = Date.now()
  ): Promise<EarrapeProfileSnapshot> {
    const safeGuildId = String(guildId ?? '').trim();
    const safeUserId = String(userId ?? '').trim();
    if (!safeGuildId || !safeUserId) {
      return {
        offenseScore: 0,
        offenseEvents: [],
        offenseEventCount: 0,
        lastOffenseAtMs: null,
        calmRmsBaseline: null,
      };
    }

    const currentDoc = await this.collection.findOne({ guildId: safeGuildId, userId: safeUserId }).catch(() => null);
    const current = normalizeDoc(currentDoc, nowMs);
    const offenseDetected = update.offenseDetected === true;

    const nextEvents = [...current.offenseEvents];
    if (offenseDetected) {
      nextEvents.push(nowMs);
    }
    const offenseEvents = normalizeEventTimestamps(nextEvents);
    const lastOffenseAtMs = offenseEvents.length > 0 ? (offenseEvents[offenseEvents.length - 1] ?? null) : null;

    let offenseScore = current.offenseScore;
    if (offenseDetected) {
      offenseScore = Math.min(MAX_OFFENSE_SCORE, offenseScore + 1);
    }

    let calmRmsBaseline = current.calmRmsBaseline;
    const calmSample = clamp01(update.calmRmsSample);
    if (calmSample != null && calmSample <= CALM_BASELINE_MAX_RMS) {
      calmRmsBaseline = calmRmsBaseline == null
        ? calmSample
        : Number(((calmRmsBaseline * (1 - CALM_BASELINE_ALPHA)) + (calmSample * CALM_BASELINE_ALPHA)).toFixed(6));
    }

    const now = new Date(nowMs);
    await this.collection.updateOne(
      { guildId: safeGuildId, userId: safeUserId },
      {
        $setOnInsert: {
          guildId: safeGuildId,
          userId: safeUserId,
          createdAt: now,
        },
        $set: {
          offenseScore,
          offenseEvents,
          offenseEventCount: offenseEvents.length,
          lastOffenseAtMs,
          calmRmsBaseline,
          updatedAt: now,
        },
      },
      { upsert: true }
    );

    return {
      offenseScore,
      offenseEvents,
      offenseEventCount: offenseEvents.length,
      lastOffenseAtMs,
      calmRmsBaseline,
    };
  }
}

