import test from 'node:test';
import assert from 'node:assert/strict';

import { MonitoringServer } from '../src/monitoring/server.ts';

test('MonitoringServer awaits async health providers for readyz', async () => {
  const server = new MonitoringServer({
    host: '127.0.0.1',
    port: 19091,
    getHealth: async () => ({
      ok: true,
      gatewayConnected: true,
      nodelink: {
        configured: true,
        reachable: true,
      },
    }),
  });

  await server.start();

  try {
    const response = await fetch('http://127.0.0.1:19091/readyz');
    const payload = await response.json() as Record<string, unknown> & {
      nodelink?: Record<string, unknown>;
    };

    assert.equal(response.status, 200);
    assert.equal(payload.ok, true);
    assert.equal(payload.gatewayConnected, true);
    assert.deepEqual(payload.nodelink, {
      configured: true,
      reachable: true,
    });
  } finally {
    await server.stop();
  }
});
