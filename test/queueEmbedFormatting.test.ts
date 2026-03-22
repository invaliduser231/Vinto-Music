import test from 'node:test';
import assert from 'node:assert/strict';

import { formatHistoryPage, formatQueuePage } from '../src/bot/commands/commandHelpers.ts';

type QueueTrack = {
  title: string;
  duration: string;
  requestedBy: string;
};

function makeTrack(index: number, titleLength = 280): QueueTrack {
  const base = `Track ${index} `;
  const filler = 'x'.repeat(Math.max(0, titleLength - base.length));
  return {
    title: `${base}${filler}`,
    duration: '3:45',
    requestedBy: '123456789012345678',
  };
}

function hasBalancedBoldMarkers(text: string) {
  return ((String(text).match(/\*\*/g) ?? []).length % 2) === 0;
}

test('formatQueuePage keeps queue lines whole and balanced when content is long', () => {
  const session = {
    player: {
      pendingTracks: Array.from({ length: 10 }, (_, i) => makeTrack(i + 1, 320)),
      currentTrack: makeTrack(0, 900),
      loopMode: 'off',
      volumePercent: 100,
      getProgressSeconds: () => 6,
    },
    settings: {
      dedupeEnabled: false,
      stayInVoiceEnabled: false,
    },
  };

  const payload = formatQueuePage(session, 1);
  const nowPlaying = payload.fields.find((field) => field.name === 'Now Playing');
  const upNext = payload.fields.find((field) => field.name.startsWith('Up Next'));

  assert.ok(nowPlaying);
  assert.ok(upNext);
  assert.equal(payload.description, 'Queue: **10** tracks • Remaining: **37:30**');
  assert.match(String(payload.footer ?? ''), /Loop off \| Vol 100% \| Dedupe off \| 24\/7 off/);
  assert.ok(hasBalancedBoldMarkers(nowPlaying.value));
  assert.ok(hasBalancedBoldMarkers(upNext.value));
  assert.match(upNext.value, /\.\.\.and \d+ more$/);
  assert.equal(upNext.name, 'Up Next (Page 1/1)');

  const queueLines = upNext.value.split('\n').filter((line) => /^\d+\./.test(line));
  assert.ok(queueLines.length >= 1);
  for (const line of queueLines) {
    assert.doesNotMatch(line, /requested by/);
    assert.match(line, /^\d+\. \*\*.+\*\* \([^)]+\)$/);
  }
});

test('formatHistoryPage keeps history lines whole and balanced when content is long', () => {
  const session = {
    player: {
      historyTracks: Array.from({ length: 30 }, (_, i) => makeTrack(i + 1, 320)),
    },
  };

  const payload = formatHistoryPage(session, 1);
  assert.equal(payload.fields.length, 1);
  const [historyField] = payload.fields;
  assert.ok(historyField);
  const value = historyField.value;

  assert.ok(hasBalancedBoldMarkers(value));
  assert.match(value, /\.\.\.and \d+ more$/);

  const lines = value.split('\n').filter((line) => /^\d+\./.test(line));
  assert.ok(lines.length >= 1);
  for (const line of lines) {
    assert.match(line, /^\d+\. \*\*.+\*\* \([^)]+\)( • requested by <@\d+>)?$/);
  }
});





