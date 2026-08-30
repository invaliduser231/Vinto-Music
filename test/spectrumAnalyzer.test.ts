import test from 'node:test';
import assert from 'node:assert/strict';

import { SpectrumAnalyzer, SPECTRUM_BAND_COUNT } from '../src/player/audio/SpectrumAnalyzer.ts';

function sineChunk(frequencyHz: number, frameCount: number, amplitude = 12_000, startFrame = 0) {
  const buffer = Buffer.alloc(frameCount * 4);
  for (let i = 0; i < frameCount; i += 1) {
    const value = Math.round(
      amplitude * Math.sin((2 * Math.PI * frequencyHz * (startFrame + i)) / 48_000),
    );
    buffer.writeInt16LE(value, i * 4);
    buffer.writeInt16LE(value, (i * 4) + 2);
  }
  return buffer;
}

async function collectFrames(analyzer: SpectrumAnalyzer, chunk: Buffer): Promise<Uint8Array[]> {
  const frames: Uint8Array[] = [];
  analyzer.onFrame = (bands) => frames.push(Uint8Array.from(bands));
  analyzer.resume();
  await new Promise<void>((resolve, reject) => {
    analyzer.write(chunk, (err) => (err ? reject(err) : resolve()));
  });
  await new Promise((resolve) => setImmediate(resolve));
  return frames;
}

function peakBand(bands: Uint8Array) {
  let index = 0;
  for (let i = 1; i < bands.length; i += 1) {
    if ((bands[i] ?? 0) > (bands[index] ?? 0)) index = i;
  }
  return index;
}

test('analyzer passes audio through untouched', async () => {
  const analyzer = new SpectrumAnalyzer();
  analyzer.enabled = true;
  analyzer.onFrame = () => {};

  const input = sineChunk(440, 4_800);
  const chunks: Buffer[] = [];
  analyzer.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
  analyzer.write(input);
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(Buffer.concat(chunks), input);
  analyzer.destroy();
});

test('analyzer stays silent while disabled', async () => {
  const analyzer = new SpectrumAnalyzer();
  analyzer.enabled = false;
  const frames = await collectFrames(analyzer, sineChunk(440, 24_000));
  assert.equal(frames.length, 0);
  analyzer.destroy();
});

test('analyzer emits frames with the configured band count', async () => {
  const analyzer = new SpectrumAnalyzer();
  analyzer.enabled = true;
  const frames = await collectFrames(analyzer, sineChunk(440, 24_000));

  assert(frames.length >= 5, `expected several frames, got ${frames.length}`);
  assert.equal(frames[0]?.length, SPECTRUM_BAND_COUNT);
  analyzer.destroy();
});

test('a low tone peaks in a lower band than a high tone', async () => {
  const low = new SpectrumAnalyzer();
  low.enabled = true;
  const lowFrames = await collectFrames(low, sineChunk(120, 48_000));

  const high = new SpectrumAnalyzer();
  high.enabled = true;
  const highFrames = await collectFrames(high, sineChunk(6_000, 48_000));

  const lowPeak = peakBand(lowFrames.at(-1)!);
  const highPeak = peakBand(highFrames.at(-1)!);

  assert(lowPeak < highPeak, `low band ${lowPeak} should sit below high band ${highPeak}`);
  low.destroy();
  high.destroy();
});

test('silence decays toward zero', async () => {
  const analyzer = new SpectrumAnalyzer();
  analyzer.enabled = true;
  await collectFrames(analyzer, sineChunk(440, 48_000));
  const quiet = await collectFrames(analyzer, Buffer.alloc(48_000 * 4));

  const last = quiet.at(-1)!;
  const loudest = Math.max(...last);
  assert(loudest < 40, `expected decay toward silence, peak was ${loudest}`);
  analyzer.destroy();
});

function pinkish(frameCount: number, amplitude: number) {
  const buffer = Buffer.alloc(frameCount * 4);
  let b0 = 0;
  let b1 = 0;
  let b2 = 0;
  for (let i = 0; i < frameCount; i += 1) {
    const white = Math.random() * 2 - 1;
    b0 = 0.99765 * b0 + white * 0.0990460;
    b1 = 0.96300 * b1 + white * 0.2965164;
    b2 = 0.57000 * b2 + white * 1.0526913;
    const pink = Math.max(-1, Math.min(1, (b0 + b1 + b2 + white * 0.1848) * 0.2)) * amplitude;
    const sample = Math.round(pink * 32767);
    buffer.writeInt16LE(sample, i * 4);
    buffer.writeInt16LE(sample, (i * 4) + 2);
  }
  return buffer;
}

function averageBands(frames: Uint8Array[]) {
  const tail = frames.slice(-30);
  return Array.from({ length: SPECTRUM_BAND_COUNT }, (_, band) => (
    tail.reduce((sum, frame) => sum + (frame[band] ?? 0), 0) / Math.max(1, tail.length)
  ));
}

test('neighbouring low bands report distinct values', async () => {
  const analyzer = new SpectrumAnalyzer();
  analyzer.enabled = true;
  const frames = await collectFrames(analyzer, pinkish(48_000 * 2, 0.3));
  const averages = averageBands(frames);

  const lowBands = averages.slice(0, 6);
  const identical = new Set(lowBands.map((value) => Math.round(value))).size;
  assert(identical > 1, `low bands must not collapse onto one bin: ${lowBands.join(', ')}`);

  analyzer.destroy();
});

test('level normalization adapts to loud and quiet material alike', async () => {
  const loud = new SpectrumAnalyzer();
  loud.enabled = true;
  const loudAvg = averageBands(await collectFrames(loud, pinkish(48_000 * 2, 0.6)));

  const quiet = new SpectrumAnalyzer();
  quiet.enabled = true;
  const quietAvg = averageBands(await collectFrames(quiet, pinkish(48_000 * 2, 0.05)));

  const loudMean = loudAvg.reduce((a, b) => a + b, 0) / loudAvg.length;
  const quietMean = quietAvg.reduce((a, b) => a + b, 0) / quietAvg.length;

  assert(loudMean > 40, `loud material should be visible: ${loudMean}`);
  assert(quietMean > 40, `quiet material should be visible too: ${quietMean}`);
  assert(Math.abs(loudMean - quietMean) < 70, `levels should track loudness, gap was ${Math.abs(loudMean - quietMean)}`);

  loud.destroy();
  quiet.destroy();
});

test('a kick pattern produces a periodic swing in the low bands', async () => {
  const analyzer = new SpectrumAnalyzer();
  analyzer.enabled = true;

  const seconds = 3;
  const total = 48_000 * seconds;
  const beat = 0.5 * 48_000;
  const buffer = Buffer.alloc(total * 4);
  for (let i = 0; i < total; i += 1) {
    const phase = i % beat;
    const envelope = Math.exp(-(phase / 48_000) / 0.09);
    const kick = Math.sin((2 * Math.PI * 60 * i) / 48_000) * envelope * 0.85;
    const pad = Math.sin((2 * Math.PI * 440 * i) / 48_000) * 0.06;
    const sample = Math.round(Math.max(-1, Math.min(1, kick + pad)) * 32767);
    buffer.writeInt16LE(sample, i * 4);
    buffer.writeInt16LE(sample, (i * 4) + 2);
  }

  const frames = await collectFrames(analyzer, buffer);
  const bass = frames.map((frame) => Math.max(...Array.from(frame.slice(0, 6))));
  const swing = Math.max(...bass) - Math.min(...bass);

  assert(swing > 120, `expected a clear beat swing, got ${swing}`);
  analyzer.destroy();
});
