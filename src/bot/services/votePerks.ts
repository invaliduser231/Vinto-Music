export interface PerkLimits {
  maxPlaylistTracks: number | null;
  searchResultLimit: number;
  playCommandCooldownMs: number;
  maxFavoritesPerUser: number;
}

export interface PerkConfig {
  maxPlaylistTracks?: number | null;
  searchResultLimit?: number;
  playCommandCooldownMs?: number;
  maxFavoritesPerUser?: number;
}

export const VOTER_PERKS = {
  playlistTrackMultiplier: 4,
  searchResultLimit: 10,
  playCooldownMs: 0,
  favoriteMultiplier: 2,
} as const;

export function baseLimits(config: PerkConfig): PerkLimits {
  return {
    maxPlaylistTracks: config.maxPlaylistTracks ?? null,
    searchResultLimit: config.searchResultLimit ?? 5,
    playCommandCooldownMs: config.playCommandCooldownMs ?? 0,
    maxFavoritesPerUser: config.maxFavoritesPerUser ?? 500,
  };
}

export function applyVoterPerks(limits: PerkLimits): PerkLimits {
  return {
    maxPlaylistTracks: limits.maxPlaylistTracks == null
      ? null
      : limits.maxPlaylistTracks * VOTER_PERKS.playlistTrackMultiplier,
    searchResultLimit: Math.max(limits.searchResultLimit, VOTER_PERKS.searchResultLimit),
    playCommandCooldownMs: Math.min(limits.playCommandCooldownMs, VOTER_PERKS.playCooldownMs),
    maxFavoritesPerUser: limits.maxFavoritesPerUser * VOTER_PERKS.favoriteMultiplier,
  };
}

export function resolveLimits(config: PerkConfig, hasVoted: boolean): PerkLimits {
  const limits = baseLimits(config);
  return hasVoted ? applyVoterPerks(limits) : limits;
}

export function describePerkDelta(config: PerkConfig): Array<{
  key: string;
  base: number | null;
  voter: number | null;
}> {
  const base = baseLimits(config);
  const voter = applyVoterPerks(base);

  return [
    { key: 'playlistTracks', base: base.maxPlaylistTracks, voter: voter.maxPlaylistTracks },
    { key: 'searchResults', base: base.searchResultLimit, voter: voter.searchResultLimit },
    { key: 'playCooldown', base: base.playCommandCooldownMs, voter: voter.playCommandCooldownMs },
    { key: 'favorites', base: base.maxFavoritesPerUser, voter: voter.maxFavoritesPerUser },
  ];
}
