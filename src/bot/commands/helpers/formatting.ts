import { ValidationError } from '../../../core/errors.ts';
import { buildEmbed } from '../../messageFormatter.ts';
import type { CommandDefinition, MessagePayload } from '../../../types/core.ts';
import {
  EMBED_FIELD_TEXT_LIMIT,
  HISTORY_PAGE_SIZE,
  PENDING_PAGE_SIZE,
  SUPPORT_SERVER_URL,
  TRACK_LINE_MAX_CHARS,
  VOICE_CHANNEL_PATTERN,
} from './constants.ts';

type TrackLike = {
  requestedBy?: string | null;
  duration?: string | null;
  title?: string | null;
  isLive?: boolean | null;
  url?: string | null;
};

type SessionLike = {
  player?: {
    pendingTracks?: TrackLike[];
    displayTrack?: TrackLike | null;
    currentTrack?: TrackLike | null;
    getProgressSeconds?: () => number;
    loopMode?: string;
    volumePercent?: number;
    historyTracks?: TrackLike[];
  };
  settings?: {
    dedupeEnabled?: boolean;
    stayInVoiceEnabled?: boolean;
  };
};

function truncateWithEllipsis(text: unknown, maxChars: number | string) {
  const value = String(text ?? '');
  const limit = Number.parseInt(String(maxChars), 10);
  if (!Number.isFinite(limit) || limit <= 0) return '';
  if (value.length <= limit) return value;
  if (limit <= 3) return '.'.repeat(limit);
  return `${value.slice(0, limit - 3)}...`;
}

function compactTrackTitle(title: unknown) {
  let value = String(title ?? '').trim() || 'Unknown title';
  value = value.replace(/^[\[({<【❰「『].*?[\])}>】❱」』]\s*/u, '');
  value = value.replace(/\s*[\[(](official (music )?video|official audio|official lyric video|lyric video|lyrics?|visualizer|audio|hd)[\])]\s*/gi, '');
  value = value.replace(/\s+-\s+(official (music )?video|official audio|visualizer|audio|lyrics?)$/gi, '');
  value = value.replace(/\s{2,}/g, ' ').trim();
  return value || 'Unknown title';
}

function isSafeMarkdownLinkTarget(value: unknown) {
  return /^https?:\/\//i.test(String(value ?? '').trim());
}

function formatTrackListLine(
  track: TrackLike,
  index: number | null = null,
  maxChars: number = TRACK_LINE_MAX_CHARS,
  options: { includeRequester?: boolean } = {},
) {
  const prefix = Number.isFinite(index) ? `${index}. ` : '';
  const by = options.includeRequester !== false && track?.requestedBy ? ` • requested by <@${track.requestedBy}>` : '';
  const duration = String(track?.duration ?? 'Unknown');
  const titleRaw = compactTrackTitle(track?.title);
  const staticLength = prefix.length + by.length + duration.length + 7;
  const titleBudget = Math.max(16, Number.parseInt(String(maxChars), 10) - staticLength);
  const safeTitle = truncateWithEllipsis(titleRaw, titleBudget);
  return `${prefix}**${safeTitle}** (${duration})${by}`;
}

function joinLinesWithinLimit(lines: unknown[], maxChars: number = EMBED_FIELD_TEXT_LIMIT) {
  const normalized = Array.isArray(lines) ? lines.map((line) => String(line ?? '').trim()).filter(Boolean) : [];
  if (!normalized.length) return '-';

  const limit = Number.parseInt(String(maxChars), 10);
  const safeLimit = Number.isFinite(limit) && limit > 0 ? limit : EMBED_FIELD_TEXT_LIMIT;
  const kept = [];
  let used = 0;

  for (const line of normalized) {
    const separatorLength = kept.length > 0 ? 1 : 0;
    const nextLength = used + separatorLength + line.length;
    if (nextLength > safeLimit) break;
    kept.push(line);
    used = nextLength;
  }

  if (!kept.length) return truncateWithEllipsis(normalized[0], safeLimit);

  let hidden = normalized.length - kept.length;
  while (hidden > 0) {
    const suffix = `\n...and ${hidden} more`;
    const body = kept.join('\n');
    if (body.length + suffix.length <= safeLimit) {
      return `${body}${suffix}`;
    }
    if (kept.length <= 1) break;
    kept.pop();
    hidden = normalized.length - kept.length;
  }

  return kept.join('\n');
}

export function parseVoiceChannelArgument(args: string[] | null | undefined) {
  if (!args?.length) return { channelId: null, rest: args ?? [] };

  const first = args[0];
  const mention = String(first).match(VOICE_CHANNEL_PATTERN);
  if (mention) return { channelId: mention[1], rest: args.slice(1) };
  if (/^\d{10,}$/.test(String(first))) return { channelId: String(first), rest: args.slice(1) };
  return { channelId: null, rest: args };
}

export function trackLabel(track: TrackLike) {
  const by = track.requestedBy ? ` • requested by <@${track.requestedBy}>` : '';
  return `**${track.title}** (${track.duration})${by}`;
}

export function trackLabelWithLink(track: TrackLike) {
  const duration = String(track?.duration ?? 'Unknown');
  const title = compactTrackTitle(track?.title);
  const linkedTitle = isSafeMarkdownLinkTarget(track?.url)
    ? `[**${title}**](${String(track.url).trim()})`
    : `**${title}**`;
  const by = track?.requestedBy ? ` • requested by <@${track.requestedBy}>` : '';
  return `${linkedTitle} (${duration})${by}`;
}

export function parseDurationToSeconds(value: unknown) {
  if (!value || typeof value !== 'string') return null;
  if (value.toLowerCase() === 'unknown') return null;

  const parts = value.split(':').map((part) => Number.parseInt(part, 10));
  if (!parts.every((part) => Number.isFinite(part) && part >= 0)) return null;
  if (parts.length === 2) return (parts[0] ?? 0) * 60 + (parts[1] ?? 0);
  if (parts.length === 3) return ((parts[0] ?? 0) * 3600) + ((parts[1] ?? 0) * 60) + (parts[2] ?? 0);
  return null;
}

export function formatSeconds(seconds: number) {
  const safe = Math.max(0, Math.floor(seconds));
  const h = Math.floor(safe / 3600);
  const m = Math.floor((safe % 3600) / 60);
  const s = safe % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function formatUptimeCompact(totalSeconds: number) {
  const safe = Math.max(0, Math.floor(totalSeconds));
  const days = Math.floor(safe / 86_400);
  const hours = Math.floor((safe % 86_400) / 3_600);
  const minutes = Math.floor((safe % 3_600) / 60);
  const secs = safe % 60;

  const parts = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0 || parts.length) parts.push(`${hours}h`);
  if (minutes > 0 || parts.length) parts.push(`${minutes}m`);
  parts.push(`${secs}s`);
  return parts.join(' ');
}

export function buildProgressBar(
  positionSec: number,
  totalSec: number,
  size: number = 16,
  options: { isLive?: boolean } = { isLive: false }
) {
  const isLive = options?.isLive === true;
  if (!Number.isFinite(totalSec) || totalSec <= 0) {
    return `${formatSeconds(positionSec)} • ${isLive ? 'Live' : 'Unknown'}`;
  }

  const clamped = Math.max(0, Math.min(positionSec, totalSec));
  const progress = clamped / totalSec;
  const marker = Math.min(size - 1, Math.max(0, Math.floor(progress * (size - 1))));
  const chars = [];
  for (let i = 0; i < size; i += 1) chars.push(i === marker ? '●' : '━');
  return `${formatSeconds(clamped)} ${chars.join('')} ${formatSeconds(totalSec)}`;
}

function sumTrackDurationsSeconds(tracks: TrackLike[]) {
  let total = 0;
  for (const track of tracks) {
    const parsed = parseDurationToSeconds(track?.duration);
    if (parsed != null) total += parsed;
  }
  return total;
}

function buildSessionStatusFooter(session: SessionLike, pendingDurationSec: number, pendingCount: number) {
  return [
    `Loop ${String(session.player?.loopMode ?? 'off')}`,
    `Vol ${session.player?.volumePercent ?? 100}%`,
    `Dedupe ${session.settings?.dedupeEnabled ? 'on' : 'off'}`,
    `24/7 ${session.settings?.stayInVoiceEnabled ? 'on' : 'off'}`,
  ].join(' | ');
}

export function formatQueuePage(session: SessionLike, page: number) {
  const pending = session.player?.pendingTracks ?? [];
  const current = session.player?.displayTrack ?? session.player?.currentTrack;
  if (!current && pending.length === 0) return { description: 'Queue is empty.', fields: [] };

  const totalPages = Math.max(1, Math.ceil(pending.length / PENDING_PAGE_SIZE));
  const safePage = Math.max(1, Math.min(page, totalPages));
  const start = (safePage - 1) * PENDING_PAGE_SIZE;
  const pageItems = pending.slice(start, start + PENDING_PAGE_SIZE);
  const fields = [];

  if (current) {
    const durationSec = parseDurationToSeconds(current.duration);
    const progressSec = session.player?.getProgressSeconds?.() ?? 0;
    fields.push({
      name: 'Now Playing',
      value: joinLinesWithinLimit([
        trackLabelWithLink(current),
        buildProgressBar(progressSec, durationSec ?? Number.NaN, 12, { isLive: Boolean(current?.isLive) }),
      ], EMBED_FIELD_TEXT_LIMIT),
    });
  }

  if (pageItems.length) {
    fields.push({
      name: `Up Next (Page ${safePage}/${totalPages})`,
      value: joinLinesWithinLimit(
        pageItems.map((track, i) => formatTrackListLine(track, start + i + 1, TRACK_LINE_MAX_CHARS, { includeRequester: false })),
        EMBED_FIELD_TEXT_LIMIT
      ),
    });
  }

  const pendingDurationSec = sumTrackDurationsSeconds(pending);
  const footer = buildSessionStatusFooter(session, pendingDurationSec, pending.length);
  return {
    description: `Queue: **${pending.length}** tracks • Remaining: **${formatSeconds(pendingDurationSec)}**`,
    footer,
    fields,
  };
}

export function formatHistoryPage(session: SessionLike, page: number) {
  const history = session.player?.historyTracks ?? [];
  if (!history.length) return { description: 'No playback history yet.', fields: [] };

  const totalPages = Math.max(1, Math.ceil(history.length / HISTORY_PAGE_SIZE));
  const safePage = Math.max(1, Math.min(page, totalPages));
  const start = (safePage - 1) * HISTORY_PAGE_SIZE;
  const pageItems = history.slice().reverse().slice(start, start + HISTORY_PAGE_SIZE);

  return {
    description: `History page **${safePage}/${totalPages}** • Total tracks: **${history.length}**`,
    fields: [{
      name: 'Recently Played',
      value: joinLinesWithinLimit(
        pageItems.map((track, idx) => formatTrackListLine(track, start + idx + 1, TRACK_LINE_MAX_CHARS)),
        EMBED_FIELD_TEXT_LIMIT
      ),
    }],
  };
}

export function parseRequiredInteger(value: unknown, label: string) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) throw new ValidationError(`${label} must be an integer.`);
  return parsed;
}

export function parseOnOff(value: unknown, fallback: boolean | null = null) {
  if (value == null) return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['on', 'true', '1', 'yes', 'enable', 'enabled'].includes(normalized)) return true;
  if (['off', 'false', '0', 'no', 'disable', 'disabled'].includes(normalized)) return false;
  return fallback;
}

export function normalizeIndex(value: unknown, label: string) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new ValidationError(`${label} must be a positive integer.`);
  }
  return parsed;
}

export function createCommand<T extends CommandDefinition>(definition: T): Readonly<T> {
  return Object.freeze(definition);
}

type HelpPageContext = {
  prefix: string;
  registry: {
    list(): CommandDefinition[];
  };
};

export function buildHelpPages(ctx: HelpPageContext): MessagePayload[] {
  const lines = ctx.registry.list().map((cmd) => {
    const aliases = cmd.aliases?.length ? ` (aliases: ${cmd.aliases.join(', ')})` : '';
    return `\`${ctx.prefix}${cmd.usage}\` - ${cmd.description}${aliases}`;
  });

  const pageSize = 12;
  const pages: MessagePayload[] = [];
  const totalPages = Math.max(1, Math.ceil(lines.length / pageSize));

  for (let i = 0; i < totalPages; i += 1) {
    const slice = lines.slice(i * pageSize, (i + 1) * pageSize);
    pages.push({
      embeds: [
        buildEmbed({
          title: `Help ${i + 1}/${totalPages}`,
          description: slice.join('\n').slice(0, 3900),
          footer: `Support: ${SUPPORT_SERVER_URL}`,
        }),
      ],
      allowed_mentions: {
        parse: [],
        users: [],
        roles: [],
        replied_user: false,
      },
    });
  }

  return pages;
}




