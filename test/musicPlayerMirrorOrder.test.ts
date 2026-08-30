import test from 'node:test';
import assert from 'node:assert/strict';

import { resolverMethods } from '../src/player/musicPlayer/resolverMethods.ts';

type MirrorRuntime = {
  enableYtSearch: boolean;
  enableYtPlayback: boolean;
  nodeLinkEnabled: boolean;
  nodeLinkClient: { enabled: boolean };
  nodeLinkMirrorSearchOrder: string[];
  logger: { debug: () => void };
  attempts: string[];
  hits: Record<string, { source: string; title: string }>;
  _resolveNodeLinkTracks: (
    query: string,
    requestedBy: string | null,
    limit: number,
    options: { searchIdentifier?: string },
  ) => Promise<Array<{ source: string; title: string }>>;
  _searchYouTubeTracks: () => Promise<unknown[]>;
};

function createRuntime(options: {
  order?: string[];
  hits?: Record<string, { source: string; title: string }>;
}): MirrorRuntime {
  const runtime: MirrorRuntime = {
    enableYtSearch: true,
    enableYtPlayback: true,
    nodeLinkEnabled: true,
    nodeLinkClient: { enabled: true },
    nodeLinkMirrorSearchOrder: options.order ?? ['dzsearch', 'tdsearch', 'scsearch', 'ytsearch'],
    logger: { debug: () => {} },
    attempts: [],
    hits: options.hits ?? {},
    async _resolveNodeLinkTracks(_query, _requestedBy, _limit, opts) {
      const identifier = String(opts?.searchIdentifier ?? '');
      runtime.attempts.push(identifier);
      const hit = runtime.hits[identifier];
      return hit ? [hit] : [];
    },
    async _searchYouTubeTracks() {
      runtime.attempts.push('local-youtube');
      return [];
    },
  };
  return runtime;
}

const resolveMirror = resolverMethods._resolveStartupMirrorFallbackTrack as (
  this: MirrorRuntime,
  track: { title: string; artist?: string; source?: string } | null,
  requestedBy: string | null,
  exhaustedSources?: string[],
) => Promise<{ source: string; title: string } | null>;

test('mirror search prefers deezer over youtube', async () => {
  const runtime = createRuntime({
    hits: {
      dzsearch: { source: 'deezer', title: 'Ich hab Angst' },
      ytsearch: { source: 'youtube', title: 'Ich hab Angst (Official Video)' },
    },
  });

  const match = await resolveMirror.call(runtime, { title: 'Ich hab Angst', artist: 'RAUM27', source: 'spotify' }, 'user-1');

  assert.equal(match?.source, 'deezer');
  assert.deepEqual(runtime.attempts, ['dzsearch']);
});

test('mirror search falls through to youtube when better sources miss', async () => {
  const runtime = createRuntime({
    hits: { ytsearch: { source: 'youtube', title: 'Rare Song' } },
  });

  const match = await resolveMirror.call(runtime, { title: 'Rare Song', source: 'spotify' }, null);

  assert.equal(match?.source, 'youtube');
  assert.deepEqual(runtime.attempts, ['dzsearch', 'tdsearch', 'scsearch', 'ytsearch']);
});

test('mirror search never mirrors back onto the source that just failed', async () => {
  const runtime = createRuntime({
    hits: {
      dzsearch: { source: 'deezer', title: 'Song' },
      tdsearch: { source: 'tidal', title: 'Song' },
    },
  });

  const match = await resolveMirror.call(runtime, { title: 'Song', source: 'deezer' }, null);

  assert.equal(match?.source, 'tidal');
  assert.equal(runtime.attempts.includes('dzsearch'), false);
});

test('mirror search skips a result whose source matches the failed one', async () => {
  const runtime = createRuntime({
    order: ['tdsearch', 'ytsearch'],
    hits: {
      tdsearch: { source: 'deezer', title: 'Mislabelled' },
      ytsearch: { source: 'youtube', title: 'Song' },
    },
  });

  const match = await resolveMirror.call(runtime, { title: 'Song', source: 'deezer' }, null);

  assert.equal(match?.source, 'youtube');
});

test('a configured order is honoured', async () => {
  const runtime = createRuntime({
    order: ['ytsearch', 'dzsearch'],
    hits: {
      dzsearch: { source: 'deezer', title: 'Song' },
      ytsearch: { source: 'youtube', title: 'Song' },
    },
  });

  const match = await resolveMirror.call(runtime, { title: 'Song', source: 'spotify' }, null);

  assert.equal(match?.source, 'youtube');
  assert.deepEqual(runtime.attempts, ['ytsearch']);
});

test('a failed mirror source is skipped on the next attempt', async () => {
  const runtime = createRuntime({
    hits: {
      dzsearch: { source: 'deezer', title: 'Sommerregen' },
      ytsearch: { source: 'youtube', title: 'Sommerregen' },
    },
  });

  const match = await resolveMirror.call(
    runtime,
    { title: 'Sommerregen', source: 'deezer' },
    null,
    ['spotify'],
  );

  assert.equal(match?.source, 'youtube');
  assert.equal(runtime.attempts.includes('dzsearch'), false);
});

test('mirror search gives up when every source is exhausted', async () => {
  const runtime = createRuntime({
    hits: {
      dzsearch: { source: 'deezer', title: 'Song' },
      ytsearch: { source: 'youtube', title: 'Song' },
    },
  });

  const match = await resolveMirror.call(
    runtime,
    { title: 'Song', source: 'youtube' },
    null,
    ['spotify', 'deezer', 'tidal', 'soundcloud'],
  );

  assert.equal(match, null);
});

test('deezer mirroring still works when youtube is disabled', async () => {
  const runtime = createRuntime({
    hits: { dzsearch: { source: 'deezer', title: 'Song' } },
  });
  runtime.enableYtSearch = false;
  runtime.enableYtPlayback = false;

  const match = await resolveMirror.call(runtime, { title: 'Song', source: 'spotify' }, null);

  assert.equal(match?.source, 'deezer');
  assert.equal(runtime.attempts.includes('ytsearch'), false);
});

test('a source in cooldown is skipped', async () => {
  const runtime = createRuntime({
    hits: {
      dzsearch: { source: 'deezer', title: 'Song' },
      ytsearch: { source: 'youtube', title: 'Song' },
    },
  }) as MirrorRuntime & { _isMirrorSourceCooling: (source: string) => boolean };
  runtime._isMirrorSourceCooling = (source: string) => source === 'deezer';

  const match = await resolveMirror.call(runtime, { title: 'Song', source: 'spotify' }, null);

  assert.equal(match?.source, 'youtube');
  assert.equal(runtime.attempts.includes('dzsearch'), false);
});
