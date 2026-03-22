import test from 'node:test';
import assert from 'node:assert/strict';

import { renderMinimalEmbedContent } from '../src/bot/messageFormatter.ts';

test('renderMinimalEmbedContent flattens description and fields into compact text', () => {
  const content = renderMinimalEmbedContent('Queue updated.', [
    { name: 'Track', value: 'Song A' },
    { name: 'Requested By', value: '<@123>' },
  ]);

  assert.equal(content, 'Queue updated.\n**Track**: Song A\n**Requested By**: <@123>');
});
