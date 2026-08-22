import type { Track } from '../../types/domain.ts';

export type MirrorReference = {
  title?: unknown;
  artist?: unknown;
  duration?: unknown;
  durationInSec?: unknown;
  isrc?: unknown;
};

export type MirrorConfidence = 'exact' | 'strong' | 'weak' | 'reject';

export type MirrorEvaluation = {
  confidence: MirrorConfidence;
  score: number;
  titleRatio: number;
  artistMatched: boolean;
  durationDeltaSec: number | null;
};

const STRONG_TITLE_RATIO = 0.7;
const WEAK_TITLE_RATIO = 0.5;
const DURATION_TOLERANCE_SEC = 15;
const NOISE_TOKENS = new Set([
  'official',
  'video',
  'audio',
  'lyric',
  'lyrics',
  'hd',
  'hq',
  'mv',
  'remaster',
  'remastered',
  'version',
  'feat',
  'ft',
  'featuring',
  'with',
  'and',
  'the',
  'a',
  'de',
  'la',
  'el',
  'o',
]);

export function normalizeMirrorIsrc(value: unknown) {
  const normalized = String(value ?? '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  return normalized.length === 12 ? normalized : null;
}

export function toMirrorSeconds(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return Math.floor(value);
  const raw = String(value ?? '').trim();
  if (!raw || raw.toLowerCase() === 'unknown' || raw.toLowerCase() === 'live') return null;
  if (/^\d+$/.test(raw)) {
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }
  const parts = raw.split(':').map((part) => Number.parseInt(part, 10));
  if (!parts.length || !parts.every((part) => Number.isFinite(part))) return null;
  if (parts.length === 2) return ((parts[0] ?? 0) * 60) + (parts[1] ?? 0);
  if (parts.length === 3) return ((parts[0] ?? 0) * 3600) + ((parts[1] ?? 0) * 60) + (parts[2] ?? 0);
  return null;
}

export function normalizeMirrorText(value: unknown) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')
    .replace(/\b(feat|ft|featuring)\b.*$/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function tokenize(value: unknown) {
  return normalizeMirrorText(value)
    .split(' ')
    .filter((token) => token.length > 1 && !NOISE_TOKENS.has(token));
}

function primaryArtist(value: unknown) {
  const raw = String(value ?? '').split(/[,;&/]| x | vs /i)[0] ?? '';
  return normalizeMirrorText(raw);
}

function titleOverlapRatio(referenceTitle: unknown, candidateText: string) {
  const referenceTokens = tokenize(referenceTitle);
  if (!referenceTokens.length) return 0;
  const candidateTokens = new Set(candidateText.split(' ').filter(Boolean));
  const hits = referenceTokens.filter((token) => candidateTokens.has(token)).length;
  return hits / referenceTokens.length;
}

function matchesArtist(referenceArtist: unknown, candidate: Partial<Track> | null | undefined, candidateText: string) {
  const reference = primaryArtist(referenceArtist);
  if (!reference) return true;

  const candidateArtist = normalizeMirrorText(candidate?.artist);
  if (candidateArtist && (candidateArtist.includes(reference) || reference.includes(candidateArtist))) {
    return true;
  }
  return candidateText.includes(reference);
}

export function evaluateMirrorCandidate(
  reference: MirrorReference | null | undefined,
  candidate: Partial<Track> | null | undefined,
): MirrorEvaluation {
  const rejected: MirrorEvaluation = {
    confidence: 'reject',
    score: 0,
    titleRatio: 0,
    artistMatched: false,
    durationDeltaSec: null,
  };
  if (!candidate) return rejected;

  const referenceIsrc = normalizeMirrorIsrc(reference?.isrc);
  const candidateIsrc = normalizeMirrorIsrc(candidate.isrc);
  if (referenceIsrc && candidateIsrc && referenceIsrc === candidateIsrc) {
    return { confidence: 'exact', score: 100, titleRatio: 1, artistMatched: true, durationDeltaSec: 0 };
  }

  const candidateText = normalizeMirrorText(`${candidate.title ?? ''} ${candidate.artist ?? ''}`);
  if (!candidateText) return rejected;

  const titleRatio = titleOverlapRatio(reference?.title, candidateText);
  const artistMatched = matchesArtist(reference?.artist, candidate, candidateText);
  const referenceSeconds = toMirrorSeconds(reference?.durationInSec ?? reference?.duration);
  const candidateSeconds = toMirrorSeconds(candidate.duration);
  const durationDeltaSec = referenceSeconds != null && candidateSeconds != null
    ? Math.abs(referenceSeconds - candidateSeconds)
    : null;
  const durationMatched = durationDeltaSec == null || durationDeltaSec <= DURATION_TOLERANCE_SEC;

  const score = (titleRatio * 60)
    + (artistMatched ? 25 : 0)
    + (durationDeltaSec == null ? 5 : Math.max(0, 15 - durationDeltaSec));

  if (titleRatio >= STRONG_TITLE_RATIO && artistMatched && durationMatched) {
    return { confidence: 'strong', score, titleRatio, artistMatched, durationDeltaSec };
  }
  if (titleRatio >= WEAK_TITLE_RATIO && (artistMatched || durationMatched)) {
    return { confidence: 'weak', score, titleRatio, artistMatched, durationDeltaSec };
  }
  return { ...rejected, titleRatio, artistMatched, durationDeltaSec };
}

export function pickBestMirrorCandidate<T extends Partial<Track>>(
  reference: MirrorReference | null | undefined,
  candidates: unknown,
  options: { allowWeak?: boolean } = {},
): { track: T; evaluation: MirrorEvaluation } | null {
  const list = Array.isArray(candidates) ? candidates as T[] : [];
  const allowWeak = options.allowWeak === true;
  let best: { track: T; evaluation: MirrorEvaluation } | null = null;

  for (const candidate of list) {
    if (!candidate) continue;
    const evaluation = evaluateMirrorCandidate(reference, candidate);
    if (evaluation.confidence === 'reject') continue;
    if (evaluation.confidence === 'weak' && !allowWeak) continue;
    if (evaluation.confidence === 'exact') return { track: candidate, evaluation };
    if (!best || evaluation.score > best.evaluation.score) {
      best = { track: candidate, evaluation };
    }
  }

  return best;
}
