import { ValidationError } from '../core/errors.js';
import { parseCommand } from '../utils/commandParser.js';
import { makeResponder } from './messageFormatter.js';
import { buildEmbed } from './messageFormatter.js';
import { CommandRegistry } from './commandRegistry.js';
import { registerCommands } from './commands/index.js';
import { CommandRateLimiter } from './services/commandRateLimiter.js';

function normalizeEmojiName(payload) {
  return String(payload?.emoji?.name ?? payload?.emoji_name ?? payload?.reaction ?? '')
    .trim()
    .toLowerCase()
    .replace(/\uFE0F/g, '');
}

function isSkipEmoji(emoji) {
  return ['\u2705', '\u23ED', 'skip', 'next_track'].includes(emoji);
}

function isPauseEmoji(emoji) {
  return ['\u23F8', 'pause'].includes(emoji);
}

function isResumeEmoji(emoji) {
  return ['\u25B6', 'resume', 'play'].includes(emoji);
}

function isFavoriteEmoji(emoji) {
  return ['\u2764', '\u2665', 'heart', 'red_heart', 'favorite', 'like'].includes(emoji);
}

function isLeftEmoji(emoji) {
  return ['\u2B05', 'left', 'arrow_left'].includes(emoji);
}

function isRightEmoji(emoji) {
  return ['\u27A1', 'right', 'arrow_right'].includes(emoji);
}
function parseDurationToSeconds(value) {
  if (!value || typeof value !== 'string') return null;
  if (value.toLowerCase() === 'unknown') return null;

  const parts = value.split(':').map((part) => Number.parseInt(part, 10));
  if (!parts.every((part) => Number.isFinite(part) && part >= 0)) return null;

  if (parts.length === 2) return (parts[0] * 60) + parts[1];
  if (parts.length === 3) return (parts[0] * 3600) + (parts[1] * 60) + parts[2];
  return null;
}

const SESSION_PANEL_REACTIONS = [
  '\u2705', // vote skip
  '\u23ED\uFE0F', // next track
  '\u2764\uFE0F', // favorite
  '\u23F8\uFE0F', // pause
  '\u25B6\uFE0F', // resume
];
const SEND_PERMISSION_PREFLIGHT_BYPASS = new Set(['ping', 'help']);

function formatSeconds(seconds) {
  const safe = Math.max(0, Math.floor(seconds));
  const h = Math.floor(safe / 3600);
  const m = Math.floor((safe % 3600) / 60);
  const s = safe % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
  return `${m}:${String(s).padStart(2, '0')}`;
}

function buildProgressBar(positionSec, totalSec, size = 16) {
  if (!Number.isFinite(totalSec) || totalSec <= 0) {
    return `${formatSeconds(positionSec)} / live`;
  }
  const clamped = Math.max(0, Math.min(positionSec, totalSec));
  const progress = clamped / totalSec;
  const marker = Math.min(size - 1, Math.max(0, Math.floor(progress * (size - 1))));
  const chars = [];
  for (let i = 0; i < size; i += 1) {
    chars.push(i === marker ? '*' : '-');
  }
  return `${formatSeconds(clamped)} ${chars.join('')} ${formatSeconds(totalSec)}`;
}

function summarizeTrack(track) {
  if (!track) return 'Unknown track';
  const by = track.requestedBy ? ` by <@${track.requestedBy}>` : '';
  return `${track.title} (${track.duration})${by}`;
}

function buildCommandReplyOptions(message) {
  const messageId = String(message?.id ?? message?.message_id ?? '').trim();
  if (!messageId) return null;

  const options = {
    replyToMessageId: messageId,
  };
  const channelId = String(message?.channel_id ?? message?.channelId ?? '').trim();
  const guildId = String(message?.guild_id ?? message?.guildId ?? '').trim();
  if (channelId) options.replyToChannelId = channelId;
  if (guildId) options.replyToGuildId = guildId;
  return options;
}

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
    this.botUserId = options.botUserId ?? null;
    this.startedAt = options.startedAt;
    this.metrics = options.metrics ?? null;
    this.errorReporter = options.errorReporter ?? null;
    this.guildOpLocks = new Map();
    this.helpPaginations = new Map();
    this.sessionPanelReactions = new Set();
    this.sessionPanelLiveLastAt = new Map();
    this.sessionPanelLastPayloadByGuild = new Map();
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

  async handleMessage(message) {
    if (!message?.content) return;
    if (message.author?.bot) return;

    const guildId = message.guild_id ?? null;
    const guildConfig = await this._resolveGuildConfig(guildId);
    const configuredPrefix = guildConfig?.prefix ?? this.config.prefix;
    const fallbackPrefix = this.config.prefix;

    let parsed = parseCommand(message.content, configuredPrefix);
    if (!parsed && this.config.allowDefaultPrefixFallback && configuredPrefix !== fallbackPrefix) {
      parsed = parseCommand(message.content, fallbackPrefix);
    }
    if (!parsed) return;

    const command = this.registry.resolve(parsed.name);
    if (!command) {
      this.metrics?.commandsTotal?.inc?.(1, { command: parsed.name.toLowerCase(), outcome: 'unknown' });
      await this._safeReply(
        message.channel_id,
        'warning',
        `Unknown command: \`${parsed.name}\``,
        null,
        buildCommandReplyOptions(message)
      );
      return;
    }

    const context = this._buildContext(message, parsed, command, {
      prefix: configuredPrefix,
      guildConfig,
    });
    if (context.guildId && this.sessions.has(context.guildId)) {
      this.sessions.bindTextChannel(context.guildId, context.channelId);
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

    if (!this.library) return;

    const session = this.sessions.get(guildId);
    if (!session) return;
    const features = await this.library.getGuildFeatureConfig(guildId).catch(() => null);
    if (!features?.sessionPanelMessageId || String(features.sessionPanelMessageId) !== String(messageId)) return;

    const currentTrack = session.player.currentTrack;
    if (!currentTrack) return;

    if (isFavoriteEmoji(emoji)) {
      await this.library.addUserFavorite(userId, currentTrack).catch(() => null);
      if (this.library.recordUserSignal) {
        await this.library.recordUserSignal(guildId, userId, 'favorite', currentTrack).catch(() => null);
      }
      await this._sendSessionPanelUpdate(session, 'reaction_favorite');
      return;
    }

    if (isPauseEmoji(emoji)) {
      if (session.player.pause()) {
        await this._sendSessionPanelUpdate(session, 'reaction_pause');
      }
      return;
    }

    if (isResumeEmoji(emoji)) {
      if (session.player.resume()) {
        await this._sendSessionPanelUpdate(session, 'reaction_resume');
      }
      return;
    }

    if (isSkipEmoji(emoji)) {
      const vote = this.sessions.registerVoteSkip(guildId, userId);
      if (!vote) return;
      const required = this._computeVoteSkipRequirement(guildId, session);
      if (vote.votes >= required) {
        session.player.skip();
        this.sessions.clearVoteSkips(guildId);
      }
      await this._sendSessionPanelUpdate(session, 'reaction_skip_vote');
      return;
    }

    this.logger?.info?.('Ignored unknown session panel reaction', {
      guildId,
      channelId,
      messageId,
      userId,
      emoji,
      emojiName: payload?.emoji?.name ?? payload?.emoji_name ?? null,
      emojiId: payload?.emoji?.id ?? payload?.emoji_id ?? null,
    });
  }

  _buildContext(message, parsed, command, options = {}) {
    const channelId = message.channel_id;
    const commandReplyOptions = buildCommandReplyOptions(message);

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
      botUserId: this.botUserId,
      registry: this.registry,
      startedAt: this.startedAt,
      withGuildOpLock: (key, fn) => this._withGuildOpLock(message.guild_id ?? null, key, fn),
      refreshSessionPanel: async () => {
        const guildId = message.guild_id ?? null;
        if (!guildId) return;
        const session = this.sessions.get(guildId);
        if (!session) return;
        await this._sendSessionPanelUpdate(session, 'manual_refresh');
      },
      registerHelpPagination: async (channelId, messageId, pages) => {
        await this._registerHelpPagination(channelId, messageId, pages);
      },

      message,
      command,
      commandName: parsed.name,
      args: parsed.args,
      rawArgs: parsed.rawArgs,
      guildId: message.guild_id ?? null,
      channelId,
      authorId: message.author?.id ?? message.user_id ?? message.member?.user?.id ?? null,

      safeTyping: async () => {
        this.rest.sendTyping(channelId).catch(() => {
          // typing indicator is optional
        });
      },

      reply: {
        info: async (text, fields = null) => this._safeReply(channelId, 'info', text, fields, commandReplyOptions),
        success: async (text, fields = null) => this._safeReply(channelId, 'success', text, fields, commandReplyOptions),
        warning: async (text, fields = null) => this._safeReply(channelId, 'warning', text, fields, commandReplyOptions),
        error: async (text, fields = null) => this._safeReply(channelId, 'error', text, fields, commandReplyOptions),
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
        `Now playing: **${track.title}** (${track.duration})`
      );
      await this._sendSessionPanelUpdate(session, 'track_start');
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
      await this._sendSessionPanelUpdate(session, 'track_error');
    });

    this.sessions.on('queueEmpty', async ({ session }) => {
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
      await this._sendSessionPanelUpdate(session, 'queue_empty');
      await this._emitWebhookEvent(session, 'queue_empty', 'Queue is now empty.');
    });

    this.sessions.on('autoplayQueued', async ({ session, track }) => {
      const channelId = this._resolveEventChannelId(session);
      if (!channelId) return;
      await this._safeReply(
        channelId,
        'info',
        `Autoplay added: **${track.title}** (${track.duration})`
      );
      await this._sendSessionPanelUpdate(session, 'autoplay');
      await this._emitWebhookEvent(session, 'autoplay', `Autoplay added: ${summarizeTrack(track)}`);
    });

    this.sessions.on('autoplayFailed', async ({ session, error }) => {
      const channelId = this._resolveEventChannelId(session);
      if (!channelId) return;
      await this._safeReply(
        channelId,
        'warning',
        `Autoplay failed: ${error?.message ?? 'unknown error'}`
      );
      await this._emitWebhookEvent(session, 'autoplay_failed', `Autoplay failed: ${error?.message ?? 'unknown error'}`);
    });

    this.sessions.on('destroyed', async ({ session, reason }) => {
      const guildId = String(session?.guildId ?? '').trim();
      if (guildId) {
        this.sessionPanelLiveLastAt.delete(guildId);
        this.sessionPanelLastPayloadByGuild.delete(guildId);
      }

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
    if (!this.library) return;
    const guildId = session?.guildId;
    if (!guildId) return;

    const features = await this.library.getGuildFeatureConfig(guildId).catch(() => null);
    if (!features) return;

    const channelId = features.sessionPanelChannelId ?? session.textChannelId ?? session.settings.musicLogChannelId ?? null;
    if (!channelId) return;

    const current = session.player.currentTrack;
    const totalSec = parseDurationToSeconds(current?.duration ?? '');
    const progressSec = session.player.getProgressSeconds();
    const progressLabel = buildProgressBar(progressSec, totalSec ?? Number.NaN);
    const queueCount = session.player.pendingTracks.length;
    const votes = this.sessions.getVoteCount(guildId);
    const voteNeed = this._computeVoteSkipRequirement(guildId, session);
    const controlsLabel = 'React with \u2705 or \u23ED\uFE0F to vote-skip, \u2764\uFE0F to favorite, \u23F8\uFE0F to pause, \u25B6\uFE0F to resume';
    const panelDescription = current ? `Now: ${summarizeTrack(current)}` : 'Now: idle';
    const payloadDigest = JSON.stringify({
      description: panelDescription,
      progress: progressLabel,
      queue: queueCount,
      voteskip: `${votes}/${voteNeed}`,
      reason,
      controls: controlsLabel,
    });
    const digestKey = String(guildId);
    if (features.sessionPanelMessageId && this.sessionPanelLastPayloadByGuild.get(digestKey) === payloadDigest) {
      return;
    }

    const payload = {
      embeds: [
        buildEmbed({
          title: 'Session Panel',
          description: panelDescription,
          fields: [
            { name: 'Progress', value: progressLabel },
            { name: 'Queue', value: `${queueCount} track(s)`, inline: true },
            { name: 'Voteskip', value: `${votes}/${voteNeed}`, inline: true },
            { name: 'Reason', value: reason, inline: true },
            { name: 'Controls', value: controlsLabel },
          ],
        }),
      ],
      allowed_mentions: {
        parse: [],
        users: [],
        roles: [],
        replied_user: false,
      },
    };

    if (features.sessionPanelMessageId && this.rest?.editMessage) {
      try {
        await this.rest.editMessage(channelId, features.sessionPanelMessageId, payload);
        await this._ensureSessionPanelReactions(channelId, features.sessionPanelMessageId);
        this.sessionPanelLastPayloadByGuild.set(digestKey, payloadDigest);
        return;
      } catch {
        // If the old panel message is gone/uneditable, fall through and create a new one.
      }
    }

    const sent = await this.rest.sendMessage(channelId, payload).catch(() => null);
    const messageId = sent?.id ?? sent?.message?.id ?? null;
    if (!messageId) return;
    await this._ensureSessionPanelReactions(channelId, messageId);
    this.sessionPanelLastPayloadByGuild.set(digestKey, payloadDigest);

    await this.library.patchGuildFeatureConfig(guildId, {
      sessionPanelChannelId: channelId,
      sessionPanelMessageId: String(messageId),
    }).catch(() => null);
  }

  async _ensureSessionPanelReactions(channelId, messageId) {
    if (!this.rest?.addReactionToMessage) return;
    const channel = String(channelId ?? '').trim();
    const message = String(messageId ?? '').trim();
    if (!channel || !message) return;

    const key = `${channel}:${message}`;
    if (this.sessionPanelReactions.has(key)) return;

    for (const emoji of SESSION_PANEL_REACTIONS) {
      try {
        await this.rest.addReactionToMessage(channel, message, emoji);
      } catch (err) {
        this.logger?.warn?.('Failed to add session panel reaction', {
          channelId: channel,
          messageId: message,
          emoji,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    this.sessionPanelReactions.add(key);
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
    this._startSessionPanelLiveTicker();

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
    };
    const helpCleanupHandle = setInterval(cleanup, 5 * 60 * 1000);
    helpCleanupHandle.unref?.();
  }

  _startSessionPanelLiveTicker() {
    if (this.sessionPanelLiveHandle) return;

    const run = () => {
      this._tickSessionPanels().catch((err) => {
        this.logger?.warn?.('Session panel live update tick failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    };

    this.sessionPanelLiveHandle = setInterval(run, 10_000);
    this.sessionPanelLiveHandle.unref?.();
    run();
  }

  async _tickSessionPanels() {
    if (!this.library) return;
    const sessionsMap = this.sessions?.sessions;
    if (!(sessionsMap instanceof Map) || sessionsMap.size === 0) return;

    const now = Date.now();
    for (const session of sessionsMap.values()) {
      const guildId = String(session?.guildId ?? '').trim();
      if (!guildId) continue;

      const player = session?.player;
      if (!player?.playing || !player?.currentTrack) {
        this.sessionPanelLiveLastAt.delete(guildId);
        continue;
      }

      const cadenceMs = player.paused ? 30_000 : 10_000;
      const lastAt = this.sessionPanelLiveLastAt.get(guildId) ?? 0;
      if ((now - lastAt) < cadenceMs) continue;

      this.sessionPanelLiveLastAt.set(guildId, now);
      const reason = player.paused ? 'live_paused' : 'live';
      await this._sendSessionPanelUpdate(session, reason).catch((err) => {
        this.logger?.warn?.('Session panel live update failed', {
          guildId,
          reason,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }
  }

  async _registerHelpPagination(channelId, messageId, pages) {
    if (!channelId || !messageId || !Array.isArray(pages) || pages.length <= 1) return;
    this.helpPaginations.set(String(messageId), {
      channelId: String(channelId),
      messageId: String(messageId),
      pages,
      index: 0,
      updatedAt: Date.now(),
    });

    if (!this.rest?.addReactionToMessage) return;
    await this.rest.addReactionToMessage(channelId, messageId, '\u2B05\uFE0F').catch(() => null);
    await this.rest.addReactionToMessage(channelId, messageId, '\u27A1\uFE0F').catch(() => null);
  }

  async _runWeeklyRecapSweep() {
    if (!this.rest?.listCurrentUserGuilds || !this.library?.buildGuildRecap) return;

    const guilds = await this.rest.listCurrentUserGuilds({ limit: 200 }).catch(() => []);
    for (const guild of guilds) {
      const guildId = String(guild?.id ?? '').trim();
      if (!guildId) continue;

      const features = await this.library.getGuildFeatureConfig(guildId).catch(() => null);
      if (!features?.recapChannelId) continue;

      const state = await this.library.getRecapState(guildId).catch(() => null);
      const lastAt = state?.lastWeeklyRecapAt ? Date.parse(state.lastWeeklyRecapAt) : NaN;
      if (Number.isFinite(lastAt) && (Date.now() - lastAt) < (6.5 * 24 * 60 * 60 * 1000)) continue;

      const recap = await this.library.buildGuildRecap(guildId, 7).catch(() => null);
      if (!recap || recap.playCount <= 0) continue;

      const trackLines = recap.topTracks.slice(0, 5).map((entry, i) => `${i + 1}. ${entry.title} (${entry.plays} plays)`);
      const userLines = recap.topRequesters.slice(0, 5).map((entry, i) => `${i + 1}. <@${entry.userId}> (${entry.plays})`);
      await this._safeReply(
        features.recapChannelId,
        'info',
        'Weekly music recap',
        [
          { name: 'Total Plays (7d)', value: String(recap.playCount), inline: true },
          { name: 'Top Tracks', value: trackLines.join('\n') || 'No data' },
          { name: 'Top Requesters', value: userLines.join('\n') || 'No data' },
        ]
      );

      await this.library.markRecapSent(guildId, new Date()).catch(() => null);
    }
  }

  async _safeReply(channelId, type, text, fields = null, replyOptions = null) {
    try {
      if (type === 'info') return await this.responder.info(channelId, text, fields, replyOptions);
      if (type === 'success') return await this.responder.success(channelId, text, fields, replyOptions);
      if (type === 'warning') return await this.responder.warning(channelId, text, fields, replyOptions);
      if (type === 'error') return await this.responder.error(channelId, text, fields, replyOptions);
      return await this.responder.plain(channelId, text, replyOptions);
    } catch (err) {
      const isUnknownGuild = (
        err?.status === 404
        && (
          String(err?.code ?? '').toUpperCase() === 'UNKNOWN_GUILD'
          || String(err?.message ?? '').toUpperCase().includes('UNKNOWN_GUILD')
        )
      );
      if (isUnknownGuild) {
        this._handleUnknownGuildForChannel(channelId);
      }

      this.logger?.warn?.('Failed to send command response', {
        channelId,
        type,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  _handleUnknownGuildForChannel(channelId) {
    const target = String(channelId ?? '').trim();
    if (!target) return;

    for (const [guildId, session] of this.sessions.sessions.entries()) {
      const textMatch = String(session?.textChannelId ?? '') === target;
      const logMatch = String(session?.settings?.musicLogChannelId ?? '') === target;
      if (!textMatch && !logMatch) continue;

      session.textChannelId = null;
      if (session.settings) {
        session.settings.musicLogChannelId = null;
      }

      this.sessions.destroy(guildId, 'unknown_guild').catch(() => null);
    }
  }
}

