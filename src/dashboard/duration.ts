export function parseTrackDurationSeconds(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.max(0, Math.floor(value));
  }

  if (!value || typeof value !== 'string') return 0;
  if (value.trim().toLowerCase() === 'unknown') return 0;

  const parts = value.split(':').map((part) => Number.parseInt(part, 10));
  if (!parts.every((part) => Number.isFinite(part))) return 0;

  if (parts.length === 2) {
    return (parts[0] ?? 0) * 60 + (parts[1] ?? 0);
  }
  if (parts.length === 3) {
    return (parts[0] ?? 0) * 3600 + (parts[1] ?? 0) * 60 + (parts[2] ?? 0);
  }

  return 0;
}
