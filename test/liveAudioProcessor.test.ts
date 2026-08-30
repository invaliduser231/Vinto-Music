import test from 'node:test';
import assert from 'node:assert/strict';

import { LiveAudioProcessor, isLiveFilterPresetSupported } from '../src/player/LiveAudioProcessor.ts';

function buildStereoChunk(samples: number[]) {
  const values = Array.isArray(samples) ? samples : [];
  const out = Buffer.alloc(values.length * 4);
  for (let i = 0; i < values.length; i += 1) {
    out.writeInt16LE(values[i] ?? 0, i * 4);
    out.writeInt16LE(values[i] ?? 0, (i * 4) + 2);
  }
  return out;
}

function buildStereoPairs(pairs: Array<[number, number]>) {
  const out = Buffer.alloc(pairs.length * 4);
  for (let i = 0; i < pairs.length; i += 1) {
    const [left = 0, right = 0] = pairs[i] ?? [0, 0];
    out.writeInt16LE(Math.round(left), i * 4);
    out.writeInt16LE(Math.round(right), (i * 4) + 2);
  }
  return out;
}

function sineFrames(frequencyHz: number, frameCount: number, amplitude = 10000) {
  const frames: number[] = [];
  for (let i = 0; i < frameCount; i += 1) {
    frames.push(Math.round(amplitude * Math.sin((2 * Math.PI * frequencyHz * i) / 48_000)));
  }
  return frames;
}

function frameCount(buffer: Buffer) {
  return Math.floor(buffer.length / 4);
}

function channelStats(buffer: Buffer, skipFrames = 0) {
  let sumLeftSquared = 0;
  let sumRightSquared = 0;
  let dot = 0;
  let counted = 0;
  for (let i = skipFrames; i < frameCount(buffer); i += 1) {
    const left = buffer.readInt16LE(i * 4);
    const right = buffer.readInt16LE((i * 4) + 2);
    sumLeftSquared += left * left;
    sumRightSquared += right * right;
    dot += left * right;
    counted += 1;
  }
  if (!counted) return { rms: 0, correlation: 0 };
  const rms = Math.sqrt((sumLeftSquared + sumRightSquared) / (2 * counted));
  const denominator = Math.sqrt(sumLeftSquared * sumRightSquared) || 1;
  return { rms, correlation: dot / denominator };
}

async function writeChunk(stream: LiveAudioProcessor, chunk: Buffer) {
  const parts: Buffer[] = [];
  const onData = (data: Uint8Array) => {
    parts.push(Buffer.from(data));
  };

  stream.on('data', onData);
  await new Promise<void>((resolve, reject) => {
    stream.write(chunk, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
  await new Promise((resolve) => setImmediate(resolve));
  stream.off('data', onData);
  return Buffer.concat(parts);
}

test('volume updates are applied live on subsequent chunks', async () => {
  const processor = new LiveAudioProcessor({
    volumePercent: 100,
    filterPreset: 'off',
    eqPreset: 'flat',
  });

  const chunk = buildStereoChunk(new Array(4096).fill(8000));
  const before = await writeChunk(processor, chunk);
  processor.updateSettings({
    volumePercent: 25,
    filterPreset: 'off',
    eqPreset: 'flat',
  });
  const after = await writeChunk(processor, chunk);

  const beforePeak = Math.abs(before.readInt16LE(before.length - 4));
  const afterPeak = Math.abs(after.readInt16LE(after.length - 4));
  assert(afterPeak < beforePeak / 2);

  processor.destroy();
});

test('recognizes live-capable filter presets', () => {
  assert.equal(isLiveFilterPresetSupported('bassboost'), true);
  assert.equal(isLiveFilterPresetSupported('radio'), true);
  assert.equal(isLiveFilterPresetSupported('karaoke'), true);
  assert.equal(isLiveFilterPresetSupported('nightcore'), true);
  assert.equal(isLiveFilterPresetSupported('vaporwave'), true);
  assert.equal(isLiveFilterPresetSupported('unknown-preset'), false);
});

test('karaoke keeps centered bass audible instead of muting the track', async () => {
  const processor = new LiveAudioProcessor({
    volumePercent: 100,
    filterPreset: 'karaoke',
    eqPreset: 'flat',
  });

  const input = buildStereoChunk(sineFrames(80, 24_000));
  const output = await writeChunk(processor, input);
  const stats = channelStats(output, 4_000);
  const inputRms = channelStats(input, 4_000).rms;

  assert(stats.rms > inputRms * 0.4, `karaoke bass rms too low: ${stats.rms} vs ${inputRms}`);
  assert(stats.correlation > 0.9, `karaoke channels are out of phase: ${stats.correlation}`);

  processor.destroy();
});

test('karaoke removes centered vocal-band content', async () => {
  const processor = new LiveAudioProcessor({
    volumePercent: 100,
    filterPreset: 'karaoke',
    eqPreset: 'flat',
  });

  const input = buildStereoChunk(sineFrames(1_200, 24_000));
  const output = await writeChunk(processor, input);
  const inputRms = channelStats(input, 4_000).rms;
  const outputRms = channelStats(output, 4_000).rms;

  assert(outputRms < inputRms * 0.1, `vocal band not removed: ${outputRms} vs ${inputRms}`);

  processor.destroy();
});

test('karaoke preserves side content of a wide stereo signal', async () => {
  const processor = new LiveAudioProcessor({
    volumePercent: 100,
    filterPreset: 'karaoke',
    eqPreset: 'flat',
  });

  const tone = sineFrames(1_200, 24_000);
  const input = buildStereoPairs(tone.map((value) => [value, -value] as [number, number]));
  const output = await writeChunk(processor, input);
  const inputRms = channelStats(input, 4_000).rms;
  const outputRms = channelStats(output, 4_000).rms;

  assert(outputRms > inputRms * 0.8, `side content lost: ${outputRms} vs ${inputRms}`);

  processor.destroy();
});

test('tempo changes the produced sample count without a pipeline restart', async () => {
  const processor = new LiveAudioProcessor({
    volumePercent: 100,
    filterPreset: 'off',
    eqPreset: 'flat',
    tempoRatio: 2,
    pitchSemitones: 0,
  });

  const input = buildStereoChunk(sineFrames(440, 48_000));
  const output = await writeChunk(processor, input);
  const ratio = frameCount(output) / 48_000;

  assert(ratio > 0.45 && ratio < 0.55, `unexpected tempo ratio: ${ratio}`);

  processor.destroy();
});

test('halved tempo stretches the stream', async () => {
  const processor = new LiveAudioProcessor({
    volumePercent: 100,
    filterPreset: 'off',
    eqPreset: 'flat',
    tempoRatio: 0.5,
    pitchSemitones: 0,
  });

  const input = buildStereoChunk(sineFrames(440, 48_000));
  const output = await writeChunk(processor, input);
  const ratio = frameCount(output) / 48_000;

  assert(ratio > 1.9 && ratio < 2.1, `unexpected tempo ratio: ${ratio}`);

  processor.destroy();
});

test('pitch shifting keeps the stream length', async () => {
  const processor = new LiveAudioProcessor({
    volumePercent: 100,
    filterPreset: 'off',
    eqPreset: 'flat',
    tempoRatio: 1,
    pitchSemitones: 7,
  });

  const input = buildStereoChunk(sineFrames(440, 48_000));
  const output = await writeChunk(processor, input);
  const ratio = frameCount(output) / 48_000;

  assert(ratio > 0.9 && ratio < 1.1, `unexpected length ratio: ${ratio}`);
  assert(channelStats(output, 4_000).rms > 1_000, 'pitch shifted output is silent');

  processor.destroy();
});

function clipPlateauRatio(buffer: Buffer, skipFrames = 2_000) {
  let clipped = 0;
  let counted = 0;
  for (let i = skipFrames; i < frameCount(buffer); i += 1) {
    const left = buffer.readInt16LE(i * 4);
    const right = buffer.readInt16LE((i * 4) + 2);
    if (Math.abs(left) >= 32767 || Math.abs(right) >= 32767) clipped += 1;
    counted += 1;
  }
  return counted ? clipped / counted : 0;
}

test('boosted eq does not hard clip loud material', async () => {
  const processor = new LiveAudioProcessor({
    volumePercent: 100,
    filterPreset: 'off',
    eqPreset: 'edm',
  });

  const input = buildStereoChunk(sineFrames(90, 48_000, 28_000));
  const output = await writeChunk(processor, input);

  assert(clipPlateauRatio(output) < 0.01, `eq boost clips: ${clipPlateauRatio(output)}`);
  assert(channelStats(output, 4_000).rms > 4_000, 'eq output collapsed');

  processor.destroy();
});

test('bassboost does not hard clip loud bass', async () => {
  const processor = new LiveAudioProcessor({
    volumePercent: 100,
    filterPreset: 'bassboost',
    eqPreset: 'flat',
  });

  const input = buildStereoChunk(sineFrames(80, 48_000, 28_000));
  const output = await writeChunk(processor, input);

  assert(clipPlateauRatio(output) < 0.01, `bassboost clips: ${clipPlateauRatio(output)}`);

  processor.destroy();
});

test('limiter tames volume above 100 percent', async () => {
  const processor = new LiveAudioProcessor({
    volumePercent: 200,
    filterPreset: 'off',
    eqPreset: 'flat',
  });

  const input = buildStereoChunk(sineFrames(440, 48_000, 30_000));
  const output = await writeChunk(processor, input);

  assert(clipPlateauRatio(output, 6_000) < 0.02, `volume boost clips: ${clipPlateauRatio(output, 6_000)}`);

  processor.destroy();
});

test('tempo can be enabled on a running processor', async () => {
  const processor = new LiveAudioProcessor({
    volumePercent: 100,
    filterPreset: 'off',
    eqPreset: 'flat',
  });

  const input = buildStereoChunk(sineFrames(440, 48_000));
  const neutral = await writeChunk(processor, input);
  assert.equal(frameCount(neutral), 48_000);

  processor.updateSettings({
    volumePercent: 100,
    filterPreset: 'off',
    eqPreset: 'flat',
    tempoRatio: 2,
    pitchSemitones: 0,
  });
  const shifted = await writeChunk(processor, input);
  const ratio = frameCount(shifted) / 48_000;

  assert(ratio > 0.45 && ratio < 0.55, `tempo not applied live: ${ratio}`);

  processor.destroy();
});
