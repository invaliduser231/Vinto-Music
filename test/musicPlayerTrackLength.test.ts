import test from 'node:test';
import assert from 'node:assert/strict';

import { MusicPlayer } from '../src/player/MusicPlayer.ts';
import type { Track } from '../src/types/domain.ts';

type LengthChecker = {
  maxTrackLengthMs: number;
};

const exceeds = (maxHours: number, track: Partial<Track>): boolean => {
  const context: LengthChecker = { maxTrackLengthMs: maxHours * 3_600_000 };
  return (MusicPlayer.prototype as unknown as {
    _exceedsMaxTrackLength(this: LengthChecker, track: Partial<Track>): boolean;
  })._exceedsMaxTrackLength.call(context, track);
};

const message = (maxHours: number, tracks: Partial<Track>[]): string => {
  const context: LengthChecker = { maxTrackLengthMs: maxHours * 3_600_000 };
  return (MusicPlayer.prototype as unknown as {
    _formatMaxTrackLengthMessage(this: LengthChecker, tracks: Partial<Track>[]): string;
  })._formatMaxTrackLengthMessage.call(context, tracks);
};

const withLength = (ms: number, extra: Partial<Track> = {}): Partial<Track> => ({
  nodelinkInfo: { length: ms },
  ...extra,
});

test('a normal song passes', () => {
  assert.equal(exceeds(6, withLength(4 * 60_000)), false);
});

test('a long DJ set below the limit passes', () => {
  assert.equal(exceeds(6, withLength(3 * 3_600_000)), false);
});

test('a track beyond the limit is rejected', () => {
  assert.equal(exceeds(6, withLength(109 * 3_600_000)), true);
});

test('a live stream is never rejected regardless of reported length', () => {
  assert.equal(exceeds(6, withLength(109 * 3_600_000, { isLive: true })), false);
  assert.equal(
    exceeds(6, { nodelinkInfo: { length: 109 * 3_600_000, isStream: true } }),
    false
  );
});

test('an unknown length is allowed rather than guessed', () => {
  assert.equal(exceeds(6, {}), false);
  assert.equal(exceeds(6, { nodelinkInfo: { length: 0 } }), false);
  assert.equal(exceeds(6, { nodelinkInfo: { length: null } }), false);
});

test('a zero limit disables the check entirely', () => {
  assert.equal(exceeds(0, withLength(109 * 3_600_000)), false);
});

test('the message names both the actual length and the limit', () => {
  const text = message(6, [withLength(109 * 3_600_000 + 31 * 60_000)]);
  assert.match(text, /109h 31m/);
  assert.match(text, /6 hours/);
});

test('the message falls back gracefully without a known length', () => {
  const text = message(6, [{}]);
  assert.match(text, /6 hours/);
});
