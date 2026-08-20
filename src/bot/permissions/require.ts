import { ValidationError } from '../../core/errors.ts';
import type { Translator } from '../../i18n/index.ts';
import { permissionTranslationKey, type PermissionFlag } from './flags.ts';
import type { PermissionCheck, PermissionUnknownReason } from './resolver.ts';

const REASON_KEYS: Record<PermissionUnknownReason, string> = {
  no_rest: 'permcheck.reason.noRest',
  no_user: 'permcheck.reason.noUser',
  missing_ids: 'permcheck.reason.missingIds',
  member_unavailable: 'permcheck.reason.memberUnavailable',
  guild_unavailable: 'permcheck.reason.guildUnavailable',
  roles_unavailable: 'permcheck.reason.rolesUnavailable',
  channel_unavailable: 'permcheck.reason.channelUnavailable',
  lookup_failed: 'permcheck.reason.lookupFailed',
};

export function permissionLabel(t: Translator, flag: PermissionFlag): string {
  return t.optional(permissionTranslationKey(flag)) ?? flag;
}

export function formatPermissionList(t: Translator, flags: readonly PermissionFlag[]): string {
  return flags.map((flag) => `**${permissionLabel(t, flag)}**`).join(', ');
}

export function describeUnknownReason(t: Translator, reason: PermissionUnknownReason | null): string {
  const key = reason ? REASON_KEYS[reason] : null;
  return (key ? t.optional(key) : null) ?? t('permcheck.reason.unknown');
}

export interface PermissionFailureOptions {
  channelMention?: string | null;
  actionKey?: string | null;
}

export function describePermissionFailure(
  t: Translator,
  check: PermissionCheck,
  options: PermissionFailureOptions = {}
): string {
  const channel = String(options.channelMention ?? '').trim();

  if (!check.known) {
    const reason = describeUnknownReason(t, check.reason);
    return channel
      ? t('permcheck.unknownInChannel', { channel, reason })
      : t('permcheck.unknown', { reason });
  }

  const list = formatPermissionList(t, check.missing);
  const count = check.missing.length;

  if (channel) {
    return t('permcheck.missingInChannel', { permissions: list, channel, count });
  }
  return t('permcheck.missing', { permissions: list, count });
}

export function ensurePermissionCheck(
  t: Translator,
  check: PermissionCheck,
  options: PermissionFailureOptions = {}
): void {
  if (check.ok) return;
  throw new ValidationError(describePermissionFailure(t, check, options));
}

export function permissionCheckFields(
  t: Translator,
  check: PermissionCheck
): Array<{ name: string; value: string; inline?: boolean }> {
  if (!check.known) {
    return [{ name: t('permcheck.field.status'), value: describeUnknownReason(t, check.reason) }];
  }

  const granted = check.required.filter((flag) => !check.missing.includes(flag));
  const fields: Array<{ name: string; value: string; inline?: boolean }> = [];

  if (check.missing.length) {
    fields.push({
      name: t('permcheck.field.missing'),
      value: check.missing.map((flag) => `❌ ${permissionLabel(t, flag)}`).join('\n'),
    });
  }
  if (granted.length) {
    fields.push({
      name: t('permcheck.field.granted'),
      value: granted.map((flag) => `✅ ${permissionLabel(t, flag)}`).join('\n'),
    });
  }

  return fields;
}
