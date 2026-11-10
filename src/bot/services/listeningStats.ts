export interface ListeningStats {
  playingCount: number;
  listenerCount: number;
}

type ListeningSession = {
  guildId?: string | null;
  connection?: { channelId?: string | null } | null;
  player?: { playing?: boolean } | null;
} | null | undefined;

type CountUsersInChannel = (guildId: string, channelId: string, excludedUserIds?: string[]) => number;

export function collectListeningStats(
  sessions: Iterable<ListeningSession>,
  countUsersInChannel: CountUsersInChannel,
  botUserId: string | null,
): ListeningStats {
  const excluded = botUserId ? [botUserId] : [];
  let playingCount = 0;
  let listenerCount = 0;
  for (const session of sessions) {
    if (session?.player?.playing !== true) continue;
    playingCount += 1;
    const guildId = String(session.guildId ?? '').trim();
    const channelId = String(session.connection?.channelId ?? '').trim();
    if (!guildId || !channelId) continue;
    listenerCount += Math.max(0, countUsersInChannel(guildId, channelId, excluded));
  }
  return { playingCount, listenerCount };
}
