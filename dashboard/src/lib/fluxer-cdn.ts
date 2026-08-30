const DEFAULT_CDN_BASE = 'https://fluxerusercontent.com';

const DEFAULT_STATIC_BASE = 'https://fluxerstatic.com';

export function readFluxerCdnBase(): string {
  const fromEnv = process.env.NEXT_PUBLIC_FLUXER_CDN_BASE?.trim();
  return (fromEnv || DEFAULT_CDN_BASE).replace(/\/+$/, '');
}

export function buildGuildIconUrl(
  guildId: string,
  iconHash: string | null | undefined,
  options?: { size?: number; cdnBase?: string },
): string | null {
  const id = String(guildId ?? '').trim();
  const hash = String(iconHash ?? '').trim();
  if (!id || !hash) return null;

  const cdnBase = (options?.cdnBase ?? readFluxerCdnBase()).replace(/\/+$/, '');
  const extension = hash.startsWith('a_') ? 'gif' : 'png';
  const url = `${cdnBase}/icons/${id}/${hash}.${extension}`;
  if (options?.size && Number.isFinite(options.size)) {
    return `${url}?size=${Math.round(options.size)}`;
  }
  return url;
}

export function getDefaultUserAvatarUrl(userId: string): string {
  const id = String(userId ?? '').trim();
  if (!id || !/^\d+$/.test(id)) return `${DEFAULT_STATIC_BASE}/avatars/0.png`;
  const index = Number(BigInt(id) % 6n);
  return `${DEFAULT_STATIC_BASE}/avatars/${index}.png`;
}

export function buildUserAvatarUrl(
  userId: string,
  avatarHash: string | null | undefined,
  options?: { size?: number; cdnBase?: string },
): string | null {
  const id = String(userId ?? '').trim();
  const hash = String(avatarHash ?? '').trim();
  if (!id || !hash) return null;

  const cdnBase = (options?.cdnBase ?? readFluxerCdnBase()).replace(/\/+$/, '');
  const extension = hash.startsWith('a_') ? 'gif' : 'png';
  const url = `${cdnBase}/avatars/${id}/${hash}.${extension}`;
  if (options?.size && Number.isFinite(options.size)) {
    return `${url}?size=${Math.round(options.size)}`;
  }
  return url;
}

export function resolveUserAvatarUrl(
  userId: string,
  avatarHash: string | null | undefined,
  options?: { size?: number },
): string {
  const custom = buildUserAvatarUrl(userId, avatarHash, options);
  return custom ?? getDefaultUserAvatarUrl(userId);
}
