const COLORS = {
  brand: 0xff2d78,
  info: 0xff2d78,
  success: 0xff2d78,
  warning: 0xff2d78,
  error: 0xff2d78,
};
const BOT_BRAND = 'Vinto';

function isoNow() {
  return new Date().toISOString();
}

function truncate(text, max) {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 3)}...`;
}

function buildReplyMessageReference(replyOptions) {
  const messageId = String(replyOptions?.replyToMessageId ?? '').trim();
  if (!messageId) return null;

  const reference = { message_id: messageId };
  const channelId = String(replyOptions?.replyToChannelId ?? '').trim();
  const guildId = String(replyOptions?.replyToGuildId ?? '').trim();
  if (channelId) reference.channel_id = channelId;
  if (guildId) reference.guild_id = guildId;
  return reference;
}

function mergeAllowedMentions(current) {
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
}) {
  const embed = {
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

function createMessagePayload(text, embed, useEmbeds, replyOptions = null) {
  const payload = (!useEmbeds || !embed)
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

export function makeResponder(rest, options = {}) {
  const useEmbeds = options.enableEmbeds !== false;

  return {
    async info(channelId, text, details = null, replyOptions = null) {
      const payload = createMessagePayload(
        useEmbeds ? null : text,
        buildEmbed({
          title: 'Info',
          description: text,
          color: COLORS.info,
          fields: details,
        }),
        useEmbeds,
        replyOptions
      );
      return rest.sendMessage(channelId, payload);
    },

    async success(channelId, text, details = null, replyOptions = null) {
      const payload = createMessagePayload(
        useEmbeds ? null : text,
        buildEmbed({
          title: 'Success',
          description: text,
          color: COLORS.success,
          fields: details,
        }),
        useEmbeds,
        replyOptions
      );
      return rest.sendMessage(channelId, payload);
    },

    async warning(channelId, text, details = null, replyOptions = null) {
      const payload = createMessagePayload(
        useEmbeds ? null : text,
        buildEmbed({
          title: 'Warning',
          description: text,
          color: COLORS.warning,
          fields: details,
        }),
        useEmbeds,
        replyOptions
      );
      return rest.sendMessage(channelId, payload);
    },

    async error(channelId, text, details = null, replyOptions = null) {
      const payload = createMessagePayload(
        useEmbeds ? null : text,
        buildEmbed({
          title: 'Error',
          description: text,
          color: COLORS.error,
          fields: details,
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
