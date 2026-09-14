import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';

import { pipelineMethods } from '../src/player/musicPlayer/pipelineMethods.ts';
import { LiveAudioProcessor } from '../src/player/LiveAudioProcessor.ts';

function nodeLinkRuntime(volumePercent: number) {
  const playbackSourceStream = new PassThrough();
  const playbackOutputStream = new PassThrough();
  playbackSourceStream.pipe(playbackOutputStream);

  return {
    ffmpeg: null,
    playbackSourceStream,
    playbackOutputStream,
    liveAudioProcessor: null as LiveAudioProcessor | null,
    volumePercent,
    minVolumePercent: 0,
    maxVolumePercent: 200,
    streamAppliedVolumePercent: 100,
    filterPreset: 'off',
    eqPreset: 'flat',
    tempoRatio: 1,
    pitchSemitones: 0,
    logger: null,
    _bindPipelineErrorHandler: () => {},
    _liveVolumeCompensation: pipelineMethods._liveVolumeCompensation,
    _getLiveAudioProcessorState: pipelineMethods._getLiveAudioProcessorState,
    _createLiveAudioProcessor: pipelineMethods._createLiveAudioProcessor,
    _syncLiveAudioProcessor: pipelineMethods._syncLiveAudioProcessor,
    isLiveFilterPresetSupported: pipelineMethods.isLiveFilterPresetSupported,
  };
}

const enableLive = pipelineMethods._enableLiveAudioProcessorDuringPlayback as (this: unknown) => boolean;

test('a NodeLink stream accepts the live processor without an ffmpeg process', () => {
  const runtime = nodeLinkRuntime(50);

  assert.equal(enableLive.call(runtime), true, 'the NodeLink stream is a valid pipeline source');
  assert.ok(runtime.liveAudioProcessor, 'the processor has to end up in the pipeline');
});

test('the processor sits between the stream and the playback output', async () => {
  const runtime = nodeLinkRuntime(50);
  enableLive.call(runtime);

  const frames = 480;
  const input = Buffer.alloc(frames * 4);
  for (let i = 0; i < frames; i += 1) {
    input.writeInt16LE(10_000, i * 4);
    input.writeInt16LE(10_000, i * 4 + 2);
  }

  const received: Buffer[] = [];
  runtime.playbackOutputStream.on('data', (chunk: Buffer) => received.push(chunk));
  runtime.playbackSourceStream.write(input);
  await new Promise((resolve) => setImmediate(resolve));

  const output = Buffer.concat(received);
  assert.ok(output.length > 0, 'audio still reaches the playback output');
  assert.ok(
    Math.abs(output.readInt16LE(0)) < 6_000,
    'half volume has to arrive at the output, not the untouched sample',
  );
});

test('an already running processor is only re-synced', () => {
  const runtime = nodeLinkRuntime(50);
  enableLive.call(runtime);
  const first = runtime.liveAudioProcessor;

  runtime.volumePercent = 80;
  assert.equal(enableLive.call(runtime), true);
  assert.equal(runtime.liveAudioProcessor, first, 'a second call must not stack processors');
  assert.equal(first?.targetGain, 0.8, 'the running processor picks up the new volume');
});
