import { ValidationError } from '../core/errors.ts';
import { parseCommand } from '../utils/commandParser.ts';
import { makeResponder } from './messageFormatter.ts';
import { CommandRegistry } from './commandRegistry.ts';
import { registerCommands } from './commands/index.ts';
import { CommandRateLimiter } from './services/commandRateLimiter.ts';
import {
  SEARCH_PICK_EMOJIS,
  buildCommandReplyOptions,
  isDirectBotMention,
  isLeftEmoji,
  isRightEmoji,
  normalizeEmojiName,
  parseMentionCommand,
  parseSearchPickIndex,
  SEND_PERMISSION_PREFLIGHT_BYPASS,
  summarizeTrack,
} from './commandRouterUtils.ts';
import {
  applySearchReactionSelection,
  handleUnknownGuildForChannel,
  registerHelpPagination,
  registerSearchReactionSelection,
  runWeeklyRecapSweep,
  safeReply,
  sendPaginated,
} from './commandRouterOperations.ts';
import type { BivariantCallback, CommandDefinition, MessagePayload, ReplyOptions, LoggerLike } from '../types/core.ts';

type RouterContextOptions = {
  prefix?: string;
  guildConfig?: { prefix?: string; settings?: { minimalMode?: boolean } } | null;
};

type RouterConfig = {
  prefix: string;
  allowDefaultPrefixFallback?: boolean;
  commandRateLimitEnabled?: boolean;
  commandUserWindowMs?: number;
  commandUserMax?: number;
  commandGuildWindowMs?: number;
  commandGuildMax?: number;
  commandRateLimitBypass?: string[];
  enableEmbeds?: boolean;
  sessionIdleMs: number;
  searchPickTimeoutMs?: number;
  [key: string]: unknown;
};

type GuildConfigResolver = {
  get: (guildId: string) => Promise<{ prefix?: string; settings?: { minimalMode?: boolean } } | null>;
};

type RouterRest = {
  sendTyping: (channelId: string) => Promise<unknown>;
  editMessage: (channelId: string, messageId: string, payload: MessagePayload) => Promise<unknown>;
  addReactionToMessage?: (channelId: string, messageId: string, emoji: string) => Promise<unknown>;
  removeUserReactionFromMessage?: (channelId: string, messageId: string, emoji: string, userId: string) => Promise<unknown>;
  sendMessage: (channelId: string, payload: MessagePayload) => Promise<unknown>;
  listCurrentUserGuilds?: (options?: { limit?: number; after?: string | null }) => Promise<unknown>;
};

type SessionLookup = {
  guildId?: string | null;
  sessionId?: string | null;
  textChannelId?: string | null;
  activeVoiceChannelId?: string | null;
  settings?: {
    musicLogChannelId?: string | null;
    stayInVoiceEnabled?: boolean;
    minimalMode?: boolean;
    dedupeEnabled?: boolean;
    voteSkipRatio?: number;
    voteSkipMinVotes?: number;
  };
  connection?: {
    channelId?: string | null;
  };
  player?: {
    playing?: boolean;
    currentTrack?: unknown;
    pendingTracks?: unknown[];
    getProgressSeconds?: () => number;
    createTrackFromData?: (track: unknown, requestedBy?: string | null) => unknown;
    enqueueResolvedTracks?: (tracks: unknown[], options?: Record<string, unknown>) => unknown[];
    play?: () => Promise<unknown>;
  };
};

type SessionManagerLike = {
  has: (guildId: string, selector?: Record<string, unknown>) => boolean;
  bindTextChannel: (guildId: string, channelId: string, selector?: Record<string, unknown>) => unknown;
  get: (guildId: string, selector?: Record<string, unknown>) => SessionLookup | null;
  destroy: (guildId: string, reason?: string, selector?: Record<string, unknown>) => Promise<unknown>;
  on: (event: string, handler: BivariantCallback<unknown[], void | Promise<void>>) => unknown;
  sessions: Map<string, SessionLookup>;
};

type RouterMessage = Record<string, unknown> & {
  content?: string;
  channel_id?: string;
  guild_id?: string;
  user_id?: string;
  author?: { id?: string; bot?: boolean } | null;
  member?: { user?: { id?: string } | null } | null;
};

type RouterReactionPayload = Record<string, unknown> & {
  guild_id?: string;
  guildId?: string;
  channel_id?: string;
  channelId?: string;
  message_id?: string;
  messageId?: string;
  user_id?: string;
  userId?: string;
  emoji?: { name?: string | null } | null;
  emoji_name?: string | null;
  reaction?: string | null;
  member?: { user?: { id?: string } | null } | null;
};

type SessionEventPayload = {
  session?: SessionLookup | null;
  track?: { title?: string; duration?: string; requestedBy?: string | null; source?: string | null; metadataDeferred?: boolean } | null;
  error?: { message?: string | null } | null;
  reason?: string | null;
  seekRestart?: boolean;
  skipped?: boolean;
  restoredFromPersistentSession?: boolean;
};

type VoiceStateStoreLike = {
  resolveMemberVoiceChannel?: (message: Record<string, unknown>) => string | null;
  countUsersInChannel: (guildId: string, channelId: string, excludedUserIds?: string[]) => number;
};

type LibraryLike = {
  recordUserSignal?: (guildId: string, userId: string, signal: string, track?: unknown) => Promise<unknown>;
  appendGuildHistory?: (guildId: string, track: unknown) => Promise<unknown>;
  getGuildFeatureConfig?: (guildId: string) => Promise<{ webhookUrl?: string | null; recapChannelId?: string | null; queueGuard?: unknown } | null>;
  buildGuildRecap?: (guildId: string, days?: number) => Promise<{ playCount: number; topTracks: Array<{ title: string; plays: number }>; topRequesters: Array<{ userId: string; plays: number }> } | null>;
  getRecapState?: (guildId: string) => Promise<{ lastWeeklyRecapAt?: string | Date | null } | null>;
  markRecapSent?: (guildId: string, sentAt?: Date) => Promise<unknown>;
};

type PermissionServiceLike = {
  canBotSendMessages: (guildId: string, channelId: string) => Promise<boolean | null>;
};

type MetricsLike = {
  commandsTotal?: {
    inc?: (value?: number, labels?: Record<string, string>) => void;
  };
};

type ErrorReporterLike = {
  captureException?: (error: unknown, context?: Record<string, unknown>) => void;
};

type HelpPaginationState = {
  channelId: string;
  messageId: string;
  pages: MessagePayload[];
  index: number;
  updatedAt: number;
};

type SearchReactionState = {
  guildId: string;
  channelId: string;
  messageId: string;
  userId: string;
  tracks: unknown[];
  expiresAt: number;
};

const DEFERRED_TRACK_START_MESSAGE_GRACE_MS = 1200;

function delay(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

type RouterLogger = LoggerLike;

type CommandRouterOptions = {
  config: RouterConfig;
  logger?: RouterLogger;
  rest: RouterRest;
  gateway: Record<string, unknown>;
  sessions: SessionManagerLike;
  guildConfigs?: GuildConfigResolver | null;
  voiceStateStore: VoiceStateStoreLike;
  lyrics: unknown;
  library?: LibraryLike | null;
  permissionService?: PermissionServiceLike | null;
  guildStateCache?: unknown;
  botUserId?: string | null;
  startedAt?: number | Date | null;
  metrics?: MetricsLike | null;
  errorReporter?: ErrorReporterLike | null;
  commandRateLimiter?: CommandRateLimiter | null;
};

export class CommandRouter {
  config: RouterConfig;
  logger: RouterLogger | undefined;
  rest: RouterRest;
  gateway: Record<string, unknown>;
  sessions: SessionManagerLike;
  guildConfigs: GuildConfigResolver | null;
  voiceStateStore: VoiceStateStoreLike;
  lyrics: unknown;
  library: LibraryLike | null;
  permissionService: PermissionServiceLike | null;
  guildStateCache: unknown;
  botUserId: string | null;
  startedAt: number | Date | null | undefined;
  metrics: MetricsLike | null;
  errorReporter: ErrorReporterLike | null;
  guildOpLocks: Map<string, number>;
  helpPaginations: Map<string, HelpPaginationState>;
  searchReactionSelections: Map<string, SearchReactionState>;
  weeklySweepHandle: NodeJS.Timeout | null;
  ephemeralCleanupHandle: NodeJS.Timeout | null;
  commandRateLimiter: CommandRateLimiter;
  responder: ReturnType<typeof makeResponder>;
  registry: CommandRegistry;
  constructor(options: CommandRouterOptions) {
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
    this.weeklySweepHandle = null;
    this.ephemeralCleanupHandle = null;
    const rateLimiterOptions = {
      ...(this.logger?.child ? { logger: this.logger.child('rate-limit') } : {}),
      ...(this.config.commandRateLimitEnabled !== undefined ? { enabled: this.config.commandRateLimitEnabled } : {}),
      ...(this.config.commandUserWindowMs !== undefined ? { userWindowMs: this.config.commandUserWindowMs } : {}),
      ...(this.config.commandUserMax !== undefined ? { userMaxCommands: this.config.commandUserMax } : {}),
      ...(this.config.commandGuildWindowMs !== undefined ? { guildWindowMs: this.config.commandGuildWindowMs } : {}),
      ...(this.config.commandGuildMax !== undefined ? { guildMaxCommands: this.config.commandGuildMax } : {}),
      ...(this.config.commandRateLimitBypass !== undefined ? { bypassCommands: this.config.commandRateLimitBypass } : {}),
    };
    this.commandRateLimiter = options.commandRateLimiter ?? new CommandRateLimiter(rateLimiterOptions);

    this.responder = makeResponder(this.rest, this.config.enableEmbeds !== undefined
      ? { enableEmbeds: this.config.enableEmbeds }
      : {});

    this.registry = new CommandRegistry();
    registerCommands(this.registry);

    this._bindSessionEvents();
    this._startBackgroundTasks();
  }

  setBotUserId(botUserId: string | null | undefined) {
    this.botUserId = botUserId ? String(botUserId) : null;
  }

  async handleMessage(message: RouterMessage) {
    const content = String(message?.content ?? '');
    const channelId = String(message?.channel_id ?? '').trim();
    if (!content || !channelId) return;
    if (message.author?.bot) return;

    const guildId = message.guild_id ?? null;
    const guildConfig = await this._resolveGuildConfig(guildId);
    const configuredPrefix = guildConfig?.prefix ?? this.config.prefix;
    const fallbackPrefix = this.config.prefix;
    if (isDirectBotMention(content, this.botUserId)) {
      await this._safeReply(
        channelId,
        'info',
        `Use \`${configuredPrefix}help\` to see all commands.`,
        undefined,
        undefined
      );
      return;
    }

    let parsed = parseCommand(content, configuredPrefix);
    if (!parsed && this.config.allowDefaultPrefixFallback && configuredPrefix !== fallbackPrefix) {
      parsed = parseCommand(content, fallbackPrefix);
    }
    if (!parsed) {
      parsed = parseMentionCommand(content, this.botUserId);
    }
    if (!parsed) return;

    const command = this.registry.resolve(parsed.name);
    if (!command) {
      this.metrics?.commandsTotal?.inc?.(1, { command: 'unknown', outcome: 'unknown' });
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

      const commandName = String(command.name ?? '').trim();
      if (!command.execute || !commandName) {
        throw new ValidationError(`Command "${command.name}" is not executable.`);
      }
      await command.execute(context);
      this.metrics?.commandsTotal?.inc?.(1, { command: commandName, outcome: 'success' });
    } catch (err) {
      const commandName = String(command.name ?? '').trim() || 'unknown';
      if (err instanceof ValidationError) {
        this.metrics?.commandsTotal?.inc?.(1, { command: commandName, outcome: 'validation_error' });
        await context.reply.warning(err.message);
        return;
      }

      this.metrics?.commandsTotal?.inc?.(1, { command: commandName, outcome: 'internal_error' });
      this.logger?.error?.('Command execution failed', {
        command: commandName,
        guildId: context.guildId,
        channelId: context.channelId,
        error: err instanceof Error ? err.message : String(err),
      });
      this.errorReporter?.captureException?.(err, {
        source: 'command_router',
        command: commandName,
        guildId: context.guildId,
        channelId: context.channelId,
      });

      await context.reply.error('Command failed unexpectedly. Please try again.');
    }
  }

  async handleReactionAdd(payload: RouterReactionPayload) {
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
        const reactionEmoji = direction < 0 ? '\u2B05\uFE0F' : '\u27A1\uFE0F';
        await this.rest.removeUserReactionFromMessage?.(String(channelId), String(messageId), reactionEmoji, String(userId)).catch(() => null);
        const nextIndex = Math.max(0, Math.min(pageState.pages.length - 1, pageState.index + direction));
        if (nextIndex !== pageState.index) {
          pageState.index = nextIndex;
          pageState.updatedAt = Date.now();
          const currentPage = pageState.pages[pageState.index];
          if (currentPage) {
            await this.rest.editMessage(pageState.channelId, pageState.messageId, currentPage).catch(() => null);
          }
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

      const reactionEmoji = SEARCH_PICK_EMOJIS[pickedIndex - 1] ?? emoji;
      await this.rest.removeUserReactionFromMessage?.(String(channelId), String(messageId), reactionEmoji, String(userId)).catch(() => null);
      this.searchReactionSelections.delete(String(messageId));
      await this._applySearchReactionSelection(searchState, pickedIndex, userId);
      return;
    }

    return;
  }

  _buildContext(message: RouterMessage, parsed: { name: string; args: string[]; rawArgs: string }, command: CommandDefinition, options: RouterContextOptions = {}) {
    const channelId = String(message.channel_id ?? '').trim();
    const commandReplyOptions = buildCommandReplyOptions(message);
    const activeVoiceChannelId = this.voiceStateStore.resolveMemberVoiceChannel?.(message) ?? null;

    return {
      config: {
        ...this.config,
        ...(options.guildConfig?.settings?.minimalMode === true ? { minimalMode: true } : {}),
      },
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
      withGuildOpLock: (key: string, fn: () => Promise<unknown>) => this._withGuildOpLock(message.guild_id ?? null, key, fn),
      registerHelpPagination: async (channelId: string, messageId: string, pages: MessagePayload[]) => {
        await this._registerHelpPagination(channelId, messageId, pages);
      },
      registerSearchReactionSelection: async (messageId: string, tracks: unknown[], timeoutMs: number | null = null) => {
        await this._registerSearchReactionSelection({
          guildId: message.guild_id ?? null,
          channelId,
          messageId,
          userId: message.author?.id ?? message.user_id ?? message.member?.user?.id ?? null,
          tracks,
          timeoutMs,
        });
      },
      sendPaginated: async (pages: MessagePayload[]) => {
        await this._sendPaginated(channelId, pages, commandReplyOptions ?? null);
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
        info: async (text: string, fields: unknown = null, embedOptions: unknown = null) => this._safeReply(
          channelId, 'info', text, fields, commandReplyOptions ?? null, {
            ...(embedOptions && typeof embedOptions === 'object' ? embedOptions as Record<string, unknown> : {}),
            ...(options.guildConfig?.settings?.minimalMode === true ? { minimalMode: true } : {}),
          }
        ),
        success: async (text: string, fields: unknown = null, embedOptions: unknown = null) => this._safeReply(
          channelId, 'success', text, fields, commandReplyOptions ?? null, {
            ...(embedOptions && typeof embedOptions === 'object' ? embedOptions as Record<string, unknown> : {}),
            ...(options.guildConfig?.settings?.minimalMode === true ? { minimalMode: true } : {}),
          }
        ),
        warning: async (text: string, fields: unknown = null, embedOptions: unknown = null) => this._safeReply(
          channelId, 'warning', text, fields, commandReplyOptions ?? null, {
            ...(embedOptions && typeof embedOptions === 'object' ? embedOptions as Record<string, unknown> : {}),
            ...(options.guildConfig?.settings?.minimalMode === true ? { minimalMode: true } : {}),
          }
        ),
        error: async (text: string, fields: unknown = null, embedOptions: unknown = null) => this._safeReply(
          channelId, 'error', text, fields, commandReplyOptions ?? null, {
            ...(embedOptions && typeof embedOptions === 'object' ? embedOptions as Record<string, unknown> : {}),
            ...(options.guildConfig?.settings?.minimalMode === true ? { minimalMode: true } : {}),
          }
        ),
        plain: async (text: string) => this._safeReply(channelId, 'plain', text, null, commandReplyOptions ?? null),
      },
    };
  }

  async _withGuildOpLock(guildId: string | null, key: string, fn: () => Promise<unknown>) {
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

  async _resolveGuildConfig(guildId: string | null) {
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
    this.sessions.on('trackStart', async (payload?: SessionEventPayload) => {
      const { session, track, restoredFromPersistentSession } = payload ?? {};
      const channelId = this._resolveEventChannelId(session);
      if (!channelId || !track) return;
      if (restoredFromPersistentSession) {
        return;
      }
      const voiceChannelId = String(session?.connection?.channelId ?? '').trim();
      const voiceChannelTag = voiceChannelId ? ` in <#${voiceChannelId}>` : '';
      const isYouTubeMixPlaceholder = String(track?.source ?? '').trim().toLowerCase() === 'youtube'
        && String(track?.title ?? '').trim() === 'YouTube Mix Track'
        && String(track?.duration ?? '').trim().toLowerCase() === 'unknown';
      if (isYouTubeMixPlaceholder) {
        return;
      }
      if (track?.metadataDeferred === true) {
        await delay(DEFERRED_TRACK_START_MESSAGE_GRACE_MS);
        if (track?.metadataDeferred === true) {
          this.logger?.debug?.('Skipping deferred trackStart popup until metadata is available', {
            channelId,
            voiceChannelId: voiceChannelId || null,
            title: String(track?.title ?? '').trim() || null,
            duration: String(track?.duration ?? '').trim() || null,
          });
          return;
        }
      }

      await this._safeReply(
        channelId,
        'info',
        `Now playing${voiceChannelTag}: **${track.title}** (${track.duration})`,
        null,
        null,
        session?.settings?.minimalMode ? { minimalMode: true } : undefined
      );
      await this._emitWebhookEvent(session, 'track_start', `Now playing${voiceChannelTag}: ${summarizeTrack(track)}`);
    });

    this.sessions.on('trackError', async (payload?: SessionEventPayload) => {
      const { session, track, error } = payload ?? {};
      const channelId = this._resolveEventChannelId(session);
      if (!channelId) return;
      await this._safeReply(
        channelId,
        'error',
        `Playback error on **${track?.title ?? 'unknown'}**: ${error?.message ?? 'unknown error'}`,
        null,
        null,
        session?.settings?.minimalMode ? { minimalMode: true } : undefined
      );
      await this._emitWebhookEvent(session, 'track_error', `Playback error: ${error?.message ?? 'unknown error'}`);
    });

    this.sessions.on('queueEmpty', async (payload?: SessionEventPayload) => {
      const { session, reason = null } = payload ?? {};
      if (!session?.guildId) return;
      const activeSession = this.sessions.get(session.guildId, { sessionId: session?.sessionId });
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
      if (reason === 'startup_error' || reason === 'startup_error_limit') {
        this.logger?.debug?.('Skipping queueEmpty announcement for startup playback failure', {
          guildId: session?.guildId ?? null,
          reason,
        });
        return;
      }

      const channelId = this._resolveEventChannelId(session);
      if (!channelId) return;

      const idleSeconds = Math.floor(this.config.sessionIdleMs / 1000);
      const suffix = session.settings?.stayInVoiceEnabled
        ? '24/7 mode is enabled, so I will stay connected.'
        : `I will disconnect after ${idleSeconds}s of inactivity.`;
      await this._safeReply(
        channelId,
        'info',
        `Queue is empty. ${suffix}`,
        null,
        null,
        session?.settings?.minimalMode ? { minimalMode: true } : undefined
      );
      await this._emitWebhookEvent(session, 'queue_empty', 'Queue is now empty.');
    });

    this.sessions.on('destroyed', async (payload?: SessionEventPayload) => {
      const { session, reason } = payload ?? {};
      const channelId = this._resolveEventChannelId(session);
      if (!channelId) return;
      if (reason === 'manual_command') return;

      const reasonText = reason === 'idle_timeout'
        ? 'Session closed due to inactivity.'
        : `Session closed (${reason}).`;

      await this._safeReply(channelId, 'warning', reasonText, null, null, session?.settings?.minimalMode ? { minimalMode: true } : undefined);
      await this._emitWebhookEvent(session, 'session_closed', reasonText);
    });

    this.sessions.on('trackEnd', async (payload?: SessionEventPayload) => {
      const { session, track, seekRestart, skipped } = payload ?? {};
      if (!this.library || !session?.guildId || !track || seekRestart) return;

      await this.library.appendGuildHistory?.(session.guildId, track).catch((err) => {
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

  _resolveEventChannelId(session: SessionLookup | null | undefined) {
    return session?.settings?.musicLogChannelId ?? session?.textChannelId ?? null;
  }

  _computeVoteSkipRequirement(guildId: string | null, session: SessionLookup | null | undefined) {
    const channelId = session?.connection?.channelId ?? null;
    if (!guildId || !channelId || !this.voiceStateStore.countUsersInChannel) return 1;

    const listeners = this.voiceStateStore.countUsersInChannel(
      guildId,
      channelId ?? '',
      this.botUserId ? [this.botUserId] : []
    );
    if (listeners <= 1) return 1;
    const ratio = Number.isFinite(session?.settings?.voteSkipRatio) ? Number(session?.settings?.voteSkipRatio) : 0.5;
    const minVotes = Number.isFinite(session?.settings?.voteSkipMinVotes) ? Number(session?.settings?.voteSkipMinVotes) : 2;
    return Math.max(minVotes, Math.ceil(listeners * ratio));
  }

  async _emitWebhookEvent(session: SessionLookup | null | undefined, type: string, text: string) {
    const guildId = String(session?.guildId ?? '').trim();
    if (!this.library || !guildId) return;
    const cfg = await this.library.getGuildFeatureConfig?.(guildId).catch(() => null);
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
      for (const [key, startedAt] of this.guildOpLocks.entries()) {
        if ((now - startedAt) > (5 * 60 * 1000)) {
          this.guildOpLocks.delete(key);
        }
      }
    };
    cleanup();
    this.ephemeralCleanupHandle = setInterval(cleanup, 5 * 60 * 1000);
    this.ephemeralCleanupHandle.unref?.();

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
  }

  async _registerHelpPagination(channelId: string, messageId: string, pages: MessagePayload[]) {
    return registerHelpPagination(this, channelId, messageId, pages);
  }

  async _runWeeklyRecapSweep() {
    return runWeeklyRecapSweep(this);
  }

  async _sendPaginated(channelId: string, pages: MessagePayload[], replyOptions: ReplyOptions | null = null) {
    return sendPaginated(this as Parameters<typeof sendPaginated>[0], channelId, pages, replyOptions);
  }

  async _registerSearchReactionSelection({
    guildId,
    channelId,
    messageId,
    userId,
    tracks,
    timeoutMs = null,
  }: {
    guildId: string | null;
    channelId: string;
    messageId: string;
    userId: string | null;
    tracks: unknown[];
    timeoutMs?: number | null;
  }) {
    return registerSearchReactionSelection(this as Parameters<typeof registerSearchReactionSelection>[0], {
      guildId: guildId ?? '',
      channelId,
      messageId,
      userId: userId ?? '',
      tracks,
      timeoutMs,
    });
  }

  async _applySearchReactionSelection(state: SearchReactionState, pickedIndex: number, userId: string) {
    return applySearchReactionSelection(this, state, pickedIndex, userId);
  }

  async _safeReply(
    channelId: string,
    type: string,
    text: string,
    fields: unknown = null,
    replyOptions: ReplyOptions | null = null,
    embedOptions: unknown = null
  ) {
    return safeReply(
      this as Parameters<typeof safeReply>[0],
      channelId,
      type,
      text,
      fields as Parameters<typeof safeReply>[4],
      replyOptions,
      embedOptions as Parameters<typeof safeReply>[6]
    );
  }

  _handleUnknownGuildForChannel(channelId: string) {
    return handleUnknownGuildForChannel(this, channelId);
  }
}





