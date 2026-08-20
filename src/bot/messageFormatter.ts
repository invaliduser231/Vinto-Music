import type {
  AllowedMentions,
  EmbedAuthor,
  EmbedField,
  EmbedPayload,
  MessagePayload,
  MessageReference,
  ReplyOptions,
  ResponderEmbedOptions,
  RestLike,
} from '../types/core.ts';

const COLORS = {
  brand: 0xff2d78,
  info: 0xff2d78,
  success: 0x2dd4a7,
  warning: 0xffb020,
  error: 0xff4d5e,
};

const SOURCE_COLORS: Record<string, number> = {
  deezer: 0xa238ff,
  spotify: 0x1db954,
  youtube: 0xff0033,
  'youtube-search': 0xff0033,
  soundcloud: 0xff5500,
  applemusic: 0xfa243c,
  tidal: 0x00cfff,
  bandcamp: 0x1da0c3,
  vkmusic: 0x0077ff,
  jiosaavn: 0x2bc5b4,
  'radio-stream': 0xff2d78,
};

const SOURCE_LABELS: Record<string, string> = {
  deezer: 'Deezer',
  spotify: 'Spotify',
  youtube: 'YouTube',
  'youtube-search': 'YouTube',
  soundcloud: 'SoundCloud',
  applemusic: 'Apple Music',
  tidal: 'Tidal',
  bandcamp: 'Bandcamp',
  vkmusic: 'VK Music',
  jiosaavn: 'JioSaavn',
  'radio-stream': 'Radio',
};

const BOT_BRAND = 'Vinto';

export function sourceColor(source: string | null | undefined, fallback: number = COLORS.brand): number {
  const key = String(source ?? '').trim().toLowerCase();
  return SOURCE_COLORS[key] ?? fallback;
}

export function sourceLabel(source: string | null | undefined): string {
  const key = String(source ?? '').trim().toLowerCase();
  if (SOURCE_LABELS[key]) return SOURCE_LABELS[key];
  if (!key) return 'Unknown';
  return key.charAt(0).toUpperCase() + key.slice(1);
}

interface BuildEmbedOptions {
  title?: string | null;
  description?: string | null;
  color?: number;
  fields?: EmbedField[] | null;
  thumbnailUrl?: string | null;
  imageUrl?: string | null;
  footer?: string | null;
  url?: string | null;
  author?: EmbedAuthor | null;
  footerIconUrl?: string | null;
}

interface ResponderOptions {
  enableEmbeds?: boolean;
}

export function renderMinimalEmbedContent(
  description: string | null | undefined,
  fields: EmbedField[] | null | undefined,
  footer: string | null | undefined = null,
): string {
  const lines: string[] = [];
  const safeDescription = String(description ?? '').trim();
  if (safeDescription) lines.push(safeDescription);

  for (const field of Array.isArray(fields) ? fields : []) {
    const name = String(field.name ?? '-').trim() || '-';
    const value = String(field.value ?? '-').trim() || '-';
    if (value.includes('\n')) {
      lines.push(`**${name}**`);
      lines.push(value);
      continue;
    }
    lines.push(`**${name}**: ${value}`);
  }

  const safeFooter = String(footer ?? '').trim();
  if (safeFooter) lines.push(safeFooter);

  return lines.join('\n').slice(0, 1900);
}

type ResponderMethod = (
  channelId: string,
  text: string,
  details?: EmbedField[] | null,
  replyOptions?: ReplyOptions | null,
  embedOptions?: ResponderEmbedOptions | null,
) => Promise<unknown>;

interface Responder {
  info: ResponderMethod;
  success: ResponderMethod;
  warning: ResponderMethod;
  error: ResponderMethod;
  plain: (channelId: string, text: string, replyOptions?: ReplyOptions | null) => Promise<unknown>;
}

function isoNow(): string {
  return new Date().toISOString();
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 3)}...`;
}

function buildReplyMessageReference(replyOptions: ReplyOptions | null | undefined): MessageReference | null {
  const messageId = String(replyOptions?.replyToMessageId ?? '').trim();
  if (!messageId) return null;

  const reference: MessageReference = { message_id: messageId };
  const channelId = String(replyOptions?.replyToChannelId ?? '').trim();
  const guildId = String(replyOptions?.replyToGuildId ?? '').trim();

  if (channelId) reference.channel_id = channelId;
  if (guildId) reference.guild_id = guildId;
  return reference;
}

function mergeAllowedMentions(current: Partial<AllowedMentions> | null | undefined): AllowedMentions {
  return {
    parse: [],
    users: [],
    roles: [],
    ...(current && typeof current === 'object' ? current : {}),
    replied_user: false,
  };
}

export function buildEmbed({
  title,
  description,
  color = COLORS.brand,
  fields,
  thumbnailUrl,
  imageUrl,
  footer,
  url,
  author,
  footerIconUrl,
}: BuildEmbedOptions): EmbedPayload {
  const embed: EmbedPayload = {
    color,
    timestamp: isoNow(),
  };

  if (title) embed.title = truncate(String(title), 256);
  if (description) embed.description = truncate(String(description), 4096);

  const safeUrl = String(url ?? '').trim();
  if (/^https?:\/\//i.test(safeUrl)) embed.url = truncate(safeUrl, 2048);

  const authorName = String(author?.name ?? '').trim();
  if (authorName) {
    const authorPayload: EmbedAuthor = { name: truncate(authorName, 256) };
    const authorUrl = String(author?.url ?? '').trim();
    const authorIcon = String(author?.icon_url ?? '').trim();
    if (/^https?:\/\//i.test(authorUrl)) authorPayload.url = truncate(authorUrl, 2048);
    if (/^https?:\/\//i.test(authorIcon)) authorPayload.icon_url = truncate(authorIcon, 2048);
    embed.author = authorPayload;
  }

  if (Array.isArray(fields) && fields.length) {
    embed.fields = fields.slice(0, 25).map((field) => ({
      name: truncate(String(field.name ?? '-'), 256),
      value: truncate(String(field.value ?? '-'), 1024),
      inline: Boolean(field.inline),
    }));
  }

  const safeThumbnailUrl = String(thumbnailUrl ?? '').trim();
  if (/^https?:\/\//i.test(safeThumbnailUrl)) {
    embed.thumbnail = { url: truncate(safeThumbnailUrl, 2048) };
  }

  const safeImageUrl = String(imageUrl ?? '').trim();
  if (/^https?:\/\//i.test(safeImageUrl)) {
    embed.image = { url: truncate(safeImageUrl, 2048) };
  }

  const footerText = footer ? `${BOT_BRAND} | ${String(footer)}` : BOT_BRAND;
  embed.footer = { text: truncate(String(footerText), 2048) };

  const safeFooterIcon = String(footerIconUrl ?? '').trim();
  if (/^https?:\/\//i.test(safeFooterIcon)) {
    embed.footer.icon_url = truncate(safeFooterIcon, 2048);
  }

  return embed;
}

function createMessagePayload(
  text: string | null,
  embed: EmbedPayload | null,
  useEmbeds: boolean,
  minimalMode = false,
  replyOptions: ReplyOptions | null = null,
): MessagePayload {
  const payload: MessagePayload = (!useEmbeds || !embed || minimalMode)
    ? {
      content: minimalMode && embed
        ? renderMinimalEmbedContent(embed.description, embed.fields, embed.footer?.text ?? null)
        : text,
    }
    : {
      content: text || undefined,
      embeds: [embed],
      allowed_mentions: {
        parse: [],
        users: [],
        roles: [],
        replied_user: false,
      },
    };

  const messageReference = buildReplyMessageReference(replyOptions);
  if (messageReference) {
    payload.message_reference = messageReference;
    payload.allowed_mentions = mergeAllowedMentions(payload.allowed_mentions);
  }

  return payload;
}

export function makeResponder(rest: RestLike, options: ResponderOptions = {}): Responder {
  const useEmbeds = options.enableEmbeds !== false;

  function buildResponderMethod(title: string, color: number): ResponderMethod {
    return async (channelId, text, details = null, replyOptions = null, embedOptions = null) => {
      const minimalMode = embedOptions?.minimalMode === true;
      const payload = createMessagePayload(
        useEmbeds ? null : text,
        buildEmbed({
          title,
          description: text,
          color: embedOptions?.color ?? color,
          fields: details,
          thumbnailUrl: embedOptions?.thumbnailUrl ?? null,
          imageUrl: embedOptions?.imageUrl ?? null,
          url: embedOptions?.url ?? null,
          author: embedOptions?.author ?? null,
          footer: embedOptions?.footer ?? null,
          footerIconUrl: embedOptions?.footerIconUrl ?? null,
        }),
        useEmbeds,
        minimalMode,
        replyOptions
      );
      return rest.sendMessage(channelId, payload);
    };
  }

  return {
    info: buildResponderMethod('Info', COLORS.info),
    success: buildResponderMethod('Success', COLORS.success),
    warning: buildResponderMethod('Warning', COLORS.warning),
    error: buildResponderMethod('Error', COLORS.error),
    async plain(channelId, text, replyOptions = null) {
      const payload = createMessagePayload(text, null, false, false, replyOptions);
      return rest.sendMessage(channelId, payload);
    },
  };
}

export { COLORS };




