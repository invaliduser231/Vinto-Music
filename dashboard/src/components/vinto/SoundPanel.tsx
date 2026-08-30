'use client';

import type { DashboardSession } from '@/types/session';

const FILTERS = ['off', 'bassboost', 'nightcore', 'vaporwave', '8d', 'soft', 'karaoke', 'radio'];
const EQ_PRESETS = ['flat', 'pop', 'rock', 'edm', 'vocal'];
const MOODS: Record<string, DashboardSession['effects']> = {
  Chill: { filterPreset: 'soft', eqPreset: 'vocal', tempoRatio: 0.95, pitchSemitones: 0 },
  Hype: { filterPreset: 'bassboost', eqPreset: 'edm', tempoRatio: 1.08, pitchSemitones: 1 },
  Retro: { filterPreset: 'vaporwave', eqPreset: 'pop', tempoRatio: 0.9, pitchSemitones: -2 },
  Clean: { filterPreset: 'off', eqPreset: 'flat', tempoRatio: 1, pitchSemitones: 0 },
  Radio: { filterPreset: 'radio', eqPreset: 'vocal', tempoRatio: 1, pitchSemitones: 0 },
};

export function SoundPanel({
  effects,
  canControl,
  onChange,
}: {
  effects: DashboardSession['effects'];
  canControl: boolean;
  onChange: (effects: DashboardSession['effects']) => void;
}) {
  const patch = (next: Partial<DashboardSession['effects']>) => onChange({ ...effects, ...next });

  return (
    <div className="vinto-panel-stack">
      <h2>Sound</h2>
      <div className="vinto-chip-grid" aria-label="Mood presets">
        {Object.entries(MOODS).map(([name, preset]) => (
          <button key={name} type="button" className="vinto-feature-chip" disabled={!canControl} onClick={() => onChange(preset)}>
            {name}
          </button>
        ))}
      </div>
      <label className="vinto-field-stack">
        <span>Filter</span>
        <select value={effects.filterPreset} disabled={!canControl} onChange={(event) => patch({ filterPreset: event.target.value })}>
          {FILTERS.map((filter) => <option key={filter} value={filter}>{filter}</option>)}
        </select>
      </label>
      <label className="vinto-field-stack">
        <span>Equalizer</span>
        <select value={effects.eqPreset} disabled={!canControl} onChange={(event) => patch({ eqPreset: event.target.value })}>
          {EQ_PRESETS.map((preset) => <option key={preset} value={preset}>{preset}</option>)}
        </select>
      </label>
      <label className="vinto-field-stack">
        <span>Tempo <strong>{effects.tempoRatio.toFixed(2)}×</strong></span>
        <input type="range" min={0.5} max={2} step={0.05} value={effects.tempoRatio} disabled={!canControl} onChange={(event) => patch({ tempoRatio: Number(event.target.value) })} />
      </label>
      <label className="vinto-field-stack">
        <span>Pitch <strong>{effects.pitchSemitones > 0 ? '+' : ''}{effects.pitchSemitones}</strong></span>
        <input type="range" min={-12} max={12} step={1} value={effects.pitchSemitones} disabled={!canControl} onChange={(event) => patch({ pitchSemitones: Number(event.target.value) })} />
      </label>
    </div>
  );
}
