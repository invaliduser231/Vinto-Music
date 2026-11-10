import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

let cachedVersion: string | null | undefined;

function readVersion(path: string): string | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { name?: unknown; version?: unknown };
    if (parsed.name !== 'fluxer-music-bot') return null;
    const version = String(parsed.version ?? '').trim();
    return version || null;
  } catch {
    return null;
  }
}

export function getAppVersion(): string | null {
  if (cachedVersion !== undefined) return cachedVersion;
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(process.cwd(), 'package.json'),
    resolve(here, '..', '..', 'package.json'),
    resolve(here, '..', '..', '..', 'package.json'),
  ];
  cachedVersion = null;
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    const version = readVersion(candidate);
    if (version) {
      cachedVersion = version;
      break;
    }
  }
  return cachedVersion;
}
