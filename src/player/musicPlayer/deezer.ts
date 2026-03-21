import { createCipheriv, createDecipheriv, createHash, getCiphers } from 'node:crypto';
import { Transform } from 'node:stream';
import { Blowfish } from 'egoroof-blowfish';
import type { TrackInput } from '../../types/domain.ts';

const DEEZER_STRIPE_CHUNK_SIZE = 2048;
const DEEZER_BLOWFISH_IV = Buffer.from([0, 1, 2, 3, 4, 5, 6, 7]);
const DEEZER_FILE_KEY = Buffer.from('jo6aey6haid2Teih', 'ascii');
const DEEZER_BLOWFISH_SECRET = 'g4el58wc0zvf9na1';
const DEEZER_BF_CBC_SUPPORTED = getCiphers().includes('bf-cbc');

export const DEEZER_ALLOWED_TRACK_FORMATS = new Set([
  'FLAC',
  'MP3_320',
  'MP3_256',
  'MP3_128',
  'MP3_64',
  'AAC_64',
]);
export const DEEZER_LAVASRC_DEFAULT_FORMATS = ['MP3_128', 'MP3_64'];
export const DEEZER_MEDIA_QUALITY_MAP = new Map([
  ['FLAC', 9],
  ['MP3_320', 3],
  ['MP3_256', 3],
  ['MP3_128', 1],
]);
export const DEEZER_SESSION_TOKEN_TTL_MS = 3_600_000;
export const DEEZER_STREAM_RETRY_LIMIT = 8;
export const DEEZER_STREAM_BASE_BACKOFF_MS = 250;
export const DEEZER_STREAM_MAX_BACKOFF_MS = 2_000;
export const DEEZER_STREAM_HIGH_WATER_MARK = 1 << 20;

function md5Hex(value: string, encoding: BufferEncoding = 'ascii') {
  const hash = createHash('md5');
  hash.update(value, encoding);
  return hash.digest('hex');
}

function getDeezerBlowfishKey(trackId: unknown) {
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

function createDeezerChunkDecryptor(blowfishKey: Buffer) {
  if (DEEZER_BF_CBC_SUPPORTED) {
    return (chunk: Buffer) => {
      const decipher = createDecipheriv('bf-cbc', blowfishKey, DEEZER_BLOWFISH_IV);
      decipher.setAutoPadding(false);
      return Buffer.concat([decipher.update(chunk), decipher.final()]);
    };
  }

  const cipher = new Blowfish(blowfishKey, Blowfish.MODE.CBC, Blowfish.PADDING.NULL);
  return (chunk: Buffer) => {
    cipher.setIv(DEEZER_BLOWFISH_IV);
    return Buffer.from(cipher.decode(chunk, Blowfish.TYPE.UINT8_ARRAY));
  };
}

function getDeezerSongFileName(track: TrackInput | null | undefined, quality: unknown) {
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

export function buildDeezerLegacyDownloadUrl(track: TrackInput | null | undefined, quality: unknown) {
  const md5Origin = String(track?.MD5_ORIGIN ?? '').trim();
  if (!md5Origin) return null;
  const cdn = md5Origin[0];
  const fileName = getDeezerSongFileName(track, quality);
  return `http://e-cdn-proxy-${cdn}.deezer.com/mobile/1/${fileName}`;
}

export function parseContentRangeStart(value: unknown) {
  const raw = String(value ?? '').trim();
  const match = raw.match(/^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i);
  if (!match) return null;
  const parsed = Number.parseInt(match[1] ?? '', 10);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return parsed;
}

export function isRetryableDeezerStreamError(err: unknown) {
  const typedErr = err && typeof err === 'object' ? err as { code?: unknown; message?: unknown } : null;
  const code = String(typedErr?.code ?? '').trim().toUpperCase();
  if (['ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT'].includes(code)) {
    return true;
  }

  const message = String(typedErr?.message ?? err ?? '').toLowerCase();
  return (
    message.includes('socket hang up')
    || message.includes('network')
    || message.includes('connection reset')
    || message.includes('body timeout')
    || message.includes('fetch failed')
    || message.includes('premature close')
  );
}

type PendingChunk = Buffer;

export class DeezerBfStripeDecryptTransform extends Transform {
  trackId: string;
  blowfishKey: Buffer;
  decryptChunk: (chunk: Buffer) => Buffer;
  pendingChunks: PendingChunk[];
  pendingBytes: number;
  blockIndex: number;

  constructor(trackId: string | number | null | undefined) {
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

  _appendPendingChunk(chunk: unknown) {
    if (chunk == null) return;
    const normalized = Buffer.isBuffer(chunk)
      ? chunk
      : typeof chunk === 'string'
        ? Buffer.from(chunk)
        : ArrayBuffer.isView(chunk)
          ? Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
          : chunk instanceof ArrayBuffer
            ? Buffer.from(chunk)
            : null;
    if (!normalized || normalized.length === 0) return;
    this.pendingChunks.push(normalized);
    this.pendingBytes += normalized.length;
  }

  _consumePendingStripe() {
    if (this.pendingBytes < DEEZER_STRIPE_CHUNK_SIZE) return null;

    const first = this.pendingChunks[0]!;
    if (first.length === DEEZER_STRIPE_CHUNK_SIZE) {
      this.pendingChunks.shift();
      this.pendingBytes -= DEEZER_STRIPE_CHUNK_SIZE;
      return first;
    }

    const stripe = Buffer.allocUnsafe(DEEZER_STRIPE_CHUNK_SIZE);
    let offset = 0;

    while (offset < DEEZER_STRIPE_CHUNK_SIZE && this.pendingChunks.length) {
      const chunk = this.pendingChunks[0]!;
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

  override _transform(chunk: unknown, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
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

  override _flush(callback: (error?: Error | null) => void) {
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

  override _destroy(err: Error | null, callback: (error?: Error | null) => void) {
    this.pendingChunks = [];
    this.pendingBytes = 0;
    callback(err);
  }
}




