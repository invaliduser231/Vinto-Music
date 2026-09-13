import test from 'node:test';
import assert from 'node:assert/strict';

import { pipelineMethods } from '../src/player/musicPlayer/pipelineMethods.ts';

type Runtime = {
  volumePercent: number;
  minVolumePercent: number;
  maxVolumePercent: number;
  streamAppliedVolumePercent: number;
};

const compensation = pipelineMethods._liveVolumeCompensation as (
  this: Runtime,
) => { required: number; reachable: boolean };

const processorState = pipelineMethods._getLiveAudioProcessorState as (
  this: Runtime & Record<string, unknown>,
) => { volumePercent: number };

function runtime(volumePercent: number, streamAppliedVolumePercent: number): Runtime {
  return {
    volumePercent,
    minVolumePercent: 0,
    maxVolumePercent: 200,
    streamAppliedVolumePercent,
  };
}

function effectiveVolume(target: number, applied: number): number {
  const state = processorState.call({
    ...runtime(target, applied),
    _liveVolumeCompensation: compensation,
    isLiveFilterPresetSupported: () => true,
    filterPreset: 'off',
    eqPreset: 'flat',
    tempoRatio: 1,
    pitchSemitones: 0,
  } as never);
  const gain = Math.min(4, Math.max(0, state.volumePercent / 100));
  return applied * gain;
}

test('raising the volume above the stream level actually gets louder', () => {
  assert.equal(effectiveVolume(20, 5), 20, 'asking for 20% must give 20%');
  assert.equal(effectiveVolume(10, 5), 10, 'asking for 10% must give 10%');
});

test('different settings no longer collapse onto the same loudness', () => {
  const twenty = effectiveVolume(20, 5);
  const ten = effectiveVolume(10, 5);
  assert.notEqual(twenty, ten, 'a lower setting must not sound the same as a higher one');
  assert.ok(twenty > ten);
});

test('a request beyond the reachable gain is reported as unreachable', () => {
  const far = compensation.call(runtime(100, 5));
  assert.equal(far.required, 2_000);
  assert.equal(far.reachable, false, 'the stream has to restart for this one');
});

test('an ordinary change stays reachable and needs no restart', () => {
  const near = compensation.call(runtime(20, 5));
  assert.equal(near.required, 400);
  assert.equal(near.reachable, true);

  const plain = compensation.call(runtime(50, 100));
  assert.equal(plain.required, 50);
  assert.equal(plain.reachable, true);
});

test('an undelegated stream passes the target through unchanged', () => {
  assert.equal(compensation.call(runtime(35, 100)).required, 35);
  assert.equal(effectiveVolume(35, 100), 35);
});

test('muting still mutes', () => {
  assert.equal(effectiveVolume(0, 5), 0);
});
