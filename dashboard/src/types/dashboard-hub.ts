export type HubTrack = {
  title?: string;
  artist?: string;
  url?: string;
  thumbnailUrl?: string | null;
  alias?: string | null;
};

export type DashboardHubData = {
  playlists: {
    items: Array<{ name: string; trackCount?: number; updatedAt?: string | null }>;
    total: number;
  };
  favorites: {
    items: HubTrack[];
    total: number;
  };
  stations: Array<{
    key: string;
    name: string;
    url: string;
    description?: string | null;
    tags?: string[];
  }>;
  templates: Array<{ key: string; name: string; tracks: HubTrack[] }>;
  recap: {
    days: number;
    playCount: number;
    topTracks: Array<HubTrack & { plays: number }>;
    topRequesters: Array<{ userId: string; plays: number; name?: string; avatarUrl?: string | null }>;
  };
  profile: {
    guildScore: number;
    taste: Array<{ term?: string; name?: string; value?: number; score?: number }>;
  };
  lastfm: null | {
    account: null | {
      username: string;
      scrobblingEnabled: boolean;
      scrobbleCount: number;
      lovedCount: number;
      streakDays: number;
    };
    recent: Array<{
      artist: string;
      track: string;
      url: string | null;
      imageUrl: string | null;
      nowPlaying: boolean;
      playedAt: string | null;
    }>;
    topTracks: Array<{
      name: string;
      artist: string | null;
      url: string | null;
      playcount: number;
    }>;
  };
  party: null | {
    startedAt: number;
    teams: { a: number; b: number };
    scores: { a: number; b: number };
  };
};
