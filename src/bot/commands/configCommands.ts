import { ValidationError } from '../../core/errors.ts';
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
      await ensureManageGuildAccess(ctx, 'change dedupe mode');

      if (!ctx.args.length) {
        await ctx.reply.info(`Dedupe is currently **${guildConfig.settings.dedupeEnabled ? 'on' : 'off'}**.`);
        return;
      }

      const value = parseOnOff(ctx.args[0], null);
      if (value == null) {
        throw new ValidationError('Use `on` or `off`.');
      }

      await updateGuildConfig(ctx, {
        settings: { dedupeEnabled: value },
      });
      await ctx.reply.success(`Dedupe is now **${value ? 'on' : 'off'}**.`);
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
      await ensureManageGuildAccess(ctx, 'change the default volume');

      if (!ctx.args.length) {
        await ctx.reply.info(`Default volume for new sessions is **${guildConfig.settings.volumePercent}%**.`);
        return;
      }

      const next = Number.parseInt(String(ctx.args[0] ?? ''), 10);
      if (!Number.isFinite(next) || next < 0 || next > 200) {
        throw new ValidationError('Volume must be an integer between 0 and 200.');
      }

      const updated = await updateGuildConfig(ctx, {
        settings: { volumePercent: next },
      });
      await ctx.reply.success(`Default volume for new sessions set to **${updated.settings.volumePercent}%**.`);
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
      await ensureManageGuildAccess(ctx, 'change 24/7 mode');
      const voiceChannelId = await resolveActiveVoiceChannelOrThrow(ctx, { fallbackCommand: '247' });
      const profile = await library.getVoiceProfile(ctx.guildId, voiceChannelId).catch(() => null);
      const current = typeof profile?.stayInVoiceEnabled === 'boolean'
        ? profile.stayInVoiceEnabled
        : Boolean(ctx.config.defaultStayInVoiceEnabled);

      if (!ctx.args.length) {
        await ctx.reply.info(`24/7 mode for <#${voiceChannelId}> is currently **${current ? 'on' : 'off'}**.`);
        return;
      }

      const value = parseOnOff(ctx.args[0], null);
      if (value == null) {
        throw new ValidationError('Use `on` or `off`.');
      }

      await library.setVoiceProfile(ctx.guildId, voiceChannelId, { stayInVoiceEnabled: value });
      await ctx.sessions.refreshVoiceProfileSettings?.(ctx.guildId, { voiceChannelId });
      await ctx.reply.success(`24/7 mode for <#${voiceChannelId}> is now **${value ? 'on' : 'off'}**.`);
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
      await ensureManageGuildAccess(ctx, 'manage DJ roles');

      const action = String(ctx.args[0] ?? 'list').toLowerCase();
      if (action === 'list') {
        const roles = [...guildConfig.settings.djRoleIds];
        if (!roles.length) {
          await ctx.reply.info('DJ role restriction is disabled (everyone can control playback).');
          return;
        }

        await ctx.reply.info('Configured DJ roles', [
          { name: 'Roles', value: roles.map((id) => `<@&${id}>`).join(', ') },
        ]);
        return;
      }

      if (action === 'clear') {
        await updateGuildConfig(ctx, {
          settings: { djRoleIds: [] },
        });
        await ctx.reply.success('Cleared all DJ role restrictions.');
        return;
      }

      if (!['add', 'remove'].includes(action)) {
        throw new ValidationError('Usage: `djrole [add|remove|clear|list] [@role|roleId]`');
      }

      const roleId = parseRoleId(ctx.args[1]);
      if (!roleId) {
        throw new ValidationError('Provide a role mention or role ID.');
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
      await ensureManageGuildAccess(ctx, 'change the command prefix');

      if (!ctx.args.length) {
        await ctx.reply.info(`Current prefix is **${guildConfig.prefix}**.`);
        return;
      }

      const nextPrefix = String(ctx.args[0] ?? '').trim();
      const updated = await updateGuildConfig(ctx, { prefix: nextPrefix });
      await ctx.reply.success(`Prefix updated to **${updated.prefix}**.`);
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
      await ensureManageGuildAccess(ctx, 'change music log channel');

      if (!ctx.args.length) {
        const current = guildConfig.settings.musicLogChannelId;
        await ctx.reply.info(
          current
            ? `Music log channel is <#${current}>.`
            : 'Music log channel is disabled (events are sent to the active command channel).'
        );
        return;
      }

      const raw = String(ctx.args[0] ?? '').trim().toLowerCase();
      if (raw === 'off' || raw === 'none' || raw === 'disable') {
        await updateGuildConfig(ctx, {
          settings: { musicLogChannelId: null },
        });
        await ctx.reply.success('Music log channel disabled.');
        return;
      }

      const channelId = parseTextChannelId(ctx.args[0]);
      if (!channelId) {
        throw new ValidationError('Provide `off`, a channel mention, or a channel id.');
      }

      await updateGuildConfig(ctx, {
        settings: { musicLogChannelId: channelId },
      });
      await ctx.reply.success(`Music log channel set to <#${channelId}>.`);
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
      await ensureManageGuildAccess(ctx, 'configure vote-skip');

      if (!ctx.args.length) {
        await ctx.reply.info('Vote-skip configuration', [
          { name: 'Ratio', value: String(guildConfig.settings.voteSkipRatio), inline: true },
          { name: 'Minimum Votes', value: String(guildConfig.settings.voteSkipMinVotes), inline: true },
        ]);
        return;
      }

      const mode = String(ctx.args[0] ?? '').toLowerCase();
      if (mode === 'ratio') {
        const raw = Number.parseFloat(String(ctx.args[1] ?? ''));
        if (!Number.isFinite(raw) || raw <= 0 || raw > 1) {
          throw new ValidationError('Ratio must be a number between 0 and 1.');
        }

        const updated = await updateGuildConfig(ctx, {
          settings: { voteSkipRatio: raw },
        });
        await ctx.reply.success(`Vote-skip ratio updated to **${updated.settings.voteSkipRatio}**.`);
        return;
      }

      if (mode === 'min') {
        const raw = Number.parseInt(String(ctx.args[1] ?? ''), 10);
        if (!Number.isFinite(raw) || raw <= 0 || raw > 100) {
          throw new ValidationError('Minimum votes must be an integer between 1 and 100.');
        }

        const updated = await updateGuildConfig(ctx, {
          settings: { voteSkipMinVotes: raw },
        });
        await ctx.reply.success(`Vote-skip minimum updated to **${updated.settings.voteSkipMinVotes}**.`);
        return;
      }

      throw new ValidationError('Usage: `voteskipcfg [ratio <0..1>|min <number>]`');
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
      const roles = guildConfig.settings.djRoleIds.length
        ? guildConfig.settings.djRoleIds.map((id) => `<@&${id}>`).join(', ')
        : 'none';

      await ctx.reply.info('Guild configuration', [
        { name: 'Prefix', value: guildConfig.prefix, inline: true },
        { name: 'Dedupe', value: guildConfig.settings.dedupeEnabled ? 'on' : 'off', inline: true },
        { name: 'Default Volume', value: `${guildConfig.settings.volumePercent}%`, inline: true },
        { name: '24/7', value: stayInVoiceEnabled ? 'on' : 'off', inline: true },
        { name: 'Vote Ratio', value: String(guildConfig.settings.voteSkipRatio), inline: true },
        { name: 'Vote Min', value: String(guildConfig.settings.voteSkipMinVotes), inline: true },
        { name: 'DJ Roles', value: roles },
        { name: 'Music Log Channel', value: guildConfig.settings.musicLogChannelId ? `<#${guildConfig.settings.musicLogChannelId}>` : 'disabled' },
        { name: 'Session Active', value: session ? 'yes' : 'no', inline: true },
      ]);
    },
  }));
}


