import test from 'node:test';
import assert from 'node:assert/strict';

import { SessionManager } from '../src/bot/sessionManager.ts';
import type { GuildConfig } from '../src/types/domain.ts';

type TestTrack = {
  title?: string;
  artist?: string | null;
  url?: string | null;
  duration?: string | number;
  source?: string;
  requestedBy?: string | null;
  isLive?: boolean;
  seekStartSec?: number;
  [key: string]: unknown;
};

type TestPlayer = {
  stop?: () => void;
  setVolumePercent: (value?: number) => void;
  playing?: boolean;
  paused?: boolean;
  loopMode?: string;
  volumePercent?: number;
  currentTrack?: TestTrack | null;
  pendingTracks?: TestTrack[];
  getProgressSeconds?: () => number;
  canSeekCurrentTrack?: () => boolean;
  setLoopMode?: (value: string) => void;
  createTrackFromData?: (track: TestTrack) => TestTrack;
  clearQueue?: () => void;
  enqueueResolvedTracks?: (tracks: TestTrack[]) => TestTrack[];
  play?: () => Promise<void>;
  pause?: () => boolean;
  previewTracks?: (query: string, options: { requestedBy?: string | null }) => Promise<TestTrack[]>;
  [key: string]: unknown;
};

type TestSession = {
  guildId: string;
  sessionId?: string | undefined;
  connection: {
    connected: boolean;
    channelId: string | null;
    connect: (channelId: string) => Promise<void>;
    disconnect: () => Promise<void>;
  };
  player: TestPlayer;
  settings: {
    stayInVoiceEnabled: boolean;
  };
  textChannelId: string | null;
  diagnostics: {
    timer: unknown;
    inFlight: boolean;
  };
  snapshot: {
    dirty: boolean;
    lastPersistAt: number;
    inFlight: boolean;
  };
  idleTimer: unknown;
  voiceProfileSettings?: {
    stayInVoiceEnabled: boolean | null;
  };
  [key: string]: unknown;
};

function createManager(overrides: Record<string, unknown> = {}) {
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
    voiceStateStore: null,
    botUserId: null,
    ...overrides,
  } as unknown as ConstructorParameters<typeof SessionManager>[0]);
}

function createSession({
  guildId = '111111',
  voiceChannelId = '222222',
  textChannelId = '333333',
  stayInVoiceEnabled = true,
}: {
  guildId?: string;
  voiceChannelId?: string | null;
  textChannelId?: string | null;
  stayInVoiceEnabled?: boolean;
} = {}) {
  const session: TestSession = {
    guildId,
    sessionId: voiceChannelId ? `${guildId}:${voiceChannelId}` : guildId,
    connection: {
      connected: Boolean(voiceChannelId),
      channelId: voiceChannelId,
      async connect(channelId: string) {
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

  return session;
}

function setSession(manager: SessionManager, key: string, session: TestSession): void {
  manager.sessions.set(key, session as unknown as Parameters<typeof manager.sessions.set>[1]);
}

function firstItem<T>(values: T[]): T {
  return values[0]!;
}

test('24/7 session persistence survives shutdown but clears on manual destroy', async () => {
  const patches: Array<{ guildId: string; patch: Record<string, unknown> }> = [];
  const manager = createManager({
    library: {
      async patchGuildFeatureConfig(guildId: string, patch: Record<string, unknown>) {
        patches.push({ guildId, patch });
        return { guildId, ...patch };
      },
    },
  });

  const shutdownSession = createSession();
  setSession(manager, shutdownSession.guildId, shutdownSession);

  await manager.syncPersistentVoiceState(shutdownSession.guildId);
  await manager.destroy(shutdownSession.guildId, 'shutdown');
  assert.equal(patches.length, 1);
  assert.equal(patches[0]!.guildId, '111111');
  assert.equal(patches[0]!.patch.persistentVoiceChannelId, '222222');
  assert.equal(patches[0]!.patch.persistentTextChannelId, '333333');

  const manualSession = createSession({ guildId: '444444', voiceChannelId: '555555', textChannelId: '666666' });
  setSession(manager, manualSession.guildId, manualSession);

  await manager.destroy(manualSession.guildId, 'manual_command');
  assert.equal(patches.length, 2);
  assert.equal(patches[1]!.guildId, '444444');
  assert.equal(patches[1]!.patch.persistentVoiceChannelId, null);
  assert.equal(patches[1]!.patch.persistentTextChannelId, null);
});

test('active non-24/7 session is stored as restart recovery binding', async () => {
  const patches: Array<{ guildId: string; patch: Record<string, unknown> }> = [];
  const manager = createManager({
    library: {
      async patchGuildFeatureConfig(guildId: string, patch: Record<string, unknown>) {
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
  setSession(manager, '212121:434343', {
    ...session,
    sessionId: '212121:434343',
  });

  const persisted = await manager.syncPersistentVoiceState('212121');
  const patch = firstItem(patches);
  assert.equal(persisted, true);
  assert.equal(patches.length, 1);
  assert.deepEqual(patch, {
    guildId: '212121',
    patch: {
      persistentVoiceConnections: [],
      restartRecoveryConnections: [{
        voiceChannelId: '434343',
        textChannelId: '656565',
      }],
      persistentVoiceChannelId: null,
      persistentTextChannelId: null,
      persistentVoiceUpdatedAt: patch.patch.persistentVoiceUpdatedAt,
    },
  });
  assert.equal(patch.patch.persistentVoiceUpdatedAt instanceof Date, true);
});

test('shutdown preserves recovery bindings for multiple sessions in the same guild', async () => {
  const patches: Array<{ guildId: string; patch: Record<string, unknown> }> = [];
  const snapshots: Array<{ guildId: string; voiceChannelId: string; snapshot: Record<string, unknown> }> = [];
  const manager = createManager({
    library: {
      async patchGuildFeatureConfig(guildId: string, patch: Record<string, unknown>) {
        patches.push({ guildId, patch });
        return { guildId, ...patch };
      },
      async upsertSessionSnapshot(guildId: string, voiceChannelId: string, snapshot: Record<string, unknown>) {
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
  setSession(manager, first.sessionId!, first);
  setSession(manager, second.sessionId!, second);

  await manager.shutdown();
  const shutdownPatch = firstItem(patches);
  assert.equal(snapshots.length, 2);
  assert.equal(patches.length, 1);
  assert.deepEqual(shutdownPatch, {
    guildId: '313131',
    patch: {
      persistentVoiceConnections: [],
      restartRecoveryConnections: [
        { voiceChannelId: '414141', textChannelId: '515151' },
        { voiceChannelId: '424242', textChannelId: '525252' },
      ],
      persistentVoiceChannelId: null,
      persistentTextChannelId: null,
      persistentVoiceUpdatedAt: shutdownPatch.patch.persistentVoiceUpdatedAt,
    },
  });
  assert.equal(shutdownPatch.patch.persistentVoiceUpdatedAt instanceof Date, true);
});

test('persistent 24/7 bindings are restored on startup', async () => {
  const patches: Array<{ guildId: string; patch: Record<string, unknown> }> = [];
  const manager = createManager({
    guildConfigs: {
      async get(guildId: string) {
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
      async patchGuildFeatureConfig(guildId: string, patch: Record<string, unknown>) {
        patches.push({ guildId, patch });
        return { guildId, ...patch };
      },
    },
  });

  manager.ensure = (async (guildId: string, guildConfig?: GuildConfig | null) => {
    const stayInVoiceEnabled = guildConfig?.settings?.stayInVoiceEnabled;
    const session = createSession({
      guildId,
      voiceChannelId: null,
      textChannelId: null,
      ...(typeof stayInVoiceEnabled === 'boolean' ? { stayInVoiceEnabled } : {}),
    });
    setSession(manager, guildId, session);
    return session;
  }) as unknown as SessionManager['ensure'];

  const results = await manager.restorePersistentVoiceSessions();
  const restored = manager.get('777777');
  const restoreResult = firstItem(results);
  const persistedPatch = firstItem(patches);
  assert.equal(results.length, 1);
  assert.equal(restoreResult.guildId, '777777');
  assert.equal(restoreResult.voiceChannelId, '888888');
  assert.equal(restoreResult.textChannelId, '999999');
  assert.equal(restoreResult.restored, true);
  assert.equal(restored?.connection?.connected, true);
  assert.equal(restored?.connection?.channelId, '888888');
  assert.equal(restored?.textChannelId, '999999');
  assert.equal(patches.length, 1);
  assert.equal(persistedPatch.patch.persistentVoiceChannelId, '888888');
  assert.equal(persistedPatch.patch.persistentTextChannelId, '999999');
});

test('voice profile 24/7 override is applied per voice channel session', async () => {
  const manager = createManager({
    guildConfigs: {
      async get(guildId: string) {
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
      async getVoiceProfile(guildId: string, channelId: string) {
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

test('guild stay-in-voice setting remains the fallback when no voice profile override exists', async () => {
  const manager = createManager({
    guildConfigs: {
      async get(guildId: string) {
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
      async getVoiceProfile() {
        return null;
      },
    },
  });

  const session = await manager.ensure('292929', null, {
    voiceChannelId: '393939',
    textChannelId: '494949',
  });
  assert.equal(session.settings.stayInVoiceEnabled, true);
});

test('persistent restore does not depend on guild-wide 24/7 flag anymore', async () => {
  const patches: Array<{ guildId: string; patch: Record<string, unknown> }> = [];
  const manager = createManager({
    guildConfigs: {
      async get(guildId: string) {
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
      async patchGuildFeatureConfig(guildId: string, patch: Record<string, unknown>) {
        patches.push({ guildId, patch });
        return { guildId, ...patch };
      },
    },
  });

  manager.ensure = (async (guildId: string) => {
    const session = createSession({
      guildId,
      voiceChannelId: null,
      textChannelId: null,
      stayInVoiceEnabled: true,
    });
    session.sessionId = `${guildId}:404040`;
    manager.sessions.set(session.sessionId!, session as unknown as Parameters<typeof manager.sessions.set>[1]);
    return session;
  }) as unknown as SessionManager['ensure'];

  const results = await manager.restorePersistentVoiceSessions();
  const restored = manager.get('202020', { voiceChannelId: '404040' });
  const restoredResult = firstItem(results);
  assert.equal(results.length, 1);
  assert.equal(restoredResult.restored, true);
  assert.equal(restored?.connection?.connected, true);
  assert.equal(restored?.connection?.channelId, '404040');
  assert.equal(patches.length, 1);
});

test('persistent restore retries transient voice server update timeout before failing', async () => {
  const calls: string[] = [];
  const manager = createManager({
    library: {
      async listPersistentVoiceConnections() {
        return [{
          guildId: '303030',
          voiceChannelId: '505050',
          textChannelId: '707070',
          updatedAt: new Date(),
        }];
      },
      async patchGuildFeatureConfig() {
        calls.push('sync');
        return {};
      },
    },
  });

  manager.ensure = (async (guildId: string) => {
    const session = createSession({
      guildId,
      voiceChannelId: null,
      textChannelId: null,
      stayInVoiceEnabled: true,
    });
    let connectAttempts = 0;
    session.connection.connect = async function connect(channelId: string) {
      connectAttempts += 1;
      calls.push(`connect:${connectAttempts}`);
      if (connectAttempts === 1) {
        throw new Error('Timeout waiting for VOICE_SERVER_UPDATE.');
      }
      this.connected = true;
      this.channelId = channelId;
    };
    session.connection.disconnect = async function disconnect() {
      calls.push('disconnect');
      this.connected = false;
      this.channelId = null;
    };
    session.sessionId = `${guildId}:505050`;
    manager.sessions.set(session.sessionId!, session as unknown as Parameters<typeof manager.sessions.set>[1]);
    return session;
  }) as unknown as SessionManager['ensure'];
  manager.restoreSessionSnapshot = async () => {
    calls.push('restore');
    return true;
  };

  const results = await manager.restorePersistentVoiceSessions();
  assert.deepEqual(calls, [
    'connect:1',
    'disconnect',
    'connect:2',
    'restore',
    'sync',
  ]);
  assert.equal(results.length, 1);
  assert.equal(results[0]!.restored, true);
  assert.equal(results[0]!.reason, 'connected');
});

test('missing persistent voice channel is cleared before restore attempt', async () => {
  const patches: Array<{ guildId: string; patch: Record<string, unknown> }> = [];
  const deletedSnapshots: Array<{ guildId: string; voiceChannelId: string }> = [];
  const manager = createManager({
    rest: {
      async getChannel() {
        const error = Object.assign(new Error('Unknown channel'), { status: 404 });
        throw error;
      },
    },
    guildConfigs: {
      async get(guildId: string) {
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
      async getGuildFeatureConfig(guildId: string) {
        return {
          guildId,
          persistentVoiceConnections: [{
            voiceChannelId: '888888',
            textChannelId: '999999',
          }],
        };
      },
      async patchGuildFeatureConfig(guildId: string, patch: Record<string, unknown>) {
        patches.push({ guildId, patch });
        return { guildId, ...patch };
      },
      async deleteSessionSnapshot(guildId: string, voiceChannelId: string) {
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
  const clearPatch = firstItem(patches);
  assert.equal(ensureCalled, false);
  assert.deepEqual(results, [{
    guildId: '777777',
    voiceChannelId: '888888',
    textChannelId: '999999',
    restored: false,
    reason: 'voice_channel_missing',
  }]);
  assert.equal(patches.length, 1);
  assert.deepEqual(clearPatch, {
    guildId: '777777',
    patch: {
      persistentVoiceConnections: [],
      restartRecoveryConnections: [],
      persistentVoiceChannelId: null,
      persistentTextChannelId: null,
      persistentVoiceUpdatedAt: clearPatch.patch.persistentVoiceUpdatedAt,
    },
  });
  assert.equal(clearPatch.patch.persistentVoiceUpdatedAt instanceof Date, true);
  assert.deepEqual(deletedSnapshots, [{
    guildId: '777777',
    voiceChannelId: '888888',
  }]);
});

test('enabling voice-channel 24/7 on an already connected session persists the voice binding', async () => {
  const patches: Array<{ guildId: string; patch: Record<string, unknown> }> = [];
  const manager = createManager({
    library: {
      async getVoiceProfile(guildId: string, channelId: string) {
        if (guildId === '121212' && channelId === '343434') {
          return { channelId, stayInVoiceEnabled: true };
        }
        return null;
      },
      async patchGuildFeatureConfig(guildId: string, patch: Record<string, unknown>) {
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
  const refreshedPatch = firstItem(patches);
  assert.equal(patches.length, 1);
  assert.equal(refreshedPatch.guildId, '121212');
  assert.equal(refreshedPatch.patch.persistentVoiceChannelId, '343434');
  assert.equal(refreshedPatch.patch.persistentTextChannelId, '565656');
});

test('session snapshot persistence stores current track, queue and seek position', async () => {
  type PersistedSnapshot = {
    state: { progressSec: number; loopMode: string };
    currentTrack: { seekStartSec: number };
    pendingTracks: unknown[];
  };
  const snapshots: Array<{ guildId: string; voiceChannelId: string; snapshot: PersistedSnapshot }> = [];
  const manager = createManager({
    library: {
      async upsertSessionSnapshot(guildId: string, voiceChannelId: string, snapshot: PersistedSnapshot) {
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
  const snapshotCall = firstItem(snapshots);
  assert.equal(persisted, true);
  assert.equal(snapshots.length, 1);
  assert.equal(snapshotCall.guildId, '131313');
  assert.equal(snapshotCall.voiceChannelId, '353535');
  assert.equal(snapshotCall.snapshot.state.progressSec, 42);
  assert.equal(snapshotCall.snapshot.state.loopMode, 'queue');
  assert.equal(snapshotCall.snapshot.currentTrack.seekStartSec, 42);
  assert.equal(snapshotCall.snapshot.pendingTracks.length, 1);
});

test('snapshot flush loop persists updated playback progress for active sessions even without new dirty events', async () => {
  type ProgressSnapshot = {
    state: { progressSec: number };
    currentTrack: { seekStartSec: number } | null;
  };
  const snapshots: Array<{ guildId: string; voiceChannelId: string; snapshot: ProgressSnapshot }> = [];
  const library = {
    async upsertSessionSnapshot(guildId: string, voiceChannelId: string, snapshot: ProgressSnapshot) {
      snapshots.push({ guildId, voiceChannelId, snapshot });
    },
  };

  let progressSec = 12;
  const manager = createManager({
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
      sessionSnapshotMinWriteIntervalMs: 1_000,
    },
    library,
  });

  const session = await manager.ensure('919191', null, { voiceChannelId: '232323' });
  session.settings.stayInVoiceEnabled = false;
  session.player.playing = true;
  assert.ok(session.player.queue);
  session.player.queue.current = {
    title: 'Keep Progress',
    url: 'https://example.com/progress',
    duration: '3:00',
    source: 'youtube',
    seekStartSec: 0,
  };
  session.player.canSeekCurrentTrack = () => true;
  session.player.getProgressSeconds = () => progressSec;

  session.snapshot!.dirty = false;
  await manager.flushDirtySnapshots();
  progressSec = 28;
  session.snapshot!.lastPersistAt = Date.now() - 2_000;
  await manager.flushDirtySnapshots();

  assert.equal(snapshots.length, 2);
  assert.equal(snapshots[0]!.snapshot.state.progressSec, 12);
  assert.equal(snapshots[0]!.snapshot.currentTrack?.seekStartSec, 12);
  assert.equal(snapshots[1]!.snapshot.state.progressSec, 28);
  assert.equal(snapshots[1]!.snapshot.currentTrack?.seekStartSec, 28);
});

test('session snapshot persistence also stores active non-24/7 sessions for restart recovery', async () => {
  type PersistedRecoverySnapshot = {
    currentTrack: { title: string; seekStartSec: number };
  };
  const snapshots: Array<{ guildId: string; voiceChannelId: string; snapshot: PersistedRecoverySnapshot }> = [];
  const manager = createManager({
    library: {
      async upsertSessionSnapshot(guildId: string, voiceChannelId: string, snapshot: PersistedRecoverySnapshot) {
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
  const recoverySnapshot = firstItem(snapshots);
  assert.equal(persisted, true);
  assert.equal(snapshots.length, 1);
  assert.equal(recoverySnapshot.guildId, '232323');
  assert.equal(recoverySnapshot.voiceChannelId, '454545');
  assert.equal(recoverySnapshot.snapshot.currentTrack.title, 'Recover Me');
  assert.equal(recoverySnapshot.snapshot.currentTrack.seekStartSec, 12);
});

test('session snapshot restore reapplies queue, loop, volume and paused state', async () => {
  const calls: unknown[][] = [];
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
  const calls: unknown[][] = [];
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
    async previewTracks(query: string, options: { requestedBy?: string | null }) {
      calls.push(['preview', query, options.requestedBy]);
      return [{
        title: 'Resolved Mirror',
        url: 'https://www.youtube.com/watch?v=resolved123',
        duration: '3:00',
        source: 'youtube',
        requestedBy: options.requestedBy ?? null,
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

test('session snapshot restore re-resolves radio streams before playback', async () => {
  const calls: unknown[][] = [];
  const manager = createManager({
    library: {
      async getSessionSnapshot() {
        return {
          state: {
            playing: true,
            paused: false,
            loopMode: 'off',
            volumePercent: 100,
            progressSec: 0,
          },
          currentTrack: {
            title: 'BBC Radio 1Xtra',
            url: 'http://as-hls-ww-live.akamaized.net/pool_92079267/live/ww/bbc_1xtra/bbc_1xtra.isml/bbc_1xtra-audio%3d96000.norewind.m3u8',
            duration: 'Live',
            source: 'radio-stream',
            requestedBy: 'user-1',
            isLive: true,
          },
          pendingTracks: [],
        };
      },
    },
  });

  const session = createSession({
    guildId: '161616',
    voiceChannelId: '383838',
    textChannelId: '606060',
    stayInVoiceEnabled: true,
  });
  session.player = {
    setVolumePercent(value) {
      calls.push(['volume', value]);
    },
    setLoopMode(value) {
      calls.push(['loop', value]);
    },
    async previewTracks(query: string, options: { requestedBy?: string | null }) {
      calls.push(['preview', query, options.requestedBy]);
      return [{
        title: 'BBC Radio 1Xtra',
        url: 'https://stream.live.vinto.test/bbc1xtra.m3u8',
        duration: 'Live',
        source: 'radio-stream',
        requestedBy: options.requestedBy ?? null,
        isLive: true,
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
    ['preview', 'http://as-hls-ww-live.akamaized.net/pool_92079267/live/ww/bbc_1xtra/bbc_1xtra.isml/bbc_1xtra-audio%3d96000.norewind.m3u8', 'user-1'],
    ['create', 'BBC Radio 1Xtra', 'https://stream.live.vinto.test/bbc1xtra.m3u8', 0],
    ['clear'],
    ['enqueue', ['BBC Radio 1Xtra']],
    ['play'],
  ]);
});

test('session snapshot restore re-resolves YouTube tracks when NodeLink is enabled', async () => {
  const calls: unknown[][] = [];
  const manager = createManager({
    library: {
      async getSessionSnapshot() {
        return {
          state: {
            playing: true,
            paused: false,
            loopMode: 'off',
            volumePercent: 100,
            progressSec: 12,
          },
          currentTrack: {
            title: 'Stored YouTube Track',
            url: 'https://www.youtube.com/watch?v=restore12345',
            duration: '3:00',
            source: 'youtube',
            requestedBy: 'user-1',
          },
          pendingTracks: [],
        };
      },
    },
  });

  const session = createSession({
    guildId: '171717',
    voiceChannelId: '393939',
    textChannelId: '616161',
    stayInVoiceEnabled: true,
  });
  session.player = {
    nodeLinkEnabled: true,
    nodeLinkClient: { enabled: true },
    setVolumePercent(value) {
      calls.push(['volume', value]);
    },
    setLoopMode(value) {
      calls.push(['loop', value]);
    },
    async previewTracks(query: string, options: { requestedBy?: string | null }) {
      calls.push(['preview', query, options.requestedBy]);
      return [{
        title: 'NodeLink Restored Track',
        url: 'https://www.youtube.com/watch?v=restore12345',
        duration: '3:00',
        source: 'youtube',
        requestedBy: options.requestedBy ?? null,
        nodelinkEncodedTrack: 'encoded-restore-track',
        nodelinkInfo: { sourceName: 'youtube' },
      }];
    },
    createTrackFromData(track) {
      calls.push(['create', track.title, track.nodelinkEncodedTrack ?? null, track.seekStartSec ?? 0]);
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
    ['preview', 'https://www.youtube.com/watch?v=restore12345', 'user-1'],
    ['create', 'NodeLink Restored Track', 'encoded-restore-track', 12],
    ['clear'],
    ['enqueue', ['NodeLink Restored Track']],
    ['play'],
  ]);
});

test('session snapshot restore does not treat spoofed youtube hostnames as YouTube tracks for NodeLink re-resolve', async () => {
  const calls: unknown[][] = [];
  const manager = createManager({
    library: {
      async getSessionSnapshot() {
        return {
          state: {
            playing: true,
            paused: false,
            loopMode: 'off',
            volumePercent: 100,
            progressSec: 12,
          },
          currentTrack: {
            title: 'Spoofed Host Track',
            url: 'https://youtube.com.evil.test/watch?v=restore12345',
            duration: '3:00',
            source: 'youtube',
            requestedBy: 'user-1',
          },
          pendingTracks: [],
        };
      },
    },
  });
  manager._isSnapshotTrackDirectlyPlayable = () => true;

  const session = createSession({
    guildId: '171717',
    voiceChannelId: '393939',
    textChannelId: '616161',
    stayInVoiceEnabled: true,
  });
  session.player = {
    nodeLinkEnabled: true,
    nodeLinkClient: { enabled: true },
    setVolumePercent(value) {
      calls.push(['volume', value]);
    },
    setLoopMode(value) {
      calls.push(['loop', value]);
    },
    async previewTracks(query: string, options: { requestedBy?: string | null }) {
      calls.push(['preview', query, options.requestedBy]);
      return [];
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
    // A spoofed hostname must not force a NodeLink re-resolve attempt.
    ['create', 'Spoofed Host Track', 'https://youtube.com.evil.test/watch?v=restore12345', 12],
    ['clear'],
    ['enqueue', ['Spoofed Host Track']],
    ['play'],
  ]);
});

test('session snapshot restore clears persisted Deezer full stream URLs so tracks are rehydrated from track id', async () => {
  const calls: unknown[][] = [];
  const manager = createManager({
    library: {
      async getSessionSnapshot() {
        return {
          state: {
            playing: true,
            paused: false,
            loopMode: 'off',
            volumePercent: 100,
            progressSec: 118,
          },
          currentTrack: {
            title: 'Fata Morgana',
            url: 'https://www.deezer.com/track/3082289301',
            duration: '3:21',
            source: 'deezer-direct',
            requestedBy: 'user-1',
            deezerTrackId: '3082289301',
            deezerFullStreamUrl: 'https://media.deezer.invalid/stale-link',
            seekStartSec: 118,
          },
          pendingTracks: [],
        };
      },
    },
  });

  const session = createSession({
    guildId: '171717',
    voiceChannelId: '393939',
    textChannelId: '616161',
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
      calls.push(['create', track.deezerTrackId, track.deezerFullStreamUrl, track.seekStartSec ?? 0]);
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
    ['create', '3082289301', null, 118],
    ['clear'],
    ['enqueue', ['Fata Morgana']],
    ['play'],
  ]);
});

test('session snapshot restore aborts restored queue on startup playback failure without surfacing restore spam', async () => {
  const calls: unknown[][] = [];
  const manager = createManager({
    library: {
      async getSessionSnapshot() {
        return {
          state: {
            playing: true,
            paused: false,
            loopMode: 'off',
            volumePercent: 100,
            progressSec: 0,
          },
          currentTrack: {
            title: 'Broken Restore Track',
            url: 'https://example.com/broken',
            duration: '3:00',
            source: 'youtube',
            requestedBy: 'user-1',
          },
          pendingTracks: [{
            title: 'Should Not Retry',
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
    guildId: '161616',
    voiceChannelId: '383838',
    textChannelId: '606060',
    stayInVoiceEnabled: true,
  });
  const trackErrorListeners = new Set<({ error }: { error?: unknown }) => void>();
  session.player = {
    setVolumePercent(value) {
      calls.push(['volume', value]);
    },
    setLoopMode(value) {
      calls.push(['loop', value]);
    },
    createTrackFromData(track) {
      calls.push(['create', track.title]);
      return { ...track };
    },
    clearQueue() {
      calls.push(['clear']);
    },
    enqueueResolvedTracks(tracks) {
      calls.push(['enqueue', tracks.map((track) => track.title)]);
      return tracks;
    },
    on(event: string, listener: ({ error }: { error?: unknown }) => void) {
      if (event === 'trackError') {
        trackErrorListeners.add(listener);
      }
    },
    off(event: string, listener: ({ error }: { error?: unknown }) => void) {
      if (event === 'trackError') {
        trackErrorListeners.delete(listener);
      }
    },
    async play() {
      calls.push(['play']);
      for (const listener of trackErrorListeners) {
        listener({ error: new Error('Playback pipeline exited before audio output (code=1).') });
      }
    },
  };

  const restored = await manager.restoreSessionSnapshot(session);
  assert.equal(restored, false);
  assert.equal(trackErrorListeners.size, 0);
  assert.equal(session.restoreState ?? null, null);
  assert.deepEqual(calls, [
    ['volume', 100],
    ['loop', 'off'],
    ['create', 'Broken Restore Track'],
    ['create', 'Should Not Retry'],
    ['clear'],
    ['enqueue', ['Broken Restore Track', 'Should Not Retry']],
    ['play'],
    ['clear'],
  ]);
});

test('restore syncs persistent state only after snapshot restore attempt', async () => {
  const calls: string[] = [];
  const manager = createManager({
    guildConfigs: {
      async get(guildId: string) {
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

  manager.ensure = (async (guildId: string) => {
    const session = createSession({
      guildId,
      voiceChannelId: null,
      textChannelId: null,
      stayInVoiceEnabled: false,
    });
    session.sessionId = `${guildId}:818181`;
    manager.sessions.set(session.sessionId!, session as unknown as Parameters<typeof manager.sessions.set>[1]);
    return session;
  }) as unknown as SessionManager['ensure'];
  manager.restoreSessionSnapshot = async () => {
    calls.push('restore');
    return true;
  };

  await manager.restorePersistentVoiceSessions();
  assert.deepEqual(calls, ['restore', 'sync']);
});






