import test from 'node:test';
import assert from 'node:assert/strict';

import { describeNodeLinkErrorBody } from '../src/player/musicPlayer/NodeLinkClient.ts';

test('NodeLink error bodies are reduced to their message', () => {
  assert.equal(
    describeNodeLinkErrorBody('{"timestamp":1,"status":500,"error":"Worker Error","message":"Failed to resolve stream URL"}', 'Internal Server Error'),
    'Failed to resolve stream URL',
  );
  assert.equal(describeNodeLinkErrorBody('{"error":"Gateway Timeout"}', 'x'), 'Gateway Timeout');
  assert.equal(describeNodeLinkErrorBody('plain text failure', 'x'), 'plain text failure');
  assert.equal(describeNodeLinkErrorBody('  ', 'Bad Gateway'), 'Bad Gateway');
});
