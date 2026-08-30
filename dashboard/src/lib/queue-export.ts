import type { NowPlayingTrack, QueueTrack } from '@/types/session';

function escapeCsv(value: unknown): string {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function buildDashboardQueueCsv(
  current: NowPlayingTrack | null,
  queue: QueueTrack[],
): string {
  const tracks: Array<NowPlayingTrack | QueueTrack> = current ? [current, ...queue] : queue;
  const rows = ['position,title,artist,duration_seconds,source,requested_by'];
  tracks.forEach((track, index) => {
    rows.push([
      index + 1,
      track.title,
      track.artist,
      track.durationSec,
      track.source,
      track.requestedByName ?? track.requestedBy ?? '',
    ].map(escapeCsv).join(','));
  });
  return rows.join('\r\n');
}

export function downloadDashboardQueue(
  guildName: string,
  current: NowPlayingTrack | null,
  queue: QueueTrack[],
): void {
  const safeGuild = guildName.replace(/[^a-z0-9_-]+/gi, '-').replace(/^-|-$/g, '') || 'guild';
  const blob = new Blob([`\uFEFF${buildDashboardQueueCsv(current, queue)}`], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `queue-${safeGuild}-${new Date().toISOString().slice(0, 10)}.csv`;
  anchor.click();
  URL.revokeObjectURL(url);
}
