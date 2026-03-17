import test from 'node:test';
import assert from 'node:assert/strict';

import { SessionManager } from '../src/bot/sessionManager.js';

function createManager(overrides = {}) {
  return new SessionManager({
    gateway: {
      joinVoice() {},
      leaveVoice() {},
      on() {},
      off() {},
    },
    config: {
      sessionIdleMs: 10_000,
      defaultDedupeEnabled: false,
      defaultStayInVoiceEnabled: false,
      defaultVolumePercent: 100,
      minVolumePercent: 0,
      maxVolumePercent: 200,
      voteSkipRatio: 0.5,
      voteSkipMinVotes: 2,
      voiceMaxBitrate: 192000,
      maxQueueSize: 100,
      maxPlaylistTracks: 25,
      enableYtSearch: true,
      enableYtPlayback: true,
      enableSpotifyImport: true,
      enableDeezerImport: true,
      youtubePlaylistResolver: 'ytdlp',
    },
    guildConfigs: null,
    library: null,
    logger: null,
    voiceStateStore: null,
    botUserId: null,
    ...overrides,
  });
}

function createSession({
  guildId = '111111',
  voiceChannelId = '222222',
  textChannelId = '333333',
  stayInVoiceEnabled = true,
} = {}) {
  return {
    guildId,
    connection: {
      connected: Boolean(voiceChannelId),
      channelId: voiceChannelId,
      async connect(channelId) {
        this.connected = true;
        this.channelId = channelId;
      },
      async disconnect() {
        this.connected = false;
        this.channelId = null;
      },
    },
    player: {
      stop() {},
      setVolumePercent() {},
    },
    settings: {
      stayInVoiceEnabled,
    },
    textChannelId,
    diagnostics: {
      timer: null,
      inFlight: false,
    },
    snapshot: {
      dirty: false,
      lastPersistAt: 0,
      inFlight: false,
    },
    idleTimer: null,
  };
}

test('24/7 session persistence survives shutdown but clears on manual destroy', async () => {
  const patches = [];
  const manager = createManager({
    library: {
      async patchGuildFeatureConfig(guildId, patch) {
        patches.push({ guildId, patch });
        return { guildId, ...patch };
      },
    },
  });

  const shutdownSession = createSession();
  manager.sessions.set(shutdownSession.guildId, shutdownSession);

  await manager.syncPersistentVoiceState(shutdownSession.guildId);
  await manager.destroy(shutdownSession.guildId, 'shutdown');

  assert.equal(patches.length, 1);
  assert.equal(patches[0].guildId, '111111');
  assert.equal(patches[0].patch.persistentVoiceChannelId, '222222');
  assert.equal(patches[0].patch.persistentTextChannelId, '333333');

  const manualSession = createSession({ guildId: '444444', voiceChannelId: '555555', textChannelId: '666666' });
  manager.sessions.set(manualSession.guildId, manualSession);

  await manager.destroy(manualSession.guildId, 'manual_command');

  assert.equal(patches.length, 2);
  assert.equal(patches[1].guildId, '444444');
  assert.equal(patches[1].patch.persistentVoiceChannelId, null);
  assert.equal(patches[1].patch.persistentTextChannelId, null);
});

test('active non-24/7 session is stored as restart recovery binding', async () => {
  const patches = [];
  const manager = createManager({
    library: {
      async patchGuildFeatureConfig(guildId, patch) {
        patches.push({ guildId, patch });
        return { guildId, ...patch };
      },
    },
  });

  const session = createSession({
    guildId: '212121',
    voiceChannelId: '434343',
    textChannelId: '656565',
    stayInVoiceEnabled: false,
  });
  session.player = {
    playing: true,
    currentTrack: {
      title: 'Demo',
      url: 'https://example.com/demo',
      source: 'youtube',
    },
    pendingTracks: [],
    stop() {},
    setVolumePercent() {},
  };
  manager.sessions.set('212121:434343', {
    ...session,
    sessionId: '212121:434343',
  });

  const persisted = await manager.syncPersistentVoiceState('212121');

  assert.equal(persisted, true);
  assert.equal(patches.length, 1);
  assert.deepEqual(patches[0], {
    guildId: '212121',
    patch: {
      persistentVoiceConnections: [],
      restartRecoveryConnections: [{
        voiceChannelId: '434343',
        textChannelId: '656565',
      }],
      persistentVoiceChannelId: null,
      persistentTextChannelId: null,
      persistentVoiceUpdatedAt: patches[0].patch.persistentVoiceUpdatedAt,
    },
  });
  assert.equal(patches[0].patch.persistentVoiceUpdatedAt instanceof Date, true);
});

test('shutdown preserves recovery bindings for multiple sessions in the same guild', async () => {
  const patches = [];
  const snapshots = [];
  const manager = createManager({
    library: {
      async patchGuildFeatureConfig(guildId, patch) {
        patches.push({ guildId, patch });
        return { guildId, ...patch };
      },
      async upsertSessionSnapshot(guildId, voiceChannelId, snapshot) {
        snapshots.push({ guildId, voiceChannelId, snapshot });
      },
    },
  });

  const first = createSession({
    guildId: '313131',
    voiceChannelId: '414141',
    textChannelId: '515151',
    stayInVoiceEnabled: false,
  });
  first.sessionId = '313131:414141';
  first.player = {
    playing: true,
    paused: false,
    loopMode: 'off',
    volumePercent: 100,
    currentTrack: {
      title: 'First',
      url: 'https://example.com/first',
      duration: '3:00',
      source: 'youtube',
      isLive: false,
    },
    pendingTracks: [],
    getProgressSeconds() { return 5; },
    canSeekCurrentTrack() { return true; },
    stop() {},
    setVolumePercent() {},
  };

  const second = createSession({
    guildId: '313131',
    voiceChannelId: '424242',
    textChannelId: '525252',
    stayInVoiceEnabled: false,
  });
  second.sessionId = '313131:424242';
  second.player = {
    playing: true,
    paused: false,
    loopMode: 'off',
    volumePercent: 100,
    currentTrack: {
      title: 'Second',
      url: 'https://example.com/second',
      duration: '4:00',
      source: 'youtube',
      isLive: false,
    },
    pendingTracks: [],
    getProgressSeconds() { return 9; },
    canSeekCurrentTrack() { return true; },
    stop() {},
    setVolumePercent() {},
  };

  manager.sessions.set(first.sessionId, first);
  manager.sessions.set(second.sessionId, second);

  await manager.shutdown();

  assert.equal(snapshots.length, 2);
  assert.equal(patches.length, 1);
  assert.deepEqual(patches[0], {
    guildId: '313131',
    patch: {
      persistentVoiceConnections: [],
      restartRecoveryConnections: [
        { voiceChannelId: '414141', textChannelId: '515151' },
        { voiceChannelId: '424242', textChannelId: '525252' },
      ],
      persistentVoiceChannelId: null,
      persistentTextChannelId: null,
      persistentVoiceUpdatedAt: patches[0].patch.persistentVoiceUpdatedAt,
    },
  });
  assert.equal(patches[0].patch.persistentVoiceUpdatedAt instanceof Date, true);
});

test('persistent 24/7 bindings are restored on startup', async () => {
  const patches = [];
  const manager = createManager({
    guildConfigs: {
      async get(guildId) {
        return {
          guildId,
          prefix: '!',
          settings: {
            dedupeEnabled: false,
            stayInVoiceEnabled: true,
            volumePercent: 100,
            voteSkipRatio: 0.5,
            voteSkipMinVotes: 2,
            djRoleIds: [],
            musicLogChannelId: null,
          },
        };
      },
    },
    library: {
      async listPersistentVoiceConnections() {
        return [{
          guildId: '777777',
          voiceChannelId: '888888',
          textChannelId: '999999',
          updatedAt: new Date(),
        }];
      },
      async patchGuildFeatureConfig(guildId, patch) {
        patches.push({ guildId, patch });
        return { guildId, ...patch };
      },
    },
  });

  manager.ensure = async (guildId, guildConfig) => {
    const session = createSession({
      guildId,
      voiceChannelId: null,
      textChannelId: null,
      stayInVoiceEnabled: guildConfig?.settings?.stayInVoiceEnabled,
    });
    manager.sessions.set(guildId, session);
    return session;
  };

  const results = await manager.restorePersistentVoiceSessions();
  const restored = manager.get('777777');

  assert.equal(results.length, 1);
  assert.equal(results[0].guildId, '777777');
  assert.equal(results[0].restored, true);
  assert.equal(restored?.connection?.connected, true);
  assert.equal(restored?.connection?.channelId, '888888');
  assert.equal(restored?.textChannelId, '999999');
  assert.equal(patches.length, 1);
  assert.equal(patches[0].patch.persistentVoiceChannelId, '888888');
  assert.equal(patches[0].patch.persistentTextChannelId, '999999');
});

test('voice profile 24/7 override is applied per voice channel session', async () => {
  const manager = createManager({
    guildConfigs: {
      async get(guildId) {
        return {
          guildId,
          prefix: '!',
          settings: {
            dedupeEnabled: false,
            stayInVoiceEnabled: false,
            volumePercent: 100,
            voteSkipRatio: 0.5,
            voteSkipMinVotes: 2,
            djRoleIds: [],
            musicLogChannelId: null,
          },
        };
      },
    },
    library: {
      async getVoiceProfile(guildId, channelId) {
        if (guildId === '191919' && channelId === '383838') {
          return { channelId, stayInVoiceEnabled: true };
        }
        return null;
      },
    },
  });

  const session = await manager.ensure('191919', null, {
    voiceChannelId: '383838',
    textChannelId: '575757',
  });

  assert.equal(session.settings.stayInVoiceEnabled, true);
});

test('persistent restore does not depend on guild-wide 24/7 flag anymore', async () => {
  const patches = [];
  const manager = createManager({
    guildConfigs: {
      async get(guildId) {
        return {
          guildId,
          prefix: '!',
          settings: {
            dedupeEnabled: false,
            stayInVoiceEnabled: false,
            volumePercent: 100,
            voteSkipRatio: 0.5,
            voteSkipMinVotes: 2,
            djRoleIds: [],
            musicLogChannelId: null,
          },
        };
      },
    },
    library: {
      async listPersistentVoiceConnections() {
        return [{
          guildId: '202020',
          voiceChannelId: '404040',
          textChannelId: '606060',
          updatedAt: new Date(),
        }];
      },
      async patchGuildFeatureConfig(guildId, patch) {
        patches.push({ guildId, patch });
        return { guildId, ...patch };
      },
    },
  });

  manager.ensure = async (guildId) => {
    const session = createSession({
      guildId,
      voiceChannelId: null,
      textChannelId: null,
      stayInVoiceEnabled: true,
    });
    session.sessionId = `${guildId}:404040`;
    manager.sessions.set(session.sessionId, session);
    return session;
  };

  const results = await manager.restorePersistentVoiceSessions();
  const restored = manager.get('202020', { voiceChannelId: '404040' });

  assert.equal(results.length, 1);
  assert.equal(results[0].restored, true);
  assert.equal(restored?.connection?.connected, true);
  assert.equal(restored?.connection?.channelId, '404040');
  assert.equal(patches.length, 1);
});

test('missing persistent voice channel is cleared before restore attempt', async () => {
  const patches = [];
  const deletedSnapshots = [];
  const manager = createManager({
    rest: {
      async getChannel() {
        const error = new Error('Unknown channel');
        error.status = 404;
        throw error;
      },
    },
    guildConfigs: {
      async get(guildId) {
        return {
          guildId,
          prefix: '!',
          settings: {
            dedupeEnabled: false,
            stayInVoiceEnabled: true,
            volumePercent: 100,
            voteSkipRatio: 0.5,
            voteSkipMinVotes: 2,
            djRoleIds: [],
            musicLogChannelId: null,
          },
        };
      },
    },
    library: {
      async listPersistentVoiceConnections() {
        return [{
          guildId: '777777',
          voiceChannelId: '888888',
          textChannelId: '999999',
          updatedAt: new Date(),
        }];
      },
      async getGuildFeatureConfig(guildId) {
        return {
          guildId,
          persistentVoiceConnections: [{
            voiceChannelId: '888888',
            textChannelId: '999999',
          }],
        };
      },
      async patchGuildFeatureConfig(guildId, patch) {
        patches.push({ guildId, patch });
        return { guildId, ...patch };
      },
      async deleteSessionSnapshot(guildId, voiceChannelId) {
        deletedSnapshots.push({ guildId, voiceChannelId });
        return true;
      },
    },
  });

  let ensureCalled = false;
  manager.ensure = async () => {
    ensureCalled = true;
    throw new Error('should not be called');
  };

  const results = await manager.restorePersistentVoiceSessions();

  assert.equal(ensureCalled, false);
  assert.deepEqual(results, [{
    guildId: '777777',
    restored: false,
    reason: 'voice_channel_missing',
  }]);
  assert.equal(patches.length, 1);
  assert.deepEqual(patches[0], {
    guildId: '777777',
    patch: {
      persistentVoiceConnections: [],
      restartRecoveryConnections: [],
      persistentVoiceChannelId: null,
      persistentTextChannelId: null,
      persistentVoiceUpdatedAt: patches[0].patch.persistentVoiceUpdatedAt,
    },
  });
  assert.equal(patches[0].patch.persistentVoiceUpdatedAt instanceof Date, true);
  assert.deepEqual(deletedSnapshots, [{
    guildId: '777777',
    voiceChannelId: '888888',
  }]);
});

test('enabling voice-channel 24/7 on an already connected session persists the voice binding', async () => {
  const patches = [];
  const manager = createManager({
    library: {
      async getVoiceProfile(guildId, channelId) {
        if (guildId === '121212' && channelId === '343434') {
          return { channelId, stayInVoiceEnabled: true };
        }
        return null;
      },
      async patchGuildFeatureConfig(guildId, patch) {
        patches.push({ guildId, patch });
        return { guildId, ...patch };
      },
    },
  });

  const session = createSession({
    guildId: '121212',
    voiceChannelId: '343434',
    textChannelId: '565656',
    stayInVoiceEnabled: false,
  });
  manager.sessions.set('121212:343434', {
    ...session,
    sessionId: '121212:343434',
    voiceProfileSettings: { stayInVoiceEnabled: null },
  });

  await manager.refreshVoiceProfileSettings('121212', { voiceChannelId: '343434' });

  assert.equal(patches.length, 1);
  assert.equal(patches[0].guildId, '121212');
  assert.equal(patches[0].patch.persistentVoiceChannelId, '343434');
  assert.equal(patches[0].patch.persistentTextChannelId, '565656');
});

test('session snapshot persistence stores current track, queue and seek position', async () => {
  const snapshots = [];
  const manager = createManager({
    library: {
      async upsertSessionSnapshot(guildId, voiceChannelId, snapshot) {
        snapshots.push({ guildId, voiceChannelId, snapshot });
      },
    },
  });

  const session = createSession({
    guildId: '131313',
    voiceChannelId: '353535',
    textChannelId: '575757',
    stayInVoiceEnabled: true,
  });
  session.player = {
    playing: true,
    paused: false,
    loopMode: 'queue',
    volumePercent: 77,
    currentTrack: {
      title: 'Current',
      url: 'https://example.com/current',
      duration: '3:00',
      source: 'youtube',
      requestedBy: 'user-1',
      isLive: false,
    },
    pendingTracks: [{
      title: 'Next',
      url: 'https://example.com/next',
      duration: '2:00',
      source: 'youtube',
      requestedBy: 'user-2',
      isLive: false,
    }],
    getProgressSeconds() {
      return 42;
    },
    canSeekCurrentTrack() {
      return true;
    },
    stop() {},
    setVolumePercent() {},
  };

  const persisted = await manager.persistSessionSnapshot(session, { force: true });

  assert.equal(persisted, true);
  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0].guildId, '131313');
  assert.equal(snapshots[0].voiceChannelId, '353535');
  assert.equal(snapshots[0].snapshot.state.progressSec, 42);
  assert.equal(snapshots[0].snapshot.state.loopMode, 'queue');
  assert.equal(snapshots[0].snapshot.currentTrack.seekStartSec, 42);
  assert.equal(snapshots[0].snapshot.pendingTracks.length, 1);
});

test('session snapshot persistence also stores active non-24/7 sessions for restart recovery', async () => {
  const snapshots = [];
  const manager = createManager({
    library: {
      async upsertSessionSnapshot(guildId, voiceChannelId, snapshot) {
        snapshots.push({ guildId, voiceChannelId, snapshot });
      },
    },
  });

  const session = createSession({
    guildId: '232323',
    voiceChannelId: '454545',
    textChannelId: '676767',
    stayInVoiceEnabled: false,
  });
  session.player = {
    playing: true,
    paused: false,
    loopMode: 'off',
    volumePercent: 100,
    currentTrack: {
      title: 'Recover Me',
      url: 'https://example.com/recover',
      duration: '3:00',
      source: 'youtube',
      requestedBy: 'user-1',
      isLive: false,
    },
    pendingTracks: [],
    getProgressSeconds() {
      return 12;
    },
    canSeekCurrentTrack() {
      return true;
    },
    stop() {},
    setVolumePercent() {},
  };

  const persisted = await manager.persistSessionSnapshot(session, { force: true });

  assert.equal(persisted, true);
  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0].guildId, '232323');
  assert.equal(snapshots[0].voiceChannelId, '454545');
  assert.equal(snapshots[0].snapshot.currentTrack.title, 'Recover Me');
  assert.equal(snapshots[0].snapshot.currentTrack.seekStartSec, 12);
});

test('session snapshot restore reapplies queue, loop, volume and paused state', async () => {
  const calls = [];
  const manager = createManager({
    library: {
      async getSessionSnapshot() {
        return {
          state: {
            playing: true,
            paused: true,
            loopMode: 'track',
            volumePercent: 66,
            progressSec: 19,
          },
          currentTrack: {
            title: 'Current',
            url: 'https://example.com/current',
            duration: '3:00',
            source: 'youtube',
            requestedBy: 'user-1',
            seekStartSec: 19,
          },
          pendingTracks: [{
            title: 'Next',
            url: 'https://example.com/next',
            duration: '2:00',
            source: 'youtube',
            requestedBy: 'user-2',
          }],
        };
      },
    },
  });

  const session = createSession({
    guildId: '141414',
    voiceChannelId: '363636',
    textChannelId: '585858',
    stayInVoiceEnabled: true,
  });
  session.player = {
    setVolumePercent(value) {
      calls.push(['volume', value]);
    },
    setLoopMode(value) {
      calls.push(['loop', value]);
    },
    createTrackFromData(track) {
      calls.push(['create', track.title, track.seekStartSec ?? 0]);
      return { ...track };
    },
    clearQueue() {
      calls.push(['clear']);
    },
    enqueueResolvedTracks(tracks) {
      calls.push(['enqueue', tracks.map((track) => track.title)]);
      return tracks;
    },
    async play() {
      calls.push(['play']);
    },
    pause() {
      calls.push(['pause']);
      return true;
    },
  };

  const restored = await manager.restoreSessionSnapshot(session);

  assert.equal(restored, true);
  assert.deepEqual(calls, [
    ['volume', 66],
    ['loop', 'track'],
    ['create', 'Current', 19],
    ['create', 'Next', 0],
    ['clear'],
    ['enqueue', ['Current', 'Next']],
    ['play'],
    ['pause'],
  ]);
});

test('session snapshot restore re-resolves metadata-only tracks before playback', async () => {
  const calls = [];
  const manager = createManager({
    library: {
      async getSessionSnapshot() {
        return {
          state: {
            playing: true,
            paused: false,
            loopMode: 'off',
            volumePercent: 100,
            progressSec: 27,
          },
          currentTrack: {
            title: 'Track From Spotify',
            artist: 'Artist',
            url: 'https://open.spotify.com/track/abc123',
            duration: '3:00',
            source: 'spotify',
            requestedBy: 'user-1',
            seekStartSec: 27,
          },
          pendingTracks: [],
        };
      },
    },
  });

  const session = createSession({
    guildId: '151515',
    voiceChannelId: '373737',
    textChannelId: '595959',
    stayInVoiceEnabled: true,
  });
  session.player = {
    setVolumePercent(value) {
      calls.push(['volume', value]);
    },
    setLoopMode(value) {
      calls.push(['loop', value]);
    },
    async previewTracks(query, options) {
      calls.push(['preview', query, options.requestedBy]);
      return [{
        title: 'Resolved Mirror',
        url: 'https://www.youtube.com/watch?v=resolved123',
        duration: '3:00',
        source: 'youtube',
        requestedBy: options.requestedBy,
      }];
    },
    createTrackFromData(track) {
      calls.push(['create', track.title, track.url, track.seekStartSec ?? 0]);
      return { ...track };
    },
    clearQueue() {
      calls.push(['clear']);
    },
    enqueueResolvedTracks(tracks) {
      calls.push(['enqueue', tracks.map((track) => track.title)]);
      return tracks;
    },
    async play() {
      calls.push(['play']);
    },
  };

  const restored = await manager.restoreSessionSnapshot(session);

  assert.equal(restored, true);
  assert.deepEqual(calls, [
    ['volume', 100],
    ['loop', 'off'],
    ['preview', 'https://open.spotify.com/track/abc123', 'user-1'],
    ['create', 'Resolved Mirror', 'https://www.youtube.com/watch?v=resolved123', 27],
    ['clear'],
    ['enqueue', ['Resolved Mirror']],
    ['play'],
  ]);
});

test('restore syncs persistent state only after snapshot restore attempt', async () => {
  const calls = [];
  const manager = createManager({
    guildConfigs: {
      async get(guildId) {
        return {
          guildId,
          prefix: '!',
          settings: {
            dedupeEnabled: false,
            stayInVoiceEnabled: false,
            volumePercent: 100,
            voteSkipRatio: 0.5,
            voteSkipMinVotes: 2,
            djRoleIds: [],
            musicLogChannelId: null,
          },
        };
      },
    },
    library: {
      async listPersistentVoiceConnections() {
        return [{
          guildId: '717171',
          voiceChannelId: '818181',
          textChannelId: '919191',
          updatedAt: new Date(),
        }];
      },
      async patchGuildFeatureConfig() {
        calls.push('sync');
        return {};
      },
    },
  });

  manager.ensure = async (guildId) => {
    const session = createSession({
      guildId,
      voiceChannelId: null,
      textChannelId: null,
      stayInVoiceEnabled: false,
    });
    session.sessionId = `${guildId}:818181`;
    manager.sessions.set(session.sessionId, session);
    return session;
  };
  manager.restoreSessionSnapshot = async () => {
    calls.push('restore');
    return true;
  };

  await manager.restorePersistentVoiceSessions();

  assert.deepEqual(calls, ['restore', 'sync']);
});
