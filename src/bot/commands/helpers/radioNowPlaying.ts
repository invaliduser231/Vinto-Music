import { spawn } from 'node:child_process';
import ffmpegPath from 'ffmpeg-static';

const RADIO_LOOKUP_CACHE_TTL_MS = 45_000;
const RADIO_LOOKUP_TIMEOUT_MS = 12_000;
const RADIO_SAMPLE_MAX_BYTES = 768 * 1024;
const RADIO_SAMPLE_MIN_BYTES = 64 * 1024;
const RADIO_FFMPEG_SAMPLE_SECONDS = 12;

type AudioSample = {
  bytes: Buffer;
  contentType: string;
};

type RadioLookupResult = {
  artist: string | null;
  title: string | null;
  source: string;
};

type SpawnLike = typeof spawn;
type AuddPayload = {
  status?: unknown;
  result?: unknown;
};
type MetadataCandidate = { artist?: unknown; title?: unknown };

function isHlsLikeUrl(url: unknown): boolean {
  return String(url ?? '').toLowerCase().includes('.m3u8');
}

function isHlsLikeContentType(contentType: unknown): boolean {
  const normalized = String(contentType ?? '').toLowerCase();
  return (
    normalized.includes('application/vnd.apple.mpegurl')
    || normalized.includes('application/x-mpegurl')
    || normalized.includes('audio/mpegurl')
    || normalized.includes('audio/x-mpegurl')
  );
}

const radioLookupCache = new Map<string, { value: RadioLookupResult; expiresAt: number }>();
const radioLookupInFlight = new Map<string, Promise<RadioLookupResult | null>>();
let radioSpawn: SpawnLike = spawn;

export function __setRadioNowPlayingSpawnForTests(value: unknown): void {
  radioSpawn = (typeof value === 'function' ? value : spawn) as SpawnLike;
}

function getCachedRadioLookup(url: unknown): RadioLookupResult | null {
  const key = String(url ?? '').trim();
  if (!key) return null;
  const cached = radioLookupCache.get(key);
  if (!cached) return null;
  if (cached.expiresAt <= Date.now()) {
    radioLookupCache.delete(key);
    return null;
  }
  return cached.value ?? null;
}

function setCachedRadioLookup(url: unknown, value: RadioLookupResult | null): void {
  const key = String(url ?? '').trim();
  if (!key || !value) return;
  radioLookupCache.set(key, {
    value,
    expiresAt: Date.now() + RADIO_LOOKUP_CACHE_TTL_MS,
  });
}

function toNormalizedResult(value: unknown, source: string): RadioLookupResult | null {
  const candidate = value && typeof value === 'object' ? (value as MetadataCandidate) : {};
  const artist = String(candidate.artist ?? '').trim();
  const title = String(candidate.title ?? '').trim();
  if (!artist && !title) return null;
  return {
    artist: artist || null,
    title: title || null,
    source,
  };
}

function parseIcyMetadataString(raw: unknown): { artist: string | null; title: string | null } | null {
  const value = String(raw ?? '').trim();
  if (!value) return null;

  const titleMatch = value.match(/StreamTitle='([^']*)';?/i) ?? value.match(/StreamTitle="([^"]*)";?/i);
  const streamTitle = String(titleMatch?.[1] ?? '').trim();
  if (!streamTitle) return null;

  const separators = [' - ', ' – ', ' — ', ' by '];
  for (const separator of separators) {
    const index = streamTitle.indexOf(separator);
    if (index <= 0) continue;
    const left = streamTitle.slice(0, index).trim();
    const right = streamTitle.slice(index + separator.length).trim();
    if (left && right) {
      if (separator === ' by ') {
        return { artist: right, title: left };
      }
      return { artist: left, title: right };
    }
  }

  return { artist: null, title: streamTitle };
}

async function readIcyMetadata(url: string): Promise<{ artist: string | null; title: string | null } | null> {
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'Icy-MetaData': '1',
      accept: '*/*',
    },
    signal: AbortSignal.timeout(RADIO_LOOKUP_TIMEOUT_MS),
  }).catch(() => null);
  if (!response?.ok || !response.body) return null;

  const metaint = Number.parseInt(String(response.headers.get('icy-metaint') ?? ''), 10);
  if (!Number.isFinite(metaint) || metaint <= 0) {
    try {
      await response.body.cancel?.();
    } catch {
      // ignore cancellation errors
    }
    return null;
  }

  const reader = response.body.getReader?.();
  if (!reader) return null;

  let pending = new Uint8Array(0);
  let audioBytesSeen = 0;
  let metadataLength = null;
  let metadataBytesNeeded = 0;

  try {
    while (audioBytesSeen < (metaint * 4)) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value?.length) continue;

      const next = new Uint8Array(pending.length + value.length);
      next.set(pending);
      next.set(value, pending.length);
      pending = next;

      while (pending.length > 0) {
        if (audioBytesSeen < metaint) {
          const need = metaint - audioBytesSeen;
          if (pending.length < need) {
            audioBytesSeen += pending.length;
            pending = new Uint8Array(0);
            break;
          }

          pending = pending.slice(need);
          audioBytesSeen = metaint;
        }

        if (metadataLength == null) {
          if (pending.length < 1) break;
          metadataLength = (pending[0] ?? 0) * 16;
          metadataBytesNeeded = metadataLength;
          pending = pending.slice(1);
          if (metadataBytesNeeded === 0) {
            audioBytesSeen = 0;
            metadataLength = null;
          }
        }

        if (metadataLength != null) {
          if (pending.length < metadataBytesNeeded) break;
          const metadataBytes = pending.slice(0, metadataBytesNeeded);
          const metadataText = new TextDecoder('utf-8', { fatal: false }).decode(metadataBytes).replace(/\0+$/g, '');
          const parsed = parseIcyMetadataString(metadataText);
          if (parsed) return parsed;

          pending = pending.slice(metadataBytesNeeded);
          audioBytesSeen = 0;
          metadataLength = null;
          metadataBytesNeeded = 0;
        }
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // ignore cancellation errors
    }
  }

  return null;
}

async function readAudioSample(url: string): Promise<AudioSample | null> {
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      accept: '*/*',
    },
    signal: AbortSignal.timeout(RADIO_LOOKUP_TIMEOUT_MS),
  }).catch(() => null);
  if (!response?.ok || !response.body) return null;

  const contentType = String(response.headers.get('content-type') ?? 'audio/mpeg').trim() || 'audio/mpeg';
  if (isHlsLikeUrl(url) || isHlsLikeContentType(contentType)) {
    try {
      await response.body.cancel?.();
    } catch {
      // ignore cancellation errors
    }
    return readAudioSampleWithFfmpeg(url);
  }

  const reader = response.body.getReader?.();
  if (!reader) return null;

  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    while (total < RADIO_SAMPLE_MAX_BYTES) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value?.length) continue;
      chunks.push(value);
      total += value.length;
      if (total >= RADIO_SAMPLE_MIN_BYTES) break;
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // ignore cancellation errors
    }
  }

  if (total < 4_096) return null;
  return {
    bytes: Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))),
    contentType,
  };
}

async function readAudioSampleWithFfmpeg(url: string): Promise<AudioSample | null> {
  const ffmpegBin = String(process.env.FFMPEG_BIN || ffmpegPath || 'ffmpeg');

  return new Promise<AudioSample | null>((resolve) => {
    const args = [
      '-nostdin',
      '-v', 'error',
      '-user_agent', 'Mozilla/5.0 (compatible; FluxerBot/1.0)',
      '-t', String(RADIO_FFMPEG_SAMPLE_SECONDS),
      '-i', url,
      '-vn',
      '-ac', '2',
      '-ar', '44100',
      '-b:a', '128k',
      '-f', 'mp3',
      'pipe:1',
    ];

    const proc = radioSpawn(ffmpegBin, args, {
      stdio: ['ignore', 'pipe', 'ignore'],
    });

    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      proc.kill('SIGKILL');
      resolve(null);
    }, RADIO_LOOKUP_TIMEOUT_MS);

    if (!proc.stdout) {
      settled = true;
      clearTimeout(timeout);
      proc.kill('SIGKILL');
      resolve(null);
      return;
    }

    proc.stdout.on('data', (chunk: unknown) => {
      if (settled) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk ?? ''));
      if (!buffer.length) return;
      chunks.push(buffer);
      total += buffer.length;
      if (total >= RADIO_SAMPLE_MAX_BYTES) {
        settled = true;
        clearTimeout(timeout);
        proc.kill('SIGKILL');
        resolve({
          bytes: Buffer.concat(chunks),
          contentType: 'audio/mpeg',
        });
      }
    });

    proc.once('error', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(null);
    });

    proc.once('close', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (total < 4_096) {
        resolve(null);
        return;
      }
      resolve({
        bytes: Buffer.concat(chunks),
        contentType: 'audio/mpeg',
      });
    });
  });
}

async function detectWithAudD(url: string, apiToken: string | null): Promise<RadioLookupResult | null> {
  if (!apiToken) return null;

  const sample = await readAudioSample(url) as AudioSample | null;
  if (!sample?.bytes?.length) return null;

  const form = new FormData();
  form.set('api_token', apiToken);
  form.set('return', 'apple_music,spotify');
  form.set(
    'file',
    new Blob([sample.bytes], { type: sample.contentType }),
    'radio-sample.mp3'
  );

  const response = await fetch('https://api.audd.io/', {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(RADIO_LOOKUP_TIMEOUT_MS),
  }).catch(() => null);
  if (!response?.ok) return null;

  const payload = await response.json().catch(() => null) as AuddPayload | null;
  if (String(payload?.status ?? '').toLowerCase() !== 'success') return null;
  return toNormalizedResult(payload?.result, 'audd');
}

export async function detectRadioNowPlaying(
  { url, auddApiToken, logger = null }: { url: unknown; auddApiToken?: unknown; logger?: { debug?: (message: string, meta?: Record<string, unknown>) => void } | null },
): Promise<RadioLookupResult | null> {
  const safeUrl = String(url ?? '').trim();
  if (!safeUrl) return null;

  const cached = getCachedRadioLookup(safeUrl);
  if (cached) return cached;

  const inFlight = radioLookupInFlight.get(safeUrl);
  if (inFlight) return inFlight;

  const task = (async () => {
    const icy = toNormalizedResult(await readIcyMetadata(safeUrl).catch(() => null), 'icy');
    if (icy) {
      setCachedRadioLookup(safeUrl, icy);
      return icy;
    }

    const audd = await detectWithAudD(safeUrl, String(auddApiToken ?? '').trim() || null).catch((err) => {
      logger?.debug?.('Radio now playing recognition failed', {
        url: safeUrl,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    });
    if (audd) {
      setCachedRadioLookup(safeUrl, audd);
      return audd;
    }

    return null;
  })();

  radioLookupInFlight.set(safeUrl, task);
  try {
    return await task;
  } finally {
    radioLookupInFlight.delete(safeUrl);
  }
}


