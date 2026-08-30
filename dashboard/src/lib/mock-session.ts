import type { DashboardSession } from '@/types/session';

export function createMockSession(): DashboardSession {
  const queue = [
    {
      id: 'q1',
      title: 'Pflaster',
      artist: 'Ich + Ich',
      durationSec: 238,
      thumbnailUrl: null,
      source: 'spotify',
      requestedBy: 'user-1',
      requestedByName: 'Rainer',
      requestedByAvatarUrl: null,
    },
    {
      id: 'q2',
      title: 'Stadt',
      artist: 'Ich + Ich',
      durationSec: 201,
      thumbnailUrl: null,
      source: 'youtube-search',
      requestedBy: 'user-2',
      requestedByName: 'Alex',
      requestedByAvatarUrl: null,
    },
    {
      id: 'q3',
      title: 'Vom selben Stern',
      artist: 'Ich + Ich',
      durationSec: 256,
      thumbnailUrl: null,
      source: 'deezer',
      requestedBy: 'user-1',
      requestedByName: 'Rainer',
      requestedByAvatarUrl: null,
    },
  ];

  return {
    guildId: 'guild-local',
    guildName: 'Local test guild',
    voiceChannelId: 'vc-general',
    voiceChannelName: 'General',
    userInChannel: true,
    canControl: true,
    autoplayEnabled: true,
    nowPlaying: {
      id: 'np1',
      title: 'Dienen',
      artist: 'Ich + Ich',
      durationSec: 272,
      positionSec: 94,
      thumbnailUrl: null,
      source: 'spotify',
      requestedBy: 'user-1',
      requestedByName: 'Rainer',
      requestedByAvatarUrl: null,
      paused: false,
      loopMode: 'off',
      volumePercent: 72,
      seekable: true,
    },
    queue,
    voiceChannels: [
      { id: 'vc-general', name: 'General', active: true, listenerCount: 3 },
      { id: 'vc-gaming', name: 'Gaming', active: false, listenerCount: 0 },
      { id: 'vc-chill', name: 'Chill', active: false, listenerCount: 1 },
    ],
    effects: {
      filterPreset: 'off',
      eqPreset: 'flat',
      tempoRatio: 1,
      pitchSemitones: 0,
    },
    voteSkip: { votes: 1, required: 2 },
    listeners: [
      { id: 'user-1', name: 'You', avatarUrl: null, isBot: false },
      { id: 'user-2', name: 'Mara', avatarUrl: null, isBot: false },
      { id: 'user-3', name: 'Jonas', avatarUrl: null, isBot: false },
    ],
    handoff: null,
  };
}

export function formatDuration(totalSec: number): string {
  const sec = Math.max(0, Math.floor(totalSec));
  const minutes = Math.floor(sec / 60);
  const seconds = sec % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}
