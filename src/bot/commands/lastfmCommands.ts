import { ValidationError } from '../../core/errors.ts';
import {
  createCommand,
  ensureGuild,
  ensureConnectedSession,
  applyVoiceProfileIfConfigured,
  resolveQueueGuard,
  getSessionOrThrow,
  getGuildConfigOrThrow,
  updateGuildConfig,
  ensureManageGuildAccess,
  parseOnOff,
  trackLabel,
} from './commandHelpers.ts';
import { buildSingleFieldInfoPayload } from './responseUtils.ts';
import { LastFmApiError } from '../../integrations/lastfm/LastFmClient.ts';
import { toLastFmTrack } from '../../integrations/lastfm/trackMetadata.ts';
import type { LastFmPeriod, LastFmRankedEntry } from '../../integrations/lastfm/LastFmClient.ts';
import type { CommandContextLike, LastFmBundle, SessionLike, TrackDataLike } from './helpers/types.ts';
import type { EmbedField } from '../../types/core.ts';

const USER_MENTION_PATTERN = /^<@!?(\d+)>$/;
const PENDING_TOKEN_TTL_MS = 15 * 60 * 1000;
const PENDING_TOKEN_PRUNE_INTERVAL_MS = 5 * 60 * 1000;
const BLEND_TRACKS_PER_USER = 3;
const BLEND_MAX_TRACKS = 24;
const COMPARE_ARTIST_SAMPLE = 100;

type LastFmCommandContext = CommandContextLike & {
  sessions: CommandContextLike['sessions'] & {
    markSnapshotDirty?: (session: SessionLike, flushSoon?: boolean) => void;
  };
};

type RegistryLike = {
  register: (definition: Readonly<{ name: string }>) => void;
};

type PendingToken = {
  token: string;
  createdAt: number;
};

const pendingTokens = new Map<string, PendingToken>();

const PERIOD_ALIASES: Record<string, LastFmPeriod> = {
  '7d': '7day',
  '7day': '7day',
  week: '7day',
  weekly: '7day',
  '1m': '1month',
  '1month': '1month',
  month: '1month',
  monthly: '1month',
  '3m': '3month',
  '3month': '3month',
  quarter: '3month',
  '6m': '6month',
  '6month': '6month',
  half: '6month',
  '1y': '12month',
  '12m': '12month',
  '12month': '12month',
  year: '12month',
  yearly: '12month',
  all: 'overall',
  alltime: 'overall',
  overall: 'overall',
};

const KIND_TOKENS = new Set(['artists', 'artist', 'tracks', 'track', 'albums', 'album']);

const PERIOD_KEYS: Record<LastFmPeriod, 'lastfm.period7day' | 'lastfm.period1month' | 'lastfm.period3month' | 'lastfm.period6month' | 'lastfm.period12month' | 'lastfm.periodOverall'> = {
  '7day': 'lastfm.period7day',
  '1month': 'lastfm.period1month',
  '3month': 'lastfm.period3month',
  '6month': 'lastfm.period6month',
  '12month': 'lastfm.period12month',
  overall: 'lastfm.periodOverall',
};

function prunePendingTokens(): void {
  const now = Date.now();
  for (const [userId, pending] of pendingTokens.entries()) {
    if (now - pending.createdAt > PENDING_TOKEN_TTL_MS) pendingTokens.delete(userId);
  }
}

const pendingTokenPruneHandle = setInterval(prunePendingTokens, PENDING_TOKEN_PRUNE_INTERVAL_MS);
pendingTokenPruneHandle.unref?.();

function requireLastFm(ctx: CommandContextLike): LastFmBundle {
  if (!ctx.lastfm) {
    throw new ValidationError(ctx.t('lastfm.unavailable'));
  }
  return ctx.lastfm;
}

function parseUserId(value: unknown, fallback: string | null = null): string | null {
  const raw = String(value ?? '').trim();
  if (!raw) return fallback;
  const mention = raw.match(USER_MENTION_PATTERN);
  if (mention) return mention[1] ?? fallback;
  if (/^\d{6,}$/.test(raw)) return raw;
  return fallback;
}

function parsePeriod(value: unknown): LastFmPeriod | null {
  const raw = String(value ?? '').trim().toLowerCase();
  if (!raw) return null;
  return PERIOD_ALIASES[raw] ?? null;
}

async function resolveLinkedUsername(ctx: CommandContextLike, targetUserId: string): Promise<string> {
  const lastfm = requireLastFm(ctx);
  const account = await lastfm.accounts.get(targetUserId);
  if (!account?.username) {
    throw new ValidationError(
      targetUserId === ctx.authorId
        ? ctx.t('lastfm.notLinkedSelf', { prefix: ctx.prefix })
        : ctx.t('lastfm.notLinkedOther', { user: `<@${targetUserId}>` }),
    );
  }
  return account.username;
}

function formatCount(value: number, t: CommandContextLike['t']): string {
  return `\`${value.toLocaleString(t.locale)}\``;
}

function formatRankedList(entries: LastFmRankedEntry[], t: CommandContextLike['t']): string {
  if (!entries.length) return t('lastfm.emptyList');

  return entries
    .map((entry, index) => {
      const label = entry.artist ? `${entry.artist} - ${entry.name}` : entry.name;
      return `${index + 1}. ${label} ${formatCount(entry.playcount, t)}`;
    })
    .join('\n')
    .slice(0, 1000);
}

function formatRelative(date: Date | null, t: CommandContextLike['t']): string {
  if (!date) return t('common.unknown');

  const diffMinutes = Math.max(0, Math.round((Date.now() - date.getTime()) / 60_000));
  if (diffMinutes < 1) return t('lastfm.justNow');
  if (diffMinutes < 60) return t('lastfm.minutesAgo', { count: diffMinutes });

  const diffHours = Math.round(diffMinutes / 60);
  if (diffHours < 24) return t('lastfm.hoursAgo', { count: diffHours });

  return t('lastfm.daysAgo', { count: Math.round(diffHours / 24) });
}

function shuffleInPlace<T>(items: T[]): T[] {
  for (let index = items.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(Math.random() * (index + 1));
    const current = items[index] as T;
    items[index] = items[swap] as T;
    items[swap] = current;
  }
  return items;
}

async function queueSearchQueries(
  ctx: CommandContextLike,
  session: SessionLike,
  queries: string[],
): Promise<TrackDataLike[]> {
  const resolved: TrackDataLike[] = [];

  for (const query of queries) {
    const candidates = await session.player
      .previewTracks(query, { requestedBy: ctx.authorId, limit: 1 })
      .catch(() => [] as TrackDataLike[]);
    const candidate = candidates[0];
    if (candidate) resolved.push(candidate);
  }

  if (!resolved.length) return [];

  const queueGuard = await resolveQueueGuard(ctx);
  return session.player.enqueueResolvedTracks(resolved, {
    dedupe: session.settings.dedupeEnabled,
    queueGuard,
  });
}

async function withLastFmErrors<T>(ctx: CommandContextLike, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err: unknown) {
    if (err instanceof LastFmApiError) {
      if (err.lastfmCode === 6) throw new ValidationError(ctx.t('lastfm.userNotFound'));
      if (err.lastfmCode === 9) throw new ValidationError(ctx.t('lastfm.sessionInvalid', { prefix: ctx.prefix }));
      throw new ValidationError(ctx.t('lastfm.apiError', { error: err.message }));
    }
    throw err;
  }
}

export function registerLastFmCommands(registry: RegistryLike) {
  registry.register(createCommand({
    name: 'lastfm',
    aliases: ['fm', 'lfm'],
    description: 'Link your Last.fm account and browse your listening data.',
    usage: 'lastfm <connect|disconnect|status|on|off|profile|recent|top|compare|blend|leaderboard>',
    async execute(ctx: CommandContextLike) {
      const lastfm = requireLastFm(ctx);
      const sub = String(ctx.args[0] ?? '').trim().toLowerCase();

      if (!sub || sub === 'help') {
        await ctx.reply.info(ctx.t('lastfm.overview'), [
          { name: ctx.t('lastfm.overviewAccount'), value: ctx.t('lastfm.overviewAccountValue', { prefix: ctx.prefix }) },
          { name: ctx.t('lastfm.overviewStats'), value: ctx.t('lastfm.overviewStatsValue', { prefix: ctx.prefix }) },
          { name: ctx.t('lastfm.overviewSocial'), value: ctx.t('lastfm.overviewSocialValue', { prefix: ctx.prefix }) },
        ]);
        return;
      }

      if (sub === 'connect' || sub === 'link') {
        await handleConnect(ctx, lastfm);
        return;
      }

      if (sub === 'disconnect' || sub === 'unlink') {
        const removed = await lastfm.accounts.unlink(ctx.authorId);
        pendingTokens.delete(String(ctx.authorId));
        await (removed
          ? ctx.reply.success(ctx.t('lastfm.disconnected'))
          : ctx.reply.warning(ctx.t('lastfm.notLinkedSelf', { prefix: ctx.prefix })));
        return;
      }

      if (sub === 'status') {
        await handleStatus(ctx, lastfm);
        return;
      }

      if (sub === 'on' || sub === 'off') {
        const account = await lastfm.accounts.get(ctx.authorId);
        if (!account) throw new ValidationError(ctx.t('lastfm.notLinkedSelf', { prefix: ctx.prefix }));

        await lastfm.accounts.setScrobblingEnabled(ctx.authorId, sub === 'on');
        await ctx.reply.success(ctx.t(sub === 'on' ? 'lastfm.scrobblingOn' : 'lastfm.scrobblingOff'));
        return;
      }

      if (sub === 'profile' || sub === 'info') {
        await handleProfile(ctx, lastfm);
        return;
      }

      if (sub === 'recent' || sub === 'last') {
        await handleRecent(ctx, lastfm);
        return;
      }

      if (sub === 'top') {
        await handleTop(ctx, lastfm);
        return;
      }

      if (sub === 'compare' || sub === 'match') {
        await handleCompare(ctx, lastfm);
        return;
      }

      if (sub === 'blend' || sub === 'mix') {
        await handleBlend(ctx, lastfm);
        return;
      }

      if (sub === 'leaderboard' || sub === 'lb') {
        await handleLeaderboard(ctx, lastfm);
        return;
      }

      throw new ValidationError(ctx.t('lastfm.unknownSubcommand', { prefix: ctx.prefix }));
    },
  }));

  registry.register(createCommand({
    name: 'fmplay',
    aliases: ['fmp'],
    description: 'Queue the track someone scrobbled most recently.',
    usage: 'fmplay [@user]',
    async execute(ctx: CommandContextLike) {
      ensureGuild(ctx);
      const lastfm = requireLastFm(ctx);

      const targetUserId = parseUserId(ctx.args[0], ctx.authorId);
      if (!targetUserId) throw new ValidationError(ctx.t('errors.userIdUnresolved'));

      const username = await resolveLinkedUsername(ctx, targetUserId);
      const recent = await withLastFmErrors(ctx, () => lastfm.client.userGetRecentTracks(username, 1));
      const entry = recent[0];
      if (!entry) {
        await ctx.reply.warning(ctx.t('lastfm.noRecent', { user: username }));
        return;
      }

      const session = await ensureConnectedSession(ctx);
      await applyVoiceProfileIfConfigured(ctx, session);

      const added = await queueSearchQueries(ctx, session, [`${entry.artist} - ${entry.track}`]);
      if (!added.length) {
        await ctx.reply.warning(ctx.t('lastfm.queueFailed', { track: `${entry.artist} - ${entry.track}` }));
        return;
      }

      if (!session.player.playing) await session.player.play();
      (ctx as LastFmCommandContext).sessions.markSnapshotDirty?.(session, true);

      await ctx.reply.success(ctx.t('lastfm.queued', {
        track: trackLabel(added[0] as never),
        user: username,
      }));
    },
  }));

  registry.register(createCommand({
    name: 'love',
    description: 'Love the currently playing track on Last.fm.',
    usage: 'love',
    async execute(ctx: CommandContextLike) {
      await handleLove(ctx, true);
    },
  }));

  registry.register(createCommand({
    name: 'unlove',
    aliases: ['unlike'],
    description: 'Remove the love mark from the current track on Last.fm.',
    usage: 'unlove',
    async execute(ctx: CommandContextLike) {
      await handleLove(ctx, false);
    },
  }));

  registry.register(createCommand({
    name: 'autoplay',
    description: 'Keep playback going with Last.fm recommendations when the queue runs out.',
    usage: 'autoplay [on|off]',
    async execute(ctx: CommandContextLike) {
      ensureGuild(ctx);
      requireLastFm(ctx);
      const guildConfig = await getGuildConfigOrThrow(ctx);

      if (!ctx.args.length) {
        const state = ctx.t(guildConfig.settings.autoplayEnabled ? 'common.on' : 'common.off');
        await ctx.reply.info(ctx.t('autoplay.current', { state }));
        return;
      }

      await ensureManageGuildAccess(ctx, 'access.changeAutoplay');
      const value = parseOnOff(ctx.args[0], null);
      if (value == null) throw new ValidationError(ctx.t('config.useOnOff'));

      await updateGuildConfig(ctx, { settings: { autoplayEnabled: value } });
      await ctx.reply.success(ctx.t('autoplay.set', { state: ctx.t(value ? 'common.on' : 'common.off') }));
    },
  }));
}

async function handleConnect(ctx: CommandContextLike, lastfm: LastFmBundle): Promise<void> {
  const userId = String(ctx.authorId ?? '').trim();
  if (!userId) throw new ValidationError(ctx.t('errors.userIdUnresolved'));

  const pending = pendingTokens.get(userId);
  if (pending && Date.now() - pending.createdAt <= PENDING_TOKEN_TTL_MS) {
    let session;
    try {
      session = await lastfm.client.getSession(pending.token);
    } catch (err: unknown) {
      if (err instanceof LastFmApiError && (err.lastfmCode === 14 || err.lastfmCode === 15 || err.lastfmCode === 4)) {
        await ctx.reply.warning(ctx.t('lastfm.connectNotAuthorized'), [
          { name: ctx.t('lastfm.connectStep1'), value: lastfm.client.buildAuthUrl(pending.token) },
        ]);
        return;
      }
      throw err;
    }

    pendingTokens.delete(userId);
    await lastfm.accounts.link(userId, session.name, session.key);
    await ctx.reply.success(ctx.t('lastfm.connected', { user: session.name }));
    return;
  }

  const token = await withLastFmErrors(ctx, () => lastfm.client.getToken());
  pendingTokens.set(userId, { token, createdAt: Date.now() });

  await ctx.reply.info(ctx.t('lastfm.connectStart'), [
    { name: ctx.t('lastfm.connectStep1'), value: lastfm.client.buildAuthUrl(token) },
    { name: ctx.t('lastfm.connectStep2'), value: `\`${ctx.prefix}lastfm connect\`` },
  ], { footer: ctx.t('lastfm.connectFooter') });
}

async function handleStatus(ctx: CommandContextLike, lastfm: LastFmBundle): Promise<void> {
  const account = await lastfm.accounts.get(ctx.authorId);
  if (!account) {
    await ctx.reply.info(ctx.t('lastfm.notLinkedSelf', { prefix: ctx.prefix }));
    return;
  }

  const fields: EmbedField[] = [
    {
      name: ctx.t('lastfm.fieldScrobbling'),
      value: ctx.t(account.scrobblingEnabled ? 'common.on' : 'common.off'),
      inline: true,
    },
    { name: ctx.t('lastfm.fieldViaBot'), value: formatCount(account.scrobbleCount, ctx.t), inline: true },
  ];

  if (account.streakDays > 0) {
    fields.push({ name: ctx.t('lastfm.fieldStreak'), value: ctx.t('lastfm.streakDays', { count: account.streakDays }), inline: true });
  }
  if (account.lastScrobbleAt) {
    fields.push({ name: ctx.t('lastfm.fieldLastScrobble'), value: formatRelative(account.lastScrobbleAt, ctx.t), inline: true });
  }

  await ctx.reply.info(ctx.t('lastfm.statusTitle', { user: account.username }), fields);
}

async function handleProfile(ctx: CommandContextLike, lastfm: LastFmBundle): Promise<void> {
  const targetUserId = parseUserId(ctx.args[1], ctx.authorId);
  if (!targetUserId) throw new ValidationError(ctx.t('errors.userIdUnresolved'));

  const username = await resolveLinkedUsername(ctx, targetUserId);
  const [info, topArtists] = await withLastFmErrors(ctx, () => Promise.all([
    lastfm.client.userGetInfo(username),
    lastfm.client.userGetTopArtists(username, 'overall', 5),
  ]));

  const fields: EmbedField[] = [
    { name: ctx.t('lastfm.fieldScrobbles'), value: formatCount(info.playcount, ctx.t), inline: true },
  ];

  if (info.country) fields.push({ name: ctx.t('lastfm.fieldCountry'), value: info.country, inline: true });
  if (info.registeredAt) {
    fields.push({
      name: ctx.t('lastfm.fieldSince'),
      value: `\`${info.registeredAt.toISOString().slice(0, 10)}\``,
      inline: true,
    });
  }
  if (topArtists.length) {
    fields.push({ name: ctx.t('lastfm.fieldTopArtists'), value: formatRankedList(topArtists, ctx.t) });
  }

  await ctx.reply.info(ctx.t('lastfm.profileTitle', { user: info.name }), fields, {
    url: info.url,
    thumbnailUrl: info.imageUrl,
  });
}

async function handleRecent(ctx: CommandContextLike, lastfm: LastFmBundle): Promise<void> {
  const targetUserId = parseUserId(ctx.args[1], ctx.authorId);
  if (!targetUserId) throw new ValidationError(ctx.t('errors.userIdUnresolved'));

  const username = await resolveLinkedUsername(ctx, targetUserId);
  const recent = await withLastFmErrors(ctx, () => lastfm.client.userGetRecentTracks(username, 10));
  if (!recent.length) {
    await ctx.reply.warning(ctx.t('lastfm.noRecent', { user: username }));
    return;
  }

  const lines = recent.map((entry, index) => {
    const when = entry.nowPlaying ? ctx.t('lastfm.nowPlayingTag') : formatRelative(entry.playedAt, ctx.t);
    return `${index + 1}. ${entry.artist} - ${entry.track} (${when})`;
  });

  await ctx.reply.info(ctx.t('lastfm.recentTitle', { user: username }), [
    { name: ctx.t('common.tracks'), value: lines.join('\n').slice(0, 1000) },
  ]);
}

async function handleTop(ctx: CommandContextLike, lastfm: LastFmBundle): Promise<void> {
  let targetUserId: string | null = ctx.authorId;
  let kind = 'artists';
  let period: LastFmPeriod = 'overall';

  for (const raw of ctx.args.slice(1)) {
    const token = String(raw ?? '').trim().toLowerCase();
    if (!token) continue;

    const mentioned = parseUserId(token, null);
    if (mentioned) {
      targetUserId = mentioned;
      continue;
    }

    const parsedPeriod = parsePeriod(token);
    if (parsedPeriod) {
      period = parsedPeriod;
      continue;
    }

    if (KIND_TOKENS.has(token)) kind = token;
  }

  if (!targetUserId) throw new ValidationError(ctx.t('errors.userIdUnresolved'));
  const username = await resolveLinkedUsername(ctx, targetUserId);

  const entries = await withLastFmErrors(ctx, () => {
    if (kind.startsWith('track')) return lastfm.client.userGetTopTracks(username, period, 10);
    if (kind.startsWith('album')) return lastfm.client.userGetTopAlbums(username, period, 10);
    return lastfm.client.userGetTopArtists(username, period, 10);
  });

  if (!entries.length) {
    await ctx.reply.warning(ctx.t('lastfm.noTop', { user: username }));
    return;
  }

  const kindLabel = ctx.t(
    kind.startsWith('track') ? 'lastfm.kindTracks' : kind.startsWith('album') ? 'lastfm.kindAlbums' : 'lastfm.kindArtists',
  );

  await ctx.reply.info(
    ctx.t('lastfm.topTitle', { user: username, kind: kindLabel, period: ctx.t(PERIOD_KEYS[period]) }),
    [{ name: kindLabel, value: formatRankedList(entries, ctx.t) }],
  );
}

async function handleCompare(ctx: CommandContextLike, lastfm: LastFmBundle): Promise<void> {
  const targetUserId = parseUserId(ctx.args[1], null);
  if (!targetUserId) throw new ValidationError(ctx.t('lastfm.compareUsage', { prefix: ctx.prefix }));
  if (targetUserId === ctx.authorId) throw new ValidationError(ctx.t('lastfm.compareSelf'));

  const [ownName, otherName] = await Promise.all([
    resolveLinkedUsername(ctx, String(ctx.authorId)),
    resolveLinkedUsername(ctx, targetUserId),
  ]);

  const [own, other] = await withLastFmErrors(ctx, () => Promise.all([
    lastfm.client.userGetTopArtists(ownName, 'overall', COMPARE_ARTIST_SAMPLE),
    lastfm.client.userGetTopArtists(otherName, 'overall', COMPARE_ARTIST_SAMPLE),
  ]));

  const otherByName = new Map(other.map((entry) => [entry.name.toLowerCase(), entry]));
  const shared = own.filter((entry) => otherByName.has(entry.name.toLowerCase()));
  const denominator = Math.max(1, Math.min(own.length, other.length));
  const score = Math.round((shared.length / denominator) * 100);

  const fields: EmbedField[] = [
    { name: ctx.t('lastfm.fieldMatch'), value: `**${score}%**`, inline: true },
    { name: ctx.t('lastfm.fieldShared'), value: formatCount(shared.length, ctx.t), inline: true },
  ];

  if (shared.length) {
    fields.push({
      name: ctx.t('lastfm.fieldSharedArtists'),
      value: shared.slice(0, 10).map((entry) => entry.name).join('\n').slice(0, 1000),
    });
  }

  await ctx.reply.info(ctx.t('lastfm.compareTitle', { left: ownName, right: otherName }), fields);
}

async function handleBlend(ctx: CommandContextLike, lastfm: LastFmBundle): Promise<void> {
  ensureGuild(ctx);

  const session = await ensureConnectedSession(ctx);
  await applyVoiceProfileIfConfigured(ctx, session);

  const channelId = String(session.connection.channelId ?? '').trim();
  if (!channelId) throw new ValidationError(ctx.t('errors.noActivePlayer'));

  const listeners = (ctx.voiceStateStore.getUsersInChannel?.(ctx.guildId, channelId) ?? [])
    .filter((userId) => userId !== ctx.botUserId);

  const usernames: string[] = [];
  for (const userId of listeners) {
    const account = await lastfm.accounts.get(userId);
    if (account?.username) usernames.push(account.username);
  }

  if (!usernames.length) {
    await ctx.reply.warning(ctx.t('lastfm.blendNobody', { prefix: ctx.prefix }));
    return;
  }

  const queries: string[] = [];
  for (const username of usernames) {
    const artists = await lastfm.client.userGetTopArtists(username, '3month', BLEND_TRACKS_PER_USER).catch(() => []);
    for (const artist of artists) {
      const top = await lastfm.client.artistGetTopTracks(artist.name, 2).catch(() => []);
      for (const entry of top) {
        queries.push(`${entry.artist} - ${entry.track}`);
      }
    }
  }

  const unique = [...new Set(queries)];
  if (!unique.length) {
    await ctx.reply.warning(ctx.t('lastfm.blendEmpty'));
    return;
  }

  const added = await queueSearchQueries(ctx, session, shuffleInPlace(unique).slice(0, BLEND_MAX_TRACKS));
  if (!added.length) {
    await ctx.reply.warning(ctx.t('lastfm.blendEmpty'));
    return;
  }

  if (!session.player.playing) await session.player.play();
  (ctx as LastFmCommandContext).sessions.markSnapshotDirty?.(session, true);

  await ctx.reply.success(ctx.t('lastfm.blendQueued', {
    count: added.length,
    listeners: usernames.length,
  }), [{ name: ctx.t('lastfm.fieldBlendedFrom'), value: usernames.join(', ').slice(0, 1000) }]);
}

async function handleLeaderboard(ctx: CommandContextLike, lastfm: LastFmBundle): Promise<void> {
  const scope = String(ctx.args[1] ?? 'global').trim().toLowerCase();
  const serverScope = scope === 'server' || scope === 'guild';

  let userIds: string[] | null = null;
  if (serverScope) {
    ensureGuild(ctx);
    userIds = await collectGuildUserIds(ctx);
    if (!userIds.length) {
      await ctx.reply.warning(ctx.t('lastfm.leaderboardEmpty'));
      return;
    }
  }

  const top = await lastfm.accounts.listTop(10, userIds);
  if (!top.length) {
    await ctx.reply.warning(ctx.t('lastfm.leaderboardEmpty'));
    return;
  }

  const lines = top.map((entry, index) => `${index + 1}. ${entry.username} ${formatCount(entry.scrobbleCount, ctx.t)}`);
  const title = serverScope ? ctx.t('lastfm.leaderboardServer') : ctx.t('lastfm.leaderboardGlobal');

  await ctx.sendPaginated([
    buildSingleFieldInfoPayload(ctx, title, ctx.t('lastfm.leaderboardHint'), ctx.t('lastfm.fieldRanking'), lines.join('\n')),
  ]);
}

async function collectGuildUserIds(ctx: CommandContextLike): Promise<string[]> {
  const participants = await ctx.library?.listGuildParticipantIds?.(ctx.guildId, 1_000).catch(() => []) ?? [];
  const ids = new Set<string>(participants);

  for (const session of ctx.sessions.listByGuild?.(ctx.guildId) ?? []) {
    const channelId = String(session.connection?.channelId ?? '').trim();
    if (!channelId) continue;
    for (const userId of ctx.voiceStateStore.getUsersInChannel?.(ctx.guildId, channelId) ?? []) {
      ids.add(String(userId));
    }
  }

  if (ctx.authorId) ids.add(String(ctx.authorId));
  if (ctx.botUserId) ids.delete(String(ctx.botUserId));

  return [...ids];
}

async function handleLove(ctx: CommandContextLike, love: boolean): Promise<void> {
  ensureGuild(ctx);
  const lastfm = requireLastFm(ctx);

  const sessionKey = await lastfm.accounts.getSessionKey(ctx.authorId);
  if (!sessionKey) throw new ValidationError(ctx.t('lastfm.notLinkedSelf', { prefix: ctx.prefix }));

  const session = getSessionOrThrow(ctx);
  const track = session.player.displayTrack ?? session.player.currentTrack ?? null;
  const meta = toLastFmTrack(track as never, { minDurationSec: 1 });
  if (!meta) throw new ValidationError(ctx.t('lastfm.trackNotSupported'));

  await withLastFmErrors(ctx, async () => {
    if (love) {
      await lastfm.client.loveTrack(sessionKey, meta.artist, meta.track);
      await lastfm.accounts.recordLove(ctx.authorId, 1);
      return;
    }
    await lastfm.client.unloveTrack(sessionKey, meta.artist, meta.track);
    await lastfm.accounts.recordLove(ctx.authorId, -1);
  });

  await ctx.reply.success(ctx.t(love ? 'lastfm.loved' : 'lastfm.unloved', {
    track: `${meta.artist} - ${meta.track}`,
  }));
}
