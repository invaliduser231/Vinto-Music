import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';
import { ConfigurationError } from '../../core/errors.ts';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const KEY_BYTES = 32;

export interface SealedSecret {
  v: number;
  iv: string;
  tag: string;
  data: string;
}

export function parseEncryptionKey(raw: unknown): Buffer {
  const value = String(raw ?? '').trim();
  if (!value) {
    throw new ConfigurationError('LASTFM_ENCRYPTION_KEY is empty');
  }

  const candidates: Buffer[] = [];
  if (/^[0-9a-f]{64}$/i.test(value)) {
    candidates.push(Buffer.from(value, 'hex'));
  }
  if (/^[A-Za-z0-9+/=_-]+$/.test(value)) {
    candidates.push(Buffer.from(value, 'base64'));
  }
  candidates.push(Buffer.from(value, 'utf8'));

  const key = candidates.find((candidate) => candidate.length === KEY_BYTES);
  if (!key) {
    throw new ConfigurationError('LASTFM_ENCRYPTION_KEY must decode to exactly 32 bytes (hex, base64 or raw)');
  }

  return key;
}

export function sealSecret(plain: string, key: Buffer): SealedSecret {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const data = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);

  return {
    v: 1,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
  };
}

export function isSealedSecret(value: unknown): value is SealedSecret {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return typeof record.iv === 'string' && typeof record.tag === 'string' && typeof record.data === 'string';
}

export function openSecret(sealed: unknown, key: Buffer): string | null {
  if (!isSealedSecret(sealed)) return null;

  try {
    const iv = Buffer.from(sealed.iv, 'base64');
    const tag = Buffer.from(sealed.tag, 'base64');
    if (iv.length !== IV_BYTES || tag.length !== 16) return null;

    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([
      decipher.update(Buffer.from(sealed.data, 'base64')),
      decipher.final(),
    ]);
    return plain.toString('utf8');
  } catch {
    return null;
  }
}

export function secretsMatch(left: string, right: string): boolean {
  const a = Buffer.from(String(left), 'utf8');
  const b = Buffer.from(String(right), 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
