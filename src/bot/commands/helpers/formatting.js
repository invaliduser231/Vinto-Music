import { ValidationError } from '../../../core/errors.js';
import { buildEmbed } from '../../messageFormatter.js';
import {
  EMBED_FIELD_TEXT_LIMIT,
  HISTORY_PAGE_SIZE,
  PENDING_PAGE_SIZE,
  SUPPORT_SERVER_URL,
  TRACK_LINE_MAX_CHARS,
  VOICE_CHANNEL_PATTERN,
} from './constants.js';

function truncateWithEllipsis(text, maxChars) {
  const value = String(text ?? '');
  const limit = Number.parseInt(String(maxChars), 10);
  if (!Number.isFinite(limit) || limit <= 0) return '';
  if (value.length <= limit) return value;
  if (limit <= 3) return '.'.repeat(limit);
  return `${value.slice(0, limit - 3)}...`;
}

function formatTrackListLine(track, index = null, maxChars = TRACK_LINE_MAX_CHARS) {
  const prefix = Number.isFinite(index) ? `${index}. ` : '';
  const by = track?.requestedBy ? ` • requested by <@${track.requestedBy}>` : '';
  const duration = String(track?.duration ?? 'Unknown');
  const titleRaw = String(track?.title ?? 'Unknown title').trim() || 'Unknown title';
  const staticLength = prefix.length + by.length + duration.length + 7;
  const titleBudget = Math.max(16, Number.parseInt(String(maxChars), 10) - staticLength);
  const safeTitle = truncateWithEllipsis(titleRaw, titleBudget);
  return `${prefix}**${safeTitle}** (${duration})${by}`;
}

function joinLinesWithinLimit(lines, maxChars = EMBED_FIELD_TEXT_LIMIT) {
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

export function parseVoiceChannelArgument(args) {
  if (!args?.length) return { channelId: null, rest: args ?? [] };

  const first = args[0];
  const mention = String(first).match(VOICE_CHANNEL_PATTERN);
  if (mention) return { channelId: mention[1], rest: args.slice(1) };
  if (/^\d{10,}$/.test(String(first))) return { channelId: String(first), rest: args.slice(1) };
  return { channelId: null, rest: args };
}

export function trackLabel(track) {
  const by = track.requestedBy ? ` • requested by <@${track.requestedBy}>` : '';
  return `**${track.title}** (${track.duration})${by}`;
}

export function parseDurationToSeconds(value) {
  if (!value || typeof value !== 'string') return null;
  if (value.toLowerCase() === 'unknown') return null;

  const parts = value.split(':').map((part) => Number.parseInt(part, 10));
  if (!parts.every((part) => Number.isFinite(part) && part >= 0)) return null;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return null;
}

export function formatSeconds(seconds) {
  const safe = Math.max(0, Math.floor(seconds));
  const h = Math.floor(safe / 3600);
  const m = Math.floor((safe % 3600) / 60);
  const s = safe % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function formatUptimeCompact(totalSeconds) {
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

export function buildProgressBar(positionSec, totalSec, size = 16) {
  if (!Number.isFinite(totalSec) || totalSec <= 0) {
    return `${formatSeconds(positionSec)} • Live`;
  }

  const clamped = Math.max(0, Math.min(positionSec, totalSec));
  const progress = clamped / totalSec;
  const marker = Math.min(size - 1, Math.max(0, Math.floor(progress * (size - 1))));
  const chars = [];
  for (let i = 0; i < size; i += 1) chars.push(i === marker ? '●' : '━');
  return `${formatSeconds(clamped)} ${chars.join('')} ${formatSeconds(totalSec)}`;
}

function sumTrackDurationsSeconds(tracks) {
  let total = 0;
  for (const track of tracks) {
    const parsed = parseDurationToSeconds(track?.duration);
    if (parsed != null) total += parsed;
  }
  return total;
}

export function formatQueuePage(session, page) {
  const pending = session.player.pendingTracks;
  const current = session.player.displayTrack ?? session.player.currentTrack;
  if (!current && pending.length === 0) return { description: 'Queue is empty.', fields: [] };

  const totalPages = Math.max(1, Math.ceil(pending.length / PENDING_PAGE_SIZE));
  const safePage = Math.max(1, Math.min(page, totalPages));
  const start = (safePage - 1) * PENDING_PAGE_SIZE;
  const pageItems = pending.slice(start, start + PENDING_PAGE_SIZE);
  const fields = [];

  if (current) {
    const durationSec = parseDurationToSeconds(current.duration);
    const progressSec = session.player.getProgressSeconds();
    fields.push({
      name: 'Now Playing',
      value: joinLinesWithinLimit([
        formatTrackListLine(current, null, 760),
        buildProgressBar(progressSec, durationSec ?? Number.NaN),
      ], EMBED_FIELD_TEXT_LIMIT),
    });
  }

  if (pageItems.length) {
    fields.push({
      name: `Up Next (Page ${safePage}/${totalPages})`,
      value: joinLinesWithinLimit(
        pageItems.map((track, i) => formatTrackListLine(track, start + i + 1, TRACK_LINE_MAX_CHARS)),
        EMBED_FIELD_TEXT_LIMIT
      ),
    });
  }

  const pendingDurationSec = sumTrackDurationsSeconds(pending);
  return {
    description: `Loop: **${session.player.loopMode}** • Volume: **${session.player.volumePercent}%** • Pending duration: **${formatSeconds(pendingDurationSec)}** • Dedupe: **${session.settings.dedupeEnabled ? 'on' : 'off'}** • 24/7: **${session.settings.stayInVoiceEnabled ? 'on' : 'off'}**`,
    fields,
  };
}

export function formatHistoryPage(session, page) {
  const history = session.player.historyTracks;
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

export function parseRequiredInteger(value, label) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) throw new ValidationError(`${label} must be an integer.`);
  return parsed;
}

export function parseOnOff(value, fallback = null) {
  if (value == null) return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['on', 'true', '1', 'yes', 'enable', 'enabled'].includes(normalized)) return true;
  if (['off', 'false', '0', 'no', 'disable', 'disabled'].includes(normalized)) return false;
  return fallback;
}

export function normalizeIndex(value, label) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new ValidationError(`${label} must be a positive integer.`);
  }
  return parsed;
}

export function createCommand(definition) {
  return Object.freeze(definition);
}

export function buildHelpPages(ctx) {
  const lines = ctx.registry.list().map((cmd) => {
    const aliases = cmd.aliases?.length ? ` (aliases: ${cmd.aliases.join(', ')})` : '';
    return `\`${ctx.prefix}${cmd.usage}\` - ${cmd.description}${aliases}`;
  });

  const pageSize = 12;
  const pages = [];
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
