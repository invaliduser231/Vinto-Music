import test from 'node:test';
import assert from 'node:assert/strict';

import { LiveAudioProcessor, isLiveFilterPresetSupported } from '../src/player/LiveAudioProcessor.js';

function buildStereoChunk(samples) {
  const values = Array.isArray(samples) ? samples : [];
  const out = Buffer.alloc(values.length * 4);
  for (let i = 0; i < values.length; i += 1) {
    out.writeInt16LE(values[i], i * 4);
    out.writeInt16LE(values[i], (i * 4) + 2);
  }
  return out;
}

async function writeChunk(stream, chunk) {
  const parts = [];
  const onData = (data) => {
    parts.push(Buffer.from(data));
  };

  stream.on('data', onData);
  await new Promise((resolve, reject) => {
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

test('recognizes live-capable and restart-only filter presets', () => {
  assert.equal(isLiveFilterPresetSupported('bassboost'), true);
  assert.equal(isLiveFilterPresetSupported('radio'), true);
  assert.equal(isLiveFilterPresetSupported('nightcore'), false);
  assert.equal(isLiveFilterPresetSupported('vaporwave'), false);
});
