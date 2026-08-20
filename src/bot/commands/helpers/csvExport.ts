export interface ExportTrack {
  title?: string | null;
  artist?: string | null;
  duration?: string | null;
  source?: string | null;
  url?: string | null;
  requestedBy?: string | null;
  isLive?: boolean | null;
}

export const CSV_COLUMNS = [
  'position',
  'state',
  'title',
  'artist',
  'duration',
  'source',
  'url',
  'requested_by',
] as const;

export function escapeCsvField(value: unknown): string {
  const text = value == null ? '' : String(value);
  if (!/[",\r\n]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

export function buildCsvRow(values: readonly unknown[]): string {
  return values.map(escapeCsvField).join(',');
}

export function buildQueueCsv(options: {
  current?: ExportTrack | null;
  pending?: readonly ExportTrack[] | null;
}): string {
  const rows: string[] = [buildCsvRow(CSV_COLUMNS)];
  const pending = Array.isArray(options.pending) ? options.pending : [];

  let position = 0;
  if (options.current) {
    position += 1;
    rows.push(trackRow(options.current, position, 'playing'));
  }

  for (const track of pending) {
    position += 1;
    rows.push(trackRow(track, position, 'queued'));
  }

  return `${rows.join('\r\n')}\r\n`;
}

function trackRow(track: ExportTrack, position: number, state: string): string {
  const duration = track.isLive === true ? 'live' : String(track.duration ?? '').trim();
  return buildCsvRow([
    position,
    state,
    String(track.title ?? '').trim(),
    String(track.artist ?? '').trim(),
    duration,
    String(track.source ?? '').trim(),
    String(track.url ?? '').trim(),
    String(track.requestedBy ?? '').trim(),
  ]);
}

export function buildExportFilename(guildId: unknown, timestamp: Date): string {
  const stamp = timestamp.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const safeGuild = String(guildId ?? 'guild').replace(/[^\w-]/g, '') || 'guild';
  return `queue-${safeGuild}-${stamp}.csv`;
}
