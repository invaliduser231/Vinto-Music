import { registerLibraryCommands } from './libraryCommands.ts';
import { registerConfigCommands } from './configCommands.ts';
import { registerAdvancedCommands } from './advancedCommands.ts';
import {
  PLAYLIST_PAGE_SIZE,
  FAVORITES_PAGE_SIZE,
  createCommand,
  ensureGuild,
  requireLibrary,
  getGuildConfigOrThrow,
  ensureDjAccessByConfig,
  parseRequiredInteger,
  normalizeIndex,
  trackLabel,
  ensureConnectedSession,
  resolveQueueGuard,
  applyVoiceProfileIfConfigured,
  resolveActiveVoiceChannelOrThrow,
  updateGuildConfig,
  parseOnOff,
  parseRoleId,
  parseTextChannelId,
  ensureManageGuildAccess,
  getSessionOrThrow,
  ensureDjAccess,
} from './commandHelpers.ts';
import { registerCorePlaybackCommands } from './corePlaybackCommands.ts';
import { registerQueueEffectsAndMiscCommands } from './queueEffectsMiscCommands.ts';
import type { CommandRegistry } from '../commandRegistry.ts';

export function registerCommands(registry: CommandRegistry) {
  registerCorePlaybackCommands(registry);

  registerLibraryCommands(registry, {
    PLAYLIST_PAGE_SIZE,
    FAVORITES_PAGE_SIZE,
    createCommand,
    ensureGuild,
    requireLibrary,
    getGuildConfigOrThrow,
    ensureDjAccessByConfig,
    parseRequiredInteger,
    normalizeIndex,
    trackLabel,
    ensureConnectedSession,
    resolveQueueGuard,
    applyVoiceProfileIfConfigured,
  });

  registerQueueEffectsAndMiscCommands(registry);

  registerConfigCommands(registry, {
    createCommand,
    ensureGuild,
    getGuildConfigOrThrow,
    updateGuildConfig,
    requireLibrary,
    parseOnOff,
    parseRoleId,
    parseTextChannelId,
    resolveActiveVoiceChannelOrThrow,
    ensureManageGuildAccess,
  });

  registerAdvancedCommands(registry, {
    createCommand,
    ensureGuild,
    getSessionOrThrow,
    ensureConnectedSession,
    ensureManageGuildAccess,
    ensureDjAccess,
    parseRequiredInteger,
    parseTextChannelId,
    requireLibrary,
  });
}


