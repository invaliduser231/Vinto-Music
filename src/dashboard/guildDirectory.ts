export type DashboardDirectoryOption = {
  id: string;
  name: string;
};

export type DashboardGuildDirectory = {
  roles: DashboardDirectoryOption[];
  textChannels: DashboardDirectoryOption[];
  voiceChannels: DashboardDirectoryOption[];
  members: DashboardDirectoryOption[];
};

function records(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === 'object'))
    : [];
}

function byName(left: DashboardDirectoryOption, right: DashboardDirectoryOption): number {
  return left.name.localeCompare(right.name, undefined, { sensitivity: 'base' });
}

export function buildGuildDirectory(
  rolesValue: unknown,
  channelsValue: unknown,
  membersValue: unknown,
): DashboardGuildDirectory {
  const roles = records(rolesValue).map((role) => ({
    id: String(role.id ?? '').trim(),
    name: String(role.name ?? '').trim(),
  })).filter((role) => role.id && role.name).sort(byName);

  const channels = records(channelsValue).map((channel) => ({
    id: String(channel.id ?? '').trim(),
    name: String(channel.name ?? '').trim(),
    type: Number(channel.type),
  })).filter((channel) => channel.id && channel.name);

  const members = records(membersValue).map((member) => {
    const user = member.user && typeof member.user === 'object'
      ? member.user as Record<string, unknown>
      : {};
    const id = String(user.id ?? member.user_id ?? '').trim();
    const name = String(member.nick ?? user.global_name ?? user.display_name ?? user.username ?? id).trim();
    return { id, name, bot: user.bot === true };
  }).filter((member) => member.id && member.name && !member.bot)
    .map(({ id, name }) => ({ id, name }))
    .sort(byName);

  return {
    roles,
    textChannels: channels.filter((channel) => channel.type === 0 || channel.type === 5)
      .map(({ id, name }) => ({ id, name })).sort(byName),
    voiceChannels: channels.filter((channel) => channel.type === 2 || channel.type === 13)
      .map(({ id, name }) => ({ id, name })).sort(byName),
    members,
  };
}
