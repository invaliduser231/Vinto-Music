export type RadioStationRecord = {
  key?: string | null;
  name?: string | null;
  url?: string | null;
  description?: string | null;
  tags?: string[] | null;
  updatedBy?: string | null;
  updatedAt?: string | Date | null;
  [key: string]: unknown;
};

export type ResolvedRadioStation = {
  key: string;
  name: string;
  url: string;
  description: string | null;
  tags: string[];
  scope: 'builtin' | 'guild';
  updatedBy: string | null;
  updatedAt: string | Date | null;
};

function builtinStation(
  name: string,
  url: string,
  description: string,
  tags: string[],
): ResolvedRadioStation {
  return {
    key: normalizeLookupKey(name),
    name,
    url,
    description,
    tags: normalizeTags(tags),
    scope: 'builtin',
    updatedBy: null,
    updatedAt: null,
  };
}

const BUILTIN_RADIO_STATIONS: ReadonlyArray<ResolvedRadioStation> = [
  builtinStation(
    'BAYERN 3',
    'https://streams.br.de/bayern3_2.m3u',
    'Major German public pop station from Bayerischer Rundfunk.',
    ['germany', 'pop', 'hits', 'mainstream'],
  ),
  builtinStation(
    'BBC Radio 1',
    'http://as-hls-ww-live.akamaized.net/pool_01505109/live/ww/bbc_radio_one/bbc_radio_one.isml/bbc_radio_one-audio%3d96000.norewind.m3u8',
    'The BBC flagship station for current chart, dance and new music.',
    ['bbc', 'uk', 'pop', 'dance'],
  ),
  builtinStation(
    'BBC Radio 1Xtra',
    'http://as-hls-ww-live.akamaized.net/pool_92079267/live/ww/bbc_1xtra/bbc_1xtra.isml/bbc_1xtra-audio%3d96000.norewind.m3u8',
    'BBC station for hip-hop, R&B, dancehall, afrobeat and grime.',
    ['bbc', 'uk', 'hip-hop', 'rnb'],
  ),
  builtinStation(
    'Beat Blender',
    'https://somafm.com/beatblender.pls',
    'Deep-house and downtempo groove selections from SomaFM.',
    ['house', 'downtempo', 'beats', 'electronic'],
  ),
  builtinStation(
    'Boot Liquor',
    'https://somafm.com/bootliquor.pls',
    'Americana, outlaw country and roots cuts.',
    ['americana', 'country', 'roots', 'folk'],
  ),
  builtinStation(
    'Bossa Beyond',
    'https://somafm.com/bossa.pls',
    'Bossa nova, downtempo lounge and chilled global grooves.',
    ['bossa', 'lounge', 'latin', 'chill'],
  ),
  builtinStation(
    'BR-KLASSIK',
    'https://streams.br.de/br-klassik_2.m3u',
    'Classical, opera and orchestral programming from BR.',
    ['germany', 'classical', 'orchestral', 'opera'],
  ),
  builtinStation(
    'Cliqhop IDM',
    'https://somafm.com/cliqhop.pls',
    'Clicks, cuts, glitch and intelligent electronic music.',
    ['idm', 'glitch', 'electronic', 'instrumental', 'lofi', 'chillhop'],
  ),
  builtinStation(
    'Covers',
    'https://somafm.com/covers.pls',
    'Unexpected cover versions across genres.',
    ['covers', 'variety', 'indie', 'pop'],
  ),
  builtinStation(
    'Dark Zone',
    'https://somafm.com/darkzone.pls',
    'Dark ambient and slow industrial textures.',
    ['dark ambient', 'industrial', 'ambient', 'drone'],
  ),
  builtinStation(
    'Deep Space One',
    'https://somafm.com/deepspaceone.pls',
    'Deep ambient electronic, experimental and space music.',
    ['ambient', 'space', 'electronic', 'experimental'],
  ),
  builtinStation(
    'Deutschlandfunk',
    'https://st01.sslstream.dlf.de/dlf/01/128/mp3/stream.mp3?aggregator=web',
    'German public radio with news, analysis and culture.',
    ['germany', 'news', 'talk', 'culture'],
  ),
  builtinStation(
    'Deutschlandfunk Kultur',
    'https://st02.sslstream.dlf.de/dlf/02/128/mp3/stream.mp3?aggregator=web',
    'German public culture station with features, arts and spoken audio.',
    ['germany', 'culture', 'talk', 'arts'],
  ),
  builtinStation(
    'Deutschlandfunk Nova',
    'https://st03.sslstream.dlf.de/dlf/03/128/mp3/stream.mp3?aggregator=web',
    'German public youth station with pop culture, science and podcasts.',
    ['germany', 'youth', 'talk', 'alternative'],
  ),
  builtinStation(
    'Doomed',
    'https://somafm.com/doomed.pls',
    'Heavy doom, sludge and post-metal.',
    ['doom', 'metal', 'heavy', 'dark'],
  ),
  builtinStation(
    'Drone Zone',
    'https://somafm.com/dronezone.pls',
    'Atmospheric textures with minimal beats.',
    ['ambient', 'drone', 'meditation', 'sleep'],
  ),
  builtinStation(
    'Fluid',
    'https://somafm.com/fluid.pls',
    'Liquid funk, nu-jazz and laid-back grooves.',
    ['jazz', 'funk', 'groove', 'downtempo'],
  ),
  builtinStation(
    'Folk Forward',
    'https://somafm.com/folkfwd.pls',
    'Modern folk, americana and singer-songwriter picks.',
    ['folk', 'americana', 'acoustic', 'indie'],
  ),
  builtinStation(
    'Groove Salad',
    'https://somafm.com/groovesalad.pls',
    'Chilled ambient and downtempo beats and grooves.',
    ['ambient', 'downtempo', 'chill', 'electronic', 'lofi', 'study'],
  ),
  builtinStation(
    'Groove Salad Classic',
    'https://somafm.com/gsclassic.pls',
    'Classic ambient, downtempo and trip-hop from the original era.',
    ['ambient', 'downtempo', 'classic', 'trip-hop'],
  ),
  builtinStation(
    'Illinois Street Lounge',
    'https://somafm.com/illstreet.pls',
    'Classic bachelor pad, playful exotica and vintage lounge.',
    ['lounge', 'vintage', 'exotica', 'easy-listening'],
  ),
  builtinStation(
    'Indie Pop Rocks!',
    'https://somafm.com/indiepop.pls',
    'New and classic favorite indie pop tracks.',
    ['indie', 'pop', 'rock', 'alternative'],
  ),
  builtinStation(
    'Jazz24',
    'https://knkx-live-a.edge.audiocdn.com/6285_128k/playlist.m3u8',
    '24/7 straight-ahead jazz, classics and modern sets.',
    ['jazz', 'swing', 'blues', 'instrumental'],
  ),
  builtinStation(
    'KEXP 90.3 FM',
    'https://kexp.streamguys1.com/kexp128.mp3',
    'Seattle indie institution with alternative, rock and eclectic sets.',
    ['indie', 'rock', 'alternative', 'seattle'],
  ),
  builtinStation(
    'Lush',
    'https://somafm.com/lush.pls',
    'Vocal dream pop, shoegaze and ethereal mood music.',
    ['dream-pop', 'shoegaze', 'ethereal', 'indie'],
  ),
  builtinStation(
    'Metal Detector',
    'https://somafm.com/metal.pls',
    'From classic heavy metal to modern hard riffs.',
    ['metal', 'rock', 'heavy', 'guitar'],
  ),
  builtinStation(
    'Mission Control',
    'https://somafm.com/missioncontrol.pls',
    'Ambient and cosmic soundtracks for deep-space focus.',
    ['ambient', 'space', 'soundtrack', 'focus', 'study'],
  ),
  builtinStation(
    'NTS 1',
    'https://stream-relay-geo.ntslive.net/stream?client=direct',
    'NTS Radio stream one with eclectic global programming.',
    ['nts', 'eclectic', 'global', 'underground'],
  ),
  builtinStation(
    'NTS 2',
    'https://stream-relay-geo.ntslive.net/stream2?client=direct',
    'NTS Radio stream two with specialist shows and deep cuts.',
    ['nts', 'eclectic', 'specialist', 'underground'],
  ),
  builtinStation(
    'PULS',
    'https://streams.br.de/puls_2.m3u',
    'Modern youth and alternative station from Bayerischer Rundfunk.',
    ['germany', 'alternative', 'indie', 'youth'],
  ),
  builtinStation(
    'PopTron',
    'https://somafm.com/poptron.pls',
    'Smart synth-driven pop and indie-electronic crossover.',
    ['synthpop', 'indie', 'electronic', 'pop'],
  ),
  builtinStation(
    'Radio Paradise',
    'https://stream.radioparadise.com/mp3-128',
    'Listener-supported eclectic mix spanning rock, ambient and world.',
    ['eclectic', 'rock', 'ambient', 'world', 'mix'],
  ),
  builtinStation(
    'Reggae Roots',
    'https://somafm.com/reggae.pls',
    'Roots reggae, dub and island grooves.',
    ['reggae', 'dub', 'roots', 'island'],
  ),
  builtinStation(
    'Secret Agent',
    'https://somafm.com/secretagent.pls',
    'Spy soundtrack, exotica and stylish lounge cuts.',
    ['lounge', 'spy', 'exotica', 'soundtrack'],
  ),
  builtinStation(
    'Sonic Universe',
    'https://somafm.com/sonicuniverse.pls',
    'Avant jazz, free improvisation and beyond.',
    ['jazz', 'avant-garde', 'experimental', 'instrumental'],
  ),
  builtinStation(
    'Space Station Soma',
    'https://somafm.com/spacestation.pls',
    'Spaced-out ambient and mid-tempo electronica.',
    ['ambient', 'electronica', 'space', 'chill', 'lofi'],
  ),
  builtinStation(
    'Suburbs of Goa',
    'https://somafm.com/suburbsofgoa.pls',
    'Desi-influenced Asian world beats and beyond.',
    ['world', 'goa', 'psy', 'asian'],
  ),
  builtinStation(
    'Synphaera',
    'https://somafm.com/synphaera.pls',
    'Modern ambient, Berlin-school synth and cinematic electronics.',
    ['ambient', 'synth', 'berlin-school', 'cinematic'],
  ),
  builtinStation(
    'The Trip',
    'https://somafm.com/thetrip.pls',
    'Progressive and deep psychedelic electronic journeys.',
    ['psychedelic', 'progressive', 'electronic', 'trance'],
  ),
  builtinStation(
    'Underground 80s',
    'https://somafm.com/u80s.pls',
    'Alternative 80s, post-punk, new wave and college radio cuts.',
    ['80s', 'new-wave', 'post-punk', 'alternative'],
  ),
  builtinStation(
    'Vaporwaves',
    'https://somafm.com/vaporwaves.pls',
    'Vaporwave, future funk and internet-age nostalgia.',
    ['vaporwave', 'future-funk', 'electronic', 'retro'],
  ),
];

function normalizeLookupKey(value: unknown) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeTags(tags: unknown) {
  const values = Array.isArray(tags) ? tags : [];
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const tag of values) {
    const next = normalizeLookupKey(tag);
    if (!next || seen.has(next)) continue;
    seen.add(next);
    normalized.push(next);
  }
  return normalized;
}

function toResolvedGuildStation(station: RadioStationRecord): ResolvedRadioStation | null {
  const name = String(station?.name ?? '').trim();
  const url = String(station?.url ?? '').trim();
  if (!name || !url) return null;

  return {
    key: normalizeLookupKey(station?.key ?? name),
    name,
    url,
    description: station?.description != null ? String(station.description).trim() || null : null,
    tags: normalizeTags(station?.tags),
    scope: 'guild',
    updatedBy: station?.updatedBy != null ? String(station.updatedBy) : null,
    updatedAt: station?.updatedAt ?? null,
  };
}

function sortStations(left: ResolvedRadioStation, right: ResolvedRadioStation) {
  if (left.scope !== right.scope) {
    return left.scope === 'guild' ? -1 : 1;
  }
  return left.name.localeCompare(right.name);
}

function buildSearchHaystack(station: ResolvedRadioStation) {
  return [
    station.key,
    normalizeLookupKey(station.name),
    normalizeLookupKey(station.description),
    ...station.tags.map((tag) => normalizeLookupKey(tag)),
  ].filter(Boolean);
}

const QUERY_SYNONYMS: Readonly<Record<string, string[]>> = {
  lofi: ['chill', 'downtempo', 'beats', 'study'],
  chill: ['ambient', 'downtempo', 'lofi'],
  study: ['focus', 'ambient', 'lofi'],
  focus: ['study', 'ambient', 'instrumental'],
  news: ['talk', 'culture', 'bbc'],
  jazz: ['swing', 'blues', 'instrumental'],
  metal: ['heavy', 'doom', 'guitar'],
  indie: ['alternative', 'rock', 'pop'],
  ambient: ['space', 'drone', 'chill'],
  electronic: ['electronica', 'idm', 'synth'],
};

function expandQueryTokens(queryKey: string) {
  const baseTokens = queryKey.split(' ').filter(Boolean);
  const expanded = new Set<string>(baseTokens);
  for (const token of baseTokens) {
    const synonyms = QUERY_SYNONYMS[token] ?? [];
    for (const synonym of synonyms) {
      const normalized = normalizeLookupKey(synonym);
      if (normalized) expanded.add(normalized);
    }
  }
  return [...expanded];
}

function scoreStationMatch(station: ResolvedRadioStation, queryKey: string) {
  if (!queryKey) return 0;

  const normalizedName = normalizeLookupKey(station.name);
  const normalizedDescription = normalizeLookupKey(station.description);
  const normalizedTags = station.tags.map((tag) => normalizeLookupKey(tag)).filter(Boolean);
  const queryTokens = queryKey.split(' ').filter(Boolean);
  const expandedTokens = expandQueryTokens(queryKey);
  let score = 0;

  if (station.key === queryKey || normalizedName === queryKey) {
    score += 10_000;
  }

  for (const tag of normalizedTags) {
    if (tag === queryKey) {
      score += 5_000;
    }
  }

  for (const token of queryTokens) {
    if (station.key.includes(token)) score += 160;
    if (normalizedName.includes(token)) score += 140;
    if (normalizedDescription.includes(token)) score += 35;
    for (const tag of normalizedTags) {
      if (tag === token) score += 220;
      else if (tag.includes(token)) score += 70;
    }
  }

  for (const token of expandedTokens) {
    if (queryTokens.includes(token)) continue;
    if (normalizedName.includes(token)) score += 18;
    if (normalizedDescription.includes(token)) score += 10;
    for (const tag of normalizedTags) {
      if (tag === token) score += 30;
      else if (tag.includes(token)) score += 8;
    }
  }

  return score;
}

function isExactStationMatch(station: ResolvedRadioStation, queryKey: string) {
  if (!queryKey) return false;
  return (
    station.key === queryKey
    || normalizeLookupKey(station.name) === queryKey
    || station.tags.some((tag) => normalizeLookupKey(tag) === queryKey)
  );
}

function sortScoredStations(left: ResolvedRadioStation, right: ResolvedRadioStation, queryKey: string) {
  const leftScore = scoreStationMatch(left, queryKey);
  const rightScore = scoreStationMatch(right, queryKey);
  if (rightScore !== leftScore) return rightScore - leftScore;
  return sortStations(left, right);
}

function isFuzzyStationMatch(station: ResolvedRadioStation, queryKey: string) {
  if (!queryKey) return true;
  const tokens = queryKey.split(' ').filter(Boolean);
  if (!tokens.length) return true;
  const haystack = buildSearchHaystack(station);
  return tokens.every((token) => haystack.some((part) => part.includes(token)));
}

export function listBuiltInRadioStations() {
  return [...BUILTIN_RADIO_STATIONS];
}

export function listAvailableRadioStations(guildStations: RadioStationRecord[] = [], query: string | null = null) {
  const byKey = new Map<string, ResolvedRadioStation>();
  for (const station of BUILTIN_RADIO_STATIONS) {
    byKey.set(station.key, station);
  }
  for (const station of guildStations) {
    const resolved = toResolvedGuildStation(station);
    if (!resolved) continue;
    byKey.set(resolved.key, resolved);
  }

  const queryKey = normalizeLookupKey(query);
  const stations = [...byKey.values()];
  if (!queryKey) {
    return stations.sort(sortStations);
  }

  return stations
    .map((station) => ({ station, score: scoreStationMatch(station, queryKey) }))
    .filter(({ station, score }) => score > 0 || isFuzzyStationMatch(station, queryKey))
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      return sortStations(left.station, right.station);
    })
    .map(({ station }) => station);
}

export function resolveRadioStationIndexSelection(guildStations: RadioStationRecord[] = [], value: unknown) {
  const parsed = Number.parseInt(String(value ?? '').trim(), 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return {
      station: null,
      index: null,
      total: listAvailableRadioStations(guildStations).length,
    };
  }

  const stations = listAvailableRadioStations(guildStations);
  return {
    station: stations[parsed - 1] ?? null,
    index: parsed,
    total: stations.length,
  };
}

export function resolveRadioStationSelection(guildStations: RadioStationRecord[] = [], query: string) {
  const queryKey = normalizeLookupKey(query);
  const stations = listAvailableRadioStations(guildStations);
  const exactMatches = stations.filter((station) => isExactStationMatch(station, queryKey));
  if (exactMatches.length === 1) {
    return {
      station: exactMatches[0] ?? null,
      matches: exactMatches,
      ambiguous: false,
    };
  }

  if (exactMatches.length > 1) {
    const rankedExactMatches = [...exactMatches].sort((left, right) => sortScoredStations(left, right, queryKey));
    return {
      station: rankedExactMatches[0] ?? null,
      matches: rankedExactMatches,
      ambiguous: false,
    };
  }

  const fuzzyMatches = listAvailableRadioStations(guildStations, query);
  if (fuzzyMatches.length === 1) {
    return {
      station: fuzzyMatches[0] ?? null,
      matches: fuzzyMatches,
      ambiguous: false,
    };
  }

  const top = fuzzyMatches[0] ?? null;
  const second = fuzzyMatches[1] ?? null;
  if (top) {
    const topScore = scoreStationMatch(top, queryKey);
    const secondScore = second ? scoreStationMatch(second, queryKey) : 0;
    if (topScore > 0) {
      return {
        station: top,
        matches: fuzzyMatches.slice(0, 10),
        ambiguous: topScore === secondScore && secondScore > 0,
      };
    }
  }

  return {
    station: null,
    matches: fuzzyMatches.slice(0, 10),
    ambiguous: fuzzyMatches.length > 1,
  };
}

export function pickRandomRadioStation(guildStations: RadioStationRecord[] = [], query: string | null = null) {
  const matches = listAvailableRadioStations(guildStations, query);
  if (!matches.length) return null;
  const index = Math.floor(Math.random() * matches.length);
  return matches[index] ?? null;
}
