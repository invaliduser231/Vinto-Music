export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type BivariantCallback<TArgs extends unknown[] = unknown[], TResult = unknown> = {
  bivarianceHack(...args: TArgs): TResult;
}['bivarianceHack'];

export type Dict<T = unknown> = Record<string, T>;

export interface LoggerLike {
  debug?: (message: string, context?: Dict) => void;
  info?: (message: string, context?: Dict) => void;
  warn?: (message: string, context?: Dict) => void;
  error?: (message: string, context?: Dict) => void;
  child?: (childName: string) => LoggerLike;
}

export interface EmbedField {
  name: string;
  value: string;
  inline?: boolean;
}

export interface EmbedImage {
  url: string;
}

export interface EmbedFooter {
  text: string;
}

export interface EmbedPayload {
  color: number;
  timestamp: string;
  title?: string;
  description?: string;
  fields?: EmbedField[];
  thumbnail?: EmbedImage;
  image?: EmbedImage;
  footer?: EmbedFooter;
}

export interface ReplyOptions {
  replyToMessageId: string;
  replyToChannelId?: string | undefined;
  replyToGuildId?: string | undefined;
}

export interface MessageReference {
  message_id: string;
  channel_id?: string | undefined;
  guild_id?: string | undefined;
}

export interface AllowedMentions {
  parse: string[];
  users: string[];
  roles: string[];
  replied_user: boolean;
}

export interface MessagePayload {
  content?: string | null | undefined;
  embeds?: EmbedPayload[] | undefined;
  allowed_mentions?: AllowedMentions | undefined;
  message_reference?: MessageReference | undefined;
  nonce?: string | undefined;
  [key: string]: unknown;
}

export interface ResponderEmbedOptions {
  thumbnailUrl?: string | null;
  imageUrl?: string | null;
}

export interface RestLike {
  sendMessage: (channelId: string, payload: MessagePayload) => Promise<unknown>;
}

export interface ParsedCommand {
  name: string;
  args: string[];
  rawArgs: string;
}

export interface CommandDefinition {
  name: string;
  aliases?: string[];
  description?: string;
  usage?: string;
  hidden?: boolean;
  execute?: BivariantCallback<unknown[], unknown>;
  [key: string]: unknown;
}

export interface MessageLike {
  id?: string;
  message_id?: string;
  channel_id?: string;
  channelId?: string;
  guild_id?: string;
  guildId?: string;
  [key: string]: unknown;
}

export interface TrackLike {
  title?: string;
  duration?: string;
  requestedBy?: string | null;
  [key: string]: unknown;
}
