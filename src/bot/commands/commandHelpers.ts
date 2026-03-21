export {
  FAVORITES_PAGE_SIZE,
  HISTORY_PAGE_SIZE,
  PENDING_PAGE_SIZE,
  PLAYLIST_PAGE_SIZE,
  SEARCH_RESULT_DEFAULT_LIMIT,
  SUPPORT_SERVER_URL,
} from './helpers/constants.ts';

export {
  buildHelpPages,
  buildProgressBar,
  createCommand,
  formatHistoryPage,
  formatQueuePage,
  formatSeconds,
  formatUptimeCompact,
  normalizeIndex,
  parseDurationToSeconds,
  parseOnOff,
  parseRequiredInteger,
  parseVoiceChannelArgument,
  trackLabel,
} from './helpers/formatting.ts';

export { fetchGlobalGuildAndUserCounts } from './helpers/guildStats.ts';

export {
  applyVoiceProfileIfConfigured,
  computeVoteSkipRequirement,
  ensureConnectedSession,
  ensureGuild,
  ensureSessionTrack,
  getGuildConfigOrThrow,
  getSessionOrThrow,
  isUserInPlaybackChannel,
  requireLibrary,
  resolveActiveVoiceChannelOrThrow,
  resolveQueueGuard,
  updateGuildConfig,
} from './helpers/context.ts';

export {
  enforcePlayCooldown,
  ensureDjAccess,
  ensureDjAccessByConfig,
  ensureManageGuildAccess,
  parseRoleId,
  parseTextChannelId,
  userHasDjAccess,
  userHasDjAccessByConfig,
} from './helpers/access.ts';

export {
  clearSearchSelection,
  consumeSearchSelection,
  saveSearchSelection,
} from './helpers/searchSelections.ts';


