export type ChannelOption = {
  id: string;
  name: string;
  active: boolean;
  listenerCount: number;
};

export function channelLabel(channel: ChannelOption): string {
  const listeners = String(channel.listenerCount);
  if (channel.active) return `${channel.name} · ${listeners} · on`;
  return `${channel.name} · ${listeners}`;
}
