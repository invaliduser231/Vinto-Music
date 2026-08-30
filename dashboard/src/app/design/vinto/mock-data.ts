export const MOCK_SERVERS = [
  {
    id: 's1',
    name: 'Vinto Lounge',
    icon: 'https://api.dicebear.com/7.x/initials/svg?seed=VL&backgroundColor=1f1f22',
  },
  {
    id: 's2',
    name: 'Gaming Crew',
    icon: 'https://api.dicebear.com/7.x/initials/svg?seed=GC&backgroundColor=2e1065',
  },
  {
    id: 's3',
    name: 'Late Night Chill',
    icon: 'https://api.dicebear.com/7.x/initials/svg?seed=LN&backgroundColor=831843',
  }
];

export const MOCK_STATE = {
  server: MOCK_SERVERS[0],
  voiceChannel: '🎵 Music & Chill',
  user: {
    name: 'Rainer',
    avatar: 'https://api.dicebear.com/7.x/notionists/svg?seed=Rainer&backgroundColor=ff2d78',
  },
  status: 'connected',
};

export const MOCK_TRACKS = [
  {
    id: '1',
    title: 'Blinding Lights',
    artist: 'The Weeknd',
    source: 'Spotify',
    duration: 200,
    cover: 'https://i.scdn.co/image/ab67616d0000b2738863bc11d2aa12b54f5aeb36',
    requester: 'Rainer',
  },
  {
    id: '2',
    title: 'Get Lucky (feat. Pharrell Williams)',
    artist: 'Daft Punk, Pharrell Williams',
    source: 'YouTube',
    duration: 249,
    cover: 'https://i.scdn.co/image/ab67616d0000b273b33d46dfa2635a47eebf63b2',
    requester: 'Alex',
  },
  {
    id: '3',
    title: 'Midnight City',
    artist: 'M83',
    source: 'Deezer',
    duration: 243,
    cover: 'https://i.scdn.co/image/ab67616d0000b273c52e421be0744c80210bb218',
    requester: 'Sam',
  },
  {
    id: '4',
    title: 'Do I Wanna Know?',
    artist: 'Arctic Monkeys',
    source: 'SoundCloud',
    duration: 272,
    cover: 'https://i.scdn.co/image/ab67616d0000b2734ae1c4c5c45aabe565499163',
    requester: 'Rainer',
  },
  {
    id: '5',
    title: 'Instant Crush',
    artist: 'Daft Punk, Julian Casablancas',
    source: 'Audius',
    duration: 338,
    cover: 'https://i.scdn.co/image/ab67616d0000b273b33d46dfa2635a47eebf63b2',
    requester: 'DJ',
  },
];

export function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}
