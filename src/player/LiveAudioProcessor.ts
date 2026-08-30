import { Transform } from 'node:stream';
import { PitchTempoShifter } from './audio/PitchTempoShifter.ts';

const SAMPLE_RATE = 48_000;
const CHANNELS = 2;
const BYTES_PER_SAMPLE = 2;
const BYTES_PER_STEREO_SAMPLE = CHANNELS * BYTES_PER_SAMPLE;
const TRANSITION_MS = 35;
const VOLUME_SMOOTHING = 0.0025;

const KARAOKE_LOW_CROSSOVER_HZ = 220;
const KARAOKE_HIGH_CROSSOVER_HZ = 5200;
const KARAOKE_MAKEUP_GAIN = 1.25;
const SHIFTER_DRAIN_FRAMES = 2048;

const HEADROOM_PROBE_HZ = [30, 60, 90, 120, 180, 250, 350, 500, 700, 1000, 1500, 2000, 3000, 4000, 6000, 8000, 12000, 16000];
const HEADROOM_ALLOWANCE = 1.1885;
const LIMITER_THRESHOLD = 31500;
const LIMITER_ATTACK = 0.5;
const LIMITER_RELEASE = 0.00014;

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
  tempoScale?: number;
  pitchOffset?: number;
};

type FilterProgram = {
  karaoke: KaraokeStage | null;
  panHz: number;
  filters: BiquadFilter[];
  pregain: number;
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
  tempoRatio?: number;
  pitchSemitones?: number;
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
  nightcore: {
    stages: [],
    tempoScale: 1.26,
    pitchOffset: 3.16,
  },
  vaporwave: {
    stages: [
      { type: 'lowpass', frequency: 3200, q: 0.707 },
    ],
    tempoScale: 0.76,
    pitchOffset: -3.86,
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

function growFloat(buffer: Float32Array<ArrayBuffer>, required: number): Float32Array<ArrayBuffer> {
  if (buffer.length >= required) return buffer;
  let size = Math.max(1024, buffer.length || 1024);
  while (size < required) size *= 2;
  return new Float32Array(size);
}

export function isLiveFilterPresetSupported(name: unknown) {
  return Boolean(LIVE_FILTER_PRESETS[normalizePresetName(name)]);
}

export function getLiveFilterPresetShift(name: unknown) {
  const preset = LIVE_FILTER_PRESETS[normalizePresetName(name)];
  return {
    tempoScale: isFiniteNumber(preset?.tempoScale) ? (preset?.tempoScale ?? 1) : 1,
    pitchOffset: isFiniteNumber(preset?.pitchOffset) ? (preset?.pitchOffset ?? 0) : 0,
  };
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

  magnitudeAt(frequency: number) {
    const omega = (2 * Math.PI * frequency) / this.sampleRate;
    const cos1 = Math.cos(omega);
    const cos2 = Math.cos(2 * omega);
    const numerator = (this.b0 * this.b0) + (this.b1 * this.b1) + (this.b2 * this.b2)
      + (2 * ((this.b0 * this.b1) + (this.b1 * this.b2)) * cos1)
      + (2 * this.b0 * this.b2 * cos2);
    const denominator = 1 + (this.a1 * this.a1) + (this.a2 * this.a2)
      + (2 * (this.a1 + (this.a1 * this.a2)) * cos1)
      + (2 * this.a2 * cos2);
    return Math.sqrt(Math.max(1e-12, numerator) / Math.max(1e-12, denominator));
  }

  processMono(input: number) {
    const output = (this.b0 * input) + (this.b1 * this.x1L) + (this.b2 * this.x2L) - (this.a1 * this.y1L) - (this.a2 * this.y2L);
    this.x2L = this.x1L;
    this.x1L = input;
    this.y2L = this.y1L;
    this.y1L = output;
    return output;
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

class KaraokeStage {
  private lowA = new BiquadFilter({ type: 'lowpass', frequency: KARAOKE_LOW_CROSSOVER_HZ, q: 0.7071 });
  private lowB = new BiquadFilter({ type: 'lowpass', frequency: KARAOKE_LOW_CROSSOVER_HZ, q: 0.7071 });
  private highA = new BiquadFilter({ type: 'highpass', frequency: KARAOKE_HIGH_CROSSOVER_HZ, q: 0.7071 });
  private highB = new BiquadFilter({ type: 'highpass', frequency: KARAOKE_HIGH_CROSSOVER_HZ, q: 0.7071 });

  process(left: number, right: number): [number, number] {
    const mid = (left + right) * 0.5;
    const side = (left - right) * 0.5;
    const low = this.lowB.processMono(this.lowA.processMono(mid));
    const high = this.highB.processMono(this.highA.processMono(mid));
    const keptMid = (low + high) * KARAOKE_MAKEUP_GAIN;
    return [keptMid + side, keptMid - side];
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
      return [new BiquadFilter({ type: 'peaking', frequency, gainDb, q: 0.9 })];
    }),
  ];

  let maxGain = 1;
  for (const frequency of HEADROOM_PROBE_HZ) {
    let gain = 1;
    for (const filter of filters) {
      gain *= filter.magnitudeAt(frequency);
    }
    if (gain > maxGain) maxGain = gain;
  }
  if (filterDef.karaoke === true) maxGain *= KARAOKE_MAKEUP_GAIN;
  const pregain = maxGain > HEADROOM_ALLOWANCE ? HEADROOM_ALLOWANCE / maxGain : 1;

  return {
    karaoke: filterDef.karaoke === true ? new KaraokeStage() : null,
    panHz: isFiniteNumber(filterDef.panHz) ? (filterDef.panHz ?? 0) : 0,
    filters,
    pregain,
  };
}

function processWithProgram(program: FilterProgram, left: number, right: number, sampleIndex: number): [number, number] {
  let outL = left;
  let outR = right;

  if (program?.karaoke) {
    [outL, outR] = program.karaoke.process(outL, outR);
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

  return [outL * program.pregain, outR * program.pregain];
}

class PeakLimiter {
  private envelope = 0;

  process(left: number, right: number): [number, number] {
    const peak = Math.max(Math.abs(left), Math.abs(right));
    if (peak > this.envelope) {
      this.envelope += (peak - this.envelope) * LIMITER_ATTACK;
    } else {
      this.envelope += (peak - this.envelope) * LIMITER_RELEASE;
    }
    if (this.envelope <= LIMITER_THRESHOLD) return [left, right];
    const gain = LIMITER_THRESHOLD / this.envelope;
    return [left * gain, right * gain];
  }
}

export class LiveAudioProcessor extends Transform {
  [key: string]: unknown;
  pending: Buffer;
  sampleCursor: number;
  currentGain: number;
  targetGain: number;
  program: FilterProgram;
  transition: ProgramTransition | null;
  shifter: PitchTempoShifter;
  limiter: PeakLimiter;
  tempoRatio: number;
  pitchSemitones: number;
  private decodedLeft = new Float32Array(0);
  private decodedRight = new Float32Array(0);

  constructor(options: LiveAudioProcessorOptions = {}) {
    super();
    this.pending = Buffer.alloc(0);
    this.sampleCursor = 0;

    this.currentGain = toVolumeGain(options.volumePercent);
    this.targetGain = this.currentGain;
    this.tempoRatio = Number(options.tempoRatio ?? 1) || 1;
    this.pitchSemitones = Number(options.pitchSemitones ?? 0) || 0;
    this.program = buildProgram(options.filterPreset, options.eqPreset);
    this.transition = null;
    this.shifter = new PitchTempoShifter();
    this.limiter = new PeakLimiter();
    this._applyShift(options.filterPreset);
  }

  _applyShift(filterPreset: unknown) {
    const { tempoScale, pitchOffset } = getLiveFilterPresetShift(filterPreset);
    this.shifter.setRatios(this.tempoRatio * tempoScale, this.pitchSemitones + pitchOffset);
  }

  updateSettings(options: LiveAudioProcessorOptions = {}) {
    this.targetGain = toVolumeGain(options.volumePercent, this.targetGain * 100);
    if (options.tempoRatio != null) this.tempoRatio = Number(options.tempoRatio) || 1;
    if (options.pitchSemitones != null) this.pitchSemitones = Number(options.pitchSemitones) || 0;
    this._applyShift(options.filterPreset);

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

      const input = this.pending.subarray(0, completeBytes);
      this.pending = Buffer.from(this.pending.subarray(completeBytes));
      const output = this._processBuffer(input);
      if (output.length) this.push(output);
      callback();
    } catch (err) {
      callback(err instanceof Error ? err : new Error(String(err)));
    }
  }

  override _flush(callback: (error?: Error | null) => void) {
    try {
      if (this.pending.length > 0) {
        const paddedLength = this.pending.length + ((BYTES_PER_STEREO_SAMPLE - (this.pending.length % BYTES_PER_STEREO_SAMPLE)) % BYTES_PER_STEREO_SAMPLE);
        const padded = Buffer.alloc(paddedLength);
        this.pending.copy(padded);
        this.pending = Buffer.alloc(0);
        const output = this._processBuffer(padded);
        if (output.length) this.push(output);
      }
      if (!this.shifter.isNeutral) {
        const tail = this._processBuffer(Buffer.alloc(SHIFTER_DRAIN_FRAMES * BYTES_PER_STEREO_SAMPLE));
        if (tail.length) this.push(tail);
      }
      callback();
    } catch (err) {
      callback(err instanceof Error ? err : new Error(String(err)));
    }
  }

  _processBuffer(input: Buffer) {
    const frames = Math.floor(input.length / BYTES_PER_STEREO_SAMPLE);
    if (frames <= 0) return Buffer.alloc(0);

    this.decodedLeft = growFloat(this.decodedLeft, frames);
    this.decodedRight = growFloat(this.decodedRight, frames);
    for (let i = 0; i < frames; i += 1) {
      const offset = i * BYTES_PER_STEREO_SAMPLE;
      this.decodedLeft[i] = input.readInt16LE(offset);
      this.decodedRight[i] = input.readInt16LE(offset + BYTES_PER_SAMPLE);
    }

    const shifted = this.shifter.process(this.decodedLeft, this.decodedRight, frames);
    const count = shifted.count;
    if (count <= 0) return Buffer.alloc(0);

    const left = shifted.left;
    const right = shifted.right;
    const output = Buffer.allocUnsafe(count * BYTES_PER_STEREO_SAMPLE);

    for (let i = 0; i < count; i += 1) {
      const inL = left[i] ?? 0;
      const inR = right[i] ?? 0;

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
      [outL, outR] = this.limiter.process(outL, outR);

      const offset = i * BYTES_PER_STEREO_SAMPLE;
      output.writeInt16LE(clamp(Math.round(outL), -32768, 32767), offset);
      output.writeInt16LE(clamp(Math.round(outR), -32768, 32767), offset + BYTES_PER_SAMPLE);
      this.sampleCursor += 1;
    }

    return output;
  }
}
