export type QueueTrack = {
  id: string;
  title: string;
  artist: string;
  durationSec: number;
  thumbnailUrl: string | null;
  source: string;
  requestedBy: string | null;
  requestedByName: string | null;
  requestedByAvatarUrl: string | null;
  url?: string | null;
};

export type NowPlayingTrack = QueueTrack & {
  positionSec: number;
  paused: boolean;
  loopMode: 'off' | 'track' | 'queue';
  volumePercent: number;
  seekable: boolean;
};

export type VoiceChannelOption = {
  id: string;
  name: string;
  active: boolean;
  listenerCount: number;
};

export type SessionListener = {
  id: string;
  name: string | null;
  avatarUrl: string | null;
  isBot: boolean;
};

export type DashboardSession = {
  guildId: string;
  guildName: string;
  voiceChannelId: string;
  voiceChannelName: string;
  userInChannel: boolean;
  canControl: boolean;
  autoplayEnabled: boolean;
  nowPlaying: NowPlayingTrack | null;
  queue: QueueTrack[];
  voiceChannels: VoiceChannelOption[];
  listeners: SessionListener[];
  effects: {
    filterPreset: string;
    eqPreset: string;
    tempoRatio: number;
    pitchSemitones: number;
  };
  voteSkip: {
    votes: number;
    required: number;
  };
  handoff: { userId: string; expiresAt: number } | null;
};
