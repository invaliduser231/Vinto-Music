export const LOOP_OFF = 'off';
export const LOOP_TRACK = 'track';
export const LOOP_QUEUE = 'queue';
export const LOOP_MODES = new Set([LOOP_OFF, LOOP_TRACK, LOOP_QUEUE]);

export const FILTER_PRESETS: Record<string, string[]> = {
  off: [],
  bassboost: ['bass=g=8:f=110:w=0.6'],
  nightcore: ['asetrate=48000*1.20', 'aresample=48000', 'atempo=1.05'],
  vaporwave: ['asetrate=48000*0.80', 'aresample=48000', 'atempo=0.95', 'lowpass=f=3200'],
  '8d': ['apulsator=hz=0.08'],
  soft: ['highshelf=f=8000:g=-6', 'lowshelf=f=120:g=-2'],
  karaoke: ['pan=stereo|c0=0.5*c0-0.5*c1|c1=0.5*c1-0.5*c0'],
  radio: ['highpass=f=200', 'lowpass=f=3500', 'acompressor=threshold=-18dB:ratio=3:attack=20:release=250'],
};

FILTER_PRESETS.karoake = FILTER_PRESETS.karaoke ?? [];

export const EQ_PRESETS = {
  flat: [0, 0, 0, 0, 0],
  pop: [2, 1, 0, 1, 2],
  rock: [4, 2, -1, 2, 4],
  edm: [5, 3, 0, 2, 4],
  vocal: [-1, 1, 3, 3, 1],
};

export const YT_PLAYLIST_RESOLVERS = new Set(['ytdlp', 'playdl']);




