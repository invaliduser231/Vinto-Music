const DEFAULT_CDN_BASE = 'https://fluxerusercontent.com';
const DEFAULT_STATIC_BASE = 'https://fluxerstatic.com';

export type DashboardMemberProfile = {
  id: string;
  username: string;
  avatarUrl: string;
};

type LooseRecord = Record<string, unknown>;

function asRecord(value: unknown): LooseRecord | null {
  if (!value || typeof value !== 'object') return null;
  return value as LooseRecord;
}

export function buildMemberAvatarUrl(userId: string, avatarHash: string | null | undefined): string {
  const id = String(userId ?? '').trim();
  const hash = String(avatarHash ?? '').trim();
  if (id && hash) {
    const extension = hash.startsWith('a_') ? 'gif' : 'png';
    return `${DEFAULT_CDN_BASE}/avatars/${id}/${hash}.${extension}`;
  }
  if (!id) return `${DEFAULT_STATIC_BASE}/avatars/0.png`;
  const index = Number(BigInt(id) % 6n);
  return `${DEFAULT_STATIC_BASE}/avatars/${index}.png`;
}

export function parseMemberProfile(member: unknown): DashboardMemberProfile | null {
  const root = asRecord(member);
  if (!root) return null;

  const user = asRecord(root.user) ?? root;
  const id = String(user.id ?? root.id ?? '').trim();
  if (!id) return null;

  const username = String(
    user.global_name
    ?? user.display_name
    ?? user.username
    ?? user.name
    ?? root.nick
    ?? id,
  ).trim() || id;

  const avatarHash = String(user.avatar ?? root.avatar ?? '').trim() || null;
  return {
    id,
    username,
    avatarUrl: buildMemberAvatarUrl(id, avatarHash),
  };
}

export function collectRequesterIds(payload: {
  nowPlaying?: { requestedBy?: string | null } | null;
  queue?: Array<{ requestedBy?: string | null }>;
  listeners?: Array<{ id?: string | null }>;
}): string[] {
  const ids = new Set<string>();
  const nowPlayingId = String(payload.nowPlaying?.requestedBy ?? '').trim();
  if (nowPlayingId) ids.add(nowPlayingId);
  for (const track of payload.queue ?? []) {
    const requesterId = String(track.requestedBy ?? '').trim();
    if (requesterId) ids.add(requesterId);
  }
  for (const listener of payload.listeners ?? []) {
    const listenerId = String(listener.id ?? '').trim();
    if (listenerId) ids.add(listenerId);
  }
  return [...ids];
}

export function applyRequesterProfiles(
  payload: {
    nowPlaying: ({
      requestedBy: string | null;
      requestedByName?: string | null;
      requestedByAvatarUrl?: string | null;
    }) | null;
    queue: Array<{
      requestedBy: string | null;
      requestedByName?: string | null;
      requestedByAvatarUrl?: string | null;
    }>;
    listeners?: Array<{
      id: string;
      name?: string | null;
      avatarUrl?: string | null;
    }>;
  },
  profiles: Map<string, DashboardMemberProfile>,
): void {
  const enrich = (track: {
    requestedBy: string | null;
    requestedByName?: string | null;
    requestedByAvatarUrl?: string | null;
  }) => {
    const requesterId = String(track.requestedBy ?? '').trim();
    if (!requesterId) return;
    const profile = profiles.get(requesterId);
    if (!profile) return;
    track.requestedByName = profile.username;
    track.requestedByAvatarUrl = profile.avatarUrl;
  };

  if (payload.nowPlaying) enrich(payload.nowPlaying);
  for (const track of payload.queue) enrich(track);

  for (const listener of payload.listeners ?? []) {
    const profile = profiles.get(String(listener.id ?? '').trim());
    if (!profile) continue;
    listener.name = profile.username;
    listener.avatarUrl = profile.avatarUrl;
  }
}
