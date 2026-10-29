import test from 'node:test';
import assert from 'node:assert/strict';

import { collectPlayableAttachmentUrls } from '../src/bot/commands/helpers/attachments.ts';

test('collects audio and video attachments by content type or file name', () => {
  const urls = collectPlayableAttachmentUrls({
    attachments: [
      { url: 'https://cdn.example/a.bin', filename: 'a.bin', content_type: 'audio/mpeg' },
      { url: 'https://cdn.example/clip.mp4', filename: 'clip.mp4' },
      { url: 'https://cdn.example/image.png', filename: 'image.png', content_type: 'image/png' },
      { url: 'https://cdn.example/old.mp3', filename: 'old.mp3', expired: true },
      { url: null, filename: 'missing.mp3' },
    ],
  });

  assert.deepEqual(urls, ['https://cdn.example/a.bin', 'https://cdn.example/clip.mp4']);
});

test('returns nothing when the message has no attachments', () => {
  assert.deepEqual(collectPlayableAttachmentUrls({}), []);
  assert.deepEqual(collectPlayableAttachmentUrls(null), []);
});
