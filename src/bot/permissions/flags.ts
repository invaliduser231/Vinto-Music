export const PERMISSION_FLAGS = {
  CREATE_INSTANT_INVITE: 1n << 0n,
  KICK_MEMBERS: 1n << 1n,
  BAN_MEMBERS: 1n << 2n,
  ADMINISTRATOR: 1n << 3n,
  MANAGE_CHANNELS: 1n << 4n,
  MANAGE_GUILD: 1n << 5n,
  ADD_REACTIONS: 1n << 6n,
  VIEW_AUDIT_LOG: 1n << 7n,
  PRIORITY_SPEAKER: 1n << 8n,
  STREAM: 1n << 9n,
  VIEW_CHANNEL: 1n << 10n,
  SEND_MESSAGES: 1n << 11n,
  SEND_TTS_MESSAGES: 1n << 12n,
  MANAGE_MESSAGES: 1n << 13n,
  EMBED_LINKS: 1n << 14n,
  ATTACH_FILES: 1n << 15n,
  READ_MESSAGE_HISTORY: 1n << 16n,
  MENTION_EVERYONE: 1n << 17n,
  USE_EXTERNAL_EMOJIS: 1n << 18n,
  CONNECT: 1n << 20n,
  SPEAK: 1n << 21n,
  MUTE_MEMBERS: 1n << 22n,
  DEAFEN_MEMBERS: 1n << 23n,
  MOVE_MEMBERS: 1n << 24n,
  USE_VAD: 1n << 25n,
  CHANGE_NICKNAME: 1n << 26n,
  MANAGE_NICKNAMES: 1n << 27n,
  MANAGE_ROLES: 1n << 28n,
  MANAGE_WEBHOOKS: 1n << 29n,
  MANAGE_EXPRESSIONS: 1n << 30n,
  USE_EXTERNAL_STICKERS: 1n << 37n,
  MODERATE_MEMBERS: 1n << 40n,
  CREATE_EXPRESSIONS: 1n << 43n,
  PIN_MESSAGES: 1n << 51n,
  BYPASS_SLOWMODE: 1n << 52n,
  UPDATE_RTC_REGION: 1n << 53n,
} as const;

export type PermissionFlag = keyof typeof PERMISSION_FLAGS;

export const PERMISSION_NAMES = Object.keys(PERMISSION_FLAGS) as PermissionFlag[];

export const ALL_PERMISSIONS = PERMISSION_NAMES.reduce(
  (bits, name) => bits | PERMISSION_FLAGS[name],
  0n
);

export const DEFAULT_PERMISSIONS = PERMISSION_FLAGS.CREATE_INSTANT_INVITE
  | PERMISSION_FLAGS.ADD_REACTIONS
  | PERMISSION_FLAGS.STREAM
  | PERMISSION_FLAGS.VIEW_CHANNEL
  | PERMISSION_FLAGS.SEND_MESSAGES
  | PERMISSION_FLAGS.EMBED_LINKS
  | PERMISSION_FLAGS.ATTACH_FILES
  | PERMISSION_FLAGS.READ_MESSAGE_HISTORY
  | PERMISSION_FLAGS.USE_EXTERNAL_EMOJIS
  | PERMISSION_FLAGS.CONNECT
  | PERMISSION_FLAGS.SPEAK
  | PERMISSION_FLAGS.USE_VAD
  | PERMISSION_FLAGS.CHANGE_NICKNAME
  | PERMISSION_FLAGS.USE_EXTERNAL_STICKERS;

export const ELEVATED_PERMISSIONS = PERMISSION_FLAGS.KICK_MEMBERS
  | PERMISSION_FLAGS.BAN_MEMBERS
  | PERMISSION_FLAGS.ADMINISTRATOR
  | PERMISSION_FLAGS.MANAGE_CHANNELS
  | PERMISSION_FLAGS.MANAGE_GUILD
  | PERMISSION_FLAGS.MANAGE_ROLES
  | PERMISSION_FLAGS.MANAGE_MESSAGES
  | PERMISSION_FLAGS.MANAGE_WEBHOOKS
  | PERMISSION_FLAGS.MANAGE_EXPRESSIONS
  | PERMISSION_FLAGS.MODERATE_MEMBERS;

export const OVERWRITE_TYPE_ROLE = 0;
export const OVERWRITE_TYPE_MEMBER = 1;

export function toPermissionBits(value: unknown): bigint | null {
  if (value == null) return null;
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return BigInt(Math.trunc(value));

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (/^\d+$/.test(trimmed)) return BigInt(trimmed);
  }

  return null;
}

export function hasPermission(bits: bigint, flag: PermissionFlag): boolean {
  const mask = PERMISSION_FLAGS[flag];
  return (bits & mask) === mask;
}

export function isAdministrator(bits: bigint): boolean {
  return hasPermission(bits, 'ADMINISTRATOR');
}

export function missingPermissions(bits: bigint, required: readonly PermissionFlag[]): PermissionFlag[] {
  if (isAdministrator(bits)) return [];
  return required.filter((flag) => !hasPermission(bits, flag));
}

export function listPermissions(bits: bigint): PermissionFlag[] {
  return PERMISSION_NAMES.filter((name) => hasPermission(bits, name));
}

export function permissionTranslationKey(flag: PermissionFlag): string {
  return `perm.${flag}`;
}
