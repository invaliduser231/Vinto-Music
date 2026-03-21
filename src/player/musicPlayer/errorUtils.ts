import {
  DEEZER_ALLOWED_TRACK_FORMATS,
  DEEZER_LAVASRC_DEFAULT_FORMATS,
} from './deezer.ts';
import { YT_PLAYLIST_RESOLVERS } from './constants.ts';

function errorMessage(err: unknown): string {
  if (err && typeof err === 'object' && 'message' in err) {
    return String((err as { message?: unknown }).message ?? '').toLowerCase();
  }
  return String(err ?? '').toLowerCase();
}

export function isSoundCloudAuthorizationError(err: unknown): boolean {
  const message = errorMessage(err);
  return (
    message.includes('soundcloud data is missing')
    || message.includes('did you forget to do authorization')
    || (message.includes('soundcloud') && message.includes('authorization'))
  );
}

export function soundCloudAuthorizationHelp() {
  return 'SoundCloud lookup needs SoundCloud authorization in play-dl. Falling back to YouTube search for this URL.';
}

export function isYouTubeBotCheckError(err: unknown): boolean {
  const message = errorMessage(err);
  return message.includes('sign in to confirm') || message.includes('not a bot');
}

export function isYtDlpModuleMissingError(err: unknown): boolean {
  const message = errorMessage(err);
  return (
    message.includes('no module named yt_dlp')
    || message.includes('no module named yt-dlp')
    || message.includes('module named yt_dlp')
  );
}

export function isConnectionRefusedError(err: unknown): boolean {
  const message = errorMessage(err);
  return (
    message.includes('winerror 10061')
    || message.includes('connection refused')
    || message.includes('zielcomputer die verbindung verweigerte')
  );
}

export function isRequestedFormatUnavailableError(err: unknown): boolean {
  const message = errorMessage(err);
  return (
    message.includes('requested format is not available')
    || message.includes('format is not available')
  );
}

export function isYtDlpOutputTimeoutError(err: unknown): boolean {
  const message = errorMessage(err);
  return message.includes('yt-dlp did not produce audio output in time');
}

export function isYtDlpExitedBeforeOutputError(err: unknown): boolean {
  const message = errorMessage(err);
  return message.includes('yt-dlp exited before output');
}

export function isRetryableYtDlpStartupError(err: unknown): boolean {
  return (
    isRequestedFormatUnavailableError(err)
    || isYtDlpOutputTimeoutError(err)
    || isYtDlpExitedBeforeOutputError(err)
  );
}

export function isPlayDlBrowseFailure(err: unknown): boolean {
  const message = errorMessage(err);
  return (
    message.includes('browseid')
    || message.includes("cannot read properties of undefined (reading 'browseid')")
    || (message.includes('cannot read properties of undefined') && message.includes('youtube'))
  );
}

export function parseCsvArgs(value: unknown): string[] {
  if (!value) return [];
  return String(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

export function normalizeDeezerTrackFormats(formatsValue: unknown): string[] {
  const raw = Array.isArray(formatsValue) ? formatsValue : parseCsvArgs(formatsValue);
  const normalized: string[] = [];
  const seen = new Set<string>();

  for (const entry of raw) {
    const format = String(entry ?? '').trim().toUpperCase();
    if (!format || seen.has(format) || !DEEZER_ALLOWED_TRACK_FORMATS.has(format)) continue;
    seen.add(format);
    normalized.push(format);
  }

  return normalized.length ? normalized : [...DEEZER_LAVASRC_DEFAULT_FORMATS];
}

export function normalizeYtDlpArgs(args: unknown): string[] {
  const input = Array.isArray(args) ? args : [];
  if (!input.length) return [];

  const listValueFlags = new Set([
    '--js-runtimes',
    '--extractor-args',
    '--remote-components',
  ]);

  const normalized: string[] = [];
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

export function normalizeYouTubePlaylistResolver(value: unknown): string {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!normalized || normalized === 'auto') return 'ytdlp';
  if (YT_PLAYLIST_RESOLVERS.has(normalized)) return normalized;
  return 'ytdlp';
}


