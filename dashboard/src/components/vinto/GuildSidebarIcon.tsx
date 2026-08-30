'use client';

import { useState } from 'react';
import { buildGuildIconUrl } from '@/lib/fluxer-cdn';
import type { OAuthGuild } from '@/lib/fluxer-oauth';

function guildInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0] ?? ''}${parts[1][0] ?? ''}`.toUpperCase();
}

export function GuildSidebarIcon({ guild }: { guild: OAuthGuild }) {
  const [iconFailed, setIconFailed] = useState(false);
  const iconUrl = buildGuildIconUrl(guild.id, guild.icon, { size: 96 });

  if (iconUrl && !iconFailed) {
    return (
      <img
        src={iconUrl}
        alt=""
        className="vinto-guild-icon"
        onError={() => setIconFailed(true)}
      />
    );
  }

  return (
    <div className="vinto-guild-icon">{guildInitials(guild.name)}</div>
  );
}
