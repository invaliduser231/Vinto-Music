import { buildEmbed, COLORS } from '../messageFormatter.js';

export function buildCommandMessageReference(ctx) {
  const messageId = String(ctx?.message?.id ?? ctx?.message?.message_id ?? '').trim();
  if (!messageId) return null;

  const reference = { message_id: messageId };
  const channelId = String(ctx?.channelId ?? '').trim();
  const guildId = String(ctx?.guildId ?? '').trim();
  if (channelId) reference.channel_id = channelId;
  if (guildId) reference.guild_id = guildId;
  return reference;
}

export function withCommandReplyReference(ctx, payload) {
  const reference = buildCommandMessageReference(ctx);
  if (!reference) return payload;

  return {
    ...(payload ?? {}),
    message_reference: reference,
    allowed_mentions: {
      parse: [],
      users: [],
      roles: [],
      ...(payload?.allowed_mentions ?? {}),
      replied_user: false,
    },
  };
}

export function buildInfoPayload(ctx, title, description, fields = [], options = {}) {
  const safeOptions = options && typeof options === 'object' ? options : {};
  if (ctx.config?.enableEmbeds === false) {
    const lines = [];
    if (title) lines.push(title);
    if (description) lines.push(description);
    for (const field of fields ?? []) {
      lines.push(`${field.name}: ${field.value}`);
    }
    return { content: lines.join('\n').slice(0, 1900) };
  }

  return {
    embeds: [
      buildEmbed({
        title,
        description,
        fields,
        thumbnailUrl: safeOptions.thumbnailUrl ?? null,
        imageUrl: safeOptions.imageUrl ?? null,
      }),
    ],
    allowed_mentions: {
      parse: [],
      users: [],
      roles: [],
      replied_user: false,
    },
  };
}

export function buildSingleFieldInfoPayload(ctx, title, description, fieldName, fieldValue) {
  return buildInfoPayload(ctx, title, description, [{ name: fieldName, value: fieldValue }]);
}

export function buildStatusPayload(ctx, kind, description, fields = [], options = {}) {
  const safeOptions = options && typeof options === 'object' ? options : {};
  const normalizedKind = String(kind ?? 'info').trim().toLowerCase();
  const titleMap = {
    info: 'Info',
    success: 'Success',
    warning: 'Warning',
    error: 'Error',
    working: 'Working',
  };
  const colorMap = {
    info: COLORS.info,
    success: COLORS.success,
    warning: COLORS.warning,
    error: COLORS.error,
    working: COLORS.brand,
  };

  if (ctx.config?.enableEmbeds === false) {
    const lines = [description];
    for (const field of fields ?? []) {
      lines.push(`${field.name}: ${field.value}`);
    }
    return { content: lines.filter(Boolean).join('\n').slice(0, 1900) };
  }

  return {
    embeds: [
      buildEmbed({
        title: titleMap[normalizedKind] ?? titleMap.info,
        description,
        color: colorMap[normalizedKind] ?? colorMap.info,
        fields,
        thumbnailUrl: safeOptions.thumbnailUrl ?? null,
        imageUrl: safeOptions.imageUrl ?? null,
      }),
    ],
    allowed_mentions: {
      parse: [],
      users: [],
      roles: [],
      replied_user: false,
    },
  };
}

export async function createProgressReporter(ctx, initialText, fields = null, options = null, config = {}) {
  const { replyReference = false } = config ?? {};
  const canEdit =
    Boolean(ctx.channelId)
    && typeof ctx.rest?.sendMessage === 'function'
    && typeof ctx.rest?.editMessage === 'function';

  if (!canEdit) {
    await ctx.reply.info(initialText, fields, options);
    return {
      messageId: null,
      replace: async () => null,
      success: (text, nextFields = null, nextOptions = null) => ctx.reply.success(text, nextFields, nextOptions),
      warning: (text, nextFields = null, nextOptions = null) => ctx.reply.warning(text, nextFields, nextOptions),
      info: (text, nextFields = null, nextOptions = null) => ctx.reply.info(text, nextFields, nextOptions),
      error: (text, nextFields = null, nextOptions = null) => ctx.reply.error(text, nextFields, nextOptions),
    };
  }

  const initialPayload = buildStatusPayload(ctx, 'working', initialText, fields, options);
  const sent = await ctx.rest.sendMessage(
    ctx.channelId,
    replyReference ? withCommandReplyReference(ctx, initialPayload) : initialPayload
  ).catch(() => null);
  const messageId = sent?.id ?? sent?.message?.id ?? null;

  const editOrReply = async (kind, text, nextFields = null, nextOptions = null) => {
    if (messageId) {
      try {
        await ctx.rest.editMessage(
          ctx.channelId,
          messageId,
          buildStatusPayload(ctx, kind, text, nextFields, nextOptions)
        );
        return;
      } catch {
        // fall through to normal reply
      }
    }

    if (kind === 'success') return ctx.reply.success(text, nextFields, nextOptions);
    if (kind === 'warning') return ctx.reply.warning(text, nextFields, nextOptions);
    if (kind === 'error') return ctx.reply.error(text, nextFields, nextOptions);
    return ctx.reply.info(text, nextFields, nextOptions);
  };

  return {
    messageId,
    replace: async (payload) => {
      if (!messageId) return null;
      return ctx.rest.editMessage(ctx.channelId, messageId, payload);
    },
    success: (text, nextFields = null, nextOptions = null) => editOrReply('success', text, nextFields, nextOptions),
    warning: (text, nextFields = null, nextOptions = null) => editOrReply('warning', text, nextFields, nextOptions),
    info: (text, nextFields = null, nextOptions = null) => editOrReply('info', text, nextFields, nextOptions),
    error: (text, nextFields = null, nextOptions = null) => editOrReply('error', text, nextFields, nextOptions),
  };
}
