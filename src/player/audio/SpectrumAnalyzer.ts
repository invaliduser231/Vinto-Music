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

const TWIDDLE_COS = (() => {
  const table = new Float32Array(FFT_SIZE / 2);
  for (let i = 0; i < table.length; i += 1) {
    table[i] = Math.cos((-2 * Math.PI * i) / FFT_SIZE);
  }
  return table;
})();

const TWIDDLE_SIN = (() => {
  const table = new Float32Array(FFT_SIZE / 2);
  for (let i = 0; i < table.length; i += 1) {
    table[i] = Math.sin((-2 * Math.PI * i) / FFT_SIZE);
  }
  return table;
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
    const stride = FFT_SIZE / size;
    for (let offset = 0; offset < FFT_SIZE; offset += size) {
      for (let k = 0; k < half; k += 1) {
        const twiddle = k * stride;
        const cos = TWIDDLE_COS[twiddle] ?? 0;
        const sin = TWIDDLE_SIN[twiddle] ?? 0;
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
  private ring = new Int16Array(FFT_SIZE * 2);
  private ringBytes = Buffer.from(this.ring.buffer, this.ring.byteOffset, this.ring.byteLength);
  private ringWrite = 0;
  private ringFill = 0;
  private sinceFrame = 0;
  private real = new Float32Array(FFT_SIZE);
  private imag = new Float32Array(FFT_SIZE);
  private levels = new Float32Array(BAND_COUNT);
  private bandDb = new Float32Array(BAND_COUNT);
  private headroomDb = HEADROOM_FLOOR_DB;
  private carry = Buffer.alloc(BYTES_PER_STEREO_SAMPLE);
  private carryLength = 0;

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
    this.carryLength = 0;
  }

  private _analyze(chunk: Buffer) {
    let offset = 0;

    if (this.carryLength > 0) {
      const missing = BYTES_PER_STEREO_SAMPLE - this.carryLength;
      const take = Math.min(missing, chunk.length);
      chunk.copy(this.carry, this.carryLength, 0, take);
      this.carryLength += take;
      offset = take;
      if (this.carryLength === BYTES_PER_STEREO_SAMPLE) {
        this._ingest(this.carry, 0, 1);
        this.carryLength = 0;
      }
    }

    const frames = Math.floor((chunk.length - offset) / BYTES_PER_STEREO_SAMPLE);
    if (frames > 0) {
      this._ingest(chunk, offset, frames);
      offset += frames * BYTES_PER_STEREO_SAMPLE;
    }

    const rest = chunk.length - offset;
    if (rest > 0) {
      chunk.copy(this.carry, 0, offset);
      this.carryLength = rest;
    }
  }

  private _ingest(source: Buffer, byteOffset: number, frameCount: number) {
    let remaining = frameCount;
    let readOffset = byteOffset;

    while (remaining > 0) {
      const untilWrap = FFT_SIZE - this.ringWrite;
      const untilFrame = Math.max(1, FRAME_INTERVAL_SAMPLES - this.sinceFrame);
      const take = Math.min(remaining, untilWrap, untilFrame);
      const byteLength = take * BYTES_PER_STEREO_SAMPLE;

      source.copy(
        this.ringBytes,
        this.ringWrite * BYTES_PER_STEREO_SAMPLE,
        readOffset,
        readOffset + byteLength,
      );

      this.ringWrite = (this.ringWrite + take) % FFT_SIZE;
      this.ringFill = Math.min(FFT_SIZE, this.ringFill + take);
      this.analyzedSamples += take;
      this.sinceFrame += take;
      readOffset += byteLength;
      remaining -= take;

      if (this.sinceFrame >= FRAME_INTERVAL_SAMPLES) {
        this.sinceFrame = 0;
        if (this.ringFill >= FFT_SIZE) this._emitFrame();
      }
    }
  }

  private _emitFrame() {
    for (let i = 0; i < FFT_SIZE; i += 1) {
      const ringIndex = ((this.ringWrite + i) % FFT_SIZE) * 2;
      const mono = ((this.ring[ringIndex] ?? 0) + (this.ring[ringIndex + 1] ?? 0)) / 65_536;
      this.real[i] = mono * (HANN[i] ?? 0);
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
