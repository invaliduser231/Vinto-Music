export function isOAuthGuildAllowed(
  oauthEnabled: boolean,
  guildId: string,
  guilds: Array<{ id: string }>,
): boolean {
  if (!oauthEnabled) return true;
  if (!guildId) return true;
  return guilds.some((guild) => guild.id === guildId);
}

export function shouldShowPlayer(
  mockEnabled: boolean,
  userInChannel: boolean,
  botInChannel: boolean | undefined,
): boolean {
  return mockEnabled || (userInChannel && botInChannel !== false);
}

export function shouldShowControls(mockEnabled: boolean, canControl: boolean): boolean {
  return mockEnabled || canControl;
}

export function shouldShowConnectPanel(mockEnabled: boolean, inVoice: boolean): boolean {
  return !mockEnabled && !inVoice;
}
