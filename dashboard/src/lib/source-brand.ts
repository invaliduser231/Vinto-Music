export type SourceBrandKey =
  | 'youtube'
  | 'spotify'
  | 'deezer'
  | 'soundcloud'
  | 'applemusic'
  | 'tidal'
  | 'bandcamp'
  | 'audius'
  | 'vkmusic'
  | 'jiosaavn'
  | 'radio';

const SOURCE_LABELS: Record<SourceBrandKey, string> = {
  youtube: 'YouTube',
  spotify: 'Spotify',
  deezer: 'Deezer',
  soundcloud: 'SoundCloud',
  applemusic: 'Apple Music',
  tidal: 'Tidal',
  bandcamp: 'Bandcamp',
  audius: 'Audius',
  vkmusic: 'VK Music',
  jiosaavn: 'JioSaavn',
  radio: 'Radio',
};

const SOURCE_COLORS: Record<SourceBrandKey, string> = {
  youtube: '#ff0033',
  spotify: '#1db954',
  deezer: '#a238ff',
  soundcloud: '#ff5500',
  applemusic: '#fa243c',
  tidal: '#00cfff',
  bandcamp: '#1da0c3',
  audius: '#cc0fe0',
  vkmusic: '#0077ff',
  jiosaavn: '#2bc5b4',
  radio: '#ff2d78',
};

const SOURCE_ICON_SLUGS: Record<SourceBrandKey, string> = {
  youtube: 'youtube',
  spotify: 'spotify',
  deezer: 'deezer',
  soundcloud: 'soundcloud',
  applemusic: 'applemusic',
  tidal: 'tidal',
  bandcamp: 'bandcamp',
  audius: 'audius',
  vkmusic: 'vk',
  jiosaavn: 'jiosaavn',
  radio: 'radio',
};

export function normalizeSourceKey(source: string | null | undefined): SourceBrandKey | null {
  const raw = String(source ?? '').trim().toLowerCase();
  if (!raw) return null;

  if (raw.includes('youtube') || raw.includes('youtu')) return 'youtube';
  if (raw.includes('spotify')) return 'spotify';
  if (raw.includes('deezer')) return 'deezer';
  if (raw.includes('soundcloud')) return 'soundcloud';
  if (raw.includes('apple')) return 'applemusic';
  if (raw.includes('tidal')) return 'tidal';
  if (raw.includes('bandcamp')) return 'bandcamp';
  if (raw.includes('audius')) return 'audius';
  if (raw.includes('vk')) return 'vkmusic';
  if (raw.includes('jiosaavn') || raw.includes('saavn')) return 'jiosaavn';
  if (raw.includes('radio')) return 'radio';

  const head = raw.split(/[-_]/)[0];
  if (head && head in SOURCE_LABELS) return head as SourceBrandKey;
  return null;
}

export function sourceBrandLabel(source: string | null | undefined): string {
  const key = normalizeSourceKey(source);
  if (key) return SOURCE_LABELS[key];
  const raw = String(source ?? '').trim();
  if (!raw) return 'Unknown';
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

export function sourceBrandColor(source: string | null | undefined): string {
  const key = normalizeSourceKey(source);
  return key ? SOURCE_COLORS[key] : '#2a2a30';
}

export function sourceBrandIconUrl(source: string | null | undefined): string | null {
  const key = normalizeSourceKey(source);
  if (!key) return null;
  const slug = SOURCE_ICON_SLUGS[key];
  const color = SOURCE_COLORS[key].replace('#', '');
  return `https://cdn.simpleicons.org/${slug}/white`;
}

export function hasSourceBrand(source: string | null | undefined): boolean {
  return normalizeSourceKey(source) !== null;
}
