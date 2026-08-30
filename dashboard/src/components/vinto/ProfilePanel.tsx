'use client';

import { useState } from 'react';
import {
  Check,
  Heart,
  LinkSimple,
  PencilSimple,
  Play,
  Plus,
  SignOut,
  Trash,
  X,
} from '@phosphor-icons/react';
import type { DashboardHubData, HubTrack } from '@/types/dashboard-hub';
import type { AuthUser } from '@/hooks/useAuthSession';
import { UserProfileAvatar } from '@/components/vinto/UserProfileAvatar';
import { EmptyState, SkeletonStack } from '@/components/vinto/Placeholders';

function trackQuery(track: HubTrack): string {
  return String(track.url ?? '').trim() || `${track.title ?? ''} ${track.artist ?? ''}`.trim();
}

export function ProfilePanel({
  user,
  data,
  loading,
  canControl,
  hasCurrentTrack,
  onPlay,
  onLibraryPlay,
  onFavoriteRename,
  onFavoriteRemove,
  lastFmAuthUrl,
  onLastFm,
  onSignOut,
}: {
  user: AuthUser | null;
  data: DashboardHubData | null;
  loading: boolean;
  canControl: boolean;
  hasCurrentTrack: boolean;
  onPlay: (query: string, playNext: boolean) => void;
  onLibraryPlay: (kind: 'playlist' | 'template' | 'favorite' | 'station', key: string) => void;
  onFavoriteRename: (index: number, alias: string) => void;
  onFavoriteRemove: (index: number) => void;
  lastFmAuthUrl: string | null;
  onLastFm: (
    operation: 'connect' | 'complete' | 'disconnect' | 'toggle' | 'love' | 'unlove',
    enabled?: boolean,
  ) => void;
  onSignOut: (() => void) | null;
}) {
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [aliasDraft, setAliasDraft] = useState('');

  if (loading && !data) return <div className="vinto-panel-stack"><SkeletonStack rows={5} /></div>;

  const favorites = data?.favorites.items ?? [];
  const taste = data?.profile.taste ?? [];

  const commitAlias = (index: number) => {
    const alias = aliasDraft.trim();
    if (alias) onFavoriteRename(index, alias);
    setEditingIndex(null);
    setAliasDraft('');
  };

  return (
    <div className="vinto-panel-stack">
      <div className="vinto-profile-header">
        {user ? <UserProfileAvatar user={user} size={56} /> : null}
        <div>
          <h2>{user?.username ?? 'Profile'}</h2>
          {data ? (
            <div className="vinto-profile-meta">
              <span><strong>{data.profile.guildScore}</strong> reputation</span>
              <span><strong>{data.favorites.total}</strong> favorites</span>
            </div>
          ) : null}
        </div>
        {onSignOut ? (
          <button type="button" className="vinto-btn vinto-btn-ghost" onClick={onSignOut}>
            <SignOut size={16} />
            Sign out
          </button>
        ) : null}
      </div>

      {taste.length > 0 ? (
        <div className="vinto-chip-grid">
          {taste.slice(0, 12).map((entry, index) => (
            <span className="vinto-feature-chip static" key={`${entry.term ?? entry.name}-${index}`}>
              {entry.term ?? entry.name ?? 'Music'}
            </span>
          ))}
        </div>
      ) : null}

      <LastFmSection
        lastfm={data?.lastfm ?? null}
        authUrl={lastFmAuthUrl}
        canControl={canControl}
        hasCurrentTrack={hasCurrentTrack}
        onPlay={onPlay}
        onAction={onLastFm}
      />

      <h3>Favorites</h3>
      {favorites.length === 0 ? (
        <EmptyState
          icon={<Heart size={26} />}
          title="No favorites"
          hint="Tap the heart on a track and it lands here, ready to replay."
        />
      ) : favorites.map((track, index) => {
        const position = index + 1;
        const editing = editingIndex === position;
        return (
          <div className="vinto-library-row" key={`${track.url ?? track.title}-${index}`}>
            {editing ? (
              <form
                className="vinto-inline-form vinto-alias-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  commitAlias(position);
                }}
              >
                <input
                  value={aliasDraft}
                  autoFocus
                  maxLength={80}
                  aria-label={`Alias for ${track.title ?? 'favorite'}`}
                  onChange={(event) => setAliasDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape') {
                      setEditingIndex(null);
                      setAliasDraft('');
                    }
                  }}
                />
                <button type="submit" aria-label="Save alias"><Check size={15} /></button>
                <button
                  type="button"
                  aria-label="Cancel rename"
                  onClick={() => {
                    setEditingIndex(null);
                    setAliasDraft('');
                  }}
                >
                  <X size={15} />
                </button>
              </form>
            ) : (
              <div>
                <strong>{track.alias || track.title || 'Unknown title'}</strong>
                <small>{track.alias ? track.title ?? track.artist ?? '' : track.artist ?? 'Unknown artist'}</small>
              </div>
            )}
            {!editing ? (
              <div className="vinto-inline-actions">
                <button
                  type="button"
                  aria-label={`Play ${track.alias || track.title || 'favorite'}`}
                  disabled={!canControl}
                  onClick={() => onLibraryPlay('favorite', String(position))}
                >
                  <Play size={15} />
                </button>
                <button
                  type="button"
                  aria-label={`Queue ${track.alias || track.title || 'favorite'} next`}
                  disabled={!canControl}
                  onClick={() => onPlay(trackQuery(track), true)}
                >
                  <Plus size={15} />
                </button>
                <button
                  type="button"
                  aria-label={`Rename ${track.alias || track.title || 'favorite'}`}
                  onClick={() => {
                    setEditingIndex(position);
                    setAliasDraft(track.alias ?? '');
                  }}
                >
                  <PencilSimple size={15} />
                </button>
                <button
                  type="button"
                  aria-label={`Remove ${track.alias || track.title || 'favorite'}`}
                  onClick={() => onFavoriteRemove(position)}
                >
                  <Trash size={15} />
                </button>
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function LastFmSection({
  lastfm,
  authUrl,
  canControl,
  hasCurrentTrack,
  onPlay,
  onAction,
}: {
  lastfm: DashboardHubData['lastfm'];
  authUrl: string | null;
  canControl: boolean;
  hasCurrentTrack: boolean;
  onPlay: (query: string, playNext: boolean) => void;
  onAction: (
    operation: 'connect' | 'complete' | 'disconnect' | 'toggle' | 'love' | 'unlove',
    enabled?: boolean,
  ) => void;
}) {
  if (!lastfm) return null;

  if (!lastfm.account) {
    return (
      <section className="vinto-community-card" aria-labelledby="lastfm-heading">
        <h3 id="lastfm-heading">Last.fm</h3>
        {authUrl ? (
          <div className="vinto-inline-actions vinto-lastfm-actions">
            <a className="vinto-btn vinto-btn-ghost" href={authUrl} target="_blank" rel="noreferrer">
              <LinkSimple />
              Authorize
            </a>
            <button type="button" className="vinto-btn vinto-btn-primary" onClick={() => onAction('complete')}>
              Finish connection
            </button>
          </div>
        ) : (
          <button type="button" className="vinto-btn vinto-btn-primary" onClick={() => onAction('connect')}>
            Connect Last.fm
          </button>
        )}
      </section>
    );
  }

  const account = lastfm.account;
  return (
    <section className="vinto-community-card" aria-labelledby="lastfm-heading">
      <div className="vinto-section-heading">
        <h3 id="lastfm-heading">Last.fm · {account.username}</h3>
        <button type="button" className="vinto-btn vinto-btn-ghost" onClick={() => onAction('disconnect')}>
          Disconnect
        </button>
      </div>
      <div className="vinto-stat-grid">
        <div className="vinto-stat-card"><strong>{account.scrobbleCount}</strong><span>scrobbles</span></div>
        <div className="vinto-stat-card"><strong>{account.lovedCount}</strong><span>loved</span></div>
        <div className="vinto-stat-card"><strong>{account.streakDays}</strong><span>day streak</span></div>
      </div>
      <label className="vinto-setting-row">
        <span><strong>Scrobbling</strong></span>
        <input
          className="vinto-toggle"
          type="checkbox"
          checked={account.scrobblingEnabled}
          onChange={(event) => onAction('toggle', event.target.checked)}
        />
      </label>
      <div className="vinto-inline-actions vinto-lastfm-actions">
        <button
          type="button"
          className="vinto-btn vinto-btn-ghost"
          disabled={!hasCurrentTrack}
          onClick={() => onAction('love')}
        >
          <Heart />
          Love current
        </button>
        <button
          type="button"
          className="vinto-btn vinto-btn-ghost"
          disabled={!hasCurrentTrack}
          onClick={() => onAction('unlove')}
        >
          Unlove
        </button>
      </div>
      {lastfm.recent.length > 0 ? <h3>Recent scrobbles</h3> : null}
      {lastfm.recent.map((track, index) => (
        <div className="vinto-library-row" key={`${track.artist}-${track.track}-${index}`}>
          <div>
            <strong>{track.track}</strong>
            <small>{track.artist}{track.nowPlaying ? ' · now playing' : ''}</small>
          </div>
          <button
            type="button"
            aria-label={`Play ${track.track}`}
            disabled={!canControl}
            onClick={() => onPlay(track.url || `${track.artist} ${track.track}`, false)}
          >
            <Play />
          </button>
        </div>
      ))}
      {lastfm.topTracks.length > 0 ? <h3>Your week</h3> : null}
      {lastfm.topTracks.map((track, index) => (
        <div className="vinto-library-row" key={`${track.artist}-${track.name}-${index}`}>
          <span className="vinto-rank">{index + 1}</span>
          <div>
            <strong>{track.name}</strong>
            <small>{track.artist ?? 'Unknown artist'} · {track.playcount} {track.playcount === 1 ? 'play' : 'plays'}</small>
          </div>
          <button
            type="button"
            aria-label={`Play ${track.name}`}
            disabled={!canControl}
            onClick={() => onPlay(track.url || `${track.artist ?? ''} ${track.name}`, false)}
          >
            <Play />
          </button>
        </div>
      ))}
    </section>
  );
}
