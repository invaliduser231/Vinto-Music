import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildGuildSettingsPayload,
  applyGuildSettingsPatch,
} from '../src/dashboard/guildSettings.ts';
import type { GuildConfig } from '../src/types/domain.ts';

const baseGuildConfig = (): GuildConfig => ({
  guildId: 'guild-1',
  prefix: '!',
  settings: {
    dedupeEnabled: true,
    stayInVoiceEnabled: false,
    earrapeProtectionEnabled: false,
    minimalMode: false,
    autoplayEnabled: false,
    volumePercent: 100,
    voteSkipRatio: 0.5,
    voteSkipMinVotes: 2,
    djRoleIds: ['role-1'],
    musicLogChannelId: null,
    language: 'en',
  },
});

test('buildGuildSettingsPayload merges guild config and feature config', () => {
  const payload = buildGuildSettingsPayload(
    baseGuildConfig(),
    {
      webhookUrl: 'https://example.com/hook',
      recapChannelId: 'chan-1',
      queueGuard: {
        enabled: true,
        maxPerRequesterWindow: 4,
        windowSize: 20,
        maxArtistStreak: 2,
      },
      voiceProfiles: [{
        channelId: 'vc-1',
        stayInVoiceEnabled: true,
        autoplayEnabled: true,
        moodPreset: 'chill',
      }],
    },
    true,
  );

  assert.equal(payload.canManage, true);
  assert.equal(payload.prefix, '!');
  assert.equal(payload.webhookUrl, 'https://example.com/hook');
  assert.equal(payload.queueGuard.maxPerRequesterWindow, 4);
  assert.equal(payload.voiceProfiles[0]?.channelId, 'vc-1');
  assert.equal(payload.voiceProfiles[0]?.autoplayEnabled, true);
  assert.equal(payload.voiceProfiles[0]?.moodPreset, 'chill');
});

test('applyGuildSettingsPatch updates guild config and features', async () => {
  let guildConfig = baseGuildConfig();
  let features = {
    webhookUrl: null,
    recapChannelId: null,
    queueGuard: {
      enabled: false,
      maxPerRequesterWindow: 5,
      windowSize: 25,
      maxArtistStreak: 3,
    },
    voiceProfiles: [],
  };

  const guildConfigs = {
    async get(guildId: string) {
      assert.equal(guildId, 'guild-1');
      return guildConfig;
    },
    async update(guildId: string, patch: { prefix?: string; settings?: Partial<GuildConfig['settings']> }) {
      assert.equal(guildId, 'guild-1');
      guildConfig = {
        ...guildConfig,
        ...(patch.prefix ? { prefix: patch.prefix } : {}),
        settings: {
          ...guildConfig.settings,
          ...(patch.settings ?? {}),
        },
      };
      return guildConfig;
    },
  };

  const library = {
    async getGuildFeatureConfig(guildId: string) {
      assert.equal(guildId, 'guild-1');
      return features;
    },
    async patchGuildFeatureConfig(guildId: string, patch: Record<string, unknown>) {
      assert.equal(guildId, 'guild-1');
      features = { ...features, ...patch } as typeof features;
      return features;
    },
    async setVoiceProfile() {
      return null;
    },
  };

  const result = await applyGuildSettingsPatch(
    'guild-1',
    {
      prefix: '?',
      webhookUrl: 'https://example.com/events',
      queueGuard: { enabled: true },
      voiceProfiles: [{ channelId: 'vc-2', stayInVoiceEnabled: true, autoplayEnabled: false, moodPreset: 'hype' }],
    },
    guildConfigs,
    library,
  );

  assert.equal(result.prefix, '?');
  assert.equal(result.webhookUrl, 'https://example.com/events');
  assert.equal(result.queueGuard.enabled, true);
  assert.equal(result.voiceProfiles[0]?.channelId, 'vc-2');
  assert.equal(result.voiceProfiles[0]?.autoplayEnabled, false);
});
