import { Transform } from 'node:stream';

const SAMPLE_RATE = 48_000;
const BYTES_PER_STEREO_SAMPLE = 4;
const FFT_SIZE = 2_048;
const BAND_COUNT = 24;
const BAND_MIN_HZ = 32;
const BAND_MAX_HZ = 16_000;
const FRAME_INTERVAL_SAMPLES = 1_600;
const TILT_DB_PER_BAND = 0.95;
const DYNAMIC_RANGE_DB = 34;
const HEADROOM_FLOOR_DB = -46;
const HEADROOM_CEILING_DB = 6;
const HEADROOM_ATTACK = 0.4;
const HEADROOM_RELEASE_DB_PER_FRAME = 0.09;

const HANN = (() => {
  const window = new Float32Array(FFT_SIZE);
  for (let i = 0; i < FFT_SIZE; i += 1) {
    window[i] = 0.5 - (0.5 * Math.cos((2 * Math.PI * i) / FFT_SIZE));
  }
  return window;
})();

const BIT_REVERSE = (() => {
  const table = new Uint16Array(FFT_SIZE);
  const bits = Math.log2(FFT_SIZE);
  for (let i = 0; i < FFT_SIZE; i += 1) {
    let reversed = 0;
    for (let bit = 0; bit < bits; bit += 1) {
      reversed = (reversed << 1) | ((i >> bit) & 1);
    }
    table[i] = reversed;
  }
  return table;
})();

const BAND_RANGES = (() => {
  const ranges: Array<{ start: number; end: number }> = [];
  const binHz = SAMPLE_RATE / FFT_SIZE;
  const maxBin = FFT_SIZE / 2;
  for (let band = 0; band < BAND_COUNT; band += 1) {
    const lowHz = BAND_MIN_HZ * ((BAND_MAX_HZ / BAND_MIN_HZ) ** (band / BAND_COUNT));
    const highHz = BAND_MIN_HZ * ((BAND_MAX_HZ / BAND_MIN_HZ) ** ((band + 1) / BAND_COUNT));
    const start = Math.max(1, Math.floor(lowHz / binHz));
    const end = Math.max(start + 1, Math.min(maxBin, Math.ceil(highHz / binHz)));
    ranges.push({ start, end });
  }
  return ranges;
})();

function fft(real: Float32Array, imag: Float32Array) {
  for (let i = 0; i < FFT_SIZE; i += 1) {
    const j = BIT_REVERSE[i] ?? 0;
    if (j > i) {
      const tempReal = real[i] ?? 0;
      real[i] = real[j] ?? 0;
      real[j] = tempReal;
      const tempImag = imag[i] ?? 0;
      imag[i] = imag[j] ?? 0;
      imag[j] = tempImag;
    }
  }

  for (let size = 2; size <= FFT_SIZE; size *= 2) {
    const half = size / 2;
    const step = (-2 * Math.PI) / size;
    for (let offset = 0; offset < FFT_SIZE; offset += size) {
      for (let k = 0; k < half; k += 1) {
        const angle = step * k;
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);
        const evenIndex = offset + k;
        const oddIndex = evenIndex + half;
        const oddReal = real[oddIndex] ?? 0;
        const oddImag = imag[oddIndex] ?? 0;
        const rotReal = (oddReal * cos) - (oddImag * sin);
        const rotImag = (oddReal * sin) + (oddImag * cos);
        real[oddIndex] = (real[evenIndex] ?? 0) - rotReal;
        imag[oddIndex] = (imag[evenIndex] ?? 0) - rotImag;
        real[evenIndex] = (real[evenIndex] ?? 0) + rotReal;
        imag[evenIndex] = (imag[evenIndex] ?? 0) + rotImag;
      }
    }
  }
}

export class SpectrumAnalyzer extends Transform {
  private ring = new Float32Array(FFT_SIZE);
  private ringWrite = 0;
  private ringFill = 0;
  private sinceFrame = 0;
  private real = new Float32Array(FFT_SIZE);
  private imag = new Float32Array(FFT_SIZE);
  private levels = new Float32Array(BAND_COUNT);
  private bandDb = new Float32Array(BAND_COUNT);
  private headroomDb = HEADROOM_FLOOR_DB;
  private carry: Buffer = Buffer.alloc(0);

  enabled = false;
  analyzedSamples = 0;
  onFrame: ((bands: Uint8Array) => void) | null = null;

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
    this.push(chunk);
    if (this.enabled && this.onFrame) {
      try {
        this._analyze(chunk);
      } catch {
      }
    }
    callback();
  }

  reset() {
    this.ring.fill(0);
    this.levels.fill(0);
    this.bandDb.fill(HEADROOM_FLOOR_DB);
    this.headroomDb = HEADROOM_FLOOR_DB;
    this.ringWrite = 0;
    this.ringFill = 0;
    this.sinceFrame = 0;
    this.analyzedSamples = 0;
    this.carry = Buffer.alloc(0);
  }

  private _analyze(chunk: Buffer) {
    const buffer = this.carry.length ? Buffer.concat([this.carry, chunk]) : chunk;
    const frames = Math.floor(buffer.length / BYTES_PER_STEREO_SAMPLE);
    this.carry = Buffer.from(buffer.subarray(frames * BYTES_PER_STEREO_SAMPLE));

    for (let i = 0; i < frames; i += 1) {
      const offset = i * BYTES_PER_STEREO_SAMPLE;
      const mono = (buffer.readInt16LE(offset) + buffer.readInt16LE(offset + 2)) / 65_536;
      this.analyzedSamples += 1;
      this.ring[this.ringWrite] = mono;
      this.ringWrite = (this.ringWrite + 1) % FFT_SIZE;
      if (this.ringFill < FFT_SIZE) this.ringFill += 1;
      this.sinceFrame += 1;

      if (this.sinceFrame >= FRAME_INTERVAL_SAMPLES && this.ringFill >= FFT_SIZE) {
        this.sinceFrame = 0;
        this._emitFrame();
      }
    }
  }

  private _emitFrame() {
    for (let i = 0; i < FFT_SIZE; i += 1) {
      const ringIndex = (this.ringWrite + i) % FFT_SIZE;
      this.real[i] = (this.ring[ringIndex] ?? 0) * (HANN[i] ?? 0);
      this.imag[i] = 0;
    }
    fft(this.real, this.imag);

    const bands = new Uint8Array(BAND_COUNT);
    for (let band = 0; band < BAND_COUNT; band += 1) {
      const range = BAND_RANGES[band];
      if (!range) continue;
      let energy = 0;
      let bins = 0;
      for (let bin = range.start; bin < range.end; bin += 1) {
        const re = this.real[bin] ?? 0;
        const im = this.imag[bin] ?? 0;
        energy += (re * re) + (im * im);
        bins += 1;
      }
      const rms = Math.sqrt(energy / Math.max(1, bins)) / (FFT_SIZE / 4);
      this.bandDb[band] = (20 * Math.log10(Math.max(1e-8, rms))) + (band * TILT_DB_PER_BAND);
    }

    let loudest = HEADROOM_FLOOR_DB;
    for (let band = 0; band < BAND_COUNT; band += 1) {
      const value = this.bandDb[band] ?? HEADROOM_FLOOR_DB;
      if (value > loudest) loudest = value;
    }
    if (loudest > this.headroomDb) {
      this.headroomDb += (loudest - this.headroomDb) * HEADROOM_ATTACK;
    } else {
      this.headroomDb -= HEADROOM_RELEASE_DB_PER_FRAME;
    }
    this.headroomDb = Math.max(HEADROOM_FLOOR_DB, Math.min(HEADROOM_CEILING_DB, this.headroomDb));

    const floorDb = this.headroomDb - DYNAMIC_RANGE_DB;
    for (let band = 0; band < BAND_COUNT; band += 1) {
      const value = this.bandDb[band] ?? floorDb;
      const normalized = Math.max(0, Math.min(1, (value - floorDb) / DYNAMIC_RANGE_DB));
      this.levels[band] = normalized;
      bands[band] = Math.round(normalized * 255);
    }

    this.onFrame?.(bands);
  }
}

export const SPECTRUM_BAND_COUNT = BAND_COUNT;
