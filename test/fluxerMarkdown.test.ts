import test from 'node:test';
import assert from 'node:assert/strict';

import {
  admonition,
  heading,
  maskedLink,
  relativeFromNow,
  relativeTimestamp,
  subtext,
  timestampTag,
} from '../src/bot/fluxerMarkdown.ts';
import { renderMinimalEmbedContent } from '../src/bot/messageFormatter.ts';

test('timestampTag renders unix seconds with the requested style', () => {
  assert.equal(timestampTag(new Date('2026-09-16T12:00:00.000Z'), 'R'), '<t:1789560000:R>');
  assert.equal(timestampTag(1789560000000, 'D'), '<t:1789560000:D>');
  assert.equal(timestampTag('2026-09-16T12:00:00.000Z'), '<t:1789560000:f>');
});

test('timestampTag returns an empty string for unusable input', () => {
  assert.equal(timestampTag(null), '');
  assert.equal(timestampTag(undefined), '');
  assert.equal(timestampTag(Number.NaN), '');
  assert.equal(timestampTag('not a date'), '');
});

test('relativeTimestamp and relativeFromNow use the relative style', () => {
  assert.match(relativeTimestamp(Date.now()), /^<t:\d+:R>$/);
  assert.match(relativeFromNow(90), /^<t:\d+:R>$/);
  assert.equal(relativeFromNow(Number.NaN), '');
});

test('subtext prefixes every line and drops empty ones', () => {
  assert.equal(subtext('Loop off | Vol 100%'), '-# Loop off | Vol 100%');
  assert.equal(subtext('first\n\nsecond'), '-# first\n-# second');
  assert.equal(subtext('   '), '');
});

test('heading collapses newlines and honours the level', () => {
  assert.equal(heading('Now Playing'), '### Now Playing');
  assert.equal(heading('Stats', 2), '## Stats');
  assert.equal(heading('two\nlines'), '### two lines');
  assert.equal(heading(null), '');
});

test('admonition wraps every line in the blockquote body', () => {
  assert.equal(admonition('WARNING', 'Nothing is playing.'), '> [!WARNING]\n> Nothing is playing.');
  assert.equal(admonition('CAUTION', 'line one\nline two'), '> [!CAUTION]\n> line one\n> line two');
  assert.equal(admonition('NOTE', ''), '');
});

test('maskedLink suppresses the embed preview unless asked otherwise', () => {
  assert.equal(maskedLink('Station', 'https://radio.example/stream'), '[Station](<https://radio.example/stream>)');
  assert.equal(
    maskedLink('Station', 'https://radio.example/stream', { embed: true }),
    '[Station](https://radio.example/stream)'
  );
});

test('maskedLink falls back to plain text for unusable targets', () => {
  assert.equal(maskedLink('Station', 'javascript:alert(1)'), 'Station');
  assert.equal(maskedLink('Station', 'https://radio.example/a b'), 'Station');
  assert.equal(maskedLink('Station', null), 'Station');
  assert.equal(maskedLink('[Sta]tion', 'https://radio.example/'), '[Station](<https://radio.example/>)');
});

test('renderMinimalEmbedContent renders a title as a heading and the footer as subtext', () => {
  const content = renderMinimalEmbedContent('Queue updated.', [{ name: 'Track', value: 'Song A' }], 'Loop off', {
    title: 'Queue',
  });

  assert.equal(content, '### Queue\nQueue updated.\n**Track**: Song A\n-# Loop off');
});

test('renderMinimalEmbedContent turns warnings and errors into admonitions', () => {
  assert.equal(
    renderMinimalEmbedContent('Nothing is playing.', null, null, { kind: 'warning' }),
    '> [!WARNING]\n> Nothing is playing.'
  );
  assert.equal(
    renderMinimalEmbedContent('Playback failed.', null, null, { kind: 'error' }),
    '> [!CAUTION]\n> Playback failed.'
  );
  assert.equal(renderMinimalEmbedContent('Playback resumed.', null, null, { kind: 'success' }), 'Playback resumed.');
});
