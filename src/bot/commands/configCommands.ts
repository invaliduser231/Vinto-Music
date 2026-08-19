import { ValidationError } from '../../core/errors.ts';
import { describePermissionFailure, ensurePermissionCheck, permissionCheckFields } from '../permissions/require.ts';
import type { PermissionFlag } from '../permissions/flags.ts';
import { parseVoiceChannelArgument } from './helpers/formatting.ts';
import { describePerkDelta } from '../services/votePerks.ts';
import {
  localeFlag,
  localeLabel,
  normalizeLocale,
  SUPPORTED_LOCALES,
  translate,
  type Locale,
  type TranslationKey,
} from '../../i18n/index.ts';
import type { CommandContextLike, CommandHelperBundle } from './helpers/types.ts';

type RegistryLike = {
  register: (definition: Readonly<{ name: string }>) => void;
};

type ConfigCommandHelpers = Pick<
  CommandHelperBundle,
  'createCommand'
  | 'ensureGuild'
  | 'getGuildConfigOrThrow'
  | 'updateGuildConfig'
  | 'requireLibrary'
  | 'parseOnOff'
  | 'parseRoleId'
  | 'parseTextChannelId'
  | 'resolveActiveVoiceChannelOrThrow'
  | 'ensureManageGuildAccess'
>;

const TEXT_PERMISSIONS: readonly PermissionFlag[] = ['VIEW_CHANNEL', 'SEND_MESSAGES', 'EMBED_LINKS', 'READ_MESSAGE_HISTORY', 'ADD_REACTIONS'];
const VOICE_PERMISSIONS: readonly PermissionFlag[] = ['VIEW_CHANNEL', 'CONNECT', 'SPEAK'];

export function registerConfigCommands(registry: RegistryLike, h: ConfigCommandHelpers) {
  const {
    createCommand,
    ensureGuild,
    getGuildConfigOrThrow,
    updateGuildConfig,
    requireLibrary,
    parseOnOff,
    parseRoleId,
    parseTextChannelId,
    resolveActiveVoiceChannelOrThrow,
    ensureManageGuildAccess,
  } = h;

  registry.register(createCommand({
    name: 'dedupe',
    description: 'Toggle duplicate prevention when adding tracks.',
    usage: 'dedupe [on|off]',
    async execute(ctx: CommandContextLike) {
      ensureGuild(ctx);
      const guildConfig = await getGuildConfigOrThrow(ctx);
      await ensureManageGuildAccess(ctx, 'access.changeDedupe');

      if (!ctx.args.length) {
        await ctx.reply.info(ctx.t('config.dedupeCurrent', { state: ctx.t(guildConfig.settings.dedupeEnabled ? 'common.on' : 'common.off') }));
        return;
      }

      const value = parseOnOff(ctx.args[0], null);
      if (value == null) {
        throw new ValidationError(ctx.t('config.useOnOff'));
      }

      await updateGuildConfig(ctx, {
        settings: { dedupeEnabled: value },
      });
      await ctx.reply.success(ctx.t('config.dedupeSet', { state: ctx.t(value ? 'common.on' : 'common.off') }));
    },
  }));

  registry.register(createCommand({
    name: 'earrape',
    aliases: ['earrapeprotection'],
    description: 'Toggle automatic earrape detection with offender disconnects.',
    usage: 'earrape [on|off]',
    async execute(ctx: CommandContextLike) {
      ensureGuild(ctx);
      const guildConfig = await getGuildConfigOrThrow(ctx);
      await ensureManageGuildAccess(ctx, 'access.changeEarrape');
      const current = Boolean(guildConfig.settings.earrapeProtectionEnabled);

      if (!ctx.args.length) {
        await ctx.reply.info(ctx.t('config.earrapeCurrent', { state: ctx.t(current ? 'common.on' : 'common.off') }));
        return;
      }

      const value = parseOnOff(ctx.args[0], null);
      if (value == null) {
        throw new ValidationError(ctx.t('config.useOnOff'));
      }

      if (value && ctx.permissionService?.checkBotPermissions) {
        const channelIds = new Set<string>();
        if (ctx.activeVoiceChannelId) {
          channelIds.add(ctx.activeVoiceChannelId);
        }
        const scopedSession = ctx.sessions.get(ctx.guildId, {
          voiceChannelId: ctx.activeVoiceChannelId,
          textChannelId: ctx.channelId,
          allowAnyGuildSession: true,
        });
        const scopedChannel = String(scopedSession?.connection?.channelId ?? '').trim();
        if (scopedChannel) {
          channelIds.add(scopedChannel);
        }
        if (typeof ctx.sessions.listByGuild === 'function') {
          const sessions = ctx.sessions.listByGuild(ctx.guildId);
          for (const session of sessions) {
            const channelId = String(session?.connection?.channelId ?? '').trim();
            if (channelId) channelIds.add(channelId);
          }
        }

        for (const channelId of channelIds) {
          const check = await ctx.permissionService.checkBotPermissions?.(
            ctx.guildId,
            channelId,
            ['VIEW_CHANNEL', 'MOVE_MEMBERS']
          );
          if (check?.known && !check.ok) {
            ensurePermissionCheck(ctx.t, check, { channelMention: `<#${channelId}>` });
          }
        }
      }

      await updateGuildConfig(ctx, {
        settings: { earrapeProtectionEnabled: value },
      });
      await ctx.reply.success(ctx.t('config.earrapeSet', { state: ctx.t(value ? 'common.on' : 'common.off') }));
    },
  }));

  registry.register(createCommand({
    name: 'minimalmode',
    aliases: ['minimal'],
    description: 'Toggle compact text replies instead of embeds.',
    usage: 'minimalmode [on|off]',
    async execute(ctx: CommandContextLike) {
      ensureGuild(ctx);
      const guildConfig = await getGuildConfigOrThrow(ctx);
      await ensureManageGuildAccess(ctx, 'access.changeMinimal');

      if (!ctx.args.length) {
        await ctx.reply.info(ctx.t('config.minimalCurrent', { state: ctx.t(guildConfig.settings.minimalMode ? 'common.on' : 'common.off') }));
        return;
      }

      const value = parseOnOff(ctx.args[0], null);
      if (value == null) {
        throw new ValidationError(ctx.t('config.useOnOff'));
      }

      await updateGuildConfig(ctx, {
        settings: { minimalMode: value },
      });
      await ctx.reply.success(ctx.t('config.minimalSet', { state: ctx.t(value ? 'common.on' : 'common.off') }));
    },
  }));

  registry.register(createCommand({
    name: 'volumedefault',
    aliases: ['volcfg', 'defaultvolume'],
    description: 'Show or set the default volume for new guild sessions.',
    usage: 'volumedefault [0-200]',
    async execute(ctx: CommandContextLike) {
      ensureGuild(ctx);
      const guildConfig = await getGuildConfigOrThrow(ctx);
      await ensureManageGuildAccess(ctx, 'access.changeDefaultVolume');

      if (!ctx.args.length) {
        await ctx.reply.info(ctx.t('config.defaultVolumeCurrent', { percent: guildConfig.settings.volumePercent }));
        return;
      }

      const next = Number.parseInt(String(ctx.args[0] ?? ''), 10);
      if (!Number.isFinite(next) || next < 0 || next > 200) {
        throw new ValidationError(ctx.t('config.volumeRange'));
      }

      const updated = await updateGuildConfig(ctx, {
        settings: { volumePercent: next },
      });
      await ctx.reply.success(ctx.t('config.defaultVolumeSet', { percent: updated.settings.volumePercent }));
    },
  }));

  registry.register(createCommand({
    name: '247',
    aliases: ['stay'],
    description: 'Toggle 24/7 mode for your current voice channel.',
    usage: '247 [on|off]',
    async execute(ctx: CommandContextLike) {
      ensureGuild(ctx);
      const library = requireLibrary(ctx);
      await ensureManageGuildAccess(ctx, 'access.change247');
      const voiceChannelId = await resolveActiveVoiceChannelOrThrow(ctx, { fallbackCommand: '247' });
      const profile = await library.getVoiceProfile(ctx.guildId, voiceChannelId).catch(() => null);
      const current = typeof profile?.stayInVoiceEnabled === 'boolean'
        ? profile.stayInVoiceEnabled
        : Boolean(ctx.config.defaultStayInVoiceEnabled);

      if (!ctx.args.length) {
        await ctx.reply.info(ctx.t('config.stayCurrent', { channel: `<#${voiceChannelId}>`, state: ctx.t(current ? 'common.on' : 'common.off') }));
        return;
      }

      const value = parseOnOff(ctx.args[0], null);
      if (value == null) {
        throw new ValidationError(ctx.t('config.useOnOff'));
      }

      await library.setVoiceProfile(ctx.guildId, voiceChannelId, { stayInVoiceEnabled: value });
      await ctx.sessions.refreshVoiceProfileSettings?.(ctx.guildId, { voiceChannelId });
      await ctx.reply.success(ctx.t('config.staySet', { channel: `<#${voiceChannelId}>`, state: ctx.t(value ? 'common.on' : 'common.off') }));
    },
  }));

  registry.register(createCommand({
    name: 'djrole',
    aliases: ['dj'],
    description: 'Manage DJ role restrictions for control commands.',
    usage: 'djrole [add|remove|clear|list] [@role|roleId]',
    async execute(ctx: CommandContextLike) {
      ensureGuild(ctx);
      const guildConfig = await getGuildConfigOrThrow(ctx);
      await ensureManageGuildAccess(ctx, 'access.manageDjRoles');

      const action = String(ctx.args[0] ?? 'list').toLowerCase();
      if (action === 'list') {
        const roles = [...guildConfig.settings.djRoleIds];
        if (!roles.length) {
          await ctx.reply.info(ctx.t('djrole.disabled'));
          return;
        }

        await ctx.reply.info(ctx.t('djrole.title'), [
          { name: ctx.t('djrole.roles'), value: roles.map((id) => `<@&${id}>`).join(', ') },
        ]);
        return;
      }

      if (action === 'clear') {
        await updateGuildConfig(ctx, {
          settings: { djRoleIds: [] },
        });
        await ctx.reply.success(ctx.t('djrole.cleared'));
        return;
      }

      if (!['add', 'remove'].includes(action)) {
        throw new ValidationError(ctx.t('djrole.usage'));
      }

      const roleId = parseRoleId(ctx.args[1]);
      if (!roleId) {
        throw new ValidationError(ctx.t('djrole.provideRole'));
      }

      const next = new Set(guildConfig.settings.djRoleIds);
      if (action === 'add') {
        next.add(roleId);
      } else {
        next.delete(roleId);
      }

      await updateGuildConfig(ctx, {
        settings: { djRoleIds: [...next] },
      });
      await ctx.reply.success(
        action === 'add'
          ? `Added DJ role <@&${roleId}>.`
          : `Removed DJ role <@&${roleId}>.`
      );
    },
  }));

  registry.register(createCommand({
    name: 'prefix',
    description: 'Show or set the guild command prefix.',
    usage: 'prefix [newPrefix]',
    async execute(ctx: CommandContextLike) {
      ensureGuild(ctx);
      const guildConfig = await getGuildConfigOrThrow(ctx);
      await ensureManageGuildAccess(ctx, 'access.changePrefix');

      if (!ctx.args.length) {
        await ctx.reply.info(ctx.t('config.prefixCurrent', { prefix: guildConfig.prefix }));
        return;
      }

      const nextPrefix = String(ctx.args[0] ?? '').trim();
      const updated = await updateGuildConfig(ctx, { prefix: nextPrefix });
      await ctx.reply.success(ctx.t('config.prefixSet', { prefix: updated.prefix }));
    },
  }));

  registry.register(createCommand({
    name: 'musiclog',
    aliases: ['logchannel'],
    description: 'Set a dedicated channel for player event logs.',
    usage: 'musiclog [off|#channel|channelId]',
    async execute(ctx: CommandContextLike) {
      ensureGuild(ctx);
      const guildConfig = await getGuildConfigOrThrow(ctx);
      await ensureManageGuildAccess(ctx, 'access.changeMusicLog');

      if (!ctx.args.length) {
        const current = guildConfig.settings.musicLogChannelId;
        await ctx.reply.info(
          current
            ? ctx.t('musiclog.current', { channel: `<#${current}>` })
            : ctx.t('musiclog.currentDisabled')
        );
        return;
      }

      const raw = String(ctx.args[0] ?? '').trim().toLowerCase();
      if (raw === 'off' || raw === 'none' || raw === 'disable') {
        await updateGuildConfig(ctx, {
          settings: { musicLogChannelId: null },
        });
        await ctx.reply.success(ctx.t('musiclog.disabled'));
        return;
      }

      const channelId = parseTextChannelId(ctx.args[0]);
      if (!channelId) {
        throw new ValidationError(ctx.t('musiclog.provideChannel'));
      }

      await updateGuildConfig(ctx, {
        settings: { musicLogChannelId: channelId },
      });
      await ctx.reply.success(ctx.t('musiclog.set', { channel: `<#${channelId}>` }));
    },
  }));

  registry.register(createCommand({
    name: 'voteskipcfg',
    aliases: ['vscfg'],
    description: 'Configure vote-skip threshold per guild.',
    usage: 'voteskipcfg [ratio <0..1>|min <number>]',
    async execute(ctx: CommandContextLike) {
      ensureGuild(ctx);
      const guildConfig = await getGuildConfigOrThrow(ctx);
      await ensureManageGuildAccess(ctx, 'access.configureVoteSkip');

      if (!ctx.args.length) {
        await ctx.reply.info(ctx.t('voteskipcfg.title'), [
          { name: ctx.t('voteskipcfg.ratio'), value: String(guildConfig.settings.voteSkipRatio), inline: true },
          { name: ctx.t('voteskipcfg.minVotes'), value: String(guildConfig.settings.voteSkipMinVotes), inline: true },
        ]);
        return;
      }

      const mode = String(ctx.args[0] ?? '').toLowerCase();
      if (mode === 'ratio') {
        const raw = Number.parseFloat(String(ctx.args[1] ?? ''));
        if (!Number.isFinite(raw) || raw <= 0 || raw > 1) {
          throw new ValidationError(ctx.t('voteskipcfg.ratioRange'));
        }

        const updated = await updateGuildConfig(ctx, {
          settings: { voteSkipRatio: raw },
        });
        await ctx.reply.success(ctx.t('voteskipcfg.ratioSet', { value: String(updated.settings.voteSkipRatio) }));
        return;
      }

      if (mode === 'min') {
        const raw = Number.parseInt(String(ctx.args[1] ?? ''), 10);
        if (!Number.isFinite(raw) || raw <= 0 || raw > 100) {
          throw new ValidationError(ctx.t('voteskipcfg.minRange'));
        }

        const updated = await updateGuildConfig(ctx, {
          settings: { voteSkipMinVotes: raw },
        });
        await ctx.reply.success(ctx.t('voteskipcfg.minSet', { value: String(updated.settings.voteSkipMinVotes) }));
        return;
      }

      throw new ValidationError(ctx.t('voteskipcfg.usage'));
    },
  }));

  registry.register(createCommand({
    name: 'settings',
    aliases: ['cfg', 'config'],
    description: 'Show effective guild music-bot settings.',
    usage: 'settings',
    async execute(ctx: CommandContextLike) {
      ensureGuild(ctx);
      const guildConfig = await getGuildConfigOrThrow(ctx);
      const session = ctx.sessions.get(ctx.guildId, {
        voiceChannelId: ctx.activeVoiceChannelId,
        textChannelId: ctx.channelId,
        allowAnyGuildSession: true,
      });
      const activeVoiceChannelId = ctx.activeVoiceChannelId ?? session?.connection?.channelId ?? null;
      const profile = activeVoiceChannelId && ctx.library?.getVoiceProfile
        ? await ctx.library.getVoiceProfile(ctx.guildId, activeVoiceChannelId).catch(() => null)
        : null;
      const stayInVoiceEnabled = typeof profile?.stayInVoiceEnabled === 'boolean'
        ? profile.stayInVoiceEnabled
        : (session?.settings?.stayInVoiceEnabled ?? Boolean(ctx.config.defaultStayInVoiceEnabled));
      const stayInVoiceLabel = activeVoiceChannelId
        ? `<#${activeVoiceChannelId}>: ${ctx.t(stayInVoiceEnabled ? 'common.on' : 'common.off')}`
        : ctx.t('config.stayNoChannel', { state: ctx.t(stayInVoiceEnabled ? 'common.on' : 'common.off') });
      const roles = guildConfig.settings.djRoleIds.length
        ? guildConfig.settings.djRoleIds.map((id) => `<@&${id}>`).join(', ')
        : ctx.t('common.noneLower');

      await ctx.reply.info(ctx.t('config.title'), [
        { name: ctx.t('config.prefix'), value: guildConfig.prefix, inline: true },
        { name: ctx.t('config.dedupe'), value: ctx.t(guildConfig.settings.dedupeEnabled ? 'common.on' : 'common.off'), inline: true },
        { name: ctx.t('config.minimalMode'), value: ctx.t(guildConfig.settings.minimalMode ? 'common.on' : 'common.off'), inline: true },
        { name: ctx.t('config.defaultVolume'), value: `${guildConfig.settings.volumePercent}%`, inline: true },
        { name: ctx.t('config.stay'), value: stayInVoiceLabel, inline: true },
        {
          name: ctx.t('config.earrape'),
          value: ctx.t(guildConfig.settings.earrapeProtectionEnabled ? 'config.earrapeOn' : 'config.earrapeOff'),
          inline: true,
        },
        { name: ctx.t('config.voteRatio'), value: String(guildConfig.settings.voteSkipRatio), inline: true },
        { name: ctx.t('config.voteMin'), value: String(guildConfig.settings.voteSkipMinVotes), inline: true },
        { name: ctx.t('config.djRoles'), value: roles },
        { name: ctx.t('config.musicLogChannel'), value: guildConfig.settings.musicLogChannelId ? `<#${guildConfig.settings.musicLogChannelId}>` : ctx.t('common.disabledLower') },
        { name: ctx.t('config.sessionActive'), value: ctx.t(session ? 'common.yes' : 'common.no'), inline: true },
      ]);
    },
  }));

  registry.register(createCommand({
    name: 'language',
    aliases: ['lang', 'sprache', 'idioma'],
    description: 'Show or change the language used for bot replies.',
    usage: 'language [en|de|pt-BR|server <code>|reset]',
    async execute(ctx: CommandContextLike) {
      const localeList = SUPPORTED_LOCALES.join(', ');
      const library = requireLibrary(ctx);

      const describe = (locale: Locale) => ({ flag: localeFlag(locale), label: localeLabel(locale) });

      const availableField = {
        name: ctx.t('language.available'),
        value: SUPPORTED_LOCALES
          .map((locale) => `${localeFlag(locale)} \`${locale}\` — ${localeLabel(locale)}`)
          .join('\n'),
      };

      const [first, ...rest] = ctx.args;
      const action = String(first ?? '').trim().toLowerCase();

      if (!action) {
        const guildLocale = normalizeLocale(ctx.guildConfig?.settings?.language);
        const userLocale = typeof library.getUserLocale === 'function'
          ? normalizeLocale(await library.getUserLocale(ctx.authorId))
          : null;

        const message = userLocale
          ? ctx.t('language.current', describe(userLocale))
          : ctx.t('language.currentInherited', describe(guildLocale ?? ctx.locale));

        await ctx.reply.info(message, [availableField], {
          footer: ctx.t('language.hint', { prefix: ctx.prefix }),
        });
        return;
      }

      if (action === 'reset' || action === 'clear') {
        if (typeof library.setUserLocale !== 'function') {
          throw new ValidationError(ctx.t('language.profilesUnavailable'));
        }
        await library.setUserLocale(ctx.authorId, null);
        const guildLocale = normalizeLocale(ctx.guildConfig?.settings?.language) ?? ctx.locale;
        await ctx.reply.success(ctx.t('language.reset', describe(guildLocale)));
        return;
      }

      if (action === 'server' || action === 'guild') {
        ensureGuild(ctx);
        const guildConfig = await getGuildConfigOrThrow(ctx);

        const requested = String(rest[0] ?? '').trim();
        if (!requested) {
          const current = normalizeLocale(guildConfig.settings.language) ?? ctx.locale;
          await ctx.reply.info(ctx.t('language.serverCurrent', describe(current)), [availableField]);
          return;
        }

        await ensureManageGuildAccess(ctx, 'access.changeServerLanguage');

        const locale = normalizeLocale(requested);
        if (!locale) {
          throw new ValidationError(ctx.t('language.unsupported', { value: requested, locales: localeList }));
        }

        await updateGuildConfig(ctx, { settings: { language: locale } });
        await ctx.reply.success(translate('language.serverUpdated', locale, describe(locale)));
        return;
      }

      const locale = normalizeLocale(action);
      if (!locale) {
        throw new ValidationError(ctx.t('language.unsupported', { value: action, locales: localeList }));
      }

      if (typeof library.setUserLocale !== 'function') {
        throw new ValidationError(ctx.t('language.profilesUnavailable'));
      }

      await library.setUserLocale(ctx.authorId, locale);
      await ctx.reply.success(translate('language.updated', locale, describe(locale)));
    },
  }));

  registry.register(createCommand({
    name: 'vote',
    aliases: ['perks'],
    description: 'Show voter perks and whether they are active for you.',
    usage: 'vote',
    async execute(ctx: CommandContextLike) {
      const voteService = ctx.voteService ?? null;
      const hasVoted = Boolean(voteService?.hasVoted?.(ctx.authorId));
      const available = Boolean(voteService?.enabled);

      const formatValue = (key: string, value: number | null): string => {
        if (value == null) return ctx.t('common.unknown');
        if (key === 'playCooldown') {
          return value <= 0 ? ctx.t('vote.value.none') : ctx.t('vote.value.seconds', { value: (value / 1000).toFixed(1) });
        }
        if (key === 'searchResults') return ctx.t('vote.value.results', { value });
        return ctx.t('vote.value.tracks', { value });
      };

      const fields = describePerkDelta(ctx.config).map((perk) => ({
        name: ctx.t(`vote.perk.${perk.key}` as TranslationKey),
        value: `${formatValue(perk.key, perk.base)} → **${formatValue(perk.key, perk.voter)}**`,
        inline: true,
      }));

      let summary: string;
      if (!available) summary = ctx.t('vote.unavailable');
      else if (hasVoted) summary = ctx.t('vote.alreadyVoted');
      else summary = ctx.t('vote.notVoted');

      const voteUrl = ctx.config.voteUrl ? String(ctx.config.voteUrl) : null;
      if (voteUrl && !hasVoted) {
        fields.push({ name: ctx.t('vote.link'), value: voteUrl, inline: false });
      }

      const reply = hasVoted ? ctx.reply.success : ctx.reply.info;
      await reply(summary, fields, { footer: ctx.t('vote.perksTitle') });
    },
  }));

  registry.register(createCommand({
    name: 'permissions',
    aliases: ['perms', 'permcheck'],
    description: 'Check which permissions the bot is missing here.',
    usage: 'permissions [#voice-channel]',
    async execute(ctx: CommandContextLike) {
      ensureGuild(ctx);

      const service = ctx.permissionService;
      if (!service?.checkBotPermissions) {
        throw new ValidationError(ctx.t('permcheck.reason.noRest'));
      }

      const explicitVoice = parseVoiceChannelArgument(ctx.args).channelId;
      const voiceChannelId = explicitVoice ?? ctx.activeVoiceChannelId ?? null;

      const textCheck = await service.checkBotPermissions(
        ctx.guildId,
        ctx.channelId,
        TEXT_PERMISSIONS
      );
      const voiceCheck = voiceChannelId
        ? await service.checkBotPermissions(ctx.guildId, voiceChannelId, VOICE_PERMISSIONS)
        : null;

      const fields = [
        {
          name: `${ctx.t('permissions.textChannel')} · <#${ctx.channelId}>`,
          value: permissionCheckFields(ctx.t, textCheck)
            .map((field) => `${field.name}\n${field.value}`)
            .join('\n\n') || '-',
        },
      ];

      if (voiceCheck && voiceChannelId) {
        fields.push({
          name: `${ctx.t('permissions.voiceChannel')} · <#${voiceChannelId}>`,
          value: permissionCheckFields(ctx.t, voiceCheck)
            .map((field) => `${field.name}\n${field.value}`)
            .join('\n\n') || '-',
        });
      } else {
        fields.push({
          name: ctx.t('permissions.voiceChannel'),
          value: ctx.t('permissions.noVoiceChannel'),
        });
      }

      const missingCount = textCheck.missing.length + (voiceCheck?.missing.length ?? 0);
      const unresolved = !textCheck.known || (voiceCheck != null && !voiceCheck.known);

      let summary: string;
      if (unresolved) {
        summary = describePermissionFailure(ctx.t, textCheck.known ? voiceCheck! : textCheck);
      } else if (missingCount > 0) {
        summary = ctx.t('permissions.summaryMissing', { count: missingCount });
      } else if (textCheck.source === 'owner') {
        summary = ctx.t('permissions.source.owner');
      } else if (textCheck.source === 'administrator') {
        summary = ctx.t('permissions.source.administrator');
      } else {
        summary = ctx.t('permissions.allGood');
      }

      const reply = missingCount > 0 || unresolved ? ctx.reply.warning : ctx.reply.success;
      await reply(summary, fields, {
        footer: missingCount > 0 ? ctx.t('permissions.hint') : null,
      });
    },
  }));
}


