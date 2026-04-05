import { parseCommand } from '../utils/commandParser.ts';
import type { AllowedMentions, MessageLike, MessagePayload, ReplyOptions, TrackLike } from '../types/core.ts';

interface EmojiPayload {
  emoji?: { name?: string | null } | null;
  emoji_name?: string | null;
  reaction?: string | null;
}

const SEARCH_PICK_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
};

export function normalizeEmojiName(payload: EmojiPayload | null | undefined): string {
  return String(payload?.emoji?.name ?? payload?.emoji_name ?? payload?.reaction ?? '')
    .trim()
    .toLowerCase()
    .replace(/\uFE0F/g, '');
}

export function isSkipEmoji(emoji: string): boolean {
  return ['\u2705', '\u23ED', 'skip', 'next_track'].includes(emoji);
}

export function isPauseEmoji(emoji: string): boolean {
  return ['\u23F8', 'pause'].includes(emoji);
}

export function isResumeEmoji(emoji: string): boolean {
  return ['\u25B6', 'resume', 'play'].includes(emoji);
}

export function isFavoriteEmoji(emoji: string): boolean {
  return ['\u2764', '\u2665', 'heart', 'red_heart', 'favorite', 'like'].includes(emoji);
}

export function isLeftEmoji(emoji: string): boolean {
  return ['\u2B05', 'left', 'arrow_left'].includes(emoji);
}

export function isRightEmoji(emoji: string): boolean {
  return ['\u27A1', 'right', 'arrow_right'].includes(emoji);
}

export const SEARCH_PICK_EMOJIS = [
  '1\uFE0F\u20E3',
  '2\uFE0F\u20E3',
  '3\uFE0F\u20E3',
  '4\uFE0F\u20E3',
  '5\uFE0F\u20E3',
  '6\uFE0F\u20E3',
  '7\uFE0F\u20E3',
  '8\uFE0F\u20E3',
  '9\uFE0F\u20E3',
  '\uD83D\uDD1F',
];

export function parseSearchPickIndex(emoji: string | null | undefined): number | null {
  if (!emoji) return null;
  if (emoji === '\uD83D\uDD1F' || emoji === 'keycap_ten' || emoji === 'ten') return 10;

  const compact = String(emoji).replace(/\u20E3/g, '').replace(/[^\d]/g, '');
  const numeric = Number.parseInt(compact, 10);
  if (Number.isFinite(numeric) && numeric >= 1 && numeric <= 9) return numeric;

  return SEARCH_PICK_WORDS[String(emoji).toLowerCase()] ?? null;
}

export const SEND_PERMISSION_PREFLIGHT_BYPASS = new Set(['ping', 'help']);

export function parseMentionCommand(content: string, botUserId: string | null | undefined) {
  const id = String(botUserId ?? '').trim();
  if (!content || !id) return null;

  for (const prefix of [`<@${id}>`, `<@!${id}>`]) {
    const parsed = parseCommand(content, prefix);
    if (parsed) return parsed;
  }
  return null;
}

export function isDirectBotMention(content: string | null | undefined, botUserId: string | null | undefined): boolean {
  const id = String(botUserId ?? '').trim();
  const text = String(content ?? '').trim();
  if (!id || !text) return false;
  return text === `<@${id}>` || text === `<@!${id}>`;
}

export function summarizeTrack(track: TrackLike | null | undefined): string {
  if (!track) return 'Unknown track';
  const by = track.requestedBy ? ` by <@${track.requestedBy}>` : '';
  return `${track.title ?? 'Unknown title'} (${track.duration ?? 'Unknown'})${by}`;
}

export function buildCommandReplyOptions(message: MessageLike | null | undefined): ReplyOptions | null {
  const messageId = String(message?.id ?? message?.message_id ?? '').trim();
  if (!messageId) return null;

  const options: ReplyOptions = { replyToMessageId: messageId };
  const channelId = String(message?.channel_id ?? message?.channelId ?? '').trim();
  const guildId = String(message?.guild_id ?? message?.guildId ?? '').trim();

  if (channelId) options.replyToChannelId = channelId;
  if (guildId) options.replyToGuildId = guildId;
  return options;
}

function mergeAllowedMentionsForReply(current: Partial<AllowedMentions> | null | undefined): AllowedMentions {
  return {
    parse: [],
    users: [],
    roles: [],
    ...(current && typeof current === 'object' ? current : {}),
    replied_user: false,
  };
}

export function applyReplyOptionsToPayload(
  payload: MessagePayload | null | undefined,
  replyOptions: ReplyOptions | null | undefined,
): MessagePayload {
  const messageId = String(replyOptions?.replyToMessageId ?? '').trim();
  if (!messageId) return payload ?? {};

  const next: MessagePayload = {
    ...(payload ?? {}),
    message_reference: { message_id: messageId },
  };

  const channelId = String(replyOptions?.replyToChannelId ?? '').trim();
  const guildId = String(replyOptions?.replyToGuildId ?? '').trim();
  if (channelId && next.message_reference) next.message_reference.channel_id = channelId;
  if (guildId && next.message_reference) next.message_reference.guild_id = guildId;
  next.allowed_mentions = mergeAllowedMentionsForReply(next.allowed_mentions);
  return next;
}




