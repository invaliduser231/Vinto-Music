import test from 'node:test';
import assert from 'node:assert/strict';

import { pushFluxerListStats } from '../src/bot/services/fluxerListStats.ts';

test('the guild count goes to the documented v1 stats endpoint as serverCount', async () => {
  const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    requests.push({ url, init });
    return new Response('{}', { status: 200 });
  }) as typeof fetch;

  await pushFluxerListStats({ apiBase: 'https://fluxerlist.com', botId: '123', apiKey: 'fl_key', guildCount: 1977 }, fetchImpl);

  assert.equal(requests[0]?.url, 'https://fluxerlist.com/api/v1/bots/123/stats');
  assert.equal(requests[0]?.init?.method, 'POST');
  assert.equal(requests[0]?.init?.body, JSON.stringify({ serverCount: 1977 }));
  assert.equal((requests[0]?.init?.headers as Record<string, string>).Authorization, 'Bearer fl_key');
});

test('a rejected push surfaces the status', async () => {
  const fetchImpl = (async () => new Response('{"error":"rate limited"}', { status: 429, statusText: 'Too Many Requests' })) as typeof fetch;

  await assert.rejects(
    pushFluxerListStats({ apiBase: 'https://fluxerlist.com', botId: '123', apiKey: 'fl_key', guildCount: 1 }, fetchImpl),
    /429 Too Many Requests/,
  );
});
