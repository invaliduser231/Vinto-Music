export type SearchPrefix = {
  identifier: string;
  label: string;
  query: string;
};

const SEARCH_SOURCES: Array<{ aliases: string[]; identifier: string; label: string }> = [
  { aliases: ['yt', 'youtube'], identifier: 'ytsearch', label: 'YouTube' },
  { aliases: ['ytm', 'ytmusic'], identifier: 'ytmsearch', label: 'YouTube Music' },
  { aliases: ['sc', 'soundcloud'], identifier: 'scsearch', label: 'SoundCloud' },
  { aliases: ['dz', 'deezer'], identifier: 'dzsearch', label: 'Deezer' },
  { aliases: ['sp', 'spotify'], identifier: 'spsearch', label: 'Spotify' },
  { aliases: ['am', 'apple', 'applemusic'], identifier: 'amsearch', label: 'Apple Music' },
  { aliases: ['td', 'tidal'], identifier: 'tdsearch', label: 'Tidal' },
  { aliases: ['bc', 'bandcamp'], identifier: 'bcsearch', label: 'Bandcamp' },
  { aliases: ['js', 'jiosaavn'], identifier: 'jssearch', label: 'JioSaavn' },
];

const ALIAS_LOOKUP = new Map(
  SEARCH_SOURCES.flatMap((source) => source.aliases.map((alias) => [alias, source] as const)),
);

const RAW_IDENTIFIER_PATTERN = /^([a-z]{2,12}):\S/;
const RAW_IDENTIFIER_SUFFIXES = ['search', 'rec', 'isrc'];
const RAW_IDENTIFIER_EXTRAS = new Set(['ftts', 'gtts', 'speak', 'tts']);

export function listSearchPrefixes(): Array<{ alias: string; label: string }> {
  return SEARCH_SOURCES.map((source) => ({ alias: source.aliases[0]!, label: source.label }));
}

export function parseSearchPrefix(input: string): SearchPrefix | null {
  const match = /^([a-z]+):\s*(.+)$/i.exec(String(input ?? '').trim());
  if (!match?.[1] || !match[2]) return null;
  if (/^https?$/i.test(match[1])) return null;

  const source = ALIAS_LOOKUP.get(match[1].toLowerCase());
  const query = match[2].trim();
  if (!source || !query) return null;
  return { identifier: source.identifier, label: source.label, query };
}

export function isNodeLinkSourceIdentifier(input: string): boolean {
  const match = RAW_IDENTIFIER_PATTERN.exec(String(input ?? '').trim());
  if (!match?.[1]) return false;
  const prefix = match[1];
  return RAW_IDENTIFIER_EXTRAS.has(prefix) || RAW_IDENTIFIER_SUFFIXES.some((suffix) => prefix.endsWith(suffix));
}
