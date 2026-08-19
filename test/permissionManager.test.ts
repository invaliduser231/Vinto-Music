import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ALL_PERMISSIONS,
  DEFAULT_PERMISSIONS,
  PERMISSION_FLAGS,
  PERMISSION_NAMES,
  hasPermission,
  listPermissions,
  missingPermissions,
  toPermissionBits,
} from '../src/bot/permissions/flags.ts';
import {
  applyChannelOverwrites,
  checkResolution,
  computeBasePermissions,
  resolveMemberPermissions,
  unknownResolution,
} from '../src/bot/permissions/resolver.ts';
import {
  describePermissionFailure,
  ensurePermissionCheck,
  formatPermissionList,
  permissionCheckFields,
} from '../src/bot/permissions/require.ts';
import { createTranslator } from '../src/i18n/index.ts';

const t = createTranslator('en');

test('permission bits match the values Fluxer ships in its client', () => {
  assert.equal(PERMISSION_FLAGS.CREATE_INSTANT_INVITE, 1n << 0n);
  assert.equal(PERMISSION_FLAGS.ADMINISTRATOR, 1n << 3n);
  assert.equal(PERMISSION_FLAGS.MANAGE_GUILD, 1n << 5n);
  assert.equal(PERMISSION_FLAGS.VIEW_CHANNEL, 1n << 10n);
  assert.equal(PERMISSION_FLAGS.SEND_MESSAGES, 1n << 11n);
  assert.equal(PERMISSION_FLAGS.CONNECT, 1n << 20n);
  assert.equal(PERMISSION_FLAGS.SPEAK, 1n << 21n);
  assert.equal(PERMISSION_FLAGS.MOVE_MEMBERS, 1n << 24n);
  assert.equal(PERMISSION_FLAGS.MODERATE_MEMBERS, 1n << 40n);
  assert.equal(PERMISSION_FLAGS.PIN_MESSAGES, 1n << 51n);
  assert.equal(PERMISSION_FLAGS.UPDATE_RTC_REGION, 1n << 53n);
});

test('bit 19 is deliberately unused and never claimed by a flag', () => {
  const bit19 = 1n << 19n;
  const claimed = PERMISSION_NAMES.filter((name) => PERMISSION_FLAGS[name] === bit19);
  assert.deepEqual(claimed, []);
  assert.equal((ALL_PERMISSIONS & bit19), 0n);
});

test('ALL_PERMISSIONS is the union of declared flags, not a saturated mask', () => {
  assert.notEqual(ALL_PERMISSIONS, 0xffffffffffffffffn);
  for (const name of PERMISSION_NAMES) {
    assert.ok(hasPermission(ALL_PERMISSIONS, name), `missing ${name}`);
  }
});

test('default permissions cover ordinary playback but no elevated rights', () => {
  assert.ok(hasPermission(DEFAULT_PERMISSIONS, 'CONNECT'));
  assert.ok(hasPermission(DEFAULT_PERMISSIONS, 'SPEAK'));
  assert.ok(hasPermission(DEFAULT_PERMISSIONS, 'SEND_MESSAGES'));
  assert.equal(hasPermission(DEFAULT_PERMISSIONS, 'ADMINISTRATOR'), false);
  assert.equal(hasPermission(DEFAULT_PERMISSIONS, 'MOVE_MEMBERS'), false);
});

test('toPermissionBits accepts the string encoding the API uses', () => {
  assert.equal(toPermissionBits('2048'), 2048n);
  assert.equal(toPermissionBits(2048), 2048n);
  assert.equal(toPermissionBits(2048n), 2048n);
  assert.equal(toPermissionBits(''), null);
  assert.equal(toPermissionBits('not-a-number'), null);
  assert.equal(toPermissionBits(null), null);
});

test('missingPermissions reports every absent flag and nothing for admins', () => {
  const bits = PERMISSION_FLAGS.VIEW_CHANNEL;
  assert.deepEqual(missingPermissions(bits, ['VIEW_CHANNEL', 'CONNECT', 'SPEAK']), ['CONNECT', 'SPEAK']);
  assert.deepEqual(missingPermissions(PERMISSION_FLAGS.ADMINISTRATOR, ['CONNECT', 'SPEAK']), []);
});

test('base permissions combine the everyone role with member roles', () => {
  const guild = {
    id: 'guild-1',
    roles: [
      { id: 'guild-1', permissions: String(PERMISSION_FLAGS.VIEW_CHANNEL) },
      { id: 'role-dj', permissions: String(PERMISSION_FLAGS.CONNECT) },
      { id: 'role-unused', permissions: String(PERMISSION_FLAGS.ADMINISTRATOR) },
    ],
  };
  const bits = computeBasePermissions({ roles: ['role-dj'] }, guild);

  assert.ok(bits != null);
  assert.ok(hasPermission(bits!, 'VIEW_CHANNEL'));
  assert.ok(hasPermission(bits!, 'CONNECT'));
  assert.equal(hasPermission(bits!, 'ADMINISTRATOR'), false);
});

test('base permissions stay unknown when no role data is present', () => {
  assert.equal(computeBasePermissions({ roles: ['role-dj'] }, { id: 'guild-1', roles: [] }), null);
});

test('overwrites apply everyone, then roles, then member — matching Fluxer', () => {
  const guild = { id: 'guild-1' };
  const member = { roles: ['role-dj'] };
  const base = PERMISSION_FLAGS.VIEW_CHANNEL | PERMISSION_FLAGS.CONNECT | PERMISSION_FLAGS.SPEAK;

  const everyoneDeniesSpeak = applyChannelOverwrites(base, member, guild, {
    permission_overwrites: [
      { id: 'guild-1', type: 0, deny: String(PERMISSION_FLAGS.SPEAK), allow: '0' },
    ],
  }, 'bot-1');
  assert.equal(hasPermission(everyoneDeniesSpeak, 'SPEAK'), false);

  const roleReAllowsSpeak = applyChannelOverwrites(base, member, guild, {
    permission_overwrites: [
      { id: 'guild-1', type: 0, deny: String(PERMISSION_FLAGS.SPEAK), allow: '0' },
      { id: 'role-dj', type: 0, deny: '0', allow: String(PERMISSION_FLAGS.SPEAK) },
    ],
  }, 'bot-1');
  assert.ok(hasPermission(roleReAllowsSpeak, 'SPEAK'), 'role allow overrides everyone deny');

  const memberDeniesSpeak = applyChannelOverwrites(base, member, guild, {
    permission_overwrites: [
      { id: 'role-dj', type: 0, deny: '0', allow: String(PERMISSION_FLAGS.SPEAK) },
      { id: 'bot-1', type: 1, deny: String(PERMISSION_FLAGS.SPEAK), allow: '0' },
    ],
  }, 'bot-1');
  assert.equal(hasPermission(memberDeniesSpeak, 'SPEAK'), false, 'member deny wins over role allow');
});

test('administrator short-circuits overwrites entirely', () => {
  const bits = applyChannelOverwrites(PERMISSION_FLAGS.ADMINISTRATOR, { roles: [] }, { id: 'g' }, {
    permission_overwrites: [{ id: 'g', type: 0, deny: String(ALL_PERMISSIONS), allow: '0' }],
  }, 'bot-1');
  assert.equal(bits, ALL_PERMISSIONS);
});

test('guild owner resolves to every permission without role data', () => {
  const resolution = resolveMemberPermissions({
    member: null,
    guild: { id: 'guild-1', owner_id: 'bot-1' },
    channel: null,
    userId: 'bot-1',
  });

  assert.equal(resolution.known, true);
  assert.equal(resolution.isOwner, true);
  assert.equal(resolution.source, 'owner');
  assert.equal(resolution.bits, ALL_PERMISSIONS);
});

test('resolution reports why it could not be determined', () => {
  assert.equal(resolveMemberPermissions({ member: null, guild: null, channel: null, userId: 'u' }).reason, 'guild_unavailable');
  assert.equal(
    resolveMemberPermissions({ member: null, guild: { id: 'g', roles: [] }, channel: null, userId: 'u' }).reason,
    'member_unavailable'
  );
  assert.equal(
    resolveMemberPermissions({ member: { roles: [] }, guild: { id: 'g', roles: [] }, channel: null, userId: 'u' }).reason,
    'roles_unavailable'
  );
  assert.equal(
    resolveMemberPermissions({
      member: { roles: [] },
      guild: { id: 'g', roles: [{ id: 'g', permissions: '1024' }] },
      channel: null,
      userId: 'u',
    }).reason,
    'channel_unavailable'
  );
});

test('check lists view channel first because it causes the others', () => {
  const resolution = resolveMemberPermissions({
    member: { roles: [] },
    guild: { id: 'g', roles: [{ id: 'g', permissions: '0' }] },
    channel: { permission_overwrites: [] },
    userId: 'u',
  });
  const check = checkResolution(resolution, ['CONNECT', 'SPEAK', 'VIEW_CHANNEL']);

  assert.equal(check.ok, false);
  assert.equal(check.missing[0], 'VIEW_CHANNEL');
  assert.deepEqual([...check.missing].sort(), ['CONNECT', 'SPEAK', 'VIEW_CHANNEL']);
});

test('an unknown resolution never claims permissions are missing', () => {
  const check = checkResolution(unknownResolution('member_unavailable'), ['CONNECT']);
  assert.equal(check.ok, false);
  assert.equal(check.known, false);
  assert.deepEqual(check.missing, [], 'must not blame the user for an unreadable state');
});

test('failure messages name the exact permissions and the channel', () => {
  const check = checkResolution(
    resolveMemberPermissions({
      member: { roles: [] },
      guild: { id: 'g', roles: [{ id: 'g', permissions: String(PERMISSION_FLAGS.VIEW_CHANNEL) }] },
      channel: { permission_overwrites: [] },
      userId: 'u',
    }),
    ['VIEW_CHANNEL', 'CONNECT', 'SPEAK']
  );

  const message = describePermissionFailure(t, check, { channelMention: '<#123>' });
  assert.match(message, /<#123>/);
  assert.match(message, /Connect/);
  assert.match(message, /Speak/);
  assert.doesNotMatch(message, /View Channel/, 'granted permissions are not listed as missing');
});

test('failure messages explain an unverifiable state instead of guessing', () => {
  const check = checkResolution(unknownResolution('roles_unavailable'), ['CONNECT']);
  const message = describePermissionFailure(t, check, { channelMention: '<#123>' });

  assert.match(message, /could not verify/i);
  assert.match(message, /roles could not be loaded/i);
  assert.doesNotMatch(message, /Connect/, 'must not name permissions it could not check');
});

test('single missing permission uses singular wording', () => {
  const check = checkResolution(
    resolveMemberPermissions({
      member: { roles: [] },
      guild: {
        id: 'g',
        roles: [{ id: 'g', permissions: String(PERMISSION_FLAGS.VIEW_CHANNEL | PERMISSION_FLAGS.CONNECT) }],
      },
      channel: { permission_overwrites: [] },
      userId: 'u',
    }),
    ['VIEW_CHANNEL', 'CONNECT', 'SPEAK']
  );

  assert.deepEqual(check.missing, ['SPEAK']);
  assert.match(describePermissionFailure(t, check), /missing the \*\*Speak\*\* permission/);
});

test('ensurePermissionCheck throws only when a permission is actually missing', () => {
  const granted = checkResolution(
    resolveMemberPermissions({
      member: null,
      guild: { id: 'g', owner_id: 'u' },
      channel: null,
      userId: 'u',
    }),
    ['CONNECT', 'SPEAK']
  );
  assert.doesNotThrow(() => ensurePermissionCheck(t, granted));

  const denied = checkResolution(
    resolveMemberPermissions({
      member: { roles: [] },
      guild: { id: 'g', roles: [{ id: 'g', permissions: '0' }] },
      channel: { permission_overwrites: [] },
      userId: 'u',
    }),
    ['CONNECT']
  );
  assert.throws(() => ensurePermissionCheck(t, denied), /Connect/);
});

test('check fields separate granted from missing for the diagnostics command', () => {
  const check = checkResolution(
    resolveMemberPermissions({
      member: { roles: [] },
      guild: { id: 'g', roles: [{ id: 'g', permissions: String(PERMISSION_FLAGS.VIEW_CHANNEL) }] },
      channel: { permission_overwrites: [] },
      userId: 'u',
    }),
    ['VIEW_CHANNEL', 'CONNECT']
  );

  const fields = permissionCheckFields(t, check);
  const missingField = fields.find((f) => f.name === 'Missing');
  const grantedField = fields.find((f) => f.name === 'Granted');

  assert.match(missingField!.value, /Connect/);
  assert.match(grantedField!.value, /View Channel/);
});

test('every permission flag has a human readable label in the catalog', () => {
  for (const name of PERMISSION_NAMES) {
    const label = t.optional(`perm.${name}`);
    assert.ok(label, `missing label for ${name}`);
    assert.notEqual(label, name, `label for ${name} is still the raw flag name`);
  }
});

test('listPermissions reports exactly the flags contained in a bitfield', () => {
  const bits = PERMISSION_FLAGS.VIEW_CHANNEL | PERMISSION_FLAGS.SPEAK;
  assert.deepEqual(listPermissions(bits).sort(), ['SPEAK', 'VIEW_CHANNEL']);
});

test('formatPermissionList renders labels rather than raw flags', () => {
  assert.equal(formatPermissionList(t, ['CONNECT', 'SPEAK']), '**Connect**, **Speak**');
});
