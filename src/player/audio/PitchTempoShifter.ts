const SYNTHESIS_HOP = 512;
const FRAME_SIZE = SYNTHESIS_HOP * 2;
const SEARCH_RADIUS = 192;
const CORRELATION_STRIDE = 4;
const MIN_TEMPO = 0.25;
const MAX_TEMPO = 4;
const MIN_PITCH_RATIO = 0.25;
const MAX_PITCH_RATIO = 4;

const HANN_WINDOW = (() => {
  const window = new Float32Array(FRAME_SIZE);
  for (let i = 0; i < FRAME_SIZE; i += 1) {
    window[i] = 0.5 - (0.5 * Math.cos((2 * Math.PI * i) / FRAME_SIZE));
  }
  return window;
})();

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function grow(buffer: Float32Array<ArrayBuffer>, required: number): Float32Array<ArrayBuffer> {
  if (buffer.length >= required) return buffer;
  let size = Math.max(1024, buffer.length || 1024);
  while (size < required) size *= 2;
  const next = new Float32Array(size);
  next.set(buffer);
  return next;
}

function catmullRom(p0: number, p1: number, p2: number, p3: number, t: number) {
  return p1 + (0.5 * t * (
    (p2 - p0) + (t * (
      ((2 * p0) - (5 * p1) + (4 * p2) - p3) + (t * ((3 * (p1 - p2)) + p3 - p0))
    ))
  ));
}

class CubicResampler {
  private histLeft = new Float32Array(3);
  private histRight = new Float32Array(3);
  private scratchLeft = new Float32Array(0);
  private scratchRight = new Float32Array(0);
  private position = 3;
  private primed = false;

  ratio = 1;

  reset() {
    this.histLeft.fill(0);
    this.histRight.fill(0);
    this.position = 3;
    this.primed = false;
  }

  maxOutputFor(count: number) {
    return Math.ceil((count + 3) / Math.max(0.01, this.ratio)) + 2;
  }

  process(
    inputLeft: Float32Array,
    inputRight: Float32Array,
    count: number,
    outputLeft: Float32Array,
    outputRight: Float32Array,
  ) {
    if (count <= 0) return 0;
    if (!this.primed) {
      this.histLeft.fill(inputLeft[0] ?? 0);
      this.histRight.fill(inputRight[0] ?? 0);
      this.position = 3;
      this.primed = true;
    }

    const total = count + 3;
    this.scratchLeft = grow(this.scratchLeft, total);
    this.scratchRight = grow(this.scratchRight, total);
    this.scratchLeft.set(this.histLeft, 0);
    this.scratchRight.set(this.histRight, 0);
    this.scratchLeft.set(inputLeft.subarray(0, count), 3);
    this.scratchRight.set(inputRight.subarray(0, count), 3);

    const left = this.scratchLeft;
    const right = this.scratchRight;
    const ratio = this.ratio;
    let position = this.position;
    let produced = 0;

    for (;;) {
      const index = Math.floor(position);
      if (index + 2 > total - 1) break;
      const fraction = position - index;
      outputLeft[produced] = catmullRom(
        left[index - 1] ?? 0,
        left[index] ?? 0,
        left[index + 1] ?? 0,
        left[index + 2] ?? 0,
        fraction,
      );
      outputRight[produced] = catmullRom(
        right[index - 1] ?? 0,
        right[index] ?? 0,
        right[index + 1] ?? 0,
        right[index + 2] ?? 0,
        fraction,
      );
      produced += 1;
      position += ratio;
    }

    this.histLeft[0] = left[total - 3] ?? 0;
    this.histLeft[1] = left[total - 2] ?? 0;
    this.histLeft[2] = left[total - 1] ?? 0;
    this.histRight[0] = right[total - 3] ?? 0;
    this.histRight[1] = right[total - 2] ?? 0;
    this.histRight[2] = right[total - 1] ?? 0;
    this.position = position - (total - 3);
    return produced;
  }
}

class WsolaStretcher {
  private bufferLeft = new Float32Array(0);
  private bufferRight = new Float32Array(0);
  private bufferMid = new Float32Array(0);
  private bufferStart = 0;
  private bufferCount = 0;
  private nextIdeal = 0;
  private overlapLeft = new Float32Array(SYNTHESIS_HOP);
  private overlapRight = new Float32Array(SYNTHESIS_HOP);
  private templateMid: Float32Array | null = null;

  alpha = 1;

  reset() {
    this.bufferStart = 0;
    this.bufferCount = 0;
    this.nextIdeal = 0;
    this.overlapLeft.fill(0);
    this.overlapRight.fill(0);
    this.templateMid = null;
  }

  private append(inputLeft: Float32Array, inputRight: Float32Array, count: number) {
    const required = this.bufferCount + count;
    this.bufferLeft = grow(this.bufferLeft, required);
    this.bufferRight = grow(this.bufferRight, required);
    this.bufferMid = grow(this.bufferMid, required);
    for (let i = 0; i < count; i += 1) {
      const left = inputLeft[i] ?? 0;
      const right = inputRight[i] ?? 0;
      this.bufferLeft[this.bufferCount + i] = left;
      this.bufferRight[this.bufferCount + i] = right;
      this.bufferMid[this.bufferCount + i] = (left + right) * 0.5;
    }
    this.bufferCount = required;
  }

  private compact(keepFrom: number) {
    const drop = Math.max(0, Math.min(this.bufferCount, keepFrom - this.bufferStart));
    if (drop <= 0) return;
    this.bufferLeft.copyWithin(0, drop, this.bufferCount);
    this.bufferRight.copyWithin(0, drop, this.bufferCount);
    this.bufferMid.copyWithin(0, drop, this.bufferCount);
    this.bufferCount -= drop;
    this.bufferStart += drop;
  }

  private findBestOffset(searchLow: number, searchHigh: number) {
    const template = this.templateMid;
    if (!template) return clamp(Math.round(this.nextIdeal), searchLow, searchHigh);

    let bestOffset = searchLow;
    let bestScore = -Infinity;
    for (let offset = searchLow; offset <= searchHigh; offset += 1) {
      const base = offset - this.bufferStart;
      let dot = 0;
      let energy = 1e-9;
      for (let j = 0; j < SYNTHESIS_HOP; j += CORRELATION_STRIDE) {
        const sample = this.bufferMid[base + j] ?? 0;
        dot += sample * (template[j] ?? 0);
        energy += sample * sample;
      }
      const score = dot / Math.sqrt(energy);
      if (score > bestScore) {
        bestScore = score;
        bestOffset = offset;
      }
    }
    return bestOffset;
  }

  process(
    inputLeft: Float32Array,
    inputRight: Float32Array,
    count: number,
    outputLeft: Float32Array,
    outputRight: Float32Array,
  ) {
    if (count > 0) this.append(inputLeft, inputRight, count);

    const analysisHop = SYNTHESIS_HOP / clamp(this.alpha, 0.1, 10);
    let produced = 0;

    for (;;) {
      const ideal = Math.floor(this.nextIdeal);
      const searchLow = Math.max(this.bufferStart, ideal - SEARCH_RADIUS);
      const searchHigh = ideal + SEARCH_RADIUS;
      if (this.bufferStart + this.bufferCount < searchHigh + FRAME_SIZE) break;
      if (produced + SYNTHESIS_HOP > outputLeft.length) break;

      const offset = this.findBestOffset(searchLow, searchHigh);
      const base = offset - this.bufferStart;

      for (let j = 0; j < SYNTHESIS_HOP; j += 1) {
        const window = HANN_WINDOW[j] ?? 0;
        outputLeft[produced + j] = (this.overlapLeft[j] ?? 0) + ((this.bufferLeft[base + j] ?? 0) * window);
        outputRight[produced + j] = (this.overlapRight[j] ?? 0) + ((this.bufferRight[base + j] ?? 0) * window);
      }
      for (let j = 0; j < SYNTHESIS_HOP; j += 1) {
        const window = HANN_WINDOW[SYNTHESIS_HOP + j] ?? 0;
        this.overlapLeft[j] = (this.bufferLeft[base + SYNTHESIS_HOP + j] ?? 0) * window;
        this.overlapRight[j] = (this.bufferRight[base + SYNTHESIS_HOP + j] ?? 0) * window;
      }

      const template = this.templateMid ?? new Float32Array(SYNTHESIS_HOP);
      for (let j = 0; j < SYNTHESIS_HOP; j += 1) {
        template[j] = this.bufferMid[base + SYNTHESIS_HOP + j] ?? 0;
      }
      this.templateMid = template;

      produced += SYNTHESIS_HOP;
      this.nextIdeal += analysisHop;
      this.compact(Math.min(offset, Math.floor(this.nextIdeal) - SEARCH_RADIUS));
    }

    return produced;
  }

  maxOutputFor(count: number) {
    const pending = this.bufferCount + count;
    const analysisHop = SYNTHESIS_HOP / clamp(this.alpha, 0.1, 10);
    const frames = Math.ceil(pending / Math.max(1, analysisHop)) + 2;
    return frames * SYNTHESIS_HOP;
  }
}

export class PitchTempoShifter {
  private resampler = new CubicResampler();
  private stretcher = new WsolaStretcher();
  private resampledLeft = new Float32Array(0);
  private resampledRight = new Float32Array(0);
  private outputLeft = new Float32Array(0);
  private outputRight = new Float32Array(0);
  private neutral = true;

  constructor(tempoRatio = 1, pitchSemitones = 0) {
    this.setRatios(tempoRatio, pitchSemitones);
  }

  setRatios(tempoRatio: unknown, pitchSemitones: unknown) {
    const tempo = clamp(Number(tempoRatio) || 1, MIN_TEMPO, MAX_TEMPO);
    const semitones = Number.isFinite(Number(pitchSemitones)) ? Number(pitchSemitones) : 0;
    const pitchRatio = clamp(2 ** (semitones / 12), MIN_PITCH_RATIO, MAX_PITCH_RATIO);
    const wasNeutral = this.neutral;

    this.resampler.ratio = pitchRatio;
    this.stretcher.alpha = pitchRatio / tempo;
    this.neutral = Math.abs(tempo - 1) < 1e-4 && Math.abs(pitchRatio - 1) < 1e-4;

    if (this.neutral !== wasNeutral) this.reset();
  }

  get isNeutral() {
    return this.neutral;
  }

  reset() {
    this.resampler.reset();
    this.stretcher.reset();
  }

  process(inputLeft: Float32Array, inputRight: Float32Array, count: number) {
    if (this.neutral || count <= 0) {
      return { left: inputLeft, right: inputRight, count: this.neutral ? count : 0 };
    }

    const resampledCapacity = this.resampler.maxOutputFor(count);
    this.resampledLeft = grow(this.resampledLeft, resampledCapacity);
    this.resampledRight = grow(this.resampledRight, resampledCapacity);
    const resampled = this.resampler.process(
      inputLeft,
      inputRight,
      count,
      this.resampledLeft,
      this.resampledRight,
    );

    const outputCapacity = this.stretcher.maxOutputFor(resampled);
    this.outputLeft = grow(this.outputLeft, outputCapacity);
    this.outputRight = grow(this.outputRight, outputCapacity);
    const produced = this.stretcher.process(
      this.resampledLeft,
      this.resampledRight,
      resampled,
      this.outputLeft,
      this.outputRight,
    );

    return { left: this.outputLeft, right: this.outputRight, count: produced };
  }
}
