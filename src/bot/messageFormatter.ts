import type {
  AllowedMentions,
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
  success: 0xff2d78,
  warning: 0xff2d78,
  error: 0xff2d78,
};
const BOT_BRAND = 'Vinto';

interface BuildEmbedOptions {
  title?: string | null;
  description?: string | null;
  color?: number;
  fields?: EmbedField[] | null;
  thumbnailUrl?: string | null;
  imageUrl?: string | null;
  footer?: string | null;
}

interface ResponderOptions {
  enableEmbeds?: boolean;
}

interface Responder {
  info: (
    channelId: string,
    text: string,
    details?: EmbedField[] | null,
    replyOptions?: ReplyOptions | null,
    embedOptions?: ResponderEmbedOptions | null,
  ) => Promise<unknown>;
  success: (
    channelId: string,
    text: string,
    details?: EmbedField[] | null,
    replyOptions?: ReplyOptions | null,
    embedOptions?: ResponderEmbedOptions | null,
  ) => Promise<unknown>;
  warning: (
    channelId: string,
    text: string,
    details?: EmbedField[] | null,
    replyOptions?: ReplyOptions | null,
    embedOptions?: ResponderEmbedOptions | null,
  ) => Promise<unknown>;
  error: (
    channelId: string,
    text: string,
    details?: EmbedField[] | null,
    replyOptions?: ReplyOptions | null,
    embedOptions?: ResponderEmbedOptions | null,
  ) => Promise<unknown>;
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
}: BuildEmbedOptions): EmbedPayload {
  const embed: EmbedPayload = {
    color,
    timestamp: isoNow(),
  };

  if (title) embed.title = truncate(String(title), 256);
  if (description) embed.description = truncate(String(description), 4096);

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

  return embed;
}

function createMessagePayload(
  text: string | null,
  embed: EmbedPayload | null,
  useEmbeds: boolean,
  replyOptions: ReplyOptions | null = null,
): MessagePayload {
  const payload: MessagePayload = (!useEmbeds || !embed)
    ? { content: text }
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

  return {
    async info(channelId, text, details = null, replyOptions = null, embedOptions = null) {
      const payload = createMessagePayload(
        useEmbeds ? null : text,
        buildEmbed({
          title: 'Info',
          description: text,
          color: COLORS.info,
          fields: details,
          thumbnailUrl: embedOptions?.thumbnailUrl ?? null,
          imageUrl: embedOptions?.imageUrl ?? null,
        }),
        useEmbeds,
        replyOptions
      );
      return rest.sendMessage(channelId, payload);
    },

    async success(channelId, text, details = null, replyOptions = null, embedOptions = null) {
      const payload = createMessagePayload(
        useEmbeds ? null : text,
        buildEmbed({
          title: 'Success',
          description: text,
          color: COLORS.success,
          fields: details,
          thumbnailUrl: embedOptions?.thumbnailUrl ?? null,
          imageUrl: embedOptions?.imageUrl ?? null,
        }),
        useEmbeds,
        replyOptions
      );
      return rest.sendMessage(channelId, payload);
    },

    async warning(channelId, text, details = null, replyOptions = null, embedOptions = null) {
      const payload = createMessagePayload(
        useEmbeds ? null : text,
        buildEmbed({
          title: 'Warning',
          description: text,
          color: COLORS.warning,
          fields: details,
          thumbnailUrl: embedOptions?.thumbnailUrl ?? null,
          imageUrl: embedOptions?.imageUrl ?? null,
        }),
        useEmbeds,
        replyOptions
      );
      return rest.sendMessage(channelId, payload);
    },

    async error(channelId, text, details = null, replyOptions = null, embedOptions = null) {
      const payload = createMessagePayload(
        useEmbeds ? null : text,
        buildEmbed({
          title: 'Error',
          description: text,
          color: COLORS.error,
          fields: details,
          thumbnailUrl: embedOptions?.thumbnailUrl ?? null,
          imageUrl: embedOptions?.imageUrl ?? null,
        }),
        useEmbeds,
        replyOptions
      );
      return rest.sendMessage(channelId, payload);
    },

    async plain(channelId, text, replyOptions = null) {
      const payload = createMessagePayload(text, null, false, replyOptions);
      return rest.sendMessage(channelId, payload);
    },
  };
}

export { COLORS };




