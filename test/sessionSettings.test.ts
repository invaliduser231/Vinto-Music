import test from 'node:test';
import assert from 'node:assert/strict';

import { settingsFromGuildConfig } from '../src/bot/sessionManager/runtimeHelpers.ts';
import type { GuildConfig } from '../src/types/domain.ts';

const guildConfig: GuildConfig = {
  guildId: 'guild-1',
  prefix: '!',
  settings: { autoplayEnabled: true },
};

test('voice profile autoplay overrides the guild fallback', () => {
  const disabled = settingsFromGuildConfig(
    { lastfmAutoplayDefaultEnabled: false },
    guildConfig,
    { stayInVoiceEnabled: null, autoplayEnabled: false },
  );
  const inherited = settingsFromGuildConfig(
    { lastfmAutoplayDefaultEnabled: false },
    guildConfig,
    { stayInVoiceEnabled: null, autoplayEnabled: null },
  );

  assert.equal(disabled.autoplayEnabled, false);
  assert.equal(inherited.autoplayEnabled, true);
});
