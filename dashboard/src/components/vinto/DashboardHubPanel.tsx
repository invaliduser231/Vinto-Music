'use client';

import { ArrowClockwise, Play, Plus, Trash } from '@phosphor-icons/react';
import { useState } from 'react';
import type { DashboardHubData, HubTrack } from '@/types/dashboard-hub';
import { RequesterBadge } from '@/components/vinto/RequesterBadge';
import { EmptyState, SkeletonStack } from '@/components/vinto/Placeholders';

function trackQuery(track: HubTrack): string {
  return String(track.url ?? '').trim() || `${track.title ?? ''} ${track.artist ?? ''}`.trim();
}

function countLabel(count: number, singular: string): string {
  return `${count} ${count === 1 ? singular : `${singular}s`}`;
}

export function DashboardHubPanel({
  view,
  data,
  loading,
  error,
  canControl,
  hasCurrentTrack,
  onReload,
  onPlay,
  onLibraryPlay,
  onSaveTemplate,
  onPlaylistCreate,
  onPlaylistDelete,
  onPlaylistAddCurrent,
  onTemplateDelete,
  onStationCreate,
  onStationDelete,
}: {
  view: 'library' | 'insights';
  data: DashboardHubData | null;
  loading: boolean;
  error: string | null;
  canControl: boolean;
  hasCurrentTrack: boolean;
  onReload: () => void;
  onPlay: (query: string, playNext: boolean) => void;
  onLibraryPlay: (kind: 'playlist' | 'template' | 'favorite' | 'station', key: string) => void;
  onSaveTemplate: (name: string) => void;
  onPlaylistCreate: (name: string) => void;
  onPlaylistDelete: (name: string) => void;
  onPlaylistAddCurrent: (name: string) => void;
  onTemplateDelete: (key: string) => void;
  onStationCreate: (name: string, url: string) => void;
  onStationDelete: (key: string) => void;
}) {
  const [templateName, setTemplateName] = useState('');
  const [playlistName, setPlaylistName] = useState('');
  const [stationName, setStationName] = useState('');
  const [stationUrl, setStationUrl] = useState('');
  if (loading && !data) return <div className="vinto-panel-stack"><SkeletonStack rows={5} /></div>;
  if (error && !data) {
    return <div className="vinto-empty-msg">{error}<button type="button" className="vinto-btn vinto-btn-ghost" onClick={onReload}><ArrowClockwise />Retry</button></div>;
  }
  if (!data) return null;

  if (view === 'insights') {
    return (
      <div className="vinto-panel-stack">
        <h2>Last {data.recap.days} days</h2>
        <div className="vinto-stat-grid">
          <div className="vinto-stat-card"><strong>{data.recap.playCount}</strong><span>plays</span></div>
          <div className="vinto-stat-card"><strong>{data.recap.topTracks.length}</strong><span>distinct tracks</span></div>
          <div className="vinto-stat-card"><strong>{data.recap.topRequesters.length}</strong><span>requesters</span></div>
        </div>
        <h3>Top tracks</h3>
        {data.recap.topTracks.length === 0 ? (
          <EmptyState title="Nothing played yet" hint="Play a few tracks and the weekly recap fills up here." />
        ) : data.recap.topTracks.map((track, index) => (
          <div className="vinto-library-row" key={`${track.url ?? track.title}-${index}`}>
            <span className="vinto-rank">{index + 1}</span>
            <div><strong>{track.title ?? 'Unknown title'}</strong><small>{countLabel(track.plays, 'play')}</small></div>
            <button type="button" aria-label={`Play ${track.title ?? 'track'}`} disabled={!canControl} onClick={() => onPlay(trackQuery(track), false)}><Play /></button>
          </div>
        ))}
        {data.recap.topRequesters.length > 0 ? <h3>Top requesters</h3> : null}
        {data.recap.topRequesters.map((requester, index) => (
          <div className="vinto-library-row" key={`${requester.userId}-${index}`}>
            <span className="vinto-rank">{index + 1}</span>
            <div className="vinto-requester-row">
              <RequesterBadge
                userId={requester.userId}
                name={requester.name ?? null}
                avatarUrl={requester.avatarUrl ?? null}
              />
              <small>{countLabel(requester.plays, 'play')}</small>
            </div>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="vinto-panel-stack">
      <h2>Library</h2>

      <h3>Guild playlists</h3>
      {canControl ? (
        <form className="vinto-inline-form" onSubmit={(event) => {
          event.preventDefault();
          const name = playlistName.trim();
          if (!name) return;
          onPlaylistCreate(name);
          setPlaylistName('');
        }}>
          <input value={playlistName} onChange={(event) => setPlaylistName(event.target.value)} placeholder="New playlist" aria-label="New playlist name" maxLength={80} />
          <button type="submit" disabled={!playlistName.trim()}>Create</button>
        </form>
      ) : null}
      {data.playlists.items.length === 0 ? (
        <EmptyState title="No playlists" hint="Create one above, then add the current track with the plus button." />
      ) : data.playlists.items.map((playlist) => (
        <div className="vinto-library-row" key={playlist.name}>
          <div><strong>{playlist.name}</strong><small>{countLabel(playlist.trackCount ?? 0, 'track')}</small></div>
          <div className="vinto-inline-actions">
            <button
              type="button"
              aria-label={`Play playlist ${playlist.name}`}
              disabled={!canControl || !playlist.trackCount}
              onClick={() => onLibraryPlay('playlist', playlist.name)}
            >
              <Play size={15} />
            </button>
            <button
              type="button"
              aria-label={`Add current track to ${playlist.name}`}
              disabled={!canControl || !hasCurrentTrack}
              title="Add current track"
              onClick={() => onPlaylistAddCurrent(playlist.name)}
            >
              <Plus size={15} />
            </button>
            <button
              type="button"
              aria-label={`Delete playlist ${playlist.name}`}
              disabled={!canControl}
              onClick={() => onPlaylistDelete(playlist.name)}
            >
              <Trash size={15} />
            </button>
          </div>
        </div>
      ))}

      <h3>Queue templates</h3>
      {canControl ? (
        <form className="vinto-inline-form" onSubmit={(event) => {
          event.preventDefault();
          const name = templateName.trim();
          if (!name) return;
          onSaveTemplate(name);
          setTemplateName('');
        }}>
          <input value={templateName} onChange={(event) => setTemplateName(event.target.value)} placeholder="Save current queue as" aria-label="Queue template name" maxLength={80} />
          <button type="submit" disabled={!templateName.trim()}>Save</button>
        </form>
      ) : null}
      {data.templates.length === 0 ? (
        <EmptyState title="No templates" hint="Save the current queue to replay the whole set later." />
      ) : data.templates.map((template) => (
        <div className="vinto-library-row" key={template.key}>
          <div><strong>{template.name}</strong><small>{countLabel(template.tracks.length, 'track')}</small></div>
          <div className="vinto-inline-actions">
            <button
              type="button"
              aria-label={`Play template ${template.name}`}
              disabled={!canControl}
              onClick={() => onLibraryPlay('template', template.key)}
            >
              <Play size={15} />
            </button>
            <button
              type="button"
              aria-label={`Delete template ${template.name}`}
              disabled={!canControl}
              onClick={() => onTemplateDelete(template.key)}
            >
              <Trash size={15} />
            </button>
          </div>
        </div>
      ))}

      <h3>Radio stations</h3>
      {canControl ? (
        <form className="vinto-inline-form vinto-station-form" onSubmit={(event) => {
          event.preventDefault();
          const name = stationName.trim();
          const url = stationUrl.trim();
          if (!name || !/^https?:\/\//i.test(url)) return;
          onStationCreate(name, url);
          setStationName('');
          setStationUrl('');
        }}>
          <input value={stationName} onChange={(event) => setStationName(event.target.value)} placeholder="Station name" aria-label="Station name" maxLength={80} />
          <input value={stationUrl} onChange={(event) => setStationUrl(event.target.value)} placeholder="Stream URL" aria-label="Station stream URL" type="url" inputMode="url" />
          <button type="submit" disabled={!stationName.trim() || !/^https?:\/\//i.test(stationUrl.trim())}>Add</button>
        </form>
      ) : null}
      {data.stations.length === 0 ? (
        <EmptyState title="No stations" hint="Add a stream URL above to keep a station one click away." />
      ) : data.stations.map((station) => (
        <div className="vinto-library-row" key={station.key}>
          <div>
            <strong>{station.name}</strong>
            <small>{station.description || station.tags?.join(' · ') || 'Radio stream'}</small>
          </div>
          <div className="vinto-inline-actions">
            <button
              type="button"
              aria-label={`Play station ${station.name}`}
              disabled={!canControl}
              onClick={() => onLibraryPlay('station', station.key)}
            >
              <Play size={15} />
            </button>
            <button
              type="button"
              aria-label={`Delete station ${station.name}`}
              disabled={!canControl}
              onClick={() => onStationDelete(station.key)}
            >
              <Trash size={15} />
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
