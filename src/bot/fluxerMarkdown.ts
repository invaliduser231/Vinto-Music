export type TimestampStyle = 'd' | 'D' | 't' | 'T' | 'f' | 'F' | 's' | 'S' | 'R';

export type AdmonitionKind = 'NOTE' | 'TIP' | 'IMPORTANT' | 'WARNING' | 'CAUTION';

function toUnixSeconds(value: Date | number | string | null | undefined): number | null {
  if (value == null) return null;

  const ms = value instanceof Date
    ? value.getTime()
    : (typeof value === 'number' ? value : Date.parse(String(value)));

  if (!Number.isFinite(ms)) return null;
  return Math.floor(ms / 1000);
}

export function timestampTag(
  value: Date | number | string | null | undefined,
  style: TimestampStyle = 'f',
): string {
  const seconds = toUnixSeconds(value);
  if (seconds == null) return '';
  return `<t:${seconds}:${style}>`;
}

export function relativeTimestamp(value: Date | number | string | null | undefined): string {
  return timestampTag(value, 'R');
}

export function relativeFromNow(offsetSeconds: number): string {
  if (!Number.isFinite(offsetSeconds)) return '';
  return relativeTimestamp(Date.now() + Math.round(offsetSeconds) * 1000);
}

export function heading(text: string | null | undefined, level: 1 | 2 | 3 = 3): string {
  const safe = String(text ?? '').trim();
  if (!safe) return '';
  return `${'#'.repeat(level)} ${safe.replace(/\r?\n/g, ' ')}`;
}

export function subtext(text: string | null | undefined): string {
  const safe = String(text ?? '').trim();
  if (!safe) return '';
  return safe
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => `-# ${line}`)
    .join('\n');
}

export function admonition(kind: AdmonitionKind, text: string | null | undefined): string {
  const safe = String(text ?? '').trim();
  if (!safe) return '';
  const body = safe
    .split(/\r?\n/)
    .map((line) => `> ${line.trim()}`.trimEnd())
    .join('\n');
  return `> [!${kind}]\n${body}`;
}

export function maskedLink(label: string, url: string | null | undefined, options: { embed?: boolean } = {}): string {
  const safeLabel = String(label ?? '').trim().replace(/[[\]]/g, '');
  const safeUrl = String(url ?? '').trim();
  if (!safeLabel) return '';
  if (!/^https?:\/\//i.test(safeUrl) || /[\s<>()]/.test(safeUrl)) return safeLabel;
  return options.embed === true ? `[${safeLabel}](${safeUrl})` : `[${safeLabel}](<${safeUrl}>)`;
}
