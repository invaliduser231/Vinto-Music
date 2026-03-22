import type { EmbedField, MessagePayload, MessageReference } from '../../types/core.ts';
import { buildEmbed, COLORS, renderMinimalEmbedContent } from '../messageFormatter.ts';

interface CommandContextLike {
  message?: {
    id?: string;
    message_id?: string;
  } | null;
  channelId?: string | null;
  guildId?: string | null;
  config?: {
    enableEmbeds?: boolean;
    minimalMode?: boolean;
  } | null;
  rest?: {
    sendMessage?: (channelId: string, payload: MessagePayload) => Promise<unknown>;
    editMessage?: (channelId: string, messageId: string, payload: MessagePayload) => Promise<unknown>;
  } | null;
  reply?: {
    success: (text: string, fields?: EmbedField[] | null, options?: unknown) => Promise<unknown>;
    warning: (text: string, fields?: EmbedField[] | null, options?: unknown) => Promise<unknown>;
    info: (text: string, fields?: EmbedField[] | null, options?: unknown) => Promise<unknown>;
    error: (text: string, fields?: EmbedField[] | null, options?: unknown) => Promise<unknown>;
  } | null;
}

interface SentMessageLike {
  id?: string;
  message?: {
    id?: string;
  } | null;
}

interface StatusPayloadOptions {
  thumbnailUrl?: string | null;
  imageUrl?: string | null;
  footer?: string | null;
}

interface ProgressReporterConfig {
  replyReference?: boolean;
}

type StatusKind = 'info' | 'success' | 'warning' | 'error' | 'working';

export function buildCommandMessageReference(ctx: CommandContextLike): MessageReference | null {
  const messageId = String(ctx?.message?.id ?? ctx?.message?.message_id ?? '').trim();
  if (!messageId) return null;

  const reference: MessageReference = { message_id: messageId };
  const channelId = String(ctx?.channelId ?? '').trim();
  const guildId = String(ctx?.guildId ?? '').trim();

  if (channelId) reference.channel_id = channelId;
  if (guildId) reference.guild_id = guildId;
  return reference;
}

export function withCommandReplyReference(ctx: CommandContextLike, payload: MessagePayload): MessagePayload {
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

export function buildInfoPayload(
  ctx: CommandContextLike,
  title: string,
  description: string,
  fields: EmbedField[] = [],
  options: StatusPayloadOptions = {},
): MessagePayload {
  const safeOptions = options && typeof options === 'object' ? options : {};
  if (ctx.config?.enableEmbeds === false) {
    const lines: string[] = [];
    if (title) lines.push(title);
    if (description) lines.push(description);
    for (const field of fields ?? []) {
      const value = String(field.value ?? '').trim();
      if (value.includes('\n')) {
        lines.push(String(field.name));
        lines.push(value);
      } else {
        lines.push(`${field.name}: ${field.value}`);
      }
    }

    if (safeOptions.footer) {
      lines.push(String(safeOptions.footer));
    }
    return { content: lines.join('\n').slice(0, 1900) };
  }

  if (ctx.config?.minimalMode === true) {
    return { content: renderMinimalEmbedContent(description, fields, safeOptions.footer ?? null) };
  }

  return {
    embeds: [
      buildEmbed({
        title,
        description,
        fields,
        thumbnailUrl: safeOptions.thumbnailUrl ?? null,
        imageUrl: safeOptions.imageUrl ?? null,
        footer: safeOptions.footer ?? null,
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

export function buildSingleFieldInfoPayload(
  ctx: CommandContextLike,
  title: string,
  description: string,
  fieldName: string,
  fieldValue: string,
): MessagePayload {
  return buildInfoPayload(ctx, title, description, [{ name: fieldName, value: fieldValue }]);
}

export function buildStatusPayload(
  ctx: CommandContextLike,
  kind: string,
  description: string,
  fields: EmbedField[] = [],
  options: StatusPayloadOptions = {},
): MessagePayload {
  const safeOptions = options && typeof options === 'object' ? options : {};
  const normalizedKind = String(kind ?? 'info').trim().toLowerCase();
  const titleMap: Record<StatusKind, string> = {
    info: 'Info',
    success: 'Success',
    warning: 'Warning',
    error: 'Error',
    working: 'Working',
  };
  const colorMap: Record<StatusKind, number> = {
    info: COLORS.info,
    success: COLORS.success,
    warning: COLORS.warning,
    error: COLORS.error,
    working: COLORS.brand,
  };

  if (ctx.config?.enableEmbeds === false) {
    const lines = [description];
    for (const field of fields ?? []) {
      const value = String(field.value ?? '').trim();
      if (value.includes('\n')) {
        lines.push(String(field.name));
        lines.push(value);
      } else {
        lines.push(`${field.name}: ${field.value}`);
      }
    }
    if (safeOptions.footer) {
      lines.push(String(safeOptions.footer));
    }
    return { content: lines.filter(Boolean).join('\n').slice(0, 1900) };
  }

  if (ctx.config?.minimalMode === true) {
    return { content: renderMinimalEmbedContent(description, fields, safeOptions.footer ?? null) };
  }

  return {
    embeds: [
      buildEmbed({
        title: titleMap[normalizedKind as StatusKind] ?? titleMap.info,
        description,
        color: colorMap[normalizedKind as StatusKind] ?? colorMap.info,
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

export async function createProgressReporter(
  ctx: CommandContextLike & { channelId?: string | null },
  initialText: string,
  fields: EmbedField[] | null = null,
  options: StatusPayloadOptions | null = null,
  config: ProgressReporterConfig = {},
) {
  const { replyReference = false } = config ?? {};
  const reply = ctx.reply!;
  const rest = ctx.rest!;
  const safeChannelId = String(ctx.channelId ?? '').trim();
  const canEdit =
    Boolean(safeChannelId)
    && typeof ctx.rest?.sendMessage === 'function'
    && typeof ctx.rest?.editMessage === 'function';

  if (!canEdit) {
    await reply.info(initialText, fields ?? undefined, options ?? undefined);
    return {
      messageId: null,
      replace: async () => null,
      success: (text: string, nextFields: EmbedField[] | null = null, nextOptions: StatusPayloadOptions | null = null) => reply.success(text, nextFields ?? undefined, nextOptions ?? undefined),
      warning: (text: string, nextFields: EmbedField[] | null = null, nextOptions: StatusPayloadOptions | null = null) => reply.warning(text, nextFields ?? undefined, nextOptions ?? undefined),
      info: (text: string, nextFields: EmbedField[] | null = null, nextOptions: StatusPayloadOptions | null = null) => reply.info(text, nextFields ?? undefined, nextOptions ?? undefined),
      error: (text: string, nextFields: EmbedField[] | null = null, nextOptions: StatusPayloadOptions | null = null) => reply.error(text, nextFields ?? undefined, nextOptions ?? undefined),
    };
  }

  const initialPayload = buildStatusPayload(ctx, 'working', initialText, fields ?? undefined, options ?? undefined);
  const sent = await rest.sendMessage!(
    safeChannelId,
    replyReference ? withCommandReplyReference(ctx, initialPayload) : initialPayload
  ).catch(() => null) as SentMessageLike | null;
  const messageId = sent?.id ?? sent?.message?.id ?? null;

  const editOrReply = async (kind: StatusKind, text: string, nextFields: EmbedField[] | null = null, nextOptions: StatusPayloadOptions | null = null) => {
    if (messageId) {
      try {
        await rest.editMessage!(
          safeChannelId,
          messageId,
          buildStatusPayload(ctx, kind, text, nextFields ?? undefined, nextOptions ?? undefined)
        );
        return;
      } catch {
        // fall through to normal reply
      }
    }

    if (kind === 'success') return reply.success(text, nextFields ?? undefined, nextOptions ?? undefined);
    if (kind === 'warning') return reply.warning(text, nextFields ?? undefined, nextOptions ?? undefined);
    if (kind === 'error') return reply.error(text, nextFields ?? undefined, nextOptions ?? undefined);
    return reply.info(text, nextFields ?? undefined, nextOptions ?? undefined);
  };

  return {
    messageId,
    replace: async (payload: MessagePayload) => {
      if (!messageId) return null;
      return rest.editMessage!(safeChannelId, messageId, payload);
    },
    success: (text: string, nextFields: EmbedField[] | null = null, nextOptions: StatusPayloadOptions | null = null) => editOrReply('success', text, nextFields, nextOptions),
    warning: (text: string, nextFields: EmbedField[] | null = null, nextOptions: StatusPayloadOptions | null = null) => editOrReply('warning', text, nextFields, nextOptions),
    info: (text: string, nextFields: EmbedField[] | null = null, nextOptions: StatusPayloadOptions | null = null) => editOrReply('info', text, nextFields, nextOptions),
    error: (text: string, nextFields: EmbedField[] | null = null, nextOptions: StatusPayloadOptions | null = null) => editOrReply('error', text, nextFields, nextOptions),
  };
}




