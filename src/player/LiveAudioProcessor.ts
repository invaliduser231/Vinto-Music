import { Transform } from 'node:stream';

const SAMPLE_RATE = 48_000;
const CHANNELS = 2;
const BYTES_PER_SAMPLE = 2;
const BYTES_PER_STEREO_SAMPLE = CHANNELS * BYTES_PER_SAMPLE;
const TRANSITION_MS = 35;
const VOLUME_SMOOTHING = 0.0025;

const EQ_PRESETS = {
  flat: [0, 0, 0, 0, 0],
  pop: [2, 1, 0, 1, 2],
  rock: [4, 2, -1, 2, 4],
  edm: [5, 3, 0, 2, 4],
  vocal: [-1, 1, 3, 3, 1],
};

const EQ_BANDS = [90, 250, 1000, 4000, 12000];

type FilterStage = {
  type: 'lowshelf' | 'highshelf' | 'lowpass' | 'highpass' | 'peaking';
  frequency: number;
  gainDb?: number;
  q?: number;
};

type FilterPresetDefinition = {
  stages: FilterStage[];
  panHz?: number;
  karaoke?: boolean;
};

type FilterProgram = {
  karaoke: boolean;
  panHz: number;
  filters: BiquadFilter[];
};

type ProgramTransition = {
  from: FilterProgram;
  to: FilterProgram;
  mix: number;
  mixStep: number;
};

type LiveAudioProcessorOptions = {
  volumePercent?: number;
  filterPreset?: string;
  eqPreset?: string;
};

const LIVE_FILTER_PRESETS: Record<string, FilterPresetDefinition> = {
  off: { stages: [] },
  bassboost: {
    stages: [
      { type: 'lowshelf', frequency: 110, gainDb: 8, q: 0.7 },
    ],
  },
  '8d': {
    stages: [],
    panHz: 0.08,
  },
  soft: {
    stages: [
      { type: 'highshelf', frequency: 8000, gainDb: -6, q: 0.707 },
      { type: 'lowshelf', frequency: 120, gainDb: -2, q: 0.707 },
    ],
  },
  karaoke: {
    stages: [],
    karaoke: true,
  },
  radio: {
    stages: [
      { type: 'highpass', frequency: 200, q: 0.707 },
      { type: 'lowpass', frequency: 3500, q: 0.707 },
    ],
  },
};

LIVE_FILTER_PRESETS.karoake = LIVE_FILTER_PRESETS.karaoke!;

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function normalizePresetName(value: unknown, fallback: string = 'off') {
  const normalized = String(value ?? '').trim().toLowerCase();
  return normalized || fallback;
}

function isFiniteNumber(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value);
}

function toVolumeGain(volumePercent: unknown, fallback: number = 100) {
  const parsed = Number.parseFloat(String(volumePercent ?? fallback));
  const normalized = Number.isFinite(parsed) ? parsed : fallback;
  return clamp(normalized / 100, 0, 4);
}

export function isLiveFilterPresetSupported(name: unknown) {
  return Boolean(LIVE_FILTER_PRESETS[normalizePresetName(name)]);
}

class BiquadFilter {
  type: FilterStage['type'];
  frequency: number;
  q: number;
  gainDb: number;
  sampleRate: number;
  x1L: number;
  x2L: number;
  y1L: number;
  y2L: number;
  x1R: number;
  x2R: number;
  y1R: number;
  y2R: number;
  b0 = 0;
  b1 = 0;
  b2 = 0;
  a1 = 0;
  a2 = 0;

  constructor(spec: FilterStage, sampleRate = SAMPLE_RATE) {
    this.type = spec.type;
    this.frequency = spec.frequency;
    this.q = spec.q ?? 0.707;
    this.gainDb = spec.gainDb ?? 0;
    this.sampleRate = sampleRate;

    this.x1L = 0;
    this.x2L = 0;
    this.y1L = 0;
    this.y2L = 0;
    this.x1R = 0;
    this.x2R = 0;
    this.y1R = 0;
    this.y2R = 0;

    this._recalculate();
  }

  _recalculate() {
    const omega = (2 * Math.PI * clamp(this.frequency, 10, (this.sampleRate / 2) - 10)) / this.sampleRate;
    const sin = Math.sin(omega);
    const cos = Math.cos(omega);
    const q = Math.max(0.001, this.q);
    const alpha = sin / (2 * q);
    const a = 10 ** (this.gainDb / 40);
    const sqrtA = Math.sqrt(a);

    let b0;
    let b1;
    let b2;
    let a0;
    let a1;
    let a2;

    switch (this.type) {
      case 'lowpass':
        b0 = (1 - cos) / 2;
        b1 = 1 - cos;
        b2 = (1 - cos) / 2;
        a0 = 1 + alpha;
        a1 = -2 * cos;
        a2 = 1 - alpha;
        break;
      case 'highpass':
        b0 = (1 + cos) / 2;
        b1 = -(1 + cos);
        b2 = (1 + cos) / 2;
        a0 = 1 + alpha;
        a1 = -2 * cos;
        a2 = 1 - alpha;
        break;
      case 'peaking':
        b0 = 1 + (alpha * a);
        b1 = -2 * cos;
        b2 = 1 - (alpha * a);
        a0 = 1 + (alpha / a);
        a1 = -2 * cos;
        a2 = 1 - (alpha / a);
        break;
      case 'lowshelf': {
        const two = 2 * sqrtA * alpha;
        b0 = a * ((a + 1) - ((a - 1) * cos) + two);
        b1 = 2 * a * ((a - 1) - ((a + 1) * cos));
        b2 = a * ((a + 1) - ((a - 1) * cos) - two);
        a0 = (a + 1) + ((a - 1) * cos) + two;
        a1 = -2 * ((a - 1) + ((a + 1) * cos));
        a2 = (a + 1) + ((a - 1) * cos) - two;
        break;
      }
      case 'highshelf': {
        const two = 2 * sqrtA * alpha;
        b0 = a * ((a + 1) + ((a - 1) * cos) + two);
        b1 = -2 * a * ((a - 1) + ((a + 1) * cos));
        b2 = a * ((a + 1) + ((a - 1) * cos) - two);
        a0 = (a + 1) - ((a - 1) * cos) + two;
        a1 = 2 * ((a - 1) - ((a + 1) * cos));
        a2 = (a + 1) - ((a - 1) * cos) - two;
        break;
      }
      default:
        b0 = 1;
        b1 = 0;
        b2 = 0;
        a0 = 1;
        a1 = 0;
        a2 = 0;
        break;
    }

    this.b0 = b0 / a0;
    this.b1 = b1 / a0;
    this.b2 = b2 / a0;
    this.a1 = a1 / a0;
    this.a2 = a2 / a0;
  }

  process(left: number, right: number) {
    const outL = (this.b0 * left) + (this.b1 * this.x1L) + (this.b2 * this.x2L) - (this.a1 * this.y1L) - (this.a2 * this.y2L);
    this.x2L = this.x1L;
    this.x1L = left;
    this.y2L = this.y1L;
    this.y1L = outL;

    const outR = (this.b0 * right) + (this.b1 * this.x1R) + (this.b2 * this.x2R) - (this.a1 * this.y1R) - (this.a2 * this.y2R);
    this.x2R = this.x1R;
    this.x1R = right;
    this.y2R = this.y1R;
    this.y1R = outR;

    return [outL, outR];
  }
}

function buildProgram(filterPreset: unknown, eqPreset: unknown): FilterProgram {
  const normalizedFilter = normalizePresetName(filterPreset);
  const normalizedEq = normalizePresetName(eqPreset, 'flat');
  const filterDef = LIVE_FILTER_PRESETS[normalizedFilter] ?? LIVE_FILTER_PRESETS.off!;
  const eqGains = EQ_PRESETS[normalizedEq as keyof typeof EQ_PRESETS] ?? EQ_PRESETS.flat;

  const filters = [
    ...filterDef.stages.map((stage) => new BiquadFilter(stage)),
    ...EQ_BANDS.flatMap((frequency, index) => {
      const gainDb = eqGains[index] ?? 0;
      if (!gainDb) return [];
      return [new BiquadFilter({ type: 'peaking', frequency, gainDb, q: 1.0 })];
    }),
  ];

  return {
    karaoke: filterDef.karaoke === true,
    panHz: isFiniteNumber(filterDef.panHz) ? (filterDef.panHz ?? 0) : 0,
    filters,
  };
}

function processWithProgram(program: FilterProgram, left: number, right: number, sampleIndex: number): [number, number] {
  let outL = left;
  let outR = right;

  if (program?.karaoke) {
    const nextL = 0.5 * (outL - outR);
    const nextR = 0.5 * (outR - outL);
    outL = nextL;
    outR = nextR;
  }

  if (Array.isArray(program?.filters)) {
    for (const filter of program.filters) {
      const [nextL = outL, nextR = outR] = filter.process(outL, outR);
      outL = nextL;
      outR = nextR;
    }
  }

  if (program?.panHz) {
    const phase = ((2 * Math.PI * program.panHz) / SAMPLE_RATE) * sampleIndex;
    const pan = Math.sin(phase);
    const leftGain = Math.cos(((pan + 1) * Math.PI) / 4);
    const rightGain = Math.sin(((pan + 1) * Math.PI) / 4);
    outL *= leftGain;
    outR *= rightGain;
  }

  return [outL, outR];
}

export class LiveAudioProcessor extends Transform {
  [key: string]: unknown;
  pending: Buffer;
  sampleCursor: number;
  currentGain: number;
  targetGain: number;
  program: FilterProgram;
  transition: ProgramTransition | null;
  constructor(options: LiveAudioProcessorOptions = {}) {
    super();
    this.pending = Buffer.alloc(0);
    this.sampleCursor = 0;

    this.currentGain = toVolumeGain(options.volumePercent);
    this.targetGain = this.currentGain;
    this.program = buildProgram(options.filterPreset, options.eqPreset);
    this.transition = null;
  }

  updateSettings(options: LiveAudioProcessorOptions = {}) {
    this.targetGain = toVolumeGain(options.volumePercent, this.targetGain * 100);
    const nextProgram = buildProgram(options.filterPreset, options.eqPreset);
    this.transition = {
      from: this.program,
      to: nextProgram,
      mix: 0,
      mixStep: 1 / Math.max(1, Math.round((SAMPLE_RATE * TRANSITION_MS) / 1000)),
    };
    this.program = nextProgram;
  }

  override _transform(chunk: unknown, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
    try {
      const asBuffer = Buffer.isBuffer(chunk)
        ? chunk
        : typeof chunk === 'string'
          ? Buffer.from(chunk)
          : ArrayBuffer.isView(chunk)
            ? Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
            : chunk instanceof ArrayBuffer
              ? Buffer.from(chunk)
              : null;
      if (!asBuffer) {
        throw new TypeError('LiveAudioProcessor expected a buffer-like chunk.');
      }
      this.pending = this.pending.length ? Buffer.concat([this.pending, asBuffer]) : Buffer.from(asBuffer);

      const completeBytes = this.pending.length - (this.pending.length % BYTES_PER_STEREO_SAMPLE);
      if (completeBytes <= 0) {
        callback();
        return;
      }

      const output = Buffer.from(this.pending.subarray(0, completeBytes));
      this.pending = this.pending.subarray(completeBytes);
      this._processBuffer(output);
      this.push(output);
      callback();
    } catch (err) {
      callback(err instanceof Error ? err : new Error(String(err)));
    }
  }

  override _flush(callback: (error?: Error | null) => void) {
    try {
      if (this.pending.length > 0) {
        const paddedLength = this.pending.length + ((BYTES_PER_STEREO_SAMPLE - (this.pending.length % BYTES_PER_STEREO_SAMPLE)) % BYTES_PER_STEREO_SAMPLE);
        const output = Buffer.alloc(paddedLength);
        this.pending.copy(output);
        this._processBuffer(output);
        this.push(output);
        this.pending = Buffer.alloc(0);
      }
      callback();
    } catch (err) {
      callback(err instanceof Error ? err : new Error(String(err)));
    }
  }

  _processBuffer(buffer: Buffer) {
    for (let offset = 0; offset < buffer.length; offset += BYTES_PER_STEREO_SAMPLE) {
      const inL = buffer.readInt16LE(offset);
      const inR = buffer.readInt16LE(offset + BYTES_PER_SAMPLE);

      let outL = inL;
      let outR = inR;

      if (this.transition) {
        const fromMix = clamp(1 - this.transition.mix, 0, 1);
        const toMix = clamp(this.transition.mix, 0, 1);
        const [fromL, fromR] = processWithProgram(this.transition.from, inL, inR, this.sampleCursor);
        const [toL, toR] = processWithProgram(this.transition.to, inL, inR, this.sampleCursor);
        outL = (fromL * fromMix) + (toL * toMix);
        outR = (fromR * fromMix) + (toR * toMix);
        this.transition.mix += this.transition.mixStep;
        if (this.transition.mix >= 1) {
          this.transition = null;
        }
      } else {
        [outL, outR] = processWithProgram(this.program, inL, inR, this.sampleCursor);
      }

      this.currentGain += (this.targetGain - this.currentGain) * VOLUME_SMOOTHING;
      outL *= this.currentGain;
      outR *= this.currentGain;

      buffer.writeInt16LE(clamp(Math.round(outL), -32768, 32767), offset);
      buffer.writeInt16LE(clamp(Math.round(outR), -32768, 32767), offset + BYTES_PER_SAMPLE);
      this.sampleCursor += 1;
    }
  }
}




