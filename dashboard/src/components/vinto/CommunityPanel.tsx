'use client';

import { useState } from 'react';
import type { DashboardSession } from '@/types/session';
import type { DashboardHubData } from '@/types/dashboard-hub';
import { SearchPicker, type SearchPickerOption } from '@/components/vinto/SearchPicker';

export function CommunityPanel({
  session,
  canControl,
  canManage,
  hasTrack,
  onVoteSkip,
  onHandoff,
  onLeave,
  party,
  onParty,
  members,
}: {
  session: DashboardSession;
  canControl: boolean;
  canManage: boolean;
  hasTrack: boolean;
  onVoteSkip: () => void;
  onHandoff: (userId: string | null, minutes?: number) => void;
  onLeave: () => void;
  party: DashboardHubData['party'];
  onParty: (operation: 'start' | 'join' | 'vote' | 'end', team?: 'a' | 'b') => void;
  members: SearchPickerOption[];
}) {
  const [targetUserId, setTargetUserId] = useState('');
  const [minutes, setMinutes] = useState(15);

  return (
    <div className="vinto-panel-stack">
      <h2>Community</h2>
      <div className="vinto-community-card">
        <span>Vote skip</span>
        <strong>{session.voteSkip.votes} / {session.voteSkip.required}</strong>
        <div className="vinto-vote-progress"><span style={{ width: `${Math.min(100, (session.voteSkip.votes / Math.max(1, session.voteSkip.required)) * 100)}%` }} /></div>
        <button type="button" className="vinto-btn vinto-btn-primary" disabled={!hasTrack} onClick={onVoteSkip}>
          Vote to skip
        </button>
      </div>
      <div className="vinto-community-card">
        <span>Party battle</span>
        {party ? (
          <>
            <div className="vinto-party-score" aria-label={`Team A ${party.scores.a}, Team B ${party.scores.b}`}>
              <div><strong>{party.scores.a}</strong><small>Team A · {party.teams.a} members</small></div>
              <span>vs</span>
              <div><strong>{party.scores.b}</strong><small>Team B · {party.teams.b} members</small></div>
            </div>
            <div className="vinto-card-grid">
              <button type="button" className="vinto-library-card" onClick={() => onParty('join', 'a')}><strong>Join A</strong><small>Choose this team</small></button>
              <button type="button" className="vinto-library-card" onClick={() => onParty('join', 'b')}><strong>Join B</strong><small>Choose this team</small></button>
            </div>
            <div className="vinto-inline-actions vinto-lastfm-actions">
              <button type="button" className="vinto-btn vinto-btn-primary" onClick={() => onParty('vote', 'a')}>Vote A</button>
              <button type="button" className="vinto-btn vinto-btn-primary" onClick={() => onParty('vote', 'b')}>Vote B</button>
              {canControl ? <button type="button" className="vinto-btn vinto-btn-ghost" onClick={() => onParty('end')}>End party</button> : null}
            </div>
          </>
        ) : (
          <button type="button" className="vinto-btn vinto-btn-primary" disabled={!canControl} onClick={() => onParty('start')}>Start party</button>
        )}
      </div>
      <div className="vinto-community-card">
        <span>DJ access</span>
        <strong>{canControl ? 'You have control' : 'Listener mode'}</strong>
      </div>
      {canManage ? (
        <div className="vinto-community-card">
          <span>Temporary DJ handoff</span>
          {session.handoff ? (
            <p className="vinto-panel-copy">
              {members.find((member) => member.id === session.handoff?.userId)?.name ?? session.handoff.userId} until {new Date(session.handoff.expiresAt).toLocaleTimeString()}
            </p>
          ) : null}
          <form className="vinto-handoff-form" onSubmit={(event) => {
            event.preventDefault();
            const userId = targetUserId.trim();
            if (!userId) return;
            onHandoff(userId, minutes);
            setTargetUserId('');
          }}>
            <label><span>Member</span><SearchPicker options={members} value={targetUserId || null} onChange={(value) => setTargetUserId(value ?? '')} placeholder="Select member" ariaLabel="Temporary DJ member" clearable /></label>
            <label><span>Minutes</span><input type="number" min={1} max={240} value={minutes} onChange={(event) => setMinutes(Number(event.target.value))} /></label>
            <button type="submit" className="vinto-btn vinto-btn-primary">Hand off</button>
            {session.handoff ? <button type="button" className="vinto-btn vinto-btn-ghost" onClick={() => onHandoff(null)}>Clear</button> : null}
          </form>
        </div>
      ) : null}
      {canControl ? <button type="button" className="vinto-btn vinto-btn-ghost" onClick={onLeave}>Disconnect Vinto</button> : null}
    </div>
  );
}
