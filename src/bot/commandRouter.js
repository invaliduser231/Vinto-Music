import { ValidationError } from '../core/errors.js';
import { parseCommand } from '../utils/commandParser.js';
import { makeResponder } from './messageFormatter.js';
import { CommandRegistry } from './commandRegistry.js';
import { registerCommands } from './commands/index.js';
import { CommandRateLimiter } from './services/commandRateLimiter.js';
import {
  buildCommandReplyOptions,
  isDirectBotMention,
  isLeftEmoji,
  isRightEmoji,
  normalizeEmojiName,
  parseMentionCommand,
  parseSearchPickIndex,
  SEND_PERMISSION_PREFLIGHT_BYPASS,
  summarizeTrack,
} from './commandRouterUtils.js';
import {
  applySearchReactionSelection,
  handleUnknownGuildForChannel,
  registerHelpPagination,
  registerSearchReactionSelection,
  runWeeklyRecapSweep,
  safeReply,
  sendPaginated,
} from './commandRouterOperations.js';

export class CommandRouter {
  constructor(options) {
    this.config = options.config;
    this.logger = options.logger;
    this.rest = options.rest;
    this.gateway = options.gateway;
    this.sessions = options.sessions;
    this.guildConfigs = options.guildConfigs ?? null;
    this.voiceStateStore = options.voiceStateStore;
    this.lyrics = options.lyrics;
    this.library = options.library ?? null;
    this.permissionService = options.permissionService ?? null;
    this.guildStateCache = options.guildStateCache ?? null;
    this.botUserId = options.botUserId ?? null;
    this.startedAt = options.startedAt;
    this.metrics = options.metrics ?? null;
    this.errorReporter = options.errorReporter ?? null;
    this.guildOpLocks = new Map();
    this.helpPaginations = new Map();
    this.searchReactionSelections = new Map();
    this.sessionPanelLiveHandle = null;
    this.weeklySweepHandle = null;
    this.commandRateLimiter = options.commandRateLimiter ?? new CommandRateLimiter({
      logger: this.logger?.child?.('rate-limit'),
      enabled: this.config.commandRateLimitEnabled,
      userWindowMs: this.config.commandUserWindowMs,
      userMaxCommands: this.config.commandUserMax,
      guildWindowMs: this.config.commandGuildWindowMs,
      guildMaxCommands: this.config.commandGuildMax,
      bypassCommands: this.config.commandRateLimitBypass,
    });

    this.responder = makeResponder(this.rest, {
      enableEmbeds: this.config.enableEmbeds,
    });

    this.registry = new CommandRegistry();
    registerCommands(this.registry);

    this._bindSessionEvents();
    this._startBackgroundTasks();
  }

  setBotUserId(botUserId) {
    this.botUserId = botUserId ? String(botUserId) : null;
  }

  async handleMessage(message) {
    if (!message?.content) return;
    if (message.author?.bot) return;

    const guildId = message.guild_id ?? null;
    const guildConfig = await this._resolveGuildConfig(guildId);
    const configuredPrefix = guildConfig?.prefix ?? this.config.prefix;
    const fallbackPrefix = this.config.prefix;
    if (isDirectBotMention(message.content, this.botUserId)) {
      await this._safeReply(
        message.channel_id,
        'info',
        `Use \`${configuredPrefix}help\` to see all commands.`,
        null,
        buildCommandReplyOptions(message)
      );
      return;
    }

    let parsed = parseCommand(message.content, configuredPrefix);
    if (!parsed && this.config.allowDefaultPrefixFallback && configuredPrefix !== fallbackPrefix) {
      parsed = parseCommand(message.content, fallbackPrefix);
    }
    if (!parsed) {
      parsed = parseMentionCommand(message.content, this.botUserId);
    }
    if (!parsed) return;

    const command = this.registry.resolve(parsed.name);
    if (!command) {
      this.metrics?.commandsTotal?.inc?.(1, { command: parsed.name.toLowerCase(), outcome: 'unknown' });
      return;
    }

    const context = this._buildContext(message, parsed, command, {
      prefix: configuredPrefix,
      guildConfig,
    });
    if (context.guildId && this.sessions.has(context.guildId, {
      voiceChannelId: context.activeVoiceChannelId,
      textChannelId: context.channelId,
    })) {
      this.sessions.bindTextChannel(context.guildId, context.channelId, {
        voiceChannelId: context.activeVoiceChannelId,
        textChannelId: context.channelId,
      });
    }

    try {
      if (
        context.guildId
        && this.permissionService
        && !SEND_PERMISSION_PREFLIGHT_BYPASS.has(String(command.name ?? '').toLowerCase())
      ) {
        const canSend = await this.permissionService.canBotSendMessages(context.guildId, context.channelId);
        if (canSend === false) {
          this.logger?.warn?.('Bot lacks send permission in command channel', {
            guildId: context.guildId,
            channelId: context.channelId,
            command: command.name,
          });
          this.metrics?.commandsTotal?.inc?.(1, { command: command.name, outcome: 'blocked_bot_send_perm' });
          return;
        }
      }

      const rateCheck = this.commandRateLimiter.consume({
        guildId: context.guildId,
        userId: context.authorId,
        commandName: command.name,
      });
      if (!rateCheck.allowed) {
        const retrySec = Math.max(0.1, (rateCheck.retryAfterMs ?? 1_000) / 1000).toFixed(1);
        throw new ValidationError(`Rate limit hit (${rateCheck.scope}). Please retry in ${retrySec}s.`);
      }

      await command.execute(context);
      this.metrics?.commandsTotal?.inc?.(1, { command: command.name, outcome: 'success' });
    } catch (err) {
      if (err instanceof ValidationError) {
        this.metrics?.commandsTotal?.inc?.(1, { command: command.name, outcome: 'validation_error' });
        await context.reply.warning(err.message);
        return;
      }

      this.metrics?.commandsTotal?.inc?.(1, { command: command.name, outcome: 'internal_error' });
      this.logger?.error?.('Command execution failed', {
        command: command.name,
        guildId: context.guildId,
        channelId: context.channelId,
        error: err instanceof Error ? err.message : String(err),
      });
      this.errorReporter?.captureException?.(err, {
        source: 'command_router',
        command: command.name,
        guildId: context.guildId,
        channelId: context.channelId,
      });

      await context.reply.error('Command failed unexpectedly. Please try again.');
    }
  }

  async handleReactionAdd(payload) {
    const guildId = payload?.guild_id ?? payload?.guildId ?? null;
    const channelId = payload?.channel_id ?? payload?.channelId ?? null;
    const messageId = payload?.message_id ?? payload?.messageId ?? null;
    const userId = payload?.user_id ?? payload?.userId ?? payload?.member?.user?.id ?? null;
    if (!guildId || !channelId || !messageId || !userId) return;
    if (this.botUserId && String(userId) === String(this.botUserId)) return;

    const emoji = normalizeEmojiName(payload);
    const pageState = this.helpPaginations.get(String(messageId));
    if (pageState) {
      const direction = isLeftEmoji(emoji) ? -1 : (isRightEmoji(emoji) ? 1 : 0);
      if (direction !== 0) {
        const nextIndex = Math.max(0, Math.min(pageState.pages.length - 1, pageState.index + direction));
        if (nextIndex !== pageState.index) {
          pageState.index = nextIndex;
          pageState.updatedAt = Date.now();
          await this.rest.editMessage(pageState.channelId, pageState.messageId, pageState.pages[pageState.index]).catch(() => null);
        }
      }
      return;
    }

    const searchState = this.searchReactionSelections.get(String(messageId));
    if (searchState) {
      if (Date.now() > searchState.expiresAt) {
        this.searchReactionSelections.delete(String(messageId));
        return;
      }

      if (String(userId) !== String(searchState.userId)) {
        return;
      }

      const pickedIndex = parseSearchPickIndex(emoji);
      if (!pickedIndex || pickedIndex > searchState.tracks.length) {
        return;
      }

      this.searchReactionSelections.delete(String(messageId));
      await this._applySearchReactionSelection(searchState, pickedIndex, userId);
      return;
    }

    return;
  }

  _buildContext(message, parsed, command, options = {}) {
    const channelId = message.channel_id;
    const commandReplyOptions = buildCommandReplyOptions(message);
    const activeVoiceChannelId = this.voiceStateStore.resolveMemberVoiceChannel(message);

    return {
      config: this.config,
      prefix: options.prefix ?? this.config.prefix,
      logger: this.logger,
      rest: this.rest,
      gateway: this.gateway,
      sessions: this.sessions,
      guildConfigs: this.guildConfigs,
      guildConfig: options.guildConfig ?? null,
      voiceStateStore: this.voiceStateStore,
      lyrics: this.lyrics,
      library: this.library,
      permissionService: this.permissionService,
      guildStateCache: this.guildStateCache,
      botUserId: this.botUserId,
      registry: this.registry,
      startedAt: this.startedAt,
      withGuildOpLock: (key, fn) => this._withGuildOpLock(message.guild_id ?? null, key, fn),
      refreshSessionPanel: async () => {
        return null;
      },
      registerHelpPagination: async (channelId, messageId, pages) => {
        await this._registerHelpPagination(channelId, messageId, pages);
      },
      registerSearchReactionSelection: async (messageId, tracks, timeoutMs = null) => {
        await this._registerSearchReactionSelection({
          guildId: message.guild_id ?? null,
          channelId,
          messageId,
          userId: message.author?.id ?? message.user_id ?? message.member?.user?.id ?? null,
          tracks,
          timeoutMs,
        });
      },
      sendPaginated: async (pages) => {
        await this._sendPaginated(channelId, pages, commandReplyOptions);
      },

      message,
      command,
      commandName: parsed.name,
      args: parsed.args,
      rawArgs: parsed.rawArgs,
      guildId: message.guild_id ?? null,
      channelId,
      activeVoiceChannelId,
      authorId: message.author?.id ?? message.user_id ?? message.member?.user?.id ?? null,

      safeTyping: async () => {
        this.rest.sendTyping(channelId).catch(() => {
          // typing indicator is optional
        });
      },

      reply: {
        info: async (text, fields = null, embedOptions = null) => this._safeReply(
          channelId, 'info', text, fields, commandReplyOptions, embedOptions
        ),
        success: async (text, fields = null, embedOptions = null) => this._safeReply(
          channelId, 'success', text, fields, commandReplyOptions, embedOptions
        ),
        warning: async (text, fields = null, embedOptions = null) => this._safeReply(
          channelId, 'warning', text, fields, commandReplyOptions, embedOptions
        ),
        error: async (text, fields = null, embedOptions = null) => this._safeReply(
          channelId, 'error', text, fields, commandReplyOptions, embedOptions
        ),
        plain: async (text) => this._safeReply(channelId, 'plain', text, null, commandReplyOptions),
      },
    };
  }

  async _withGuildOpLock(guildId, key, fn) {
    if (!guildId) return fn();
    const lockKey = `${String(guildId)}:${String(key ?? 'default')}`;
    if (this.guildOpLocks.has(lockKey)) {
      throw new ValidationError('This action is already running. Please retry in a moment.');
    }
    this.guildOpLocks.set(lockKey, Date.now());
    try {
      return await fn();
    } finally {
      this.guildOpLocks.delete(lockKey);
    }
  }

  async _resolveGuildConfig(guildId) {
    if (!guildId || !this.guildConfigs) return null;

    try {
      return await this.guildConfigs.get(guildId);
    } catch (err) {
      this.logger?.warn?.('Failed to resolve guild config', {
        guildId,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  _bindSessionEvents() {
    this.sessions.on('trackStart', async ({ session, track }) => {
      const channelId = this._resolveEventChannelId(session);
      if (!channelId) return;

      await this._safeReply(
        channelId,
        'info',
        `Now playing: **${track.title}** (${track.duration})`,
        null,
        null,
        {
          thumbnailUrl: track?.thumbnailUrl ?? null,
          imageUrl: track?.thumbnailUrl ?? null,
        }
      );
      await this._emitWebhookEvent(session, 'track_start', `Now playing: ${summarizeTrack(track)}`);

      if (this.library?.recordUserSignal && track?.requestedBy && /^\d{6,}$/.test(String(track.requestedBy))) {
        await this.library.recordUserSignal(session.guildId, String(track.requestedBy), 'play', track).catch(() => null);
      }
    });

    this.sessions.on('trackError', async ({ session, track, error }) => {
      const channelId = this._resolveEventChannelId(session);
      if (!channelId) return;
      await this._safeReply(
        channelId,
        'error',
        `Playback error on **${track?.title ?? 'unknown'}**: ${error?.message ?? 'unknown error'}`
      );
      await this._emitWebhookEvent(session, 'track_error', `Playback error: ${error?.message ?? 'unknown error'}`);
    });

    this.sessions.on('queueEmpty', async ({ session, reason = null }) => {
      const activeSession = this.sessions.get(session?.guildId, { sessionId: session?.sessionId });
      if (activeSession && activeSession !== session) return;
      const player = session?.player ?? null;
      if (player?.playing || player?.currentTrack) {
        this.logger?.debug?.('Skipping queueEmpty announcement while playback is still active', {
          guildId: session?.guildId ?? null,
          playing: Boolean(player?.playing),
          hasCurrentTrack: Boolean(player?.currentTrack),
        });
        return;
      }
      if (reason === 'startup_error') {
        this.logger?.debug?.('Skipping queueEmpty announcement for startup playback failure', {
          guildId: session?.guildId ?? null,
        });
        return;
      }

      const channelId = this._resolveEventChannelId(session);
      if (!channelId) return;

      const idleSeconds = Math.floor(this.config.sessionIdleMs / 1000);
      const suffix = session.settings.stayInVoiceEnabled
        ? '24/7 mode is enabled, so I will stay connected.'
        : `I will disconnect after ${idleSeconds}s of inactivity.`;
      await this._safeReply(
        channelId,
        'info',
        `Queue is empty. ${suffix}`
      );
      await this._emitWebhookEvent(session, 'queue_empty', 'Queue is now empty.');
    });

    this.sessions.on('destroyed', async ({ session, reason }) => {
      const channelId = this._resolveEventChannelId(session);
      if (!channelId) return;
      if (reason === 'manual_command') return;

      const reasonText = reason === 'idle_timeout'
        ? 'Session closed due to inactivity.'
        : `Session closed (${reason}).`;

      await this._safeReply(channelId, 'warning', reasonText);
      await this._emitWebhookEvent(session, 'session_closed', reasonText);
    });

    this.sessions.on('trackEnd', async ({ session, track, seekRestart, skipped }) => {
      if (!this.library || !session?.guildId || !track || seekRestart) return;

      await this.library.appendGuildHistory(session.guildId, track).catch((err) => {
        this.logger?.warn?.('Failed to persist guild history entry', {
          guildId: session.guildId,
          error: err instanceof Error ? err.message : String(err),
        });
      });

      if (skipped && this.library.recordUserSignal && track?.requestedBy && /^\d{6,}$/.test(String(track.requestedBy))) {
        await this.library.recordUserSignal(session.guildId, String(track.requestedBy), 'skip', track).catch(() => null);
      }
    });
  }

  _resolveEventChannelId(session) {
    return session?.settings?.musicLogChannelId ?? session?.textChannelId ?? null;
  }

  _computeVoteSkipRequirement(guildId, session) {
    const channelId = session?.connection?.channelId ?? null;
    if (!guildId || !channelId) return 1;

    const listeners = this.voiceStateStore.countUsersInChannel(
      guildId,
      channelId,
      this.botUserId ? [this.botUserId] : []
    );
    if (listeners <= 1) return 1;
    const ratio = Number.isFinite(session?.settings?.voteSkipRatio) ? session.settings.voteSkipRatio : 0.5;
    const minVotes = Number.isFinite(session?.settings?.voteSkipMinVotes) ? session.settings.voteSkipMinVotes : 2;
    return Math.max(minVotes, Math.ceil(listeners * ratio));
  }

  async _sendSessionPanelUpdate(session, reason = 'update') {
    return null;
  }

  async _withSessionPanelUpdateLock(guildId, fn) {
    return fn();
  }

  async _ensureSessionPanelReactions(channelId, messageId) {
    return null;
  }

  async _emitWebhookEvent(session, type, text) {
    if (!this.library || !session?.guildId) return;
    const cfg = await this.library.getGuildFeatureConfig(session.guildId).catch(() => null);
    const webhookUrl = cfg?.webhookUrl ?? null;
    if (!webhookUrl || !/^https?:\/\//.test(String(webhookUrl))) return;

    const payload = {
      content: `[music:${type}] ${text}`.slice(0, 1900),
    };

    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(8_000),
    }).catch(() => null);
  }

  _startBackgroundTasks() {
    if (!this.library?.buildGuildRecap || !this.library?.getRecapState) return;
    const run = () => {
      this._runWeeklyRecapSweep().catch((err) => {
        this.logger?.warn?.('Weekly recap sweep failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    };
    this.weeklySweepHandle = setInterval(run, 60 * 60 * 1000);
    this.weeklySweepHandle.unref?.();
    run();

    const cleanup = () => {
      const now = Date.now();
      for (const [key, state] of this.helpPaginations.entries()) {
        if ((now - state.updatedAt) > (30 * 60 * 1000)) {
          this.helpPaginations.delete(key);
        }
      }
      for (const [key, state] of this.searchReactionSelections.entries()) {
        if (now > state.expiresAt) {
          this.searchReactionSelections.delete(key);
        }
      }
    };
    const helpCleanupHandle = setInterval(cleanup, 5 * 60 * 1000);
    helpCleanupHandle.unref?.();
  }

  _startSessionPanelLiveTicker() {
    return;
  }

  async _tickSessionPanels() {
    return;
  }

  async _registerHelpPagination(channelId, messageId, pages) {
    return registerHelpPagination(this, channelId, messageId, pages);
  }

  async _runWeeklyRecapSweep() {
    return runWeeklyRecapSweep(this);
  }

  async _sendPaginated(channelId, pages, replyOptions = null) {
    return sendPaginated(this, channelId, pages, replyOptions);
  }

  async _registerSearchReactionSelection({
    guildId,
    channelId,
    messageId,
    userId,
    tracks,
    timeoutMs = null,
  }) {
    return registerSearchReactionSelection(this, {
      guildId,
      channelId,
      messageId,
      userId,
      tracks,
      timeoutMs,
    });
  }

  async _applySearchReactionSelection(state, pickedIndex, userId) {
    return applySearchReactionSelection(this, state, pickedIndex, userId);
  }

  async _safeReply(channelId, type, text, fields = null, replyOptions = null, embedOptions = null) {
    return safeReply(this, channelId, type, text, fields, replyOptions, embedOptions);
  }

  _handleUnknownGuildForChannel(channelId) {
    return handleUnknownGuildForChannel(this, channelId);
  }
}

