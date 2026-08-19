import { PERMISSION_FLAGS } from '../../permissions/flags.ts';

export const VOICE_CHANNEL_PATTERN = /^<#(\d+)>$/;
export const ROLE_MENTION_PATTERN = /^<@&(\d+)>$/;
export const PENDING_PAGE_SIZE = 10;
export const HISTORY_PAGE_SIZE = 10;
export const PLAYLIST_PAGE_SIZE = 10;
export const FAVORITES_PAGE_SIZE = 10;
export const SEARCH_RESULT_DEFAULT_LIMIT = 5;
export const SUPPORT_SERVER_URL = 'https://fluxer.gg/vinto';
export const PERMISSION_CACHE_TTL_MS = 60_000;
export const ADMINISTRATOR_PERMISSION = PERMISSION_FLAGS.ADMINISTRATOR;
export const MANAGE_GUILD_PERMISSION = PERMISSION_FLAGS.MANAGE_GUILD;
export const EMBED_FIELD_TEXT_LIMIT = 1000;
export const TRACK_LINE_MAX_CHARS = 240;


