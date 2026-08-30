'use client';

import { Plus } from '@phosphor-icons/react';
import { GuildSidebarIcon } from '@/components/vinto/GuildSidebarIcon';
import type { OAuthGuild } from '@/lib/fluxer-oauth';

export function GuildSidebar({
  guilds,
  activeGuildId,
  onSelectGuild,
}: {
  guilds: OAuthGuild[];
  activeGuildId: string;
  onSelectGuild: (guildId: string) => void;
}) {
  return (
    <nav className="vinto-guild-sidebar" aria-label="Servers">
      {guilds.map((guild) => (
        <button
          type="button"
          key={guild.id}
          className={`vinto-guild-item${guild.id === activeGuildId ? ' active' : ''}`}
          title={guild.name}
          aria-label={guild.name}
          aria-current={guild.id === activeGuildId ? 'page' : undefined}
          onClick={() => onSelectGuild(guild.id)}
        >
          <div className="vinto-guild-indicator" />
          <GuildSidebarIcon guild={guild} />
        </button>
      ))}
      <div className="vinto-guild-separator" />
      <a
        href="https://invite.vinto.music"
        target="_blank"
        rel="noopener noreferrer"
        className="vinto-guild-item"
        title="Invite Vinto"
      >
        <div
          className="vinto-guild-icon"
          style={{
            background: 'transparent',
            border: '1px dashed var(--text-muted)',
            color: 'var(--text-muted)',
          }}
        >
          <Plus size={20} />
        </div>
      </a>
    </nav>
  );
}
