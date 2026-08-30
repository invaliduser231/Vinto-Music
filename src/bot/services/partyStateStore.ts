export type PartyTeam = 'a' | 'b';

export type PartySnapshot = {
  startedAt: number;
  teams: { a: number; b: number };
  scores: { a: number; b: number };
};

type PartyState = {
  startedAt: number;
  teams: { a: Set<string>; b: Set<string> };
  scores: { a: number; b: number };
  votes: Set<string>;
};

const PARTY_STATE_TTL_MS = 12 * 60 * 60 * 1000;

class PartyStateStore {
  private readonly states = new Map<string, PartyState>();

  start(guildId: string): PartySnapshot {
    const state = this._create();
    this.states.set(guildId, state);
    return this._snapshot(state);
  }

  end(guildId: string): boolean {
    return this.states.delete(guildId);
  }

  get(guildId: string, now = Date.now()): PartySnapshot | null {
    const state = this._getActive(guildId, now);
    return state ? this._snapshot(state) : null;
  }

  join(guildId: string, userId: string, team: PartyTeam): PartySnapshot | null {
    const state = this._getActive(guildId);
    if (!state) return null;
    state.teams.a.delete(userId);
    state.teams.b.delete(userId);
    state.teams[team].add(userId);
    return this._snapshot(state);
  }

  vote(guildId: string, userId: string, team: PartyTeam, date = new Date()): {
    snapshot: PartySnapshot | null;
    alreadyVoted: boolean;
  } {
    const state = this._getActive(guildId, date.getTime());
    if (!state) return { snapshot: null, alreadyVoted: false };

    const voteKey = `${userId}:${date.toISOString().slice(0, 10)}`;
    if (state.votes.has(voteKey)) {
      return { snapshot: this._snapshot(state), alreadyVoted: true };
    }
    state.votes.add(voteKey);
    state.scores[team] += 1;
    return { snapshot: this._snapshot(state), alreadyVoted: false };
  }

  prune(now = Date.now()): void {
    for (const guildId of this.states.keys()) this._getActive(guildId, now);
  }

  private _getActive(guildId: string, now = Date.now()): PartyState | null {
    const state = this.states.get(guildId) ?? null;
    if (!state) return null;
    if ((now - state.startedAt) <= PARTY_STATE_TTL_MS) return state;
    this.states.delete(guildId);
    return null;
  }

  private _create(): PartyState {
    return {
      startedAt: Date.now(),
      teams: { a: new Set(), b: new Set() },
      scores: { a: 0, b: 0 },
      votes: new Set(),
    };
  }

  private _snapshot(state: PartyState): PartySnapshot {
    return {
      startedAt: state.startedAt,
      teams: { a: state.teams.a.size, b: state.teams.b.size },
      scores: { ...state.scores },
    };
  }
}

export const partyStateStore = new PartyStateStore();
