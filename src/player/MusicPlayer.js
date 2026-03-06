import { EventEmitter } from 'events';
import { spawn } from 'child_process';
import { createCipheriv, createDecipheriv, createHash, getCiphers } from 'node:crypto';
import { copyFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { PassThrough, Transform } from 'node:stream';
import ffmpegPath from 'ffmpeg-static';
import { Blowfish } from 'egoroof-blowfish';
import playdl from 'play-dl';
import { Queue } from './Queue.js';
import { ValidationError } from '../core/errors.js';

const LOOP_OFF = 'off';
const LOOP_TRACK = 'track';
const LOOP_QUEUE = 'queue';
const LOOP_MODES = new Set([LOOP_OFF, LOOP_TRACK, LOOP_QUEUE]);

const FILTER_PRESETS = {
  off: [],
  bassboost: ['bass=g=8:f=110:w=0.6'],
  nightcore: ['asetrate=48000*1.20', 'aresample=48000', 'atempo=1.05'],
  vaporwave: ['asetrate=48000*0.80', 'aresample=48000', 'atempo=0.95', 'lowpass=f=3200'],
  '8d': ['apulsator=hz=0.08'],
  soft: ['highshelf=f=8000:g=-6', 'lowshelf=f=120:g=-2'],
  karaoke: ['pan=stereo|c0=0.5*c0-0.5*c1|c1=0.5*c1-0.5*c0'],
  radio: ['highpass=f=200', 'lowpass=f=3500', 'acompressor=threshold=-18dB:ratio=3:attack=20:release=250'],
};
FILTER_PRESETS.karoake = FILTER_PRESETS.karaoke;

const EQ_PRESETS = {
  flat: [0, 0, 0, 0, 0],
  pop: [2, 1, 0, 1, 2],
  rock: [4, 2, -1, 2, 4],
  edm: [5, 3, 0, 2, 4],
  vocal: [-1, 1, 3, 3, 1],
};
const EQ_BANDS = [90, 250, 1000, 4000, 12000];
const YT_PLAYLIST_RESOLVERS = new Set(['ytdlp', 'playdl']);
const DEEZER_STRIPE_CHUNK_SIZE = 2048;
const DEEZER_BLOWFISH_IV = Buffer.from([0, 1, 2, 3, 4, 5, 6, 7]);
const DEEZER_FILE_KEY = Buffer.from('jo6aey6haid2Teih', 'ascii');
const DEEZER_BLOWFISH_SECRET = 'g4el58wc0zvf9na1';
const DEEZER_BF_CBC_SUPPORTED = getCiphers().includes('bf-cbc');
const DEEZER_ALLOWED_TRACK_FORMATS = new Set([
  'FLAC',
  'MP3_320',
  'MP3_256',
  'MP3_128',
  'MP3_64',
  'AAC_64',
]);
const DEEZER_LAVASRC_DEFAULT_FORMATS = ['MP3_128', 'MP3_64'];
const DEEZER_MEDIA_QUALITY_MAP = new Map([
  ['FLAC', 9],
  ['MP3_320', 3],
  ['MP3_256', 3],
  ['MP3_128', 1],
]);
const DEEZER_SESSION_TOKEN_TTL_MS = 3_600_000;
const DEEZER_STREAM_RETRY_LIMIT = 8;
const DEEZER_STREAM_BASE_BACKOFF_MS = 250;
const DEEZER_STREAM_MAX_BACKOFF_MS = 2_000;
const DEEZER_STREAM_HIGH_WATER_MARK = 1 << 20;

function md5Hex(value, encoding = 'ascii') {
  const hash = createHash('md5');
  hash.update(value, encoding);
  return hash.digest('hex');
}

function getDeezerBlowfishKey(trackId) {
  const idMd5 = md5Hex(String(trackId ?? '').trim(), 'ascii');
  const key = Buffer.alloc(16);

  for (let i = 0; i < 16; i += 1) {
    key[i] = (
      idMd5.charCodeAt(i)
      ^ idMd5.charCodeAt(i + 16)
      ^ DEEZER_BLOWFISH_SECRET.charCodeAt(i)
    ) & 0xff;
  }

  return key;
}

function createDeezerChunkDecryptor(blowfishKey) {
  if (DEEZER_BF_CBC_SUPPORTED) {
    return (chunk) => {
      const decipher = createDecipheriv('bf-cbc', blowfishKey, DEEZER_BLOWFISH_IV);
      decipher.setAutoPadding(false);
      return Buffer.concat([decipher.update(chunk), decipher.final()]);
    };
  }

  const cipher = new Blowfish(blowfishKey, Blowfish.MODE.CBC, Blowfish.PADDING.NULL);
  return (chunk) => {
    cipher.setIv(DEEZER_BLOWFISH_IV);
    return Buffer.from(cipher.decode(chunk, Blowfish.TYPE.UINT8_ARRAY));
  };
}

function getDeezerSongFileName(track, quality) {
  const md5Origin = String(track?.MD5_ORIGIN ?? '').trim();
  const songId = String(track?.SNG_ID ?? '').trim();
  const mediaVersion = String(track?.MEDIA_VERSION ?? '').trim();
  const step1 = [md5Origin, String(quality), songId, mediaVersion].join('\u00A4');

  let step2 = `${md5Hex(step1, 'ascii')}\u00A4${step1}\u00A4`;
  while (step2.length % 16 !== 0) {
    step2 += ' ';
  }

  const cipher = createCipheriv('aes-128-ecb', DEEZER_FILE_KEY, null);
  return cipher.update(step2, 'ascii').toString('hex');
}

function buildDeezerLegacyDownloadUrl(track, quality) {
  const md5Origin = String(track?.MD5_ORIGIN ?? '').trim();
  if (!md5Origin) return null;
  const cdn = md5Origin[0];
  const fileName = getDeezerSongFileName(track, quality);
  return `http://e-cdn-proxy-${cdn}.deezer.com/mobile/1/${fileName}`;
}

function parseContentRangeStart(value) {
  const raw = String(value ?? '').trim();
  const match = raw.match(/^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i);
  if (!match) return null;
  const parsed = Number.parseInt(match[1], 10);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return parsed;
}

function isRetryableDeezerStreamError(err) {
  const code = String(err?.code ?? '').trim().toUpperCase();
  if (['ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT'].includes(code)) {
    return true;
  }

  const message = String(err?.message ?? err ?? '').toLowerCase();
  return (
    message.includes('socket hang up')
    || message.includes('network')
    || message.includes('connection reset')
    || message.includes('body timeout')
    || message.includes('fetch failed')
    || message.includes('premature close')
  );
}

class DeezerBfStripeDecryptTransform extends Transform {
  constructor(trackId) {
    super({
      readableHighWaterMark: 1 << 20,
      writableHighWaterMark: 1 << 20,
    });
    this.trackId = String(trackId ?? '').trim();
    this.blowfishKey = getDeezerBlowfishKey(this.trackId);
    this.decryptChunk = createDeezerChunkDecryptor(this.blowfishKey);
    this.pendingChunks = [];
    this.pendingBytes = 0;
    this.blockIndex = 0;
  }

  _appendPendingChunk(chunk) {
    if (!chunk || chunk.length === 0) return;
    const normalized = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this.pendingChunks.push(normalized);
    this.pendingBytes += normalized.length;
  }

  _consumePendingStripe() {
    if (this.pendingBytes < DEEZER_STRIPE_CHUNK_SIZE) return null;

    const first = this.pendingChunks[0];
    if (first.length === DEEZER_STRIPE_CHUNK_SIZE) {
      this.pendingChunks.shift();
      this.pendingBytes -= DEEZER_STRIPE_CHUNK_SIZE;
      return first;
    }

    const stripe = Buffer.allocUnsafe(DEEZER_STRIPE_CHUNK_SIZE);
    let offset = 0;

    while (offset < DEEZER_STRIPE_CHUNK_SIZE && this.pendingChunks.length) {
      const chunk = this.pendingChunks[0];
      const remaining = DEEZER_STRIPE_CHUNK_SIZE - offset;
      const toCopy = Math.min(remaining, chunk.length);
      chunk.copy(stripe, offset, 0, toCopy);
      offset += toCopy;

      if (toCopy === chunk.length) {
        this.pendingChunks.shift();
      } else {
        this.pendingChunks[0] = chunk.subarray(toCopy);
      }
    }

    this.pendingBytes -= DEEZER_STRIPE_CHUNK_SIZE;
    return stripe;
  }

  _transform(chunk, _encoding, callback) {
    try {
      this._appendPendingChunk(chunk);
      while (this.pendingBytes >= DEEZER_STRIPE_CHUNK_SIZE) {
        const block = this._consumePendingStripe();
        if (!block || block.length !== DEEZER_STRIPE_CHUNK_SIZE) {
          throw new Error('Invalid Deezer stripe block size.');
        }

        if (this.blockIndex % 3 === 0) {
          this.push(this.decryptChunk(block));
        } else {
          this.push(block);
        }
        this.blockIndex += 1;
      }
      callback();
    } catch (err) {
      callback(err instanceof Error ? err : new Error(String(err)));
    }
  }

  _flush(callback) {
    if (this.pendingBytes > 0) {
      if (this.pendingChunks.length === 1) {
        this.push(this.pendingChunks[0]);
      } else {
        const remainder = Buffer.allocUnsafe(this.pendingBytes);
        let offset = 0;
        for (const part of this.pendingChunks) {
          part.copy(remainder, offset);
          offset += part.length;
        }
        this.push(remainder);
      }
      this.pendingChunks = [];
      this.pendingBytes = 0;
    }
    callback();
  }

  _destroy(err, callback) {
    this.pendingChunks = [];
    this.pendingBytes = 0;
    callback(err);
  }
}

function isHttpUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function isYouTubeUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.hostname.includes('youtube.com') || parsed.hostname.includes('youtu.be');
  } catch {
    return false;
  }
}

function extractYouTubeVideoId(value) {
  try {
    const parsed = new URL(value);
    const host = parsed.hostname.toLowerCase();

    if (host.includes('youtu.be')) {
      const segment = String(parsed.pathname ?? '').split('/').filter(Boolean)[0];
      return segment ? segment.trim() : null;
    }

    if (host.includes('youtube.com')) {
      const v = String(parsed.searchParams.get('v') ?? '').trim();
      return v || null;
    }

    return null;
  } catch {
    return null;
  }
}

function toCanonicalYouTubeWatchUrl(value) {
  const videoId = extractYouTubeVideoId(value);
  if (!videoId) return null;
  return `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
}

function inferYouTubeWatchUrlFromPlaylist(value) {
  try {
    const parsed = new URL(value);
    const host = parsed.hostname.toLowerCase();
    if (!host.includes('youtube.com') && !host.includes('youtu.be')) return null;

    const explicit = toCanonicalYouTubeWatchUrl(value);
    if (explicit) return explicit;

    const listId = String(parsed.searchParams.get('list') ?? '').trim();
    if (!listId || !listId.toUpperCase().startsWith('RD')) return null;

    const match = listId.match(/([A-Za-z0-9_-]{11})$/);
    if (!match?.[1]) return null;

    const videoId = match[1];
    return `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}&list=${encodeURIComponent(listId)}`;
  } catch {
    return null;
  }
}

function buildYouTubeThumbnailFromUrl(value) {
  const videoId = extractYouTubeVideoId(value);
  if (!videoId) return null;
  return `https://i.ytimg.com/vi/${encodeURIComponent(videoId)}/hqdefault.jpg`;
}

function normalizeYouTubeVideoUrlFromEntry(entry) {
  const webpageUrl = String(entry?.webpage_url ?? '').trim();
  if (webpageUrl && isYouTubeUrl(webpageUrl)) return webpageUrl;

  const rawUrl = String(entry?.url ?? '').trim();
  if (rawUrl && isYouTubeUrl(rawUrl)) return rawUrl;

  const id = String(entry?.id ?? '').trim();
  if (id) return `https://www.youtube.com/watch?v=${encodeURIComponent(id)}`;

  if (/^[\w-]{6,}$/.test(rawUrl)) {
    return `https://www.youtube.com/watch?v=${encodeURIComponent(rawUrl)}`;
  }

  return null;
}

function getYouTubePlaylistId(value) {
  try {
    const parsed = new URL(value);
    const host = parsed.hostname.toLowerCase();
    if (!host.includes('youtube.com') && !host.includes('youtu.be')) return null;
    const list = String(parsed.searchParams.get('list') ?? '').trim();
    return list || null;
  } catch {
    return null;
  }
}

function toCanonicalYouTubePlaylistUrl(value) {
  try {
    const parsed = new URL(value);
    const host = parsed.hostname.toLowerCase();
    if (!host.includes('youtube.com') && !host.includes('youtu.be')) return null;

    const listId = String(parsed.searchParams.get('list') ?? '').trim();
    if (!listId) return null;

    const videoId = String(parsed.searchParams.get('v') ?? '').trim();
    const requiresWatchContext = listId.toUpperCase().startsWith('RD')
      || String(parsed.searchParams.get('start_radio') ?? '').trim() === '1';

    if (videoId && requiresWatchContext) {
      return `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}&list=${encodeURIComponent(listId)}`;
    }

    return `https://www.youtube.com/playlist?list=${encodeURIComponent(listId)}`;
  } catch {
    return null;
  }
}

function isSoundCloudUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.hostname.includes('soundcloud.com') || parsed.hostname.includes('snd.sc') || parsed.hostname.includes('on.soundcloud.com');
  } catch {
    return false;
  }
}

function toSoundCloudDurationLabel(value) {
  if (value == null) return 'Unknown';

  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value > 10_000) {
      return toDurationLabel(Math.floor(value / 1000));
    }
    return toDurationLabel(value);
  }

  const parsed = Number.parseFloat(String(value));
  if (Number.isFinite(parsed)) {
    if (parsed > 10_000) {
      return toDurationLabel(Math.floor(parsed / 1000));
    }
    return toDurationLabel(parsed);
  }

  return toDurationLabel(value);
}

function toDeezerDurationLabel(value) {
  if (value == null) return 'Unknown';

  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value > 10_000) {
      return toDurationLabel(Math.floor(value / 1000));
    }
    return toDurationLabel(value);
  }

  const parsed = Number.parseFloat(String(value));
  if (Number.isFinite(parsed)) {
    if (parsed > 10_000) {
      return toDurationLabel(Math.floor(parsed / 1000));
    }
    return toDurationLabel(parsed);
  }

  return toDurationLabel(value);
}

function isDeezerUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.hostname.includes('deezer.com') || parsed.hostname.includes('link.deezer.com');
  } catch {
    return false;
  }
}

function isSpotifyUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.hostname.includes('spotify.com') || parsed.hostname.includes('spotify.link');
  } catch {
    return false;
  }
}

function extractDeezerTrackId(value) {
  try {
    const parsed = new URL(value);
    const parts = String(parsed.pathname ?? '')
      .split('/')
      .map((segment) => segment.trim())
      .filter(Boolean);

    const trackIdx = parts.findIndex((segment) => segment.toLowerCase() === 'track');
    if (trackIdx >= 0) {
      const next = parts[trackIdx + 1] ?? '';
      if (/^\d+$/.test(next)) return next;
    }

    const direct = parts.find((segment) => /^\d+$/.test(segment)) ?? null;
    return direct;
  } catch {
    return null;
  }
}

function isAudiusUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.hostname === 'audius.co' || parsed.hostname.endsWith('.audius.co');
  } catch {
    return false;
  }
}

function toAudiusDurationLabel(value) {
  if (value == null) return 'Unknown';

  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value > 10_000) {
      return toDurationLabel(Math.floor(value / 1000));
    }
    return toDurationLabel(value);
  }

  const parsed = Number.parseFloat(String(value));
  if (Number.isFinite(parsed)) {
    if (parsed > 10_000) {
      return toDurationLabel(Math.floor(parsed / 1000));
    }
    return toDurationLabel(parsed);
  }

  return toDurationLabel(value);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function toDurationLabel(value) {
  if (value == null) return 'Unknown';
  if (typeof value === 'number' && Number.isFinite(value)) {
    const total = Math.max(0, Math.floor(value));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;

    if (h > 0) {
      return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    }
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  return String(value);
}

function buildTrackId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function pickArtistName(track) {
  if (Array.isArray(track?.artists) && track.artists[0]?.name) {
    return track.artists[0].name;
  }
  if (track?.artist?.name) return track.artist.name;
  if (track?.user?.name) return track.user.name;
  return null;
}

function pickTrackArtistFromMetadata(track) {
  const nestedArtist = pickArtistName(track);
  if (nestedArtist) return String(nestedArtist).trim();

  const candidates = [
    track?.artist,
    track?.uploader,
    track?.creator,
    track?.channel?.name,
    track?.channel?.title,
    track?.channelName,
    track?.ownerChannelName,
    track?.author?.name,
    track?.author,
    track?.video_details?.channel?.name,
    track?.video_details?.channel?.title,
    track?.videoDetails?.channel?.name,
    track?.videoDetails?.channel?.title,
  ];

  for (const candidate of candidates) {
    const value = String(candidate ?? '').trim();
    if (value) return value;
  }

  return null;
}


function isSoundCloudAuthorizationError(err) {
  const message = String(err?.message ?? err ?? '').toLowerCase();
  return (
    message.includes('soundcloud data is missing')
    || message.includes('did you forget to do authorization')
    || (message.includes('soundcloud') && message.includes('authorization'))
  );
}

function soundCloudAuthorizationHelp() {
  return 'SoundCloud lookup needs SoundCloud authorization in play-dl. Falling back to YouTube search for this URL.';
}

function isYouTubeBotCheckError(err) {
  const message = String(err?.message ?? err ?? '').toLowerCase();
  return message.includes('sign in to confirm') || message.includes('not a bot');
}

function isYtDlpModuleMissingError(err) {
  const message = String(err?.message ?? err ?? '').toLowerCase();
  return (
    message.includes('no module named yt_dlp')
    || message.includes('no module named yt-dlp')
    || message.includes('module named yt_dlp')
  );
}

function isConnectionRefusedError(err) {
  const message = String(err?.message ?? err ?? '').toLowerCase();
  return (
    message.includes('winerror 10061')
    || message.includes('connection refused')
    || message.includes('zielcomputer die verbindung verweigerte')
  );
}

function isRequestedFormatUnavailableError(err) {
  const message = String(err?.message ?? err ?? '').toLowerCase();
  return (
    message.includes('requested format is not available')
    || message.includes('format is not available')
  );
}

function isYtDlpOutputTimeoutError(err) {
  const message = String(err?.message ?? err ?? '').toLowerCase();
  return message.includes('yt-dlp did not produce audio output in time');
}

function isYtDlpExitedBeforeOutputError(err) {
  const message = String(err?.message ?? err ?? '').toLowerCase();
  return message.includes('yt-dlp exited before output');
}

function isRetryableYtDlpStartupError(err) {
  return (
    isRequestedFormatUnavailableError(err)
    || isYtDlpOutputTimeoutError(err)
    || isYtDlpExitedBeforeOutputError(err)
  );
}

function isPlayDlBrowseFailure(err) {
  const message = String(err?.message ?? err ?? '').toLowerCase();
  return (
    message.includes('browseid')
    || message.includes("cannot read properties of undefined (reading 'browseid')")
    || (message.includes('cannot read properties of undefined') && message.includes('youtube'))
  );
}

function parseCsvArgs(value) {
  if (!value) return [];
  return String(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeDeezerTrackFormats(formatsValue) {
  const raw = Array.isArray(formatsValue) ? formatsValue : parseCsvArgs(formatsValue);
  const normalized = [];
  const seen = new Set();

  for (const entry of raw) {
    const format = String(entry ?? '').trim().toUpperCase();
    if (!format || seen.has(format) || !DEEZER_ALLOWED_TRACK_FORMATS.has(format)) continue;
    seen.add(format);
    normalized.push(format);
  }

  return normalized.length ? normalized : [...DEEZER_LAVASRC_DEFAULT_FORMATS];
}

function normalizeYtDlpArgs(args) {
  const input = Array.isArray(args) ? args : [];
  if (!input.length) return [];

  const listValueFlags = new Set([
    '--js-runtimes',
    '--extractor-args',
    '--remote-components',
  ]);

  const normalized = [];
  for (let i = 0; i < input.length; i += 1) {
    const token = String(input[i] ?? '').trim();
    if (!token) continue;

    if (listValueFlags.has(token)) {
      const values = [];
      while (i + 1 < input.length) {
        const next = String(input[i + 1] ?? '').trim();
        if (!next || next.startsWith('--')) break;
        values.push(next);
        i += 1;
      }

      normalized.push(token);
      if (values.length) {
        normalized.push(values.join(','));
      }
      continue;
    }

    normalized.push(token);
  }

  return normalized;
}

function normalizeYouTubePlaylistResolver(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!normalized || normalized === 'auto') return 'ytdlp';
  if (YT_PLAYLIST_RESOLVERS.has(normalized)) return normalized;
  return 'ytdlp';
}


function sanitizeUrlToSearchQuery(url) {
  try {
    const parsed = new URL(url);
    const rawSegments = parsed.pathname
      .split('/')
      .map((segment) => decodeURIComponent(segment).trim())
      .filter(Boolean);

    const ignored = new Set([
      'track', 'tracks', 'album', 'playlist', 'artist', 'user',
      'sets', 'music', 'intl-en', 'intl-de', 'intl-fr',
    ]);

    const meaningful = rawSegments.filter((segment) => !ignored.has(segment.toLowerCase()));
    if (!meaningful.length) return null;

    const queryParts = [];
    const primary = meaningful[meaningful.length - 1];
    const secondary = meaningful.length > 1 ? meaningful[meaningful.length - 2] : null;

    if (secondary && !/^\d+$/.test(secondary)) {
      queryParts.push(secondary);
    }
    if (primary && !/^\d+$/.test(primary)) {
      queryParts.push(primary);
    }

    if (!queryParts.length) return null;

    const normalized = queryParts.join(' ')
      .replace(/[-_]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (!normalized || /^\d+$/.test(normalized)) return null;
    return normalized;
  } catch {
    return null;
  }
}

function normalizeThumbnailUrl(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  if (!isHttpUrl(raw)) return null;
  return raw.slice(0, 2048);
}

function pickThumbnailUrlFromItem(item) {
  if (!item || typeof item !== 'object') return null;

  const directCandidates = [
    item.thumbnail?.url,
    item.thumbnailURL,
    item.thumbnail_url,
    item.thumbnail,
    item.image?.url,
    item.image,
    item.artwork_url,
    item.artworkUrl,
    item.cover_url,
    item.coverUrl,
    item.cover_xl,
    item.cover_big,
    item.cover_medium,
    item.cover_small,
    item.artwork?.url,
    item.artwork?.['1000x1000'],
    item.artwork?.['480x480'],
    item.artwork?.['150x150'],
    item.picture_xl,
    item.picture_big,
    item.picture_medium,
    item.picture_small,
    item.album?.cover_xl,
    item.album?.cover_big,
    item.album?.cover_medium,
    item.album?.cover_small,
    item.album?.cover,
    item.artist?.picture_xl,
    item.artist?.picture_big,
    item.artist?.picture_medium,
    item.artist?.picture_small,
    item.artist?.picture,
    item.profile_picture?.['1000x1000'],
    item.profile_picture?.['480x480'],
    item.profile_picture?.['150x150'],
  ];

  for (const candidate of directCandidates) {
    const normalized = normalizeThumbnailUrl(candidate);
    if (normalized) return normalized;
  }

  const listCandidates = [
    item.thumbnails,
    item.images,
    item.video_details?.thumbnails,
    item.videoDetails?.thumbnails,
  ];

  for (const list of listCandidates) {
    if (!Array.isArray(list) || !list.length) continue;
    for (let i = list.length - 1; i >= 0; i -= 1) {
      const entry = list[i];
      const normalized = normalizeThumbnailUrl(entry?.url ?? entry);
      if (normalized) return normalized;
    }
  }

  return null;
}

export class MusicPlayer extends EventEmitter {
  constructor(voice, options = {}) {
    super();
    this.voice = voice;
    this.queue = new Queue();
    this.logger = options.logger;

    this.ffmpegBin = options.ffmpegBin || process.env.FFMPEG_BIN || ffmpegPath || 'ffmpeg';
    this.ytdlpBin = options.ytdlpBin || process.env.YTDLP_BIN || null;
    this.ytdlpCookiesFile = options.ytdlpCookiesFile || process.env.YTDLP_COOKIES_FILE || null;
    this.ytdlpCookiesFromBrowser = options.ytdlpCookiesFromBrowser || process.env.YTDLP_COOKIES_FROM_BROWSER || null;
    const configuredYtdlpClient = options.ytdlpYoutubeClient ?? process.env.YTDLP_YOUTUBE_CLIENT ?? null;
    this.ytdlpYoutubeClient = String(configuredYtdlpClient ?? '').trim() || null;
    const configuredYtDlpExtraArgs = options.ytdlpExtraArgs ?? process.env.YTDLP_EXTRA_ARGS ?? null;
    const rawYtDlpExtraArgs = Array.isArray(configuredYtDlpExtraArgs)
      ? configuredYtDlpExtraArgs
      : parseCsvArgs(configuredYtDlpExtraArgs);
    this.ytdlpExtraArgs = normalizeYtDlpArgs(rawYtDlpExtraArgs);
    this._useRuntimeYtDlpCookiesFile();

    this.maxQueueSize = options.maxQueueSize ?? 100;
    this.maxPlaylistTracks = options.maxPlaylistTracks ?? 25;
    this.minVolumePercent = options.minVolumePercent ?? 0;
    this.maxVolumePercent = options.maxVolumePercent ?? 200;
    this.enableYtSearch = options.enableYtSearch !== false;
    this.enableYtPlayback = options.enableYtPlayback !== false;
    this.enableSpotifyImport = options.enableSpotifyImport !== false;
    this.enableDeezerImport = options.enableDeezerImport !== false;
    this.deezerArl = String(options.deezerArl ?? process.env.DEEZER_ARL ?? '').trim() || null;
    this.deezerTrackFormats = normalizeDeezerTrackFormats(
      options.deezerTrackFormats ?? process.env.DEEZER_TRACK_FORMATS ?? null
    );
    this._deezerCookieHeader = this.deezerArl ? `arl=${this.deezerArl}` : null;
    this._deezerSessionTokens = null;
    this.soundcloudClientId = String(options.soundcloudClientId ?? process.env.SOUNDCLOUD_CLIENT_ID ?? '').trim() || null;
    this.soundcloudAutoClientId = options.soundcloudAutoClientId !== false;
    this.youtubePlaylistResolver = normalizeYouTubePlaylistResolver(
      options.youtubePlaylistResolver ?? process.env.YOUTUBE_PLAYLIST_RESOLVER
    );

    this.filterPreset = 'off';
    this.eqPreset = 'flat';
    this.tempoRatio = 1.0;
    this.pitchSemitones = 0;

    this.volumePercent = options.defaultVolumePercent ?? 100;
    this.loopMode = LOOP_OFF;

    this.ffmpeg = null;
    this.sourceProc = null;
    this.sourceStream = null;
    this.deezerDecryptStream = null;
    this._deezerStreamMetaByTrackId = new Map();
    this.pipelineErrorHandlers = [];

    this.playing = false;
    this.paused = false;
    this.skipRequested = false;

    this.pendingSeekTrack = null;
    this.trackHistory = [];
    this.maxHistorySize = options.maxHistorySize ?? 100;
    this.trackStartedAtMs = null;
    this.pauseStartedAtMs = null;
    this.totalPausedMs = 0;
    this.currentTrackOffsetSec = 0;
    this.lastKnownTrack = null;
    this.lastKnownTrackAtMs = 0;
    this.activePlaybackToken = 0;
    this.soundcloudClientIdResolvedAt = this.soundcloudClientId ? Date.now() : 0;

    this._lastYtDlpDiagnostics = null;
    this._lastFfmpegArgs = null;
  }

  _useRuntimeYtDlpCookiesFile() {
    if (!this.ytdlpCookiesFile || this.ytdlpCookiesFromBrowser) return;

    const sourcePath = String(this.ytdlpCookiesFile).trim();
    if (!sourcePath) return;

    if (!existsSync(sourcePath)) {
      this.logger?.warn?.('Configured yt-dlp cookies file not found', {
        path: sourcePath,
      });
      return;
    }

    const runtimePath = join(
      tmpdir(),
      `${basename(sourcePath)}.runtime-${process.pid}-${Math.random().toString(36).slice(2, 10)}`
    );
    try {
      copyFileSync(sourcePath, runtimePath);
      this.ytdlpCookiesFile = runtimePath;
      this.logger?.info?.('Using runtime copy of yt-dlp cookies file to avoid mutating source cookies', {
        sourcePath,
        runtimePath,
      });
    } catch (err) {
      this.logger?.warn?.('Failed to prepare runtime yt-dlp cookies file copy, using source file directly', {
        sourcePath,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  get currentTrack() {
    return this.queue.current;
  }

  get displayTrack() {
    if (this.currentTrack) return this.currentTrack;
    const recentEnough = this.lastKnownTrackAtMs > 0 && (Date.now() - this.lastKnownTrackAtMs) <= 30_000;
    if (this.voice?.isStreaming && this.lastKnownTrack && recentEnough) {
      return this.lastKnownTrack;
    }
    return null;
  }

  get pendingTracks() {
    return [...this.queue.tracks];
  }

  get historyTracks() {
    return [...this.trackHistory];
  }

  getState() {
    return {
      playing: this.playing,
      paused: this.paused,
      loopMode: this.loopMode,
      volumePercent: this.volumePercent,
      current: this.currentTrack,
      pendingCount: this.queue.pendingSize,
      progressSec: this.getProgressSeconds(),
      historyCount: this.trackHistory.length,
      filterPreset: this.filterPreset,
      eqPreset: this.eqPreset,
      tempoRatio: this.tempoRatio,
      pitchSemitones: this.pitchSemitones,
    };
  }

  getProgressSeconds() {
    if (!this.currentTrack) return 0;

    if (!this.playing || !this.trackStartedAtMs) {
      return Math.max(0, this.currentTrackOffsetSec);
    }

    const now = this.paused && this.pauseStartedAtMs ? this.pauseStartedAtMs : Date.now();
    const elapsedMs = Math.max(0, now - this.trackStartedAtMs - this.totalPausedMs);
    return Math.max(0, this.currentTrackOffsetSec + Math.floor(elapsedMs / 1000));
  }

  setLoopMode(mode) {
    const normalized = String(mode ?? '').toLowerCase();
    if (!LOOP_MODES.has(normalized)) {
      throw new ValidationError(`Invalid loop mode: ${mode}`);
    }

    this.loopMode = normalized;
    return this.loopMode;
  }

  setVolumePercent(value) {
    const next = Number.parseInt(value, 10);
    if (!Number.isFinite(next)) {
      throw new ValidationError('Volume must be a number.');
    }
    if (next < this.minVolumePercent || next > this.maxVolumePercent) {
      throw new ValidationError(`Volume must be between ${this.minVolumePercent} and ${this.maxVolumePercent}.`);
    }

    this.volumePercent = next;
    return this.volumePercent;
  }

  setFilterPreset(name) {
    const normalized = String(name ?? '').trim().toLowerCase() || 'off';
    if (!FILTER_PRESETS[normalized]) {
      throw new ValidationError(`Unknown filter preset: ${name}`);
    }

    this.filterPreset = normalized;
    return this.filterPreset;
  }

  setEqPreset(name) {
    const normalized = String(name ?? '').trim().toLowerCase();
    if (!EQ_PRESETS[normalized]) {
      throw new ValidationError(`Unknown EQ preset: ${name}`);
    }

    this.eqPreset = normalized;
    return this.eqPreset;
  }

  setTempoRatio(value) {
    const parsed = Number.parseFloat(String(value ?? ''));
    if (!Number.isFinite(parsed) || parsed < 0.5 || parsed > 2.0) {
      throw new ValidationError('Tempo must be between 0.5 and 2.0.');
    }

    this.tempoRatio = parsed;
    return this.tempoRatio;
  }

  setPitchSemitones(value) {
    const parsed = Number.parseFloat(String(value ?? ''));
    if (!Number.isFinite(parsed) || parsed < -12 || parsed > 12) {
      throw new ValidationError('Pitch must be between -12 and +12 semitones.');
    }

    this.pitchSemitones = parsed;
    return this.pitchSemitones;
  }

  getAudioEffectsState() {
    return {
      filterPreset: this.filterPreset,
      eqPreset: this.eqPreset,
      tempoRatio: this.tempoRatio,
      pitchSemitones: this.pitchSemitones,
    };
  }

  getAvailableFilterPresets() {
    return Object.keys(FILTER_PRESETS)
      .filter((name) => name !== 'karoake')
      .sort();
  }

  getAvailableEqPresets() {
    return Object.keys(EQ_PRESETS).sort();
  }

  clearQueue() {
    this.queue.tracks = [];
    return 0;
  }

  shuffleQueue() {
    this.queue.shuffle();
    return this.queue.pendingSize;
  }

  removeFromQueue(index) {
    return this.queue.remove(index);
  }

  getLastHistoryTrack() {
    if (!this.trackHistory.length) return null;
    return this.trackHistory[this.trackHistory.length - 1];
  }

  replayCurrentTrack() {
    if (!this.currentTrack || !this.playing) return false;
    this.pendingSeekTrack = this._cloneTrack(this.currentTrack, { seekStartSec: 0 });
    this.skipRequested = true;
    this._cleanupProcesses();
    return true;
  }

  refreshCurrentTrackProcessing() {
    if (!this.playing || !this.currentTrack) return false;

    // Mid-track seek restarts are significantly more likely to trigger YouTube challenge failures.
    // For effect reprocessing, prefer a clean restart from 0 for stability.
    this.pendingSeekTrack = this._cloneTrack(this.currentTrack, { seekStartSec: 0 });
    this.skipRequested = true;
    this._cleanupProcesses();
    return true;
  }

  getTotalPendingDurationSeconds() {
    let total = 0;
    for (const track of this.pendingTracks) {
      const parsed = this._parseDurationSeconds(track.duration);
      if (parsed == null) continue;
      total += parsed;
    }
    return total;
  }

  queuePreviousTrack() {
    const previous = this.getLastHistoryTrack();
    if (!previous) return null;

    const clone = this._cloneTrack(previous);
    this.queue.addFront(clone);
    this.emit('tracksAdded', [clone]);
    return clone;
  }

  canSeekCurrentTrack() {
    if (!this.currentTrack) return false;
    return isYouTubeUrl(this.currentTrack.url);
  }

  seekTo(seconds) {
    if (!this.playing || !this.currentTrack) {
      throw new ValidationError('Nothing is currently playing.');
    }

    if (!this.canSeekCurrentTrack()) {
      throw new ValidationError('Seek is currently supported for YouTube tracks only.');
    }

    const target = Number.parseInt(String(seconds), 10);
    if (!Number.isFinite(target) || target < 0) {
      throw new ValidationError('Seek target must be a non-negative number of seconds.');
    }

    this.pendingSeekTrack = {
      ...this.currentTrack,
      seekStartSec: target,
    };

    this.skipRequested = true;
    this._cleanupProcesses();
    return target;
  }

  async enqueue(query, options = {}) {
    const requestedBy = options.requestedBy ?? null;
    const playNext = Boolean(options.playNext);
    const dedupe = Boolean(options.dedupe);

    const tracks = await this._resolveTracks(query, requestedBy);
    if (!tracks.length) return [];

    return this.enqueueResolvedTracks(tracks, { dedupe, playNext });
  }

  enqueueResolvedTracks(tracks, options = {}) {
    const playNext = Boolean(options.playNext);
    const dedupe = Boolean(options.dedupe);
    const queueGuard = options.queueGuard && typeof options.queueGuard === 'object'
      ? options.queueGuard
      : null;
    const input = Array.isArray(tracks) ? tracks : [];
    if (!input.length) return [];

    const filteredTracks = dedupe
      ? input.filter((track) => !this._hasDuplicateTrack(track))
      : input;

    if (!filteredTracks.length) {
      return [];
    }

    if (queueGuard?.enabled) {
      this._enforceQueueGuard(filteredTracks, queueGuard);
    }

    if (this.queue.pendingSize + filteredTracks.length > this.maxQueueSize) {
      throw new ValidationError(`Queue limit exceeded (${this.maxQueueSize} pending tracks max).`);
    }

    if (playNext) {
      for (let i = filteredTracks.length - 1; i >= 0; i -= 1) {
        this.queue.addFront(filteredTracks[i]);
      }
    } else {
      for (const track of filteredTracks) {
        this.queue.add(track);
      }
    }

    this.emit('tracksAdded', filteredTracks);
    return filteredTracks;
  }

  _enforceQueueGuard(newTracks, guard) {
    const pending = this.pendingTracks;
    const windowSize = Math.max(1, Math.min(200, Number.parseInt(String(guard.windowSize ?? 25), 10) || 25));
    const maxPerRequesterWindow = Math.max(1, Math.min(50, Number.parseInt(String(guard.maxPerRequesterWindow ?? 5), 10) || 5));
    const maxArtistStreak = Math.max(1, Math.min(20, Number.parseInt(String(guard.maxArtistStreak ?? 3), 10) || 3));

    const queueWindow = pending.slice(-windowSize);
    const requesterCounts = new Map();
    for (const track of queueWindow) {
      const requester = String(track?.requestedBy ?? '').trim();
      if (!requester) continue;
      requesterCounts.set(requester, (requesterCounts.get(requester) ?? 0) + 1);
    }

    for (const track of newTracks) {
      const requester = String(track?.requestedBy ?? '').trim();
      if (!requester) continue;
      const nextCount = (requesterCounts.get(requester) ?? 0) + 1;
      if (nextCount > maxPerRequesterWindow) {
        throw new ValidationError(
          `Queue guard: requester limit reached (${maxPerRequesterWindow} tracks per ${windowSize} queue items).`
        );
      }
      requesterCounts.set(requester, nextCount);
    }

    const artistQueue = [...pending, ...newTracks].map((track) => this._trackArtistKey(track)).filter(Boolean);
    let streak = 1;
    for (let i = 1; i < artistQueue.length; i += 1) {
      if (artistQueue[i] === artistQueue[i - 1]) {
        streak += 1;
      } else {
        streak = 1;
      }
      if (streak > maxArtistStreak) {
        throw new ValidationError(
          `Queue guard: max artist streak exceeded (${maxArtistStreak}). Mix in a different artist.`
        );
      }
    }
  }

  _trackArtistKey(track) {
    const explicit = String(track?.artist ?? '').trim().toLowerCase();
    if (explicit) return explicit;

    const title = String(track?.title ?? '').trim().toLowerCase();
    if (!title) return null;
    if (title.includes(' - ')) {
      return title.split(' - ')[0].trim();
    }
    return title.split(' ').slice(0, 2).join(' ').trim();
  }

  async play() {
    if (this.playing) return;

    const track = this.queue.next();
    if (!track) {
      this._stopVoiceStream();
      this.emit('queueEmpty');
      return;
    }
    const playbackToken = ++this.activePlaybackToken;

    this.playing = true;
    this.paused = false;
    this.skipRequested = false;

    try {
      this._clearPipelineState();

      if (isYouTubeUrl(track.url)) {
        await this._startYouTubePipeline(track.url, track.seekStartSec ?? 0);
      } else if (String(track.source ?? '').startsWith('audius')) {
        await this._startAudiusPipeline(track, track.seekStartSec ?? 0);
      } else if (track?.deezerTrackId || String(track.source ?? '').startsWith('deezer-direct')) {
        await this._startDeezerPipeline(track, track.seekStartSec ?? 0);
      } else if (String(track.source ?? '').startsWith('soundcloud')) {
        await this._startSoundCloudPipeline(track, track.seekStartSec ?? 0);
      } else {
        await this._startPlayDlPipeline(track.url, 0);
      }

      await this.voice.sendAudio(this.ffmpeg.stdout);
      this._startPlaybackClock(track.seekStartSec ?? 0);
      this.lastKnownTrack = track;
      this.lastKnownTrackAtMs = Date.now();
      this.emit('trackStart', track);
      this.logger?.info?.('Playback started', { title: track.title, url: track.url, seek: track.seekStartSec ?? 0 });

      this.ffmpeg.once('close', async (code, signal) => {
        await this._handleTrackClose(track, code, signal, playbackToken);
      });
    } catch (err) {
      const normalized = this._normalizePlaybackError(err);
      this.emit('trackError', { track, error: normalized });
      this.logger?.error?.('Playback setup failed', { track: track.title, error: normalized.message });

      this._cleanupProcesses();
      this.playing = false;
      this.paused = false;
      this._resetPlaybackClock();
      this.queue.current = null;

      if (this.queue.pendingSize > 0) {
        await this.play();
        return;
      }

      this._stopVoiceStream();
      this.emit('queueEmpty');
    }
  }

  pause() {
    if (!this.playing || this.paused) return false;
    if (!this._setPipelinePaused(true)) return false;

    this.paused = true;
    this.pauseStartedAtMs = Date.now();
    return true;
  }

  resume() {
    if (!this.playing || !this.paused) return false;
    if (!this._setPipelinePaused(false)) return false;

    if (this.pauseStartedAtMs) {
      this.totalPausedMs += Date.now() - this.pauseStartedAtMs;
    }

    this.pauseStartedAtMs = null;
    this.paused = false;
    return true;
  }

  _setPipelinePaused(paused) {
    const shouldPause = Boolean(paused);
    const signal = shouldPause ? 'SIGSTOP' : 'SIGCONT';
    const streamMethod = shouldPause ? 'pause' : 'resume';
    const voiceMethod = shouldPause ? 'pauseAudio' : 'resumeAudio';
    let changed = false;

    const applyVoicePause = this.voice?.[voiceMethod];
    if (typeof applyVoicePause === 'function') {
      try {
        changed = Boolean(applyVoicePause.call(this.voice)) || changed;
      } catch {
        // ignore voice pause/resume errors
      }
    }

    if (process.platform !== 'win32') {
      for (const proc of [this.sourceProc, this.ffmpeg]) {
        if (!proc?.kill) continue;
        try {
          proc.kill(signal);
          changed = true;
        } catch (err) {
          this.logger?.debug?.('Process signal pause/resume failed; falling back to stream controls', {
            signal,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    for (const stream of [this.sourceStream, this.sourceProc?.stdout, this.ffmpeg?.stdout]) {
      const method = stream?.[streamMethod];
      if (typeof method !== 'function') continue;
      try {
        method.call(stream);
        changed = true;
      } catch {
        // ignore stream pause/resume errors
      }
    }

    return changed;
  }

  skip() {
    if (!this.playing) return false;
    this.skipRequested = true;
    this._cleanupProcesses();
    return true;
  }

  stop() {
    this.skipRequested = true;
    this.pendingSeekTrack = null;
    this.queue.clear();
    this._cleanupProcesses();
    this._stopVoiceStream();
    this.playing = false;
    this.paused = false;
    this._resetPlaybackClock();
  }

  async _handleTrackClose(track, code, signal, playbackToken = null) {
    if (playbackToken != null && playbackToken !== this.activePlaybackToken) {
      this.logger?.debug?.('Ignoring stale track close event', {
        title: track?.title ?? null,
        token: playbackToken,
        activeToken: this.activePlaybackToken,
      });
      return;
    }

    const wasSkip = this.skipRequested;
    const pendingSeekTrack = this.pendingSeekTrack;
    this.pendingSeekTrack = null;

    this._cleanupProcesses();
    this.playing = false;
    this.paused = false;
    this._resetPlaybackClock();

    this.queue.current = null;

    this.emit('trackEnd', {
      track,
      code,
      signal,
      skipped: wasSkip,
      seekRestart: Boolean(pendingSeekTrack),
    });

    if (!pendingSeekTrack) {
      this._rememberTrack(track);
    }

    if (pendingSeekTrack) {
      this.queue.addFront(pendingSeekTrack);
      await this.play();
      return;
    }

    if (!wasSkip) {
      if (this.loopMode === LOOP_TRACK) {
        this.queue.addFront(this._cloneTrack(track, { seekStartSec: 0 }));
      } else if (this.loopMode === LOOP_QUEUE) {
        this.queue.add(this._cloneTrack(track, { seekStartSec: 0 }));
      }
    }

    if (this.queue.pendingSize > 0) {
      await this.play();
      return;
    }

    this._stopVoiceStream();
    this.emit('queueEmpty');
  }

  async _resolveTracks(query, requestedBy) {
    const raw = String(query ?? '').trim();
    if (!raw) {
      throw new ValidationError('Missing query.');
    }

    if (!isHttpUrl(raw)) {
      return this._resolveSearchTrack(raw, requestedBy);
    }

    const url = await this._normalizeInputUrl(raw);
    const validation = await playdl.validate(url).catch(() => false);
    const playlistUrl = toCanonicalYouTubePlaylistUrl(url);
    const effectiveValidation = (
      playlistUrl
        ? 'yt_playlist'
        : validation
    );

    switch (effectiveValidation) {
      case 'yt_video':
        return this._resolveSingleYouTubeTrack(url, requestedBy);
      case 'yt_playlist':
        return this._resolveYouTubePlaylistTracks(playlistUrl ?? url, requestedBy, {
          fallbackWatchUrl: toCanonicalYouTubeWatchUrl(url) ?? inferYouTubeWatchUrlFromPlaylist(url),
        });
      case 'so_track':
        return this._resolveSoundCloudTrack(url, requestedBy);
      case 'so_playlist':
        return this._resolveSoundCloudPlaylist(url, requestedBy);
      case 'sp_track':
        return this._resolveSpotifyTrack(url, requestedBy);
      case 'sp_playlist':
      case 'sp_album':
        return this._resolveSpotifyCollection(url, requestedBy);
      case 'dz_track':
        return this._resolveDeezerTrack(url, requestedBy);
      case 'dz_playlist':
      case 'dz_album':
        return this._resolveDeezerCollection(url, requestedBy);
      default:
        if (isAudiusUrl(url)) {
          return this._resolveAudiusByUrl(url, requestedBy);
        }
        if (isSoundCloudUrl(url)) {
          return this._resolveSoundCloudByGuess(url, requestedBy);
        }
        if (isDeezerUrl(url)) {
          return this._resolveDeezerByGuess(url, requestedBy);
        }
        if (isSpotifyUrl(url)) {
          return this._resolveSpotifyByGuess(url, requestedBy);
        }

        return this._resolveSingleUrlTrack(url, requestedBy);
    }
  }

  async _resolveSearchTrack(query, requestedBy) {
    if (!this.enableYtSearch) {
      throw new ValidationError('YouTube search is currently disabled by bot configuration.');
    }
    if (!this.enableYtPlayback) {
      throw new ValidationError('YouTube playback is currently disabled by bot configuration.');
    }

    const youtube = await this._searchYouTubeTracks(query, 1, requestedBy).catch(() => []);
    if (youtube.length) return youtube;

    if (this.deezerArl && this.enableDeezerImport) {
      const deezer = await this._searchDeezerTracks(query, 1, requestedBy).catch(() => []);
      if (deezer.length) return deezer;
    }

    return [];
  }

  getDiagnostics() {
    return {
      playing: this.playing,
      paused: this.paused,
      skipRequested: this.skipRequested,
      loopMode: this.loopMode,
      progressSec: this.getProgressSeconds(),
      volumePercent: this.volumePercent,
      filterPreset: this.filterPreset,
      eqPreset: this.eqPreset,
      tempoRatio: this.tempoRatio,
      pitchSemitones: this.pitchSemitones,
      deezerTrackFormats: [...this.deezerTrackFormats],
      pendingCount: this.queue.pendingSize,
      hasCurrentTrack: Boolean(this.currentTrack),
      sourceProcPid: this.sourceProc?.pid ?? null,
      ffmpegPid: this.ffmpeg?.pid ?? null,
      ffmpegArgs: Array.isArray(this._lastFfmpegArgs) ? [...this._lastFfmpegArgs] : null,
      ytdlp: this._lastYtDlpDiagnostics ? { ...this._lastYtDlpDiagnostics } : null,
    };
  }

  async searchCandidates(query, limit = 5, options = {}) {
    const requestedBy = options.requestedBy ?? null;
    const safeLimit = Math.max(1, Math.min(10, Number.parseInt(String(limit), 10) || 5));

    if (!this.enableYtSearch) {
      throw new ValidationError('YouTube search is currently disabled by bot configuration.');
    }
    if (!this.enableYtPlayback) {
      throw new ValidationError('YouTube playback is currently disabled by bot configuration.');
    }

    const youtube = await this._searchYouTubeTracks(query, safeLimit, requestedBy).catch(() => []);
    if (youtube.length) return youtube;

    if (this.deezerArl && this.enableDeezerImport) {
      const deezer = await this._searchDeezerTracks(query, safeLimit, requestedBy).catch(() => []);
      if (deezer.length) return deezer;
    }

    return [];
  }

  async _searchYouTubeTracks(query, limit, requestedBy) {
    const results = await playdl.search(query, { source: { youtube: 'video' }, limit }).catch(async (err) => {
      if (!isPlayDlBrowseFailure(err)) throw err;
      this.logger?.warn?.('play-dl searchCandidates failed, trying yt-dlp search fallback', {
        query,
        limit,
        error: err instanceof Error ? err.message : String(err),
      });
      return this._searchWithYtDlp(query, limit);
    });

    return results.map((item) => this._buildTrack({
      title: item.title,
      url: item.url,
      duration: item.durationRaw ?? item.duration,
      thumbnailUrl: pickThumbnailUrlFromItem(item),
      requestedBy,
      source: 'youtube-search',
      artist: pickTrackArtistFromMetadata(item),
    }));
  }

  async _searchDeezerTracks(query, limit, requestedBy) {
    const safeQuery = String(query ?? '').trim();
    const safeLimit = Math.max(1, Math.min(10, Number.parseInt(String(limit), 10) || 5));
    if (!safeQuery || !this.deezerArl || !this.enableDeezerImport) return [];

    const payload = await this._deezerApiRequest(`/search/track?q=${encodeURIComponent(safeQuery)}`).catch(() => null);
    const items = Array.isArray(payload?.data) ? payload.data : [];
    const tracks = [];
    for (const item of items) {
      if (tracks.length >= safeLimit) break;
      const track = this._buildDeezerTrackFromMetadata(item, requestedBy, 'deezer-search-direct');
      if (track?.deezerTrackId) {
        tracks.push(track);
      }
    }

    return tracks;
  }

  async previewTracks(query, options = {}) {
    const requestedBy = options.requestedBy ?? null;
    const tracks = await this._resolveTracks(query, requestedBy);
    const limit = Number.parseInt(String(options.limit ?? 0), 10);
    if (Number.isFinite(limit) && limit > 0) {
      return tracks.slice(0, limit);
    }
    return tracks;
  }

  createTrackFromData(data, requestedBy = null) {
    const normalizedThumbnailUrl = (
      data?.thumbnailUrl
      ?? data?.thumbnail_url
      ?? data?.thumbnail
      ?? pickThumbnailUrlFromItem(data)
    );

    return this._buildTrack({
      title: data?.title,
      url: data?.url,
      duration: data?.duration,
      thumbnailUrl: normalizedThumbnailUrl,
      requestedBy,
      source: data?.source ?? 'stored',
      artist: data?.artist ?? data?.artist_name ?? pickTrackArtistFromMetadata(data),
      soundcloudTrackId: data?.soundcloudTrackId ?? data?.soundcloud_track_id ?? null,
      audiusTrackId: data?.audiusTrackId ?? data?.audius_track_id ?? null,
      deezerTrackId: data?.deezerTrackId ?? data?.deezer_track_id ?? null,
      deezerPreviewUrl: data?.deezerPreviewUrl ?? data?.deezer_preview_url ?? null,
      deezerFullStreamUrl: data?.deezerFullStreamUrl ?? data?.deezer_full_stream_url ?? null,
    });
  }

  async _resolveSingleYouTubeTrack(url, requestedBy) {
    if (!this.enableYtPlayback) {
      throw new ValidationError('YouTube playback is currently disabled by bot configuration.');
    }

    try {
      const info = await playdl.video_info(url);
      return [this._buildTrack({
        title: info.video_details.title,
        url,
        duration: info.video_details.durationRaw,
        thumbnailUrl: pickThumbnailUrlFromItem(info.video_details),
        requestedBy,
        source: 'youtube',
        artist: pickTrackArtistFromMetadata(info.video_details),
      })];
    } catch {
      return [this._buildTrack({
        title: url,
        url,
        duration: 'Unknown',
        requestedBy,
        source: 'youtube',
      })];
    }
  }

  async _resolveYouTubePlaylistTracks(url, requestedBy, options = {}) {
    if (!this.enableYtPlayback) {
      throw new ValidationError('YouTube playback is currently disabled by bot configuration.');
    }

    const order = this.youtubePlaylistResolver === 'playdl'
      ? ['playdl', 'ytdlp']
      : ['ytdlp', 'playdl'];

    const resolverErrors = [];
    for (const resolver of order) {
      if (resolver === 'ytdlp') {
        try {
          const tracks = await this._resolveYouTubePlaylistTracksViaYtDlp(url, requestedBy);
          if (tracks.length) {
            this.logger?.info?.('Resolved YouTube playlist via yt-dlp', {
              url,
              count: tracks.length,
              mode: this.youtubePlaylistResolver,
            });
            return tracks;
          }
          throw new Error('yt-dlp returned no playlist entries');
        } catch (err) {
          resolverErrors.push({ resolver, error: err });
          this.logger?.warn?.('yt-dlp playlist lookup failed', {
            url,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        continue;
      }

      try {
        const tracks = await this._resolveYouTubePlaylistTracksViaPlayDl(url, requestedBy);
        if (tracks.length) {
          if (this.youtubePlaylistResolver !== 'playdl') {
            this.logger?.info?.('Resolved YouTube playlist via play-dl fallback', {
              url,
              count: tracks.length,
            });
          }
          return tracks;
        }
        throw new Error('play-dl returned no playlist entries');
      } catch (err) {
        resolverErrors.push({ resolver, error: err });
        this.logger?.warn?.('play-dl playlist lookup failed', {
          url,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const watchUrl = options.fallbackWatchUrl ?? inferYouTubeWatchUrlFromPlaylist(url) ?? toCanonicalYouTubeWatchUrl(url);
    if (watchUrl) {
      return this._resolveSingleYouTubeTrack(watchUrl, requestedBy);
    }

    if (resolverErrors.length > 0) {
      const summary = resolverErrors
        .map(({ resolver, error }) => `${resolver}:${error instanceof Error ? error.message : String(error)}`)
        .join(' | ')
        .slice(0, 900);
      this.logger?.warn?.('All YouTube playlist resolvers failed, using search fallback', {
        url,
        errors: summary,
      });
    }

    return this._resolveFromUrlFallbackSearch(url, requestedBy, 'youtube-playlist-fallback');
  }

  async _fetchYouTubePlaylistInfo(url) {
    return playdl.playlist_info(url, { incomplete: true });
  }

  async _resolveYouTubePlaylistTracksViaPlayDl(url, requestedBy) {
    const playlist = await this._fetchYouTubePlaylistInfo(url);
    await playlist.fetch(this.maxPlaylistTracks);

    const videos = [];
    for (let page = 1; page <= playlist.total_pages && videos.length < this.maxPlaylistTracks; page += 1) {
      const items = playlist.page(page) ?? [];
      for (const item of items) {
        videos.push(item);
        if (videos.length >= this.maxPlaylistTracks) break;
      }
    }

    if (!videos.length && Array.isArray(playlist.videos)) {
      videos.push(...playlist.videos.slice(0, this.maxPlaylistTracks));
    }

    return videos.map((video) => this._buildTrack({
      title: video.title,
      url: video.url,
      duration: video.durationRaw,
      thumbnailUrl: pickThumbnailUrlFromItem(video),
      requestedBy,
      source: 'youtube-playlist',
      artist: pickTrackArtistFromMetadata(video),
    }));
  }

  async _resolveYouTubePlaylistTracksViaYtDlp(url, requestedBy) {
    const safeLimit = Math.max(1, Number.parseInt(String(this.maxPlaylistTracks ?? 25), 10) || 25);
    const args = [
      '--ignore-config',
      '--quiet',
      '--no-warnings',
      '--skip-download',
      '--flat-playlist',
      '--dump-single-json',
      '--playlist-end', String(safeLimit),
    ];

    if (this.ytdlpYoutubeClient) {
      args.push('--extractor-args', `youtube:player_client=${this.ytdlpYoutubeClient}`);
    }
    if (this.ytdlpCookiesFile) {
      args.push('--cookies', this.ytdlpCookiesFile);
    }
    if (this.ytdlpCookiesFromBrowser) {
      args.push('--cookies-from-browser', this.ytdlpCookiesFromBrowser);
    }

    args.push(url);
    const { stdout } = await this._runYtDlpCommand(args, 25_000);
    if (!stdout?.trim()) return [];

    let payload;
    try {
      payload = JSON.parse(stdout);
    } catch {
      return [];
    }

    const entries = Array.isArray(payload?.entries)
      ? payload.entries
      : [];

    const tracks = [];
    for (const entry of entries) {
      if (tracks.length >= safeLimit) break;
      const videoUrl = normalizeYouTubeVideoUrlFromEntry(entry);
      if (!videoUrl) continue;

      const title = String(entry?.title ?? '').trim() || videoUrl;
      const duration = Number.isFinite(entry?.duration) ? entry.duration : 'Unknown';
      tracks.push(this._buildTrack({
        title,
        url: videoUrl,
        duration,
        thumbnailUrl: pickThumbnailUrlFromItem(entry),
        requestedBy,
        source: 'youtube-playlist-ytdlp',
        artist: pickTrackArtistFromMetadata(entry),
      }));
    }

    return tracks;
  }

  async _audiusApiRequest(pathname, query = {}, timeoutMs = 10_000) {
    const endpoint = new URL(pathname, 'https://api.audius.co/v1');
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value == null) continue;
      endpoint.searchParams.set(key, String(value));
    }

    const response = await fetch(endpoint, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    }).catch(() => null);

    if (!response?.ok) {
      throw new Error(`Audius API request failed (${response?.status ?? 'network'}): ${endpoint.pathname}`);
    }

    return response.json();
  }

  _pickAudiusEntity(payload) {
    if (!payload || typeof payload !== 'object') return null;
    const data = payload?.data;
    if (Array.isArray(data)) return data[0] ?? null;
    if (data && typeof data === 'object') return data;
    if (Array.isArray(payload)) return payload[0] ?? null;
    if (payload?.id != null) return payload;
    return null;
  }

  _pickAudiusTrackIdFromTrack(track) {
    const explicit = String(track?.audiusTrackId ?? '').trim();
    if (explicit) return explicit;
    return null;
  }

  _buildAudiusPermalink(meta) {
    const direct = String(meta?.permalink ?? meta?.permalink_url ?? meta?.url ?? '').trim();
    if (direct && isHttpUrl(direct)) return direct;

    const handle = String(meta?.user?.handle ?? '').trim();
    const slug = String(meta?.permalink ?? '').trim();
    if (handle && slug) {
      return `https://audius.co/${encodeURIComponent(handle)}/${encodeURIComponent(slug)}`;
    }

    return null;
  }

  _buildAudiusTrackFromMetadata(meta, requestedBy, source = 'audius-direct') {
    const permalink = this._buildAudiusPermalink(meta);
    if (!permalink) return null;

    const title = String(meta?.title ?? 'Audius track').trim() || 'Audius track';
    const duration = toAudiusDurationLabel(meta?.duration ?? null);
    const artist = String(meta?.user?.name ?? meta?.user?.handle ?? '').trim() || null;
    const thumbnailUrl = pickThumbnailUrlFromItem(meta);
    const trackId = meta?.id != null ? String(meta.id) : null;

    return this._buildTrack({
      title,
      url: permalink,
      duration,
      thumbnailUrl,
      requestedBy,
      source,
      artist,
      audiusTrackId: trackId,
    });
  }

  async _resolveAudiusByUrl(url, requestedBy) {
    const payload = await this._audiusApiRequest('/resolve', { url }).catch(() => null);
    const entity = this._pickAudiusEntity(payload);
    if (!entity) {
      return this._resolveFromUrlFallbackSearch(url, requestedBy, 'audius-fallback');
    }

    const kind = String(entity?.kind ?? '').toLowerCase();
    if (kind === 'playlist' || kind === 'album' || kind === 'system_playlist' || entity?.playlist_name || Array.isArray(entity?.tracks)) {
      return this._resolveAudiusPlaylist(entity, requestedBy, url);
    }

    const track = this._buildAudiusTrackFromMetadata(entity, requestedBy, 'audius-direct');
    if (track) return [track];

    return this._resolveFromUrlFallbackSearch(url, requestedBy, 'audius-fallback');
  }

  async _resolveAudiusPlaylist(entity, requestedBy, fallbackUrl = null) {
    const playlistId = String(entity?.id ?? '').trim();
    let tracksRaw = Array.isArray(entity?.tracks) ? entity.tracks : [];

    if ((!tracksRaw || tracksRaw.length === 0) && playlistId) {
      const trackListPayload = await this._audiusApiRequest(`/playlists/${encodeURIComponent(playlistId)}/tracks`, {
        limit: this.maxPlaylistTracks,
        offset: 0,
      }).catch(() => null);
      tracksRaw = Array.isArray(trackListPayload?.data) ? trackListPayload.data : [];
    }

    const tracks = [];
    for (const entry of tracksRaw) {
      if (tracks.length >= this.maxPlaylistTracks) break;
      const track = this._buildAudiusTrackFromMetadata(entry, requestedBy, 'audius-playlist-direct');
      if (track) tracks.push(track);
    }

    if (tracks.length) return tracks;
    if (fallbackUrl) {
      return this._resolveFromUrlFallbackSearch(fallbackUrl, requestedBy, 'audius-playlist-fallback');
    }
    throw new ValidationError('Could not resolve Audius playlist tracks.');
  }

  async _resolveAudiusStreamUrl(track) {
    const trackId = this._pickAudiusTrackIdFromTrack(track);
    if (!trackId) {
      throw new Error('Missing Audius track id.');
    }

    const payload = await this._audiusApiRequest(`/tracks/${encodeURIComponent(trackId)}/stream`, {
      no_redirect: true,
    }).catch(() => null);

    const directUrl = String(payload?.data?.url ?? payload?.data ?? '').trim();
    if (directUrl && isHttpUrl(directUrl)) return directUrl;

    return `https://api.audius.co/v1/tracks/${encodeURIComponent(trackId)}/stream`;
  }

  async _startAudiusPipeline(track, seekSec = 0) {
    const streamUrl = await this._resolveAudiusStreamUrl(track);
    this.ffmpeg = await this._spawnProcess(this.ffmpegBin, this._ffmpegHttpArgs(streamUrl, seekSec), {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    this._bindPipelineErrorHandler(this.ffmpeg.stdout, 'ffmpeg.stdout');
  }

  async _resolveSoundCloudTrack(url, requestedBy) {
    try {
      const direct = await this._resolveSoundCloudTrackDirect(url, requestedBy);
      if (direct.length) return direct;
    } catch (err) {
      this.logger?.warn?.('Direct SoundCloud track resolve failed, falling back to play-dl resolver', {
        url,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    let data;
    try {
      data = await playdl.soundcloud(url);
    } catch (err) {
      if (isSoundCloudAuthorizationError(err)) {
        this.logger?.warn?.(soundCloudAuthorizationHelp(), { url });
        return this._resolveFromUrlFallbackSearch(url, requestedBy, 'soundcloud-fallback');
      }
      throw err;
    }

    if (!data || data.type !== 'track') {
      return this._resolveFromUrlFallbackSearch(url, requestedBy, 'soundcloud-fallback');
    }

    return [this._buildSoundCloudTrackFromMetadata(data, requestedBy, 'soundcloud-direct')];
  }

  async _resolveSoundCloudPlaylist(url, requestedBy) {
    try {
      const direct = await this._resolveSoundCloudPlaylistDirect(url, requestedBy);
      if (direct.length) return direct;
    } catch (err) {
      this.logger?.warn?.('Direct SoundCloud playlist resolve failed, falling back to play-dl resolver', {
        url,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    let data;
    try {
      data = await playdl.soundcloud(url);
    } catch (err) {
      if (isSoundCloudAuthorizationError(err)) {
        this.logger?.warn?.(soundCloudAuthorizationHelp(), { url });
        return this._resolveFromUrlFallbackSearch(url, requestedBy, 'soundcloud-fallback');
      }
      throw err;
    }

    if (!data || data.type !== 'playlist') {
      return this._resolveFromUrlFallbackSearch(url, requestedBy, 'soundcloud-fallback');
    }

    const tracks = await data.all_tracks();
    return tracks
      .slice(0, this.maxPlaylistTracks)
      .map((track) => this._buildSoundCloudTrackFromMetadata(track, requestedBy, 'soundcloud-playlist-direct'))
      .filter(Boolean);
  }

  async _resolveSpotifyTrack(url, requestedBy) {
    if (!this.enableSpotifyImport) {
      throw new ValidationError('Spotify import is currently disabled by bot configuration.');
    }
    throw new ValidationError('Spotify support is coming soon.');
  }

  async _resolveSpotifyCollection(url, requestedBy) {
    if (!this.enableSpotifyImport) {
      throw new ValidationError('Spotify import is currently disabled by bot configuration.');
    }
    throw new ValidationError('Spotify support is coming soon.');
  }

  async _resolveDeezerTrack(url, requestedBy) {
    if (!this.enableDeezerImport) {
      throw new ValidationError('Deezer import is currently disabled by bot configuration.');
    }

    if (this.deezerArl) {
      try {
        const direct = await this._resolveDeezerTrackDirect(url, requestedBy);
        if (direct.length) return direct;
      } catch (err) {
        this.logger?.warn?.('Direct Deezer track resolve failed, falling back to mapped source', {
          url,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const data = await playdl.deezer(url);
    if (!data || data.type !== 'track') return [];

    return this._resolveCrossSourceToYouTube([data], requestedBy, 'deezer');
  }

  async _resolveDeezerCollection(url, requestedBy) {
    if (!this.enableDeezerImport) {
      throw new ValidationError('Deezer import is currently disabled by bot configuration.');
    }

    if (this.deezerArl) {
      try {
        const direct = await this._resolveDeezerCollectionDirect(url, requestedBy);
        if (direct.length) return direct;
      } catch (err) {
        this.logger?.warn?.('Direct Deezer collection resolve failed, falling back to mapped source', {
          url,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const data = await playdl.deezer(url);
    if (!data || (data.type !== 'playlist' && data.type !== 'album')) return [];

    const tracks = await data.all_tracks();
    return this._resolveCrossSourceToYouTube(tracks.slice(0, this.maxPlaylistTracks), requestedBy, `deezer-${data.type}`);
  }

  async _deezerApiRequest(pathname, timeoutMs = 10_000) {
    const endpoint = new URL(pathname, 'https://api.deezer.com');
    const response = await fetch(endpoint, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    }).catch(() => null);

    if (!response?.ok) {
      throw new Error(`Deezer API request failed (${response?.status ?? 'network'}): ${endpoint.pathname}`);
    }

    return response.json();
  }

  _buildDeezerTrackFromMetadata(meta, requestedBy, source = 'deezer-direct') {
    const trackId = String(meta?.id ?? '').trim();
    if (!trackId) return null;

    const title = String(meta?.title ?? 'Deezer track').trim() || 'Deezer track';
    const artist = String(meta?.artist?.name ?? '').trim() || null;
    const duration = toDeezerDurationLabel(meta?.duration ?? null);
    const deezerUrl = String(meta?.link ?? '').trim() || `https://www.deezer.com/track/${encodeURIComponent(trackId)}`;
    const previewUrl = String(meta?.preview ?? '').trim() || null;
    const thumbnailUrl = pickThumbnailUrlFromItem(meta);

    return this._buildTrack({
      title,
      url: deezerUrl,
      duration,
      thumbnailUrl,
      requestedBy,
      source,
      artist,
      deezerTrackId: trackId,
      deezerPreviewUrl: previewUrl,
    });
  }

  async _resolveDeezerTrackDirect(url, requestedBy) {
    const trackId = extractDeezerTrackId(url);
    if (!trackId) {
      throw new Error('Could not extract Deezer track id from URL.');
    }

    const payload = await this._deezerApiRequest(`/track/${encodeURIComponent(trackId)}`);
    const track = this._buildDeezerTrackFromMetadata(payload, requestedBy, 'deezer-direct');
    if (track?.deezerTrackId) {
      const fullUrl = await this._resolveDeezerFullStreamUrlWithArl(track.deezerTrackId);
      track.deezerFullStreamUrl = fullUrl;
      track.deezerPreviewUrl = null;
    }
    return track ? [track] : [];
  }

  async _resolveDeezerCollectionDirect(url, requestedBy) {
    let payload = null;
    let isPlaylist = false;

    const parsed = new URL(url);
    const parts = String(parsed.pathname ?? '').split('/').map((segment) => segment.trim()).filter(Boolean);
    const playlistIdx = parts.findIndex((segment) => segment.toLowerCase() === 'playlist');
    const albumIdx = parts.findIndex((segment) => segment.toLowerCase() === 'album');

    if (playlistIdx >= 0 && /^\d+$/.test(parts[playlistIdx + 1] ?? '')) {
      isPlaylist = true;
      payload = await this._deezerApiRequest(`/playlist/${encodeURIComponent(parts[playlistIdx + 1])}`);
    } else if (albumIdx >= 0 && /^\d+$/.test(parts[albumIdx + 1] ?? '')) {
      payload = await this._deezerApiRequest(`/album/${encodeURIComponent(parts[albumIdx + 1])}`);
    } else {
      throw new Error('Could not extract Deezer playlist/album id from URL.');
    }

    const rawTracks = Array.isArray(payload?.tracks?.data) ? payload.tracks.data : [];
    const tracks = [];
    for (const entry of rawTracks) {
      if (tracks.length >= this.maxPlaylistTracks) break;
      const track = this._buildDeezerTrackFromMetadata(
        entry,
        requestedBy,
        isPlaylist ? 'deezer-direct-playlist' : 'deezer-direct-album'
      );
      if (!track) continue;

      try {
        const fullUrl = await this._resolveDeezerFullStreamUrlWithArl(track.deezerTrackId);
        track.deezerFullStreamUrl = fullUrl;
        track.deezerPreviewUrl = null;
        tracks.push(track);
      } catch (err) {
        this.logger?.warn?.('Skipping Deezer direct track without full stream token', {
          trackId: track.deezerTrackId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return tracks;
  }

  async _deezerGatewayCall(method, apiToken = 'null', args = {}, timeoutMs = 10_000) {
    if (!this.deezerArl) {
      throw new Error('DEEZER_ARL is not configured.');
    }

    const endpoint = new URL('https://www.deezer.com/ajax/gw-light.php');
    endpoint.searchParams.set('method', method);
    endpoint.searchParams.set('input', '3');
    endpoint.searchParams.set('api_version', '1.0');
    endpoint.searchParams.set('api_token', apiToken);

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        cookie: this._getDeezerCookieHeader(),
        referer: 'https://www.deezer.com/',
        origin: 'https://www.deezer.com',
        'user-agent': 'Mozilla/5.0',
      },
      body: JSON.stringify(args ?? {}),
      signal: AbortSignal.timeout(timeoutMs),
    }).catch(() => null);

    if (!response?.ok) {
      throw new Error(`Deezer gateway call failed (${response?.status ?? 'network'}): ${method}`);
    }
    this._updateDeezerCookieHeader(response);

    const body = await response.json();
    const deezerError = this._extractDeezerError(body?.error);
    if (deezerError) {
      throw new Error(`Deezer gateway ${method} returned error: ${deezerError}`);
    }
    return body;
  }

  _getDeezerCookieHeader() {
    return this._deezerCookieHeader || `arl=${this.deezerArl}`;
  }

  _updateDeezerCookieHeader(response) {
    if (!response?.headers || !this.deezerArl) return;

    const setCookies = typeof response.headers.getSetCookie === 'function'
      ? response.headers.getSetCookie()
      : (() => {
          const single = response.headers.get('set-cookie');
          return single ? [single] : [];
        })();

    const cookieMap = new Map();
    for (const pair of String(this._deezerCookieHeader || `arl=${this.deezerArl}`).split(';')) {
      const segment = pair.trim();
      if (!segment) continue;
      const eq = segment.indexOf('=');
      if (eq <= 0) continue;
      const key = segment.slice(0, eq).trim();
      const value = segment.slice(eq + 1).trim();
      if (key && value) cookieMap.set(key, value);
    }
    if (!cookieMap.has('arl')) {
      cookieMap.set('arl', this.deezerArl);
    }

    for (const raw of setCookies) {
      const first = String(raw ?? '').split(';')[0]?.trim() || '';
      if (!first) continue;
      const eq = first.indexOf('=');
      if (eq <= 0) continue;
      const key = first.slice(0, eq).trim();
      const value = first.slice(eq + 1).trim();
      if (key && value) cookieMap.set(key, value);
    }

    this._deezerCookieHeader = Array.from(cookieMap.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
  }

  _readDeezerCookieValue(name) {
    const target = String(name ?? '').trim();
    if (!target) return null;

    const header = String(this._deezerCookieHeader || `arl=${this.deezerArl ?? ''}`);
    for (const pair of header.split(';')) {
      const segment = pair.trim();
      if (!segment) continue;
      const eq = segment.indexOf('=');
      if (eq <= 0) continue;
      const key = segment.slice(0, eq).trim();
      if (key !== target) continue;
      const value = segment.slice(eq + 1).trim();
      if (value) return value;
    }
    return null;
  }

  async _getDeezerSessionTokens(forceRefresh = false) {
    if (!this.deezerArl) {
      throw new Error('DEEZER_ARL is not configured.');
    }

    const now = Date.now();
    if (!forceRefresh && this._deezerSessionTokens && this._deezerSessionTokens.expiresAtMs > now) {
      return this._deezerSessionTokens;
    }

    const userData = await this._deezerGatewayCall('deezer.getUserData', 'null', {});
    const results = userData?.results ?? {};
    const apiToken = String(results?.checkForm ?? '').trim();
    const licenseToken = String(results?.USER?.OPTIONS?.license_token ?? results?.OPTIONS?.license_token ?? '').trim();
    if (!apiToken || !licenseToken) {
      throw new Error('Deezer ARL session did not provide API/license tokens.');
    }

    this._deezerSessionTokens = {
      apiToken,
      licenseToken,
      sessionId: this._readDeezerCookieValue('sid'),
      dzrUniqId: this._readDeezerCookieValue('dzr_uniq_id'),
      expiresAtMs: now + DEEZER_SESSION_TOKEN_TTL_MS,
    };
    return this._deezerSessionTokens;
  }

  _extractDeezerError(errorValue) {
    if (!errorValue) return null;
    if (Array.isArray(errorValue)) {
      if (!errorValue.length) return null;
      const first = errorValue[0];
      return typeof first === 'string' ? first : JSON.stringify(first);
    }
    if (typeof errorValue === 'string') {
      return errorValue.trim() || null;
    }
    if (typeof errorValue === 'object') {
      const entries = Object.entries(errorValue);
      if (!entries.length) return null;
      const [key, val] = entries[0];
      if (typeof val === 'string' && val.trim()) {
        return `${key}: ${val.trim()}`;
      }
      return key;
    }
    return String(errorValue);
  }

  _extractFirstHttpUrl(value) {
    if (!value) return null;
    if (typeof value === 'string') {
      return isHttpUrl(value) ? value : null;
    }
    if (Array.isArray(value)) {
      for (const entry of value) {
        const candidate = this._extractFirstHttpUrl(entry);
        if (candidate) return candidate;
      }
      return null;
    }
    if (typeof value === 'object') {
      for (const entry of Object.values(value)) {
        const candidate = this._extractFirstHttpUrl(entry);
        if (candidate) return candidate;
      }
    }
    return null;
  }

  _pickDeezerPreferredFormat(candidate) {
    const upper = String(candidate ?? '').trim().toUpperCase();
    if (DEEZER_MEDIA_QUALITY_MAP.has(upper)) return upper;
    return 'MP3_128';
  }

  _resolveDeezerMediaVariantFromResponse(body) {
    const firstItem = Array.isArray(body?.data) ? body.data[0] : null;
    const firstMedia = Array.isArray(firstItem?.media) ? firstItem.media[0] : null;
    if (!firstMedia || typeof firstMedia !== 'object') return null;

    const firstSource = Array.isArray(firstMedia.sources) ? firstMedia.sources[0] : null;
    let selectedSource = firstSource ?? null;
    let url = String(selectedSource?.url ?? '').trim();
    if (!isHttpUrl(url) && Array.isArray(firstMedia.sources)) {
      selectedSource = firstMedia.sources.find((entry) => isHttpUrl(String(entry?.url ?? '').trim())) ?? null;
      url = String(selectedSource?.url ?? '').trim();
    }
    if (!isHttpUrl(url)) return null;

    return {
      url,
      cipherType: String(firstMedia?.cipher?.type ?? firstMedia?.cipher ?? 'BF_CBC_STRIPE').trim().toUpperCase() || 'BF_CBC_STRIPE',
      format: String(firstMedia?.format ?? selectedSource?.format ?? '').trim().toUpperCase() || null,
    };
  }

  _extractFirstStringByKey(value, targetKey) {
    if (!value || !targetKey) return null;
    if (Array.isArray(value)) {
      for (const entry of value) {
        const found = this._extractFirstStringByKey(entry, targetKey);
        if (found) return found;
      }
      return null;
    }
    if (typeof value !== 'object') return null;

    for (const [key, entry] of Object.entries(value)) {
      if (key === targetKey && typeof entry === 'string') {
        const trimmed = entry.trim();
        if (trimmed) return trimmed;
      }
    }
    for (const entry of Object.values(value)) {
      const found = this._extractFirstStringByKey(entry, targetKey);
      if (found) return found;
    }
    return null;
  }

  async _resolveDeezerSongData(apiToken, trackId) {
    const safeTrackId = String(trackId ?? '').trim();
    if (!safeTrackId) return null;

    const requests = [
      this._deezerGatewayCall('song.getData', apiToken, { sng_id: safeTrackId }).catch(() => null),
      this._deezerGatewayCall('deezer.pageTrack', apiToken, { sng_id: safeTrackId }).catch(() => null),
      this._deezerGatewayCall('song.getListData', apiToken, { sng_ids: [safeTrackId] }).catch(() => null),
    ];

    for (const request of requests) {
      const payload = await request;
      if (!payload) continue;
      const results = payload?.results ?? {};
      const dataCandidate = results?.DATA ?? results?.data?.[0] ?? results ?? null;
      const md5Origin = String(dataCandidate?.MD5_ORIGIN ?? '').trim();
      const songId = String(dataCandidate?.SNG_ID ?? safeTrackId).trim();
      const mediaVersion = String(dataCandidate?.MEDIA_VERSION ?? '').trim();

      if (md5Origin && songId && mediaVersion) {
        return {
          MD5_ORIGIN: md5Origin,
          SNG_ID: songId,
          MEDIA_VERSION: mediaVersion,
        };
      }
    }

    return null;
  }

  async _resolveDeezerLegacyEncryptedStreamUrl(apiToken, trackId, preferredFormat = null) {
    const track = await this._resolveDeezerSongData(apiToken, trackId);
    if (!track) return null;

    const preferred = this._pickDeezerPreferredFormat(preferredFormat);
    const qualityOrder = [preferred, 'MP3_320', 'MP3_128', 'FLAC'];
    const seen = new Set();

    for (const format of qualityOrder) {
      if (seen.has(format)) continue;
      seen.add(format);
      const quality = DEEZER_MEDIA_QUALITY_MAP.get(format);
      if (!quality) continue;
      const url = buildDeezerLegacyDownloadUrl(track, quality);
      if (isHttpUrl(url)) {
        return { url, cipherType: 'BF_CBC_STRIPE', format };
      }
    }

    return null;
  }

  async _resolveDeezerFullStreamUrlWithArl(trackId) {
    const safeTrackId = String(trackId ?? '').trim();
    if (!safeTrackId) {
      throw new Error('Missing Deezer track id.');
    }

    const formats = this.deezerTrackFormats.map((format) => ({ cipher: 'BF_CBC_STRIPE', format }));
    let lastMediaError = null;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const tokens = await this._getDeezerSessionTokens(attempt > 0);
      const trackToken = await this._resolveDeezerTrackToken(tokens.apiToken, safeTrackId);
      if (!trackToken) {
        if (attempt === 0) {
          this._deezerSessionTokens = null;
          continue;
        }
        throw new Error('Missing Deezer track token (likely unavailable for this account/region).');
      }

      const payload = {
        license_token: tokens.licenseToken,
        media: [{ type: 'FULL', formats }],
        track_tokens: [trackToken],
      };

      const response = await fetch('https://media.deezer.com/v1/get_url', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          cookie: this._getDeezerCookieHeader(),
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10_000),
      }).catch(() => null);

      if (!response?.ok) {
        lastMediaError = new Error(`Deezer media URL call failed (${response?.status ?? 'network'})`);
        if (attempt === 0) {
          this._deezerSessionTokens = null;
          continue;
        }
        break;
      }
      this._updateDeezerCookieHeader(response);

      const body = await response.json().catch(() => null);
      const variant = this._resolveDeezerMediaVariantFromResponse(body);
      if (variant?.url) {
        this._deezerStreamMetaByTrackId.set(safeTrackId, {
          url: variant.url,
          cipherType: variant.cipherType || 'BF_CBC_STRIPE',
          format: variant.format || null,
        });
        return variant.url;
      }

      lastMediaError = new Error('Deezer media URL response did not contain a playable source.');
      if (attempt === 0) {
        this._deezerSessionTokens = null;
        continue;
      }
      break;
    }

    const apiToken = this._deezerSessionTokens?.apiToken ?? null;
    const legacy = apiToken
      ? await this._resolveDeezerLegacyEncryptedStreamUrl(apiToken, safeTrackId, this.deezerTrackFormats[0]).catch(() => null)
      : null;
    if (legacy?.url) {
      this._deezerStreamMetaByTrackId.set(safeTrackId, {
        url: legacy.url,
        cipherType: legacy.cipherType || 'BF_CBC_STRIPE',
        format: legacy.format || null,
      });
      return legacy.url;
    }

    throw lastMediaError ?? new Error('No Deezer stream URL available from media API or legacy fallback.');
  }

  async _resolveDeezerTrackToken(apiToken, trackId) {
    const safeTrackId = String(trackId ?? '').trim();
    if (!safeTrackId) return null;

    const payload = await this._deezerGatewayCall('song.getData', apiToken, { sng_id: safeTrackId }).catch(() => null);
    if (!payload) return null;

    const direct = String(payload?.results?.TRACK_TOKEN ?? '').trim();
    if (direct) return direct;

    const recursive = this._extractFirstStringByKey(payload?.results ?? payload, 'TRACK_TOKEN');
    return recursive || null;
  }

  async _resolveDeezerStreamUrl(track) {
    const trackId = String(track?.deezerTrackId ?? '').trim();
    const pinned = String(track?.deezerFullStreamUrl ?? '').trim();
    const cachedMeta = trackId ? this._deezerStreamMetaByTrackId.get(trackId) : null;

    if (pinned && isHttpUrl(pinned)) {
      if (cachedMeta && cachedMeta.url === pinned) {
        return {
          url: pinned,
          cipherType: cachedMeta.cipherType || 'NONE',
          format: cachedMeta.format || null,
          trackId,
        };
      }
      return {
        url: pinned,
        cipherType: 'NONE',
        format: null,
        trackId,
      };
    }

    if (this.deezerArl && trackId) {
      const url = await this._resolveDeezerFullStreamUrlWithArl(trackId);
      const meta = this._deezerStreamMetaByTrackId.get(trackId);
      return {
        url,
        cipherType: meta?.cipherType || 'NONE',
        format: meta?.format || null,
        trackId,
      };
    }

    throw new Error('No playable Deezer full stream URL available.');
  }

  async _sleep(ms) {
    const waitMs = Math.max(0, Number.parseInt(String(ms), 10) || 0);
    if (waitMs <= 0) return;
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }

  async _openDeezerStreamConnection(streamUrl, offset = 0) {
    const headers = { accept: '*/*' };
    if (this.deezerArl) {
      headers.cookie = this._getDeezerCookieHeader();
    }

    const safeOffset = Math.max(0, Number.parseInt(String(offset), 10) || 0);
    if (safeOffset > 0) {
      headers.range = `bytes=${safeOffset}-`;
    }

    const response = await fetch(streamUrl, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(15_000),
    }).catch(() => null);

    if (!response?.ok || !response.body) {
      throw new Error(`Failed to fetch encrypted Deezer stream (${response?.status ?? 'network'})`);
    }
    this._updateDeezerCookieHeader(response);

    if (safeOffset > 0) {
      if (response.status !== 206) {
        throw new Error(`Deezer stream did not honor range resume (status ${response.status}).`);
      }

      const rangeStart = parseContentRangeStart(response.headers.get('content-range'));
      if (rangeStart == null || rangeStart !== safeOffset) {
        throw new Error(`Deezer stream resumed at unexpected offset (${rangeStart ?? 'unknown'} != ${safeOffset}).`);
      }
    }

    return response;
  }

  _createDeezerResilientReadable(streamUrl) {
    const out = new PassThrough({
      highWaterMark: DEEZER_STREAM_HIGH_WATER_MARK,
    });

    let offset = 0;
    let attempts = 0;
    let closed = false;
    let activeReader = null;

    const onClose = () => {
      closed = true;
      try {
        activeReader?.cancel?.();
      } catch {
        // ignore reader cancel errors
      }
    };
    out.once('close', onClose);
    out.once('error', onClose);

    const run = async () => {
      while (!closed) {
        let response;
        try {
          response = await this._openDeezerStreamConnection(streamUrl, offset);
        } catch (err) {
          if (!isRetryableDeezerStreamError(err) || attempts >= DEEZER_STREAM_RETRY_LIMIT) {
            out.destroy(err instanceof Error ? err : new Error(String(err)));
            return;
          }

          const backoffMs = Math.min(
            DEEZER_STREAM_MAX_BACKOFF_MS,
            DEEZER_STREAM_BASE_BACKOFF_MS * (2 ** attempts)
          );
          attempts += 1;
          await this._sleep(backoffMs);
          continue;
        }

        attempts = 0;
        activeReader = response.body?.getReader?.() ?? null;
        if (!activeReader) {
          out.destroy(new Error('Encrypted Deezer response body is not readable.'));
          return;
        }

        try {
          while (!closed) {
            const { done, value } = await activeReader.read();
            if (done) {
              out.end();
              return;
            }

            if (!value || value.length === 0) continue;
            offset += value.length;

            if (!out.write(Buffer.from(value))) {
              await new Promise((resolve) => out.once('drain', resolve));
            }
          }
        } catch (err) {
          if (closed) return;

          if (!isRetryableDeezerStreamError(err) || attempts >= DEEZER_STREAM_RETRY_LIMIT) {
            out.destroy(err instanceof Error ? err : new Error(String(err)));
            return;
          }

          const backoffMs = Math.min(
            DEEZER_STREAM_MAX_BACKOFF_MS,
            DEEZER_STREAM_BASE_BACKOFF_MS * (2 ** attempts)
          );
          attempts += 1;
          await this._sleep(backoffMs);
        } finally {
          try {
            activeReader?.releaseLock?.();
          } catch {
            // ignore reader release errors
          }
          activeReader = null;
        }
      }
    };

    run().catch((err) => {
      out.destroy(err instanceof Error ? err : new Error(String(err)));
    });

    return out;
  }

  async _startDeezerEncryptedPipeline(streamUrl, trackId, seekSec = 0) {
    const rawStream = this._createDeezerResilientReadable(streamUrl);
    const decryptStream = new DeezerBfStripeDecryptTransform(trackId);
    this.sourceStream = rawStream;
    this.deezerDecryptStream = decryptStream;

    this.ffmpeg = await this._spawnProcess(this.ffmpegBin, this._ffmpegArgs(seekSec), {
      stdio: ['pipe', 'pipe', 'ignore'],
    });

    this._bindPipelineErrorHandler(rawStream, 'deezer.raw');
    this._bindPipelineErrorHandler(decryptStream, 'deezer.decrypt');
    this._bindPipelineErrorHandler(this.ffmpeg.stdin, 'ffmpeg.stdin');
    this._bindPipelineErrorHandler(this.ffmpeg.stdout, 'ffmpeg.stdout');

    rawStream.on('error', () => {
      this.ffmpeg?.kill('SIGKILL');
    });
    decryptStream.on('error', () => {
      this.ffmpeg?.kill('SIGKILL');
    });

    rawStream.pipe(decryptStream).pipe(this.ffmpeg.stdin);
  }

  async _startDeezerPipeline(track, seekSec = 0) {
    const stream = await this._resolveDeezerStreamUrl(track);
    if (stream.cipherType === 'BF_CBC_STRIPE') {
      await this._startDeezerEncryptedPipeline(stream.url, stream.trackId || track?.deezerTrackId, seekSec);
      return;
    }

    this.ffmpeg = await this._spawnProcess(this.ffmpegBin, this._ffmpegHttpArgs(stream.url, seekSec), {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    this._bindPipelineErrorHandler(this.ffmpeg.stdout, 'ffmpeg.stdout');
  }

  async _resolveCrossSourceToYouTube(sourceTracks, requestedBy, source) {
    if (!this.enableYtSearch) {
      throw new ValidationError('Cross-source imports require YouTube search, which is currently disabled.');
    }
    if (!this.enableYtPlayback) {
      throw new ValidationError('Cross-source imports require YouTube playback, which is currently disabled.');
    }

    const resolved = [];

    for (const sourceTrack of sourceTracks) {
      const title = sourceTrack.title || sourceTrack.name || 'Unknown title';
      const artist = pickArtistName(sourceTrack);
      const query = artist ? `${artist} - ${title}` : title;

      const result = await playdl.search(query, { source: { youtube: 'video' }, limit: 1 }).catch(() => []);
      if (!result.length) continue;

      resolved.push(this._buildTrack({
        title: result[0].title || title,
        url: result[0].url,
        duration: result[0].durationRaw || toDurationLabel(sourceTrack.durationInSec),
        thumbnailUrl: pickThumbnailUrlFromItem(result[0]),
        requestedBy,
        source,
      }));
    }

    if (!resolved.length) {
      throw new ValidationError(`No playable YouTube matches found for ${source} source.`);
    }

    return resolved;
  }

  async _resolveSingleUrlTrack(url, requestedBy) {
    try {
      const info = await playdl.video_info(url);
      return [this._buildTrack({
        title: info.video_details.title,
        url,
        duration: info.video_details.durationRaw,
        thumbnailUrl: pickThumbnailUrlFromItem(info.video_details),
        requestedBy,
        source: 'url',
      })];
    } catch {
      return [this._buildTrack({
        title: url,
        url,
        duration: 'Unknown',
        requestedBy,
        source: 'url',
      })];
    }
  }

  async _resolveSoundCloudByGuess(url, requestedBy) {
    try {
      if (url.includes('/sets/')) {
        return await this._resolveSoundCloudPlaylist(url, requestedBy);
      }
      return await this._resolveSoundCloudTrack(url, requestedBy);
    } catch {
      return this._resolveFromUrlFallbackSearch(url, requestedBy, 'soundcloud-fallback');
    }
  }

  async _resolveDeezerByGuess(url, requestedBy) {
    try {
      if (url.includes('/playlist/') || url.includes('/album/')) {
        return await this._resolveDeezerCollection(url, requestedBy);
      }
      return await this._resolveDeezerTrack(url, requestedBy);
    } catch {
      return this._resolveFromUrlFallbackSearch(url, requestedBy, 'deezer-fallback');
    }
  }

  async _resolveSpotifyByGuess(url, requestedBy) {
    try {
      if (url.includes('/playlist/') || url.includes('/album/')) {
        return await this._resolveSpotifyCollection(url, requestedBy);
      }
      return await this._resolveSpotifyTrack(url, requestedBy);
    } catch (err) {
      throw err;
    }
  }

  async _resolveFromUrlFallbackSearch(url, requestedBy, source) {
    if (!this.enableYtSearch) {
      throw new ValidationError(`Could not resolve ${source} URL because YouTube search is disabled.`);
    }
    if (!this.enableYtPlayback) {
      throw new ValidationError(`Could not resolve ${source} URL because YouTube playback is disabled.`);
    }

    const query = sanitizeUrlToSearchQuery(url);
    if (!query) {
      throw new ValidationError(`Could not resolve ${source} URL to a playable track.`);
    }

    const result = await playdl.search(query, { source: { youtube: 'video' }, limit: 1 }).catch(() => []);
    if (!result.length) {
      throw new ValidationError(`Could not resolve ${source} URL to a playable track.`);
    }

    return [this._buildTrack({
      title: result[0].title || query,
      url: result[0].url,
      duration: result[0].durationRaw,
      thumbnailUrl: pickThumbnailUrlFromItem(result[0]),
      requestedBy,
      source,
    })];
  }

  async _normalizeInputUrl(url) {
    let trimmed = String(url ?? '').trim();
    if (!isHttpUrl(trimmed)) return trimmed;

    const htmlDecoded = trimmed
      .replace(/&amp;/gi, '&')
      .replace(/&#38;/gi, '&');
    if (htmlDecoded !== trimmed && isHttpUrl(htmlDecoded)) {
      trimmed = htmlDecoded;
    }

    try {
      const parsed = new URL(trimmed);
      if (parsed.hostname === 'music.youtube.com') {
        parsed.hostname = 'www.youtube.com';
        return parsed.toString();
      }
      const shouldExpand = parsed.hostname.includes('link.deezer.com') || parsed.hostname.includes('on.soundcloud.com');

      if (shouldExpand) {
        const response = await fetch(trimmed, {
          method: 'GET',
          redirect: 'follow',
          signal: AbortSignal.timeout(7_000),
        }).catch(() => null);

        if (response?.url && isHttpUrl(response.url)) {
          return response.url;
        }
      }
    } catch {
      return trimmed;
    }

    return trimmed;
  }

  _buildTrack({
    title,
    url,
    duration,
    thumbnailUrl = null,
    requestedBy,
    source,
    artist = null,
    soundcloudTrackId = null,
    audiusTrackId = null,
    deezerTrackId = null,
    deezerPreviewUrl = null,
    deezerFullStreamUrl = null,
    seekStartSec = 0,
  }) {
    const normalizedThumbnail = normalizeThumbnailUrl(thumbnailUrl) ?? buildYouTubeThumbnailFromUrl(url);
    const normalizedDeezerPreview = normalizeThumbnailUrl(deezerPreviewUrl);
    const normalizedDeezerFull = normalizeThumbnailUrl(deezerFullStreamUrl);
    return {
      id: buildTrackId(),
      title: title || 'Unknown title',
      url,
      duration: toDurationLabel(duration),
      thumbnailUrl: normalizedThumbnail,
      requestedBy,
      source,
      artist: artist ? String(artist).slice(0, 128) : null,
      soundcloudTrackId: soundcloudTrackId ? String(soundcloudTrackId) : null,
      audiusTrackId: audiusTrackId ? String(audiusTrackId) : null,
      deezerTrackId: deezerTrackId ? String(deezerTrackId) : null,
      deezerPreviewUrl: normalizedDeezerPreview,
      deezerFullStreamUrl: normalizedDeezerFull,
      queuedAt: Date.now(),
      seekStartSec: Math.max(0, Number.parseInt(String(seekStartSec), 10) || 0),
    };
  }

  async _ensureSoundCloudClientId() {
    if (this.soundcloudClientId) return this.soundcloudClientId;
    if (!this.soundcloudAutoClientId) {
      throw new ValidationError('SoundCloud is not configured (missing SOUNDCLOUD_CLIENT_ID).');
    }

    try {
      const clientId = await playdl.getFreeClientID();
      if (!clientId) {
        throw new Error('empty client id');
      }
      this.soundcloudClientId = String(clientId).trim();
      this.soundcloudClientIdResolvedAt = Date.now();
      this.logger?.info?.('Resolved SoundCloud client id for direct playback');
      return this.soundcloudClientId;
    } catch (err) {
      throw new ValidationError(`Failed to resolve SoundCloud client id: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async _soundCloudResolve(url) {
    const clientId = await this._ensureSoundCloudClientId();
    const endpoint = new URL('https://api-v2.soundcloud.com/resolve');
    endpoint.searchParams.set('url', String(url));
    endpoint.searchParams.set('client_id', clientId);

    const response = await fetch(endpoint, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    }).catch(() => null);
    if (!response?.ok) {
      throw new Error(`resolve failed (${response?.status ?? 'network'})`);
    }

    return response.json();
  }

  async _fetchSoundCloudTrackById(trackId) {
    const clientId = await this._ensureSoundCloudClientId();
    const endpoint = new URL(`https://api-v2.soundcloud.com/tracks/${encodeURIComponent(String(trackId))}`);
    endpoint.searchParams.set('client_id', clientId);

    const response = await fetch(endpoint, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    }).catch(() => null);
    if (!response?.ok) {
      throw new Error(`track lookup failed (${response?.status ?? 'network'})`);
    }

    return response.json();
  }

  async _resolveSoundCloudTranscodingUrl(trackPayload) {
    const clientId = await this._ensureSoundCloudClientId();
    const transcodings = Array.isArray(trackPayload?.media?.transcodings)
      ? trackPayload.media.transcodings
      : [];
    if (!transcodings.length) {
      throw new Error('no transcodings in SoundCloud payload');
    }

    const ranked = [
      ...transcodings.filter((entry) => entry?.format?.protocol === 'progressive'),
      ...transcodings.filter((entry) => entry?.format?.protocol === 'hls'),
    ];
    if (!ranked.length) {
      throw new Error('no usable SoundCloud transcodings');
    }

    let lastError = null;
    for (const transcoding of ranked) {
      const lookupUrl = String(transcoding?.url ?? '').trim();
      if (!lookupUrl) continue;

      const endpoint = new URL(lookupUrl);
      endpoint.searchParams.set('client_id', clientId);
      const response = await fetch(endpoint, {
        method: 'GET',
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(10_000),
      }).catch(() => null);
      if (!response?.ok) {
        lastError = new Error(`transcoding lookup failed (${response?.status ?? 'network'})`);
        continue;
      }

      const body = await response.json().catch(() => null);
      const streamUrl = String(body?.url ?? '').trim();
      if (!streamUrl || !isHttpUrl(streamUrl)) {
        lastError = new Error('transcoding lookup returned no stream url');
        continue;
      }
      return streamUrl;
    }

    throw lastError ?? new Error('no playable SoundCloud stream URL');
  }

  _buildSoundCloudTrackFromMetadata(meta, requestedBy, source = 'soundcloud-direct') {
    const permalink = String(meta?.permalink_url ?? meta?.url ?? '').trim();
    if (!permalink || !isHttpUrl(permalink)) return null;

    const title = String(meta?.title ?? 'SoundCloud track').trim() || 'SoundCloud track';
    const duration = toSoundCloudDurationLabel(meta?.duration ?? meta?.durationInSec ?? null);
    const artist = String(meta?.user?.username ?? meta?.publisher_metadata?.artist ?? '').trim() || null;
    const thumbnailUrl = pickThumbnailUrlFromItem(meta) ?? normalizeThumbnailUrl(meta?.artwork_url);
    const trackId = meta?.id != null ? String(meta.id) : null;

    return this._buildTrack({
      title,
      url: permalink,
      duration,
      thumbnailUrl,
      requestedBy,
      source,
      artist,
      soundcloudTrackId: trackId,
    });
  }

  async _resolveSoundCloudTrackDirect(url, requestedBy) {
    const payload = await this._soundCloudResolve(url);
    const kind = String(payload?.kind ?? '').toLowerCase();
    if (kind !== 'track') {
      throw new Error(`resolved object is not a track (${kind || 'unknown'})`);
    }

    const track = this._buildSoundCloudTrackFromMetadata(payload, requestedBy, 'soundcloud-direct');
    return track ? [track] : [];
  }

  async _resolveSoundCloudPlaylistDirect(url, requestedBy) {
    const payload = await this._soundCloudResolve(url);
    const kind = String(payload?.kind ?? '').toLowerCase();
    if (kind !== 'playlist' && kind !== 'system-playlist') {
      throw new Error(`resolved object is not a playlist (${kind || 'unknown'})`);
    }

    const tracks = Array.isArray(payload?.tracks) ? payload.tracks : [];
    const resolved = [];
    for (const entry of tracks) {
      if (resolved.length >= this.maxPlaylistTracks) break;
      const track = this._buildSoundCloudTrackFromMetadata(entry, requestedBy, 'soundcloud-playlist-direct');
      if (track) resolved.push(track);
    }

    return resolved;
  }

  async _resolveSoundCloudStreamUrl(track) {
    const sourceUrl = String(track?.url ?? '').trim();
    const trackId = String(track?.soundcloudTrackId ?? '').trim() || null;

    let payload = null;
    if (trackId) {
      payload = await this._fetchSoundCloudTrackById(trackId).catch(() => null);
    }
    if (!payload && sourceUrl) {
      payload = await this._soundCloudResolve(sourceUrl).catch(() => null);
    }
    if (!payload) {
      throw new Error('SoundCloud track resolve failed');
    }

    return this._resolveSoundCloudTranscodingUrl(payload);
  }

  async _startSoundCloudPipeline(track, seekSec = 0) {
    const streamUrl = await this._resolveSoundCloudStreamUrl(track);
    this.ffmpeg = await this._spawnProcess(this.ffmpegBin, this._ffmpegHttpArgs(streamUrl, seekSec), {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    this._bindPipelineErrorHandler(this.ffmpeg.stdout, 'ffmpeg.stdout');
  }

  _ffmpegHttpArgs(inputUrl, seekSec = 0) {
    const normalizedVolume = clamp(this.volumePercent, this.minVolumePercent, this.maxVolumePercent);
    const volumeFactor = (normalizedVolume / 100).toFixed(2);
    const filterChain = this._buildAudioFilterChain(volumeFactor);
    const seek = Math.max(0, Number.parseInt(String(seekSec), 10) || 0);

    const args = [
      '-reconnect', '1',
      '-reconnect_streamed', '1',
      '-reconnect_delay_max', '5',
    ];

    if (seek > 0) {
      args.push('-ss', String(seek));
    }

    args.push(
      '-i', inputUrl,
      '-ac', '2',
      '-ar', '48000',
      '-af', filterChain,
      '-f', 's16le',
      '-acodec', 'pcm_s16le',
      'pipe:1',
    );

    return args;
  }

  _cloneTrack(track, overrides = {}) {
    const next = {
      ...track,
      ...overrides,
    };
    next.id = overrides.id ?? buildTrackId();
    next.queuedAt = overrides.queuedAt ?? Date.now();
    return next;
  }

  _trackKey(track) {
    if (!track) return null;
    const url = String(track.url ?? '').trim().toLowerCase();
    if (url) return `url:${url}`;
    const title = String(track.title ?? '').trim().toLowerCase();
    return title ? `title:${title}` : null;
  }

  _hasDuplicateTrack(candidate) {
    const key = this._trackKey(candidate);
    if (!key) return false;

    if (this._trackKey(this.currentTrack) === key) return true;
    return this.pendingTracks.some((track) => this._trackKey(track) === key);
  }

  _rememberTrack(track) {
    if (!track) return;

    const snapshot = this._cloneTrack(track, {
      seekStartSec: 0,
      id: track.id,
      queuedAt: track.queuedAt,
    });
    this.trackHistory.push(snapshot);

    if (this.trackHistory.length > this.maxHistorySize) {
      this.trackHistory.splice(0, this.trackHistory.length - this.maxHistorySize);
    }
  }

  _parseDurationSeconds(value) {
    if (!value || typeof value !== 'string') return null;
    if (value.toLowerCase() === 'unknown') return null;

    const parts = value.split(':').map((part) => Number.parseInt(part, 10));
    if (!parts.every((part) => Number.isFinite(part))) return null;

    if (parts.length === 2) {
      return parts[0] * 60 + parts[1];
    }
    if (parts.length === 3) {
      return parts[0] * 3600 + parts[1] * 60 + parts[2];
    }

    return null;
  }

  async _startPlayDlPipeline(url, seekSec = 0) {
    const options = { quality: 2 };
    if (seekSec > 0 && isYouTubeUrl(url)) {
      options.seek = seekSec;
    }

    const stream = await playdl.stream(url, options);
    this.sourceStream = stream.stream;

    this.ffmpeg = await this._spawnProcess(this.ffmpegBin, this._ffmpegArgs(), {
      stdio: ['pipe', 'pipe', 'ignore'],
    });

    this._bindPipelineErrorHandler(this.sourceStream, 'source.stream');
    this._bindPipelineErrorHandler(this.ffmpeg.stdin, 'ffmpeg.stdin');
    this._bindPipelineErrorHandler(this.ffmpeg.stdout, 'ffmpeg.stdout');

    this.sourceStream.on('error', () => {
      this.ffmpeg?.kill('SIGKILL');
    });

    this.sourceStream.pipe(this.ffmpeg.stdin);
  }

  async _startYouTubePipeline(url, seekSec = 0) {
    if (!this.enableYtPlayback) {
      throw new ValidationError('YouTube playback is currently disabled by bot configuration.');
    }

    await this._startYtDlpPipeline(url, seekSec);
  }

  async _startYtDlpPipeline(url, seekSec = 0) {
    const attempts = this.ytdlpYoutubeClient
      ? [
          { format: 'bestaudio/best', includeClientArg: true },
          { format: 'bestaudio/best', includeClientArg: false },
          { format: null, includeClientArg: false },
        ]
      : [
          { format: 'bestaudio/best', includeClientArg: false },
          { format: null, includeClientArg: false },
        ];

    let lastErr = null;
    for (const attempt of attempts) {
      try {
        await this._startYtDlpPipelineWithFormat(url, seekSec, attempt.format, attempt.includeClientArg);
        return;
      } catch (err) {
        lastErr = err;
        if (!isRetryableYtDlpStartupError(err)) {
          throw err;
        }

        this.logger?.warn?.('yt-dlp startup strategy failed, retrying with next strategy', {
          format: attempt.format ?? '(default)',
          includeClientArg: attempt.includeClientArg,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    throw lastErr ?? new Error('yt-dlp format selection failed');
  }

  async _startYtDlpPipelineWithFormat(url, seekSec = 0, formatSelector = 'bestaudio/best', includeClientArg = true) {
    this._lastYtDlpDiagnostics = {
      formatSelector: formatSelector ?? null,
      includeClientArg: Boolean(includeClientArg),
      selectedFormats: null,
      selectedItag: null,
      updatedAt: new Date().toISOString(),
    };

    this.sourceProc = await this._spawnYtDlp(url, formatSelector, includeClientArg);
    this.sourceProc.stderr?.setEncoding?.('utf8');

    let stderr = '';
    let stderrBuffer = '';
    const ytdlpVerboseEnabled = this._isYtDlpVerboseEnabled();
    const onStderr = (chunk) => {
      const text = String(chunk ?? '');
      stderr = `${stderr}${text}`.slice(-4096);
      this._trackYtDlpFormatSelection(text);

      if (!ytdlpVerboseEnabled) return;
      stderrBuffer = `${stderrBuffer}${text}`;
      const lines = stderrBuffer.split(/\r?\n/);
      stderrBuffer = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed) {
          this.logger?.info?.('yt-dlp verbose', { line: trimmed });
        }
      }
    };
    this.sourceProc.stderr?.on?.('data', onStderr);

    const ffmpegArgs = this._ffmpegArgs(seekSec);
    this._lastFfmpegArgs = [...ffmpegArgs];
    this.ffmpeg = await this._spawnProcess(this.ffmpegBin, ffmpegArgs, {
      stdio: ['pipe', 'pipe', 'ignore'],
    });

    this._bindPipelineErrorHandler(this.sourceProc.stdout, 'sourceProc.stdout');
    this._bindPipelineErrorHandler(this.sourceProc.stderr, 'sourceProc.stderr');
    this._bindPipelineErrorHandler(this.ffmpeg.stdin, 'ffmpeg.stdin');
    this._bindPipelineErrorHandler(this.ffmpeg.stdout, 'ffmpeg.stdout');

    this.sourceProc.stdout.pipe(this.ffmpeg.stdin);
    this.sourceProc.once('close', () => {
      this.ffmpeg?.stdin?.end();
    });

    try {
      const waitTimeoutMs = seekSec > 0
        ? Math.min(45_000, 10_000 + (Math.max(0, Number.parseInt(String(seekSec), 10) || 0) * 50))
        : 10_000;
      await this._awaitProcessOutput(this.sourceProc, waitTimeoutMs);
    } catch (err) {
      if (stderr.trim()) {
        throw new Error(stderr.trim().split('\n').slice(-2).join(' | '));
      }
      throw err;
    } finally {
      if (ytdlpVerboseEnabled) {
        const trailing = stderrBuffer.trim();
        if (trailing) {
          this.logger?.info?.('yt-dlp verbose', { line: trailing });
        }
      }
      this.sourceProc.stderr?.off?.('data', onStderr);
    }
  }

  _ffmpegArgs(seekSec = 0, options = {}) {
    const normalizedVolume = clamp(this.volumePercent, this.minVolumePercent, this.maxVolumePercent);
    const volumeFactor = (normalizedVolume / 100).toFixed(2);
    const filterChain = this._buildAudioFilterChain(volumeFactor);
    const seek = Math.max(0, Number.parseInt(String(seekSec), 10) || 0);
    const realtimeInput = options?.realtimeInput === true;

    const args = [
      ...(realtimeInput ? ['-re'] : []),
      '-thread_queue_size', '4096',
      '-i', 'pipe:0',
    ];

    if (seek > 0) {
      // Output-side seek keeps yt-dlp fallback usable even when play-dl seek fails.
      args.push('-ss', String(seek));
    }

    args.push(
      '-ac', '2',
      '-ar', '48000',
      '-af', filterChain,
      '-f', 's16le',
      '-acodec', 'pcm_s16le',
      'pipe:1',
    );

    return args;
  }

  _buildAudioFilterChain(volumeFactor) {
    const filters = [];

    if (this.pitchSemitones !== 0) {
      const rateFactor = 2 ** (this.pitchSemitones / 12);
      filters.push(`asetrate=48000*${rateFactor.toFixed(6)}`);
      filters.push('aresample=48000');
    }

    if (this.tempoRatio !== 1) {
      filters.push(`atempo=${this.tempoRatio.toFixed(3)}`);
    }

    const presetFilters = FILTER_PRESETS[this.filterPreset] ?? FILTER_PRESETS.off;
    filters.push(...presetFilters);

    const eqGains = EQ_PRESETS[this.eqPreset] ?? EQ_PRESETS.flat;
    for (let i = 0; i < EQ_BANDS.length; i += 1) {
      const gain = eqGains[i] ?? 0;
      if (gain === 0) continue;
      filters.push(`equalizer=f=${EQ_BANDS[i]}:t=q:w=1:g=${gain}`);
    }

    filters.push(`volume=${volumeFactor}`);
    return filters.join(',');
  }

  async _spawnYtDlp(url, formatSelector = 'bestaudio/best', includeClientArg = true) {
    const ytdlpVerboseEnabled = this._isYtDlpVerboseEnabled();
    const commonArgs = [
      '--ignore-config',
      '--no-playlist',
      '--no-warnings',
      '--no-progress',
      '--extractor-retries', '3',
      '--fragment-retries', '3',
      '--retry-sleep', 'fragment:1:3',
    ];
    if (!ytdlpVerboseEnabled) {
      commonArgs.push('--quiet');
    }

    if (formatSelector) {
      commonArgs.push('-f', formatSelector);
    }

    if (includeClientArg && this.ytdlpYoutubeClient) {
      commonArgs.push('--extractor-args', `youtube:player_client=${this.ytdlpYoutubeClient}`);
    }
    if (this.ytdlpCookiesFile) {
      commonArgs.push('--cookies', this.ytdlpCookiesFile);
    }
    if (this.ytdlpCookiesFromBrowser) {
      commonArgs.push('--cookies-from-browser', this.ytdlpCookiesFromBrowser);
    }
    if (this.ytdlpExtraArgs.length) {
      commonArgs.push(...this.ytdlpExtraArgs);
    }

    commonArgs.push('-o', '-', url);
    const candidates = [];

    if (this.ytdlpBin) {
      candidates.push([this.ytdlpBin, commonArgs]);
    }

    candidates.push(
      ['yt-dlp', commonArgs],
      ['yt_dlp', commonArgs],
      ['py', ['-m', 'yt_dlp', ...commonArgs]],
      ['python', ['-m', 'yt_dlp', ...commonArgs]],
      ['python3', ['-m', 'yt_dlp', ...commonArgs]]
    );

    let lastErr = null;
    for (const [cmd, args] of candidates) {
      try {
        return await this._spawnProcess(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (err) {
        if (err?.code === 'ENOENT') {
          lastErr = err;
          continue;
        }
        throw err;
      }
    }

    throw new Error(`yt-dlp not found (${lastErr?.message ?? 'command not available'})`);
  }

  _isYtDlpVerboseEnabled() {
    if (!Array.isArray(this.ytdlpExtraArgs) || !this.ytdlpExtraArgs.length) return false;
    return this.ytdlpExtraArgs.some((arg) => {
      const token = String(arg ?? '').trim();
      return token === '--verbose' || token === '-v';
    });
  }

  _trackYtDlpFormatSelection(stderrChunk) {
    const text = String(stderrChunk ?? '');
    if (!text) return;

    const selectedMatch = text.match(/Downloading\s+\d+\s+format\(s\):\s*([^\r\n]+)/i);
    if (selectedMatch?.[1]) {
      const selectedFormats = String(selectedMatch[1]).trim();
      const itagMatch = selectedFormats.match(/\b(\d{2,4})\b/);
      this._lastYtDlpDiagnostics = {
        ...(this._lastYtDlpDiagnostics ?? {}),
        selectedFormats,
        selectedItag: itagMatch?.[1] ?? this._lastYtDlpDiagnostics?.selectedItag ?? null,
        updatedAt: new Date().toISOString(),
      };
      return;
    }

    const itagMatch = text.match(/[?&]itag=(\d{2,4})\b/i);
    if (itagMatch?.[1]) {
      this._lastYtDlpDiagnostics = {
        ...(this._lastYtDlpDiagnostics ?? {}),
        selectedItag: itagMatch[1],
        updatedAt: new Date().toISOString(),
      };
    }
  }

  async _searchWithYtDlp(query, limit = 1) {
    const safeLimit = Math.max(1, Math.min(10, Number.parseInt(String(limit), 10) || 1));
    const searchExpr = `ytsearch${safeLimit}:${query}`;
    const commonArgs = [
      '--ignore-config',
      '--quiet',
      '--no-warnings',
      '--skip-download',
      '--dump-single-json',
    ];

    if (this.ytdlpYoutubeClient) {
      commonArgs.push('--extractor-args', `youtube:player_client=${this.ytdlpYoutubeClient}`);
    }
    if (this.ytdlpCookiesFile) {
      commonArgs.push('--cookies', this.ytdlpCookiesFile);
    }
    if (this.ytdlpCookiesFromBrowser) {
      commonArgs.push('--cookies-from-browser', this.ytdlpCookiesFromBrowser);
    }

    commonArgs.push(searchExpr);
    const { stdout } = await this._runYtDlpCommand(commonArgs, 15_000);

    if (!stdout?.trim()) return [];
    let payload;
    try {
      payload = JSON.parse(stdout);
    } catch {
      return [];
    }

    const entries = Array.isArray(payload?.entries)
      ? payload.entries
      : (payload ? [payload] : []);

    return entries
      .map((entry) => {
        const id = String(entry?.id ?? '').trim();
        const url = String(entry?.webpage_url ?? entry?.url ?? '').trim() || (id ? `https://www.youtube.com/watch?v=${id}` : null);
        const title = String(entry?.title ?? '').trim();
        if (!url || !title) return null;
        return {
          title,
          url,
          duration: entry?.duration ?? null,
          thumbnailUrl: pickThumbnailUrlFromItem(entry),
          artist: pickTrackArtistFromMetadata(entry),
        };
      })
      .filter(Boolean);
  }

  async _runYtDlpCommand(args, timeoutMs = 12_000) {
    const candidates = [];
    if (this.ytdlpBin) candidates.push(this.ytdlpBin);
    candidates.push('yt-dlp', 'yt_dlp', 'py', 'python', 'python3');

    let lastErr = null;
    for (const cmd of candidates) {
      let proc;
      try {
        if (cmd === 'python3' || cmd === 'python' || cmd === 'py') {
          proc = await this._spawnProcess(cmd, ['-m', 'yt_dlp', ...args], {
            stdio: ['ignore', 'pipe', 'pipe'],
          });
        } else {
          proc = await this._spawnProcess(cmd, args, {
            stdio: ['ignore', 'pipe', 'pipe'],
          });
        }
      } catch (err) {
        if (err?.code === 'ENOENT') {
          lastErr = err;
          continue;
        }
        throw err;
      }

      const output = await this._collectProcessOutput(proc, timeoutMs).catch((err) => {
        throw err;
      });
      if (output.code === 0) return output;

      lastErr = new Error(output.stderr?.trim() || `yt-dlp exited with code ${output.code}`);
    }

    throw lastErr ?? new Error('yt-dlp command failed');
  }

  _collectProcessOutput(proc, timeoutMs = 12_000) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let stdout = '';
      let stderr = '';

      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        proc.kill('SIGKILL');
        reject(new Error('yt-dlp metadata command timed out.'));
      }, timeoutMs);

      proc.stdout?.setEncoding?.('utf8');
      proc.stderr?.setEncoding?.('utf8');
      proc.stdout?.on?.('data', (chunk) => {
        stdout = `${stdout}${chunk}`.slice(-2_000_000);
      });
      proc.stderr?.on?.('data', (chunk) => {
        stderr = `${stderr}${chunk}`.slice(-8_192);
      });

      proc.once('error', (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(err instanceof Error ? err : new Error(String(err)));
      });

      proc.once('close', (code, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        const exitCode = Number.isFinite(code) ? code : 1;
        if (signal) {
          reject(new Error(`yt-dlp metadata command terminated by signal ${signal}.`));
          return;
        }
        resolve({ code: exitCode, stdout, stderr });
      });
    });
  }

  _awaitProcessOutput(proc, timeoutMs = 5_000) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let sawOutput = false;
      const timeout = setTimeout(() => {
        if (settled || sawOutput) return;
        cleanup();
        reject(new Error('yt-dlp did not produce audio output in time.'));
      }, timeoutMs);

      const onData = () => {
        sawOutput = true;
        if (settled) return;
        cleanup();
        resolve();
      };

      const onClose = (code, signal) => {
        if (settled || sawOutput) return;
        cleanup();
        const codeLabel = code == null ? 'unknown' : String(code);
        const signalLabel = signal ? `, signal=${signal}` : '';
        reject(new Error(`yt-dlp exited before output (code=${codeLabel}${signalLabel}).`));
      };

      const onError = (err) => {
        if (settled || sawOutput) return;
        cleanup();
        reject(err instanceof Error ? err : new Error(String(err)));
      };

      const cleanup = () => {
        settled = true;
        clearTimeout(timeout);
        proc.stdout?.off?.('data', onData);
        proc.off?.('close', onClose);
        proc.off?.('error', onError);
      };

      proc.stdout?.on?.('data', onData);
      proc.on?.('close', onClose);
      proc.on?.('error', onError);
    });
  }

  _spawnProcess(cmd, args, options) {
    return new Promise((resolve, reject) => {
      const proc = spawn(cmd, args, options);
      let settled = false;

      proc.once('spawn', () => {
        settled = true;
        resolve(proc);
      });

      proc.once('error', (err) => {
        if (!settled) {
          reject(err);
        }
      });
    });
  }

  _cleanupProcesses() {
    try {
      if (this.sourceProc?.stdout && this.ffmpeg?.stdin) {
        this.sourceProc.stdout.unpipe(this.ffmpeg.stdin);
      }
    } catch {
      // ignore pipe teardown errors
    }

    try {
      if (this.sourceStream && this.ffmpeg?.stdin) {
        this.sourceStream.unpipe(this.ffmpeg.stdin);
      }
    } catch {
      // ignore pipe teardown errors
    }

    try {
      if (this.sourceStream && this.deezerDecryptStream) {
        this.sourceStream.unpipe(this.deezerDecryptStream);
      }
    } catch {
      // ignore pipe teardown errors
    }

    try {
      if (this.deezerDecryptStream && this.ffmpeg?.stdin) {
        this.deezerDecryptStream.unpipe(this.ffmpeg.stdin);
      }
    } catch {
      // ignore pipe teardown errors
    }

    try {
      this.deezerDecryptStream?.destroy?.();
    } catch {
      // ignore deezer decrypt stream teardown errors
    }
    this.deezerDecryptStream = null;

    try {
      this.sourceStream?.destroy?.();
    } catch {
      // ignore source stream teardown errors
    }

    this.sourceStream = null;
    this.sourceProc?.kill('SIGKILL');
    this.sourceProc = null;

    try {
      this.ffmpeg?.stdin?.destroy?.();
    } catch {
      // ignore stdin teardown errors
    }

    this.ffmpeg?.kill('SIGKILL');
    this.ffmpeg = null;
    this._clearPipelineErrorHandlers();
  }

  _clearPipelineState() {
    this._clearPipelineErrorHandlers();
    this.deezerDecryptStream = null;
    this.sourceStream = null;
  }

  _stopVoiceStream() {
    const stopAudio = this.voice?.stopAudio;
    if (typeof stopAudio !== 'function') return;
    try {
      stopAudio.call(this.voice);
    } catch {
      // ignore voice stop errors
    }
  }

  _clearPipelineErrorHandlers() {
    for (const unbind of this.pipelineErrorHandlers) {
      try {
        unbind();
      } catch {
        // ignore listener cleanup errors
      }
    }
    this.pipelineErrorHandlers = [];
  }

  _bindPipelineErrorHandler(stream, label) {
    if (!stream?.on || !stream?.off) return;

    const onError = (err) => {
      if (this._isExpectedPipeError(err)) {
        this.logger?.debug?.('Ignoring expected pipeline error', {
          label,
          code: err?.code ?? null,
        });
        return;
      }

      this.logger?.warn?.('Pipeline stream error', {
        label,
        code: err?.code ?? null,
        error: err instanceof Error ? err.message : String(err),
      });
    };

    stream.on('error', onError);
    this.pipelineErrorHandlers.push(() => {
      stream.off('error', onError);
    });
  }

  _isExpectedPipeError(err) {
    const code = err?.code;
    return code === 'EPIPE' || code === 'ERR_STREAM_DESTROYED' || code === 'ECONNRESET';
  }

  _startPlaybackClock(offsetSec) {
    this.currentTrackOffsetSec = Math.max(0, Number.parseInt(String(offsetSec), 10) || 0);
    this.trackStartedAtMs = Date.now();
    this.pauseStartedAtMs = null;
    this.totalPausedMs = 0;
  }

  _resetPlaybackClock() {
    this.trackStartedAtMs = null;
    this.pauseStartedAtMs = null;
    this.totalPausedMs = 0;
    this.currentTrackOffsetSec = 0;
  }

  _normalizePlaybackError(err) {
    if (err?.code === 'ENOENT' && (err?.path === this.ffmpegBin || err?.path === 'ffmpeg')) {
      return new Error('FFmpeg is not available. Install ffmpeg or set FFMPEG_BIN.');
    }
    if (err?.code === 'ENOENT' && /yt[_-]?dlp/i.test(String(err?.path ?? ''))) {
      return new Error('yt-dlp is not available. Install yt-dlp or set YTDLP_BIN.');
    }
    if (isYtDlpModuleMissingError(err)) {
      return new Error('yt-dlp Python module is missing. Install it with `python -m pip install yt-dlp` or set YTDLP_BIN to yt-dlp.exe.');
    }
    if (isConnectionRefusedError(err)) {
      return new Error('Network connection refused during media fetch. Check proxy env vars (HTTP_PROXY/HTTPS_PROXY/ALL_PROXY) and remove localhost:9 mappings.');
    }
    if (isYouTubeBotCheckError(err)) {
      return new Error(
        'YouTube requested bot verification. Configure YTDLP_COOKIES_FILE or YTDLP_COOKIES_FROM_BROWSER and update yt-dlp.'
      );
    }

    if (err instanceof ValidationError) return err;
    if (err instanceof Error) return err;
    return new Error(String(err));
  }
}
