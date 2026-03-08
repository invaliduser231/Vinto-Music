const RADIO_LOOKUP_CACHE_TTL_MS = 45_000;
const RADIO_LOOKUP_TIMEOUT_MS = 12_000;
const RADIO_SAMPLE_MAX_BYTES = 768 * 1024;
const RADIO_SAMPLE_MIN_BYTES = 64 * 1024;

const radioLookupCache = new Map();
const radioLookupInFlight = new Map();

function getCachedRadioLookup(url) {
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

function setCachedRadioLookup(url, value) {
  const key = String(url ?? '').trim();
  if (!key || !value) return;
  radioLookupCache.set(key, {
    value,
    expiresAt: Date.now() + RADIO_LOOKUP_CACHE_TTL_MS,
  });
}

function toNormalizedResult(value, source) {
  const artist = String(value?.artist ?? '').trim();
  const title = String(value?.title ?? '').trim();
  if (!artist && !title) return null;
  return {
    artist: artist || null,
    title: title || null,
    source,
  };
}

function parseIcyMetadataString(raw) {
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

async function readIcyMetadata(url) {
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
          metadataLength = pending[0] * 16;
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

async function readAudioSample(url) {
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      accept: '*/*',
    },
    signal: AbortSignal.timeout(RADIO_LOOKUP_TIMEOUT_MS),
  }).catch(() => null);
  if (!response?.ok || !response.body) return null;

  const reader = response.body.getReader?.();
  if (!reader) return null;

  const chunks = [];
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
    contentType: String(response.headers.get('content-type') ?? 'audio/mpeg').trim() || 'audio/mpeg',
  };
}

async function detectWithAudD(url, apiToken) {
  if (!apiToken) return null;

  const sample = await readAudioSample(url);
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

  const payload = await response.json().catch(() => null);
  if (String(payload?.status ?? '').toLowerCase() !== 'success') return null;
  return toNormalizedResult(payload?.result, 'audd');
}

export async function detectRadioNowPlaying({ url, auddApiToken, logger = null }) {
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
