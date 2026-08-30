type DashboardLibrary = {
  listGuildPlaylists: (guildId: string, page: number, pageSize: number) => Promise<unknown>;
  listUserFavorites: (userId: string, page: number, pageSize: number) => Promise<unknown>;
  listGuildStations: (guildId: string) => Promise<unknown>;
  listQueueTemplates: (guildId: string) => Promise<unknown>;
  buildGuildRecap: (guildId: string, days: number) => Promise<unknown>;
  getUserProfile: (userId: string, guildId: string) => Promise<unknown>;
};

export type DashboardHubPayload = {
  playlists: unknown;
  favorites: unknown;
  stations: unknown;
  templates: unknown;
  recap: unknown;
  profile: unknown;
};

export async function buildDashboardHubPayload(
  library: DashboardLibrary,
  guildId: string,
  userId: string,
): Promise<DashboardHubPayload> {
  const [playlists, favorites, stations, templates, recap, profile] = await Promise.all([
    library.listGuildPlaylists(guildId, 1, 50),
    library.listUserFavorites(userId, 1, 500),
    library.listGuildStations(guildId),
    library.listQueueTemplates(guildId),
    library.buildGuildRecap(guildId, 7),
    library.getUserProfile(userId, guildId),
  ]);

  return { playlists, favorites, stations, templates, recap, profile };
}

export async function toggleUserFavorite(
  library: {
    listUserFavorites: (userId: string, page: number, pageSize: number) => Promise<unknown>;
    addUserFavorite: (userId: string, track: unknown) => Promise<unknown>;
    removeUserFavorite: (userId: string, index: number) => Promise<unknown>;
  },
  userId: string,
  track: { url?: unknown },
): Promise<boolean> {
  const currentUrl = String(track.url ?? '').trim();
  const favorites = await library.listUserFavorites(userId, 1, 500) as {
    items?: Array<{ url?: string | null }>;
  };
  const existingIndex = (favorites.items ?? []).findIndex((favorite) => (
    String(favorite.url ?? '').trim() === currentUrl
  ));
  if (existingIndex < 0) {
    await library.addUserFavorite(userId, track);
    return true;
  }
  await library.removeUserFavorite(userId, existingIndex + 1);
  return false;
}
