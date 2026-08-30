export type LyricLine = {
  timeSec: number;
  text: string;
};

const TIMESTAMP_PATTERN = /\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g;

export function parseLrc(raw: string | null | undefined): LyricLine[] {
  const source = String(raw ?? '');
  if (!source.trim()) return [];

  const lines: LyricLine[] = [];
  for (const rawLine of source.split('\n')) {
    TIMESTAMP_PATTERN.lastIndex = 0;
    const stamps: number[] = [];
    let match = TIMESTAMP_PATTERN.exec(rawLine);
    while (match) {
      const minutes = Number.parseInt(match[1] ?? '0', 10);
      const seconds = Number.parseInt(match[2] ?? '0', 10);
      const fractionRaw = match[3] ?? '';
      const fraction = fractionRaw
        ? Number.parseInt(fractionRaw, 10) / 10 ** fractionRaw.length
        : 0;
      if (Number.isFinite(minutes) && Number.isFinite(seconds)) {
        stamps.push((minutes * 60) + seconds + fraction);
      }
      match = TIMESTAMP_PATTERN.exec(rawLine);
    }
    if (!stamps.length) continue;

    const text = rawLine.replace(TIMESTAMP_PATTERN, '').trim();
    for (const timeSec of stamps) {
      lines.push({ timeSec, text });
    }
  }

  lines.sort((a, b) => a.timeSec - b.timeSec);
  return lines;
}

export function findActiveLineIndex(lines: LyricLine[], positionSec: number): number {
  if (!lines.length) return -1;
  let low = 0;
  let high = lines.length - 1;
  let found = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if ((lines[mid]?.timeSec ?? 0) <= positionSec) {
      found = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return found;
}
