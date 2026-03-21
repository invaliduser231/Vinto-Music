import { ValidationError } from '../../core/errors.ts';
import {
  createCommand,
  ensureGuild,
  getSessionOrThrow,
  ensureDjAccess,
  parseRequiredInteger,
  trackLabel,
  parseOnOff,
  getGuildConfigOrThrow,
  updateGuildConfig,
  parseRoleId,
  parseTextChannelId,
  ensureManageGuildAccess,
  ensureConnectedSession,
  requireLibrary,
  ensureSessionTrack,
  computeVoteSkipRequirement,
  fetchGlobalGuildAndUserCounts,
  formatUptimeCompact,
} from './commandHelpers.ts';
import { createProgressReporter } from './responseUtils.ts';
import type { CommandRegistry } from '../commandRegistry.ts';
import type { CommandContextLike, SessionLike, TrackDataLike } from './helpers/types.ts';
import type { MessagePayload } from '../../types/core.ts';

const DIAG_OWNER_USER_ID = '1474761291856015469';
type DiagnosticPayload = Record<string, unknown> | null;
type VoicePumpDiagnostics = {
  framesCaptured?: unknown;
  uptimeSec?: unknown;
  backpressureWaits?: unknown;
  concealedFrames?: unknown;
};
type VoiceTransportDiagnostics = {
  jitterMs?: unknown;
  roundTripTimeMs?: unknown;
  outboundBitrateKbps?: unknown;
};
type QueueEffectsContext = CommandContextLike & {
  startedAt?: number;
  safeTyping?: () => Promise<unknown>;
  lyrics?: {
    search: (query: string) => Promise<{ lyrics?: string | null; source?: string | null } | null>;
  };
  sessions: CommandContextLike['sessions'] & {
    sessions?: Map<string, unknown>;
    markSnapshotDirty?: (session: SessionLike, flushSoon?: boolean) => void;
    getVoteCount?: (guildId: string, selector?: Record<string, unknown>) => number;
  };
};
type DiagnosticsSnapshot = {
  capturedAt: number;
  track: { id?: string | null; title?: string | null; source?: string | null } | null;
  player: DiagnosticPayload;
  voice: DiagnosticPayload;
  computed: {
    producedPcmMs: number;
    wallClockMs: number;
    paceRatio: number | null;
    backpressureWaits: number;
    concealedFrames: number;
    queueDepthMs: number;
    jitterMs: number;
    rttMs: number;
    outboundBitrateKbps: number;
  };
};
type TrackDiagAggregate = {
  startedAt: number;
  endedAt: number | null;
  trackId: string | null;
  trackTitle: string;
  trackSource: string;
  samples: number;
  lowBufferSamples: number;
  catchupSamples: number;
  okSamples: number;
  backpressureMax: number;
  backpressureTotal: number;
  concealedFramesMax: number;
  concealedFramesTotal: number;
  queueDepthMinMs: number;
  queueDepthMaxMs: number;
  queueDepthSumMs: number;
  paceMin: number;
  paceMax: number;
  paceSum: number;
  paceCount: number;
};
const diagSnapshotsByGuild = new Map<string, DiagnosticsSnapshot>();
const diagTrackMonitorsByGuild = new Map<string, { cleanup?: () => void }>();

function ensureDiagOwner(ctx: QueueEffectsContext) {
  const userId = String(ctx?.authorId ?? '').trim();
  if (userId === DIAG_OWNER_USER_ID) return;
  throw new ValidationError('This command is restricted to the bot owner.');
}

function toFixedSafe(value: unknown, digits: number = 2) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 'n/a';
  return parsed.toFixed(digits);
}

function buildDiagSnapshot(session: SessionLike | null | undefined, playerDiagnostics: DiagnosticPayload, voiceDiagnostics: DiagnosticPayload): DiagnosticsSnapshot {
  const nowTs = Date.now();
  const pump = (voiceDiagnostics?.pump ?? null) as VoicePumpDiagnostics | null;
  const transport = (voiceDiagnostics?.transport ?? null) as VoiceTransportDiagnostics | null;
  const framesCaptured = Number.parseInt(String(pump?.framesCaptured ?? 0), 10) || 0;
  const producedPcmMs = framesCaptured * 20;
  const pumpUptimeSec = Number.parseInt(String(pump?.uptimeSec ?? 0), 10) || 0;
  const wallClockMs = Math.max(0, pumpUptimeSec * 1000);
  const paceRatio = wallClockMs > 0 ? producedPcmMs / wallClockMs : null;
  const activeTrack = session?.player?.displayTrack ?? session?.player?.currentTrack ?? null;

  return {
    capturedAt: nowTs,
    track: activeTrack
      ? {
          id: activeTrack.id ?? null,
          title: activeTrack.title ?? null,
          source: activeTrack.source ?? null,
        }
      : null,
    player: playerDiagnostics ?? null,
    voice: voiceDiagnostics ?? null,
    computed: {
      producedPcmMs,
      wallClockMs,
      paceRatio,
      backpressureWaits: Number.parseInt(String(pump?.backpressureWaits ?? 0), 10) || 0,
      concealedFrames: Number.parseInt(String(pump?.concealedFrames ?? 0), 10) || 0,
      queueDepthMs: Number(voiceDiagnostics?.queuedDurationMs ?? Number.NaN),
      jitterMs: Number(transport?.jitterMs ?? Number.NaN),
      rttMs: Number(transport?.roundTripTimeMs ?? Number.NaN),
      outboundBitrateKbps: Number(transport?.outboundBitrateKbps ?? Number.NaN),
    },
  };
}

function describeDiagStatus(snapshot: DiagnosticsSnapshot) {
  const ratio = Number(snapshot?.computed?.paceRatio ?? Number.NaN);
  const queueDepth = Number(snapshot?.computed?.queueDepthMs ?? Number.NaN);
  const backpressureWaits = Number.parseInt(String(snapshot?.computed?.backpressureWaits ?? 0), 10) || 0;

  const flags = [];
  if (Number.isFinite(ratio) && ratio > 1.03) {
    flags.push('catch-up-speed');
  }
  if (Number.isFinite(queueDepth) && queueDepth < 40) {
    flags.push('low-buffer');
  }
  if (backpressureWaits > 0) {
    flags.push('backpressure');
  }
  return flags.length ? flags.join(', ') : 'ok';
}

function createTrackDiagAggregate(track: TrackDataLike | null | undefined): TrackDiagAggregate {
  return {
    startedAt: Date.now(),
    endedAt: null,
    trackId: track?.id ?? null,
    trackTitle: track?.title ?? 'Unknown',
    trackSource: track?.source ?? 'unknown',
    samples: 0,
    lowBufferSamples: 0,
    catchupSamples: 0,
    okSamples: 0,
    backpressureMax: 0,
    backpressureTotal: 0,
    concealedFramesMax: 0,
    concealedFramesTotal: 0,
    queueDepthMinMs: Number.POSITIVE_INFINITY,
    queueDepthMaxMs: 0,
    queueDepthSumMs: 0,
    paceMin: Number.POSITIVE_INFINITY,
    paceMax: 0,
    paceSum: 0,
    paceCount: 0,
  };
}

function addTrackDiagSample(aggregate: TrackDiagAggregate, snapshot: DiagnosticsSnapshot) {
  aggregate.samples += 1;

  const queueDepth = Number(snapshot?.computed?.queueDepthMs ?? Number.NaN);
  if (Number.isFinite(queueDepth) && queueDepth >= 0) {
    aggregate.queueDepthMinMs = Math.min(aggregate.queueDepthMinMs, queueDepth);
    aggregate.queueDepthMaxMs = Math.max(aggregate.queueDepthMaxMs, queueDepth);
    aggregate.queueDepthSumMs += queueDepth;
  }

  const pace = Number(snapshot?.computed?.paceRatio ?? Number.NaN);
  if (Number.isFinite(pace) && pace > 0) {
    aggregate.paceMin = Math.min(aggregate.paceMin, pace);
    aggregate.paceMax = Math.max(aggregate.paceMax, pace);
    aggregate.paceSum += pace;
    aggregate.paceCount += 1;
  }

  const backpressure = Number.parseInt(String(snapshot?.computed?.backpressureWaits ?? 0), 10) || 0;
  aggregate.backpressureMax = Math.max(aggregate.backpressureMax, backpressure);
  aggregate.backpressureTotal += backpressure;
  const concealedFrames = Number.parseInt(String(snapshot?.computed?.concealedFrames ?? 0), 10) || 0;
  aggregate.concealedFramesMax = Math.max(aggregate.concealedFramesMax, concealedFrames);
  aggregate.concealedFramesTotal += concealedFrames;

  const status = describeDiagStatus(snapshot);
  if (status.includes('low-buffer')) {
    aggregate.lowBufferSamples += 1;
  } else if (status.includes('catch-up-speed')) {
    aggregate.catchupSamples += 1;
  } else {
    aggregate.okSamples += 1;
  }
}

function formatTrackDiagSummary(aggregate: TrackDiagAggregate) {
  const totalDurationSec = Math.max(0, Math.round(((aggregate.endedAt ?? Date.now()) - aggregate.startedAt) / 1000));
  const avgQueue = aggregate.samples > 0 ? (aggregate.queueDepthSumMs / aggregate.samples) : Number.NaN;
  const avgPace = aggregate.paceCount > 0 ? (aggregate.paceSum / aggregate.paceCount) : Number.NaN;

  const queueMin = Number.isFinite(aggregate.queueDepthMinMs) ? aggregate.queueDepthMinMs : Number.NaN;
  const paceMin = Number.isFinite(aggregate.paceMin) ? aggregate.paceMin : Number.NaN;

  return [
    { name: 'Track', value: aggregate.trackTitle, inline: true },
    { name: 'Source', value: aggregate.trackSource, inline: true },
    { name: 'Duration', value: `${totalDurationSec}s`, inline: true },
    { name: 'Samples', value: String(aggregate.samples), inline: true },
    { name: 'Queue Min/Avg/Max', value: `${toFixedSafe(queueMin, 0)} / ${toFixedSafe(avgQueue, 0)} / ${toFixedSafe(aggregate.queueDepthMaxMs, 0)} ms`, inline: true },
    { name: 'Pace Min/Avg/Max', value: `${toFixedSafe(paceMin, 3)} / ${toFixedSafe(avgPace, 3)} / ${toFixedSafe(aggregate.paceMax, 3)}`, inline: true },
    { name: 'Low-buffer samples', value: String(aggregate.lowBufferSamples), inline: true },
    { name: 'Catch-up samples', value: String(aggregate.catchupSamples), inline: true },
    { name: 'OK samples', value: String(aggregate.okSamples), inline: true },
    { name: 'Backpressure max/total', value: `${aggregate.backpressureMax} / ${aggregate.backpressureTotal}`, inline: true },
    { name: 'Conceal max/total', value: `${aggregate.concealedFramesMax} / ${aggregate.concealedFramesTotal}`, inline: true },
  ];
}

function splitTextIntoPages(text: unknown, maxChars: number = 900) {
  const value = String(text ?? '').trim();
  if (!value) return [];
  if (value.length <= maxChars) return [value];

  const pages = [];
  const lines = value.split('\n');
  let current = '';

  for (const lineRaw of lines) {
    const line = String(lineRaw ?? '');
    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length <= maxChars) {
      current = candidate;
      continue;
    }

    if (current) {
      pages.push(current);
      current = '';
    }

    if (line.length <= maxChars) {
      current = line;
      continue;
    }

    for (let i = 0; i < line.length; i += maxChars) {
      pages.push(line.slice(i, i + maxChars));
    }
  }

  if (current) pages.push(current);
  return pages.filter(Boolean);
}

function buildLyricsPagePayload(
  ctx: QueueEffectsContext,
  title: string,
  source: string,
  pageText: string,
  pageIndex: number,
  totalPages: number
): MessagePayload {
  if (ctx.config?.enableEmbeds === false) {
    const header = `${title} (${pageIndex}/${totalPages})`;
    return {
      content: `${header}\nSource: ${source}\n\n${pageText}`.slice(0, 1900),
    };
  }

  return {
    embeds: [{
      color: 0x5865F2,
      title: `${title} (${pageIndex}/${totalPages})`,
      fields: [
        { name: 'Source', value: String(source), inline: true },
        { name: 'Lyrics', value: String(pageText) },
      ],
      timestamp: new Date().toISOString(),
    }],
    allowed_mentions: {
      parse: [],
      users: [],
      roles: [],
      replied_user: false,
    },
  };
}

export function registerQueueEffectsAndMiscCommands(registry: CommandRegistry) {
  registry.register(createCommand({
    name: 'diag',
    aliases: ['audiodiag'],
    description: 'Owner-only playback diagnostics snapshot and per-track report.',
    usage: 'diag [now|last|track|cancel]',
    async execute(ctx: CommandContextLike) {
      const typedCtx = ctx as QueueEffectsContext;
      ensureDiagOwner(typedCtx);
      ensureGuild(ctx);

      const mode = String(ctx.args[0] ?? 'now').trim().toLowerCase();
      const key = String(ctx.guildId);
      const activeMonitor = diagTrackMonitorsByGuild.get(key);

      if (mode === 'cancel') {
        if (!activeMonitor) {
          await typedCtx.reply.warning('No active per-track diagnostics run.');
          return;
        }
        try {
          activeMonitor.cleanup?.();
        } catch {
          // ignore monitor cleanup errors
        }
        diagTrackMonitorsByGuild.delete(key);
        await typedCtx.reply.info('Per-track diagnostics cancelled.');
        return;
      }

      if (mode === 'track') {
        if (activeMonitor) {
          await typedCtx.reply.warning('A per-track diagnostics run is already active.');
          return;
        }

        const session = getSessionOrThrow(ctx);
        ensureSessionTrack(ctx, session);
        const targetTrack = session.player.displayTrack ?? session.player.currentTrack;
        const aggregate = createTrackDiagAggregate(targetTrack);
        let intervalHandle: ReturnType<typeof setInterval> | null = null;

        const sampleNow = async () => {
          const playerDiagnostics = typeof session.player?.getDiagnostics === 'function'
            ? session.player.getDiagnostics()
            : (typeof session.player?.getState === 'function' ? session.player.getState() : null);
          const voiceDiagnostics = typeof session.connection?.getDiagnostics === 'function'
            ? await session.connection.getDiagnostics()
            : null;
          const snapshot = buildDiagSnapshot(session, playerDiagnostics, voiceDiagnostics);
          addTrackDiagSample(aggregate, snapshot);
        };

        let finalized = false;
        const finalize = async (reason: string) => {
          if (finalized) return;
          finalized = true;

          if (intervalHandle) clearInterval(intervalHandle);
          session.player.off?.('trackEnd', onTrackEnd);
          session.player.off?.('trackStart', onTrackStart);
          diagTrackMonitorsByGuild.delete(key);

          aggregate.endedAt = Date.now();
          const fields = [
            ...formatTrackDiagSummary(aggregate),
            { name: 'End reason', value: reason, inline: true },
          ];
          await typedCtx.reply.info('Audio diagnostics (track summary)', fields);
        };

        const onTrackEnd = async ({ track }: { track?: TrackDataLike | null }) => {
          if (!track || String(track.id ?? '') !== String(aggregate.trackId ?? '')) return;
          await finalize('track_ended');
        };
        const onTrackStart = async (track: TrackDataLike | null | undefined) => {
          if (!track) return;
          if (String(track.id ?? '') === String(aggregate.trackId ?? '')) return;
          await finalize('track_changed');
        };

        session.player.on('trackEnd', onTrackEnd);
        session.player.on('trackStart', onTrackStart);

        intervalHandle = setInterval(() => {
          sampleNow().catch(() => null);
        }, 1_000);
        intervalHandle.unref?.();

        const cleanup = () => {
          clearInterval(intervalHandle);
          session.player.off?.('trackEnd', onTrackEnd);
          session.player.off?.('trackStart', onTrackStart);
        };
        diagTrackMonitorsByGuild.set(key, { cleanup });

        await sampleNow().catch(() => null);
        await typedCtx.reply.info(
          `Per-track diagnostics started for **${aggregate.trackTitle}**. I will send the summary when this track ends.`
        );
        return;
      }

      if (mode === 'last') {
        const previous = diagSnapshotsByGuild.get(key);
        if (!previous) {
          await typedCtx.reply.warning('No previous diagnostics snapshot found. Run `diag now` first.');
          return;
        }

        await typedCtx.reply.info('Audio diagnostics (last)', [
          { name: 'Captured', value: new Date(previous.capturedAt).toISOString(), inline: true },
          { name: 'Track', value: previous.track?.title ?? 'none', inline: true },
          { name: 'Source', value: previous.track?.source ?? 'n/a', inline: true },
          { name: 'Pace ratio', value: toFixedSafe(previous.computed?.paceRatio, 3), inline: true },
          { name: 'Queue depth', value: `${toFixedSafe(previous.computed?.queueDepthMs, 0)} ms`, inline: true },
          { name: 'Backpressure', value: String(previous.computed?.backpressureWaits ?? 0), inline: true },
          { name: 'Concealed frames', value: String(previous.computed?.concealedFrames ?? 0), inline: true },
          { name: 'RTT/Jitter', value: `${toFixedSafe(previous.computed?.rttMs, 0)} / ${toFixedSafe(previous.computed?.jitterMs, 0)} ms`, inline: true },
          { name: 'Output bitrate', value: `${toFixedSafe(previous.computed?.outboundBitrateKbps, 0)} kbps`, inline: true },
          { name: 'Status', value: describeDiagStatus(previous), inline: true },
        ]);
        return;
      }

      if (mode !== 'now') {
        throw new ValidationError(`Usage: ${ctx.prefix}diag [now|last|track|cancel]`);
      }

      const session = getSessionOrThrow(ctx);
      const playerDiagnostics = typeof session.player?.getDiagnostics === 'function'
        ? session.player.getDiagnostics()
        : (typeof session.player?.getState === 'function' ? session.player.getState() : null);
      const voiceDiagnostics = typeof session.connection?.getDiagnostics === 'function'
        ? await session.connection.getDiagnostics()
        : null;
      const snapshot = buildDiagSnapshot(session, playerDiagnostics, voiceDiagnostics);
      diagSnapshotsByGuild.set(key, snapshot);

      await typedCtx.reply.info('Audio diagnostics (now)', [
        { name: 'Captured', value: new Date(snapshot.capturedAt).toISOString(), inline: true },
        { name: 'Track', value: snapshot.track?.title ?? 'none', inline: true },
        { name: 'Source', value: snapshot.track?.source ?? 'n/a', inline: true },
        { name: 'Pace ratio', value: toFixedSafe(snapshot.computed?.paceRatio, 3), inline: true },
        { name: 'Queue depth', value: `${toFixedSafe(snapshot.computed?.queueDepthMs, 0)} ms`, inline: true },
        { name: 'Backpressure', value: String(snapshot.computed?.backpressureWaits ?? 0), inline: true },
        { name: 'Concealed frames', value: String(snapshot.computed?.concealedFrames ?? 0), inline: true },
        { name: 'RTT/Jitter', value: `${toFixedSafe(snapshot.computed?.rttMs, 0)} / ${toFixedSafe(snapshot.computed?.jitterMs, 0)} ms`, inline: true },
        { name: 'Output bitrate', value: `${toFixedSafe(snapshot.computed?.outboundBitrateKbps, 0)} kbps`, inline: true },
        { name: 'Status', value: describeDiagStatus(snapshot), inline: true },
      ]);
    },
  }));

  registry.register(createCommand({
    name: 'remove',
    aliases: ['rm'],
    description: 'Remove a queued track by index (from queue view).',
    usage: 'remove <index>',
    async execute(ctx: CommandContextLike) {
      const typedCtx = ctx as QueueEffectsContext;
      ensureGuild(ctx);
      const session = getSessionOrThrow(ctx);
      ensureDjAccess(ctx, session, 'remove tracks');

      const index = parseRequiredInteger(ctx.args[0], 'Index');
      const removed = session.player.removeFromQueue(index);

      if (!removed) {
        await ctx.reply.warning('Invalid queue index.');
        return;
      }

      typedCtx.sessions.markSnapshotDirty?.(session, true);
      await ctx.reply.success(`Removed: ${trackLabel(removed)}`);
    },
  }));

  registry.register(createCommand({
    name: 'clear',
    aliases: ['cq'],
    description: 'Clear all pending tracks.',
    usage: 'clear',
    async execute(ctx: CommandContextLike) {
      const typedCtx = ctx as QueueEffectsContext;
      ensureGuild(ctx);
      const session = getSessionOrThrow(ctx);
      ensureDjAccess(ctx, session, 'clear the queue');

      const removed = session.player.pendingTracks.length;
      session.player.clearQueue();

      typedCtx.sessions.markSnapshotDirty?.(session, true);
      await ctx.reply.success(`Cleared ${removed} pending track(s).`);
    },
  }));

  registry.register(createCommand({
    name: 'shuffle',
    aliases: ['mix'],
    description: 'Shuffle pending queue tracks.',
    usage: 'shuffle',
    async execute(ctx: CommandContextLike) {
      const typedCtx = ctx as QueueEffectsContext;
      ensureGuild(ctx);
      const session = getSessionOrThrow(ctx);
      ensureDjAccess(ctx, session, 'shuffle the queue');

      const count = session.player.shuffleQueue();
      typedCtx.sessions.markSnapshotDirty?.(session, true);
      await ctx.reply.success(`Shuffled ${count} pending track(s).`);
    },
  }));

  registry.register(createCommand({
    name: 'loop',
    aliases: ['repeat'],
    description: 'Set loop mode: off, track, queue.',
    usage: 'loop <off|track|queue>',
    async execute(ctx: CommandContextLike) {
      const typedCtx = ctx as QueueEffectsContext;
      ensureGuild(ctx);
      const session = getSessionOrThrow(ctx);
      ensureDjAccess(ctx, session, 'change loop mode');

      if (!ctx.args.length) {
        await ctx.reply.info(`Current loop mode: **${session.player.loopMode}**`);
        return;
      }

      const modeArg = String(ctx.args[0] ?? 'off');
      const mode = session.player.setLoopMode(modeArg);
      typedCtx.sessions.markSnapshotDirty?.(session, true);
      await ctx.reply.success(`Loop mode set to **${mode}**.`);
    },
  }));

  registry.register(createCommand({
    name: 'volume',
    aliases: ['vol'],
    description: 'Get/set volume percentage.',
    usage: 'volume [0-200]',
    async execute(ctx: CommandContextLike) {
      const typedCtx = ctx as QueueEffectsContext;
      ensureGuild(ctx);
      const session = getSessionOrThrow(ctx);
      ensureDjAccess(ctx, session, 'change volume');

      if (!ctx.args.length) {
        await ctx.reply.info(`Current volume: **${session.player.volumePercent}%**`);
        return;
      }

      const volumeArg = parseRequiredInteger(ctx.args[0], 'Volume');
      const next = session.player.setVolumePercent(volumeArg);
      typedCtx.sessions.markSnapshotDirty?.(session, true);
      await ctx.reply.success(`Volume set to **${next}%**.`);
    },
  }));

  registry.register(createCommand({
    name: 'filter',
    aliases: ['fx'],
    description: 'Set audio filter preset.',
    usage: 'filter [off|bassboost|nightcore|vaporwave|8d|soft|karaoke|radio]',
    async execute(ctx: CommandContextLike) {
      ensureGuild(ctx);
      const session = getSessionOrThrow(ctx);
      ensureDjAccess(ctx, session, 'change audio filters');

      if (!ctx.args.length) {
        await ctx.reply.info(
          `Current filter: **${session.player.getAudioEffectsState().filterPreset}**`,
          [{ name: 'Available', value: session.player.getAvailableFilterPresets().join(', ').slice(0, 1000) }]
        );
        return;
      }

      const previousFilter = String(session.player.filterPreset ?? 'off');
      const filter = session.player.setFilterPreset(String(ctx.args[0] ?? 'off'));
      const restarted = session.player.playing
        && (!session.player.isLiveFilterPresetSupported(previousFilter) || !session.player.isLiveFilterPresetSupported(filter))
        ? session.player.refreshCurrentTrackProcessing()
        : false;
      await ctx.reply.success(
        `Filter set to **${filter}**.${restarted ? ' Reapplying current track...' : ''}`
      );
    },
  }));

  registry.register(createCommand({
    name: 'eq',
    description: 'Set EQ preset.',
    usage: 'eq [flat|pop|rock|edm|vocal]',
    async execute(ctx: CommandContextLike) {
      ensureGuild(ctx);
      const session = getSessionOrThrow(ctx);
      ensureDjAccess(ctx, session, 'change EQ');

      if (!ctx.args.length) {
        await ctx.reply.info(
          `Current EQ: **${session.player.getAudioEffectsState().eqPreset}**`,
          [{ name: 'Available', value: session.player.getAvailableEqPresets().join(', ').slice(0, 1000) }]
        );
        return;
      }

      const args = [...ctx.args];
      if (String(args[0]).toLowerCase() === 'preset') {
        args.shift();
      }

      const presetArg = String(args[0] ?? 'flat');
      const preset = session.player.setEqPreset(presetArg);
      await ctx.reply.success(`EQ preset set to **${preset}**.`);
    },
  }));

  registry.register(createCommand({
    name: 'tempo',
    description: 'Set playback tempo (0.5 - 2.0).',
    usage: 'tempo <0.5-2.0>',
    async execute(ctx: CommandContextLike) {
      ensureGuild(ctx);
      const session = getSessionOrThrow(ctx);
      ensureDjAccess(ctx, session, 'change tempo');

      const tempoArg = Number.parseFloat(String(ctx.args[0] ?? ''));
      if (!Number.isFinite(tempoArg)) {
        throw new ValidationError('Provide a valid tempo ratio.');
      }
      const tempo = session.player.setTempoRatio(tempoArg);
      const restarted = session.player.refreshCurrentTrackProcessing();
      await ctx.reply.success(
        `Tempo set to **${tempo.toFixed(2)}x**.${restarted ? ' Reapplying to current track...' : ''}`
      );
    },
  }));

  registry.register(createCommand({
    name: 'pitch',
    description: 'Set pitch shift in semitones (-12 to +12).',
    usage: 'pitch <-12..12>',
    async execute(ctx: CommandContextLike) {
      ensureGuild(ctx);
      const session = getSessionOrThrow(ctx);
      ensureDjAccess(ctx, session, 'change pitch');

      const pitchArg = parseRequiredInteger(ctx.args[0], 'Pitch');
      const pitch = session.player.setPitchSemitones(pitchArg);
      const restarted = session.player.refreshCurrentTrackProcessing();
      const signed = pitch >= 0 ? `+${pitch}` : String(pitch);
      await ctx.reply.success(
        `Pitch set to **${signed} semitones**.${restarted ? ' Reapplying to current track...' : ''}`
      );
    },
  }));

  registry.register(createCommand({
    name: 'effects',
    aliases: ['fxstate'],
    description: 'Show current audio effect state.',
    usage: 'effects',
    async execute(ctx: CommandContextLike) {
      ensureGuild(ctx);
      const session = getSessionOrThrow(ctx);

      const state = session.player.getAudioEffectsState();
      await ctx.reply.info('Audio effects', [
        { name: 'Filter', value: state.filterPreset, inline: true },
        { name: 'EQ', value: state.eqPreset, inline: true },
        { name: 'Tempo', value: `${state.tempoRatio.toFixed(2)}x`, inline: true },
        { name: 'Pitch', value: String(state.pitchSemitones), inline: true },
      ]);
    },
  }));

  registry.register(createCommand({
    name: 'voteskip',
    aliases: ['vs'],
    description: 'Show current vote-skip progress.',
    usage: 'voteskip',
    async execute(ctx: CommandContextLike) {
      ensureGuild(ctx);
      const session = getSessionOrThrow(ctx);
      ensureSessionTrack(ctx, session);

      const needed = computeVoteSkipRequirement(ctx, session);
      const current = typeof ctx.sessions.getVoteCount === 'function' ? ctx.sessions.getVoteCount(ctx.guildId, {
        voiceChannelId: ctx.activeVoiceChannelId,
        textChannelId: ctx.channelId,
      }) : 0;
      await ctx.reply.info(`Vote-skip progress: **${current}/${needed}**`);
    },
  }));

  registry.register(createCommand({
    name: 'lyrics',
    aliases: ['ly'],
    description: 'Show lyrics for current track or a query.',
    usage: 'lyrics [artist - title]',
    async execute(ctx: CommandContextLike) {
      const typedCtx = ctx as QueueEffectsContext;
      const query = typedCtx.args.join(' ').trim();
      const session = typedCtx.guildId ? typedCtx.sessions.get(typedCtx.guildId, {
        voiceChannelId: typedCtx.activeVoiceChannelId,
        textChannelId: typedCtx.channelId,
      }) : null;
      const currentTrack = session?.player?.currentTrack ?? null;
      const fallbackTitle = String(currentTrack?.title ?? '').trim();
      const fallbackArtist = String(currentTrack?.artist ?? '').trim();
      const fallback = fallbackArtist && fallbackTitle
        ? `${fallbackArtist} - ${fallbackTitle}`
        : (fallbackTitle || null);
      const effectiveQuery = query || fallback;

      if (!effectiveQuery) {
        throw new ValidationError('Provide a song query or play a track first.');
      }

      await typedCtx.safeTyping?.();
      if (!typedCtx.lyrics) {
        throw new ValidationError('Lyrics service is not available.');
      }
      const result = await typedCtx.lyrics.search(effectiveQuery);
      if (!result) {
        await typedCtx.reply.warning(`No lyrics found for: **${effectiveQuery}**`);
        return;
      }

      const pages = splitTextIntoPages(result.lyrics, 900);
      if (!pages.length) {
        await typedCtx.reply.warning(`No lyrics found for: **${effectiveQuery}**`);
        return;
      }

      const payloads = pages.map((pageText: string, idx: number) => buildLyricsPagePayload(
        typedCtx,
        `Lyrics for ${effectiveQuery}`,
        String(result.source ?? 'unknown'),
        pageText,
        idx + 1,
        pages.length
      ));
      await typedCtx.sendPaginated(payloads);
    },
  }));

  registry.register(createCommand({
    name: 'stats',
    description: 'Show runtime statistics.',
    usage: 'stats',
    async execute(ctx: CommandContextLike) {
      const typedCtx = ctx as QueueEffectsContext;
      const progress = await createProgressReporter(typedCtx, 'Collecting runtime statistics...', null, null, { replyReference: true });
      const uptimeSeconds = Math.floor((Date.now() - (typedCtx.startedAt ?? Date.now())) / 1000);
      const mem = process.memoryUsage();
      await progress.info('Runtime statistics', [
        { name: 'Uptime', value: formatUptimeCompact(uptimeSeconds), inline: true },
        { name: 'Guild sessions', value: String(typedCtx.sessions.sessions?.size ?? 0), inline: true },
        { name: 'Servers total', value: 'counting...', inline: true },
        { name: 'Users total', value: 'counting...', inline: true },
        { name: 'Heap Used', value: `${Math.round(mem.heapUsed / 1024 / 1024)} MB`, inline: true },
      ]);

      const globalCounts = await fetchGlobalGuildAndUserCounts(typedCtx.rest).catch(() => null);
      const serverCountLabel = globalCounts?.guildCount == null
        ? 'n/a'
        : String(globalCounts.guildCount);
      const userCountLabel = globalCounts?.userCount == null
        ? 'n/a'
        : (
          globalCounts.incompleteGuildCount > 0
            ? `${globalCounts.userCount} (partial)`
            : String(globalCounts.userCount)
        );

      await progress.info('Runtime statistics', [
        { name: 'Uptime', value: formatUptimeCompact(uptimeSeconds), inline: true },
        { name: 'Guild sessions', value: String(typedCtx.sessions.sessions?.size ?? 0), inline: true },
        { name: 'Servers total', value: serverCountLabel, inline: true },
        { name: 'Users total', value: userCountLabel, inline: true },
        { name: 'Heap Used', value: `${Math.round(mem.heapUsed / 1024 / 1024)} MB`, inline: true },
      ]);
    },
  }));
}



