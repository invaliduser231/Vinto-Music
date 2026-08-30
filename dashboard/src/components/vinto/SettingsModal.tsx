'use client';

import { useEffect, useRef, useState } from 'react';
import {
  X,
  SlidersHorizontal,
  SpeakerHigh,
  ListNumbers,
  Plugs,
} from '@phosphor-icons/react';
import type { GuildSettings, GuildVoiceProfile } from '@/types/guild-settings';
import { SearchPicker, type SearchPickerOption } from '@/components/vinto/SearchPicker';

const LANGUAGES = [
  { value: 'en', label: 'English' },
  { value: 'de', label: 'Deutsch' },
  { value: 'pt-BR', label: 'Português (BR)' },
] as const;

type SettingsModalProps = {
  open: boolean;
  guildName: string;
  settings: GuildSettings | null;
  channelNames: Map<string, string>;
  availableVoiceChannels: Array<{ id: string; name: string }>;
  availableTextChannels: SearchPickerOption[];
  availableRoles: SearchPickerOption[];
  onClose: () => void;
  onPatch: (patch: Partial<GuildSettings>) => Promise<boolean>;
};

type SettingsTab = 'general' | 'voice' | 'queue' | 'integrations';

export function SettingsModal({
  open,
  guildName,
  settings: remoteSettings,
  channelNames,
  availableVoiceChannels,
  availableTextChannels,
  availableRoles,
  onClose,
  onPatch: savePatch,
}: SettingsModalProps) {
  const [tab, setTab] = useState<SettingsTab>('general');
  const [draft, setDraft] = useState<GuildSettings | null>(remoteSettings);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const wasOpenRef = useRef(false);

  useEffect(() => {
    if (!open) {
      wasOpenRef.current = false;
      return;
    }
    if (wasOpenRef.current) return;
    wasOpenRef.current = true;
    setDraft(remoteSettings);
    setDirty(false);
    setSaveError(null);
    window.setTimeout(() => closeButtonRef.current?.focus(), 0);
  }, [open, remoteSettings]);

  useEffect(() => {
    if (!open || dirty) return;
    setDraft(remoteSettings);
  }, [open, dirty, remoteSettings]);

  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
      if (event.key !== 'Tab') return;
      const focusable = containerRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), a[href]',
      );
      if (!focusable?.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  const settings = draft ?? remoteSettings;
  const onPatch = async (patch: Partial<GuildSettings>): Promise<boolean> => {
    setDraft((current) => current ? { ...current, ...patch } : current);
    setDirty(true);
    setSaveError(null);
    return true;
  };

  const save = async () => {
    if (!settings || !dirty) return;
    setSaving(true);
    setSaveError(null);
    const saved = await savePatch(settings);
    setSaving(false);
    if (saved) {
      setDirty(false);
      return;
    }
    setSaveError('Settings could not be saved. Check the connection and try again.');
  };

  if (!settings) return null;

  const channelLabel = (id: string) => (
    channelNames.get(id) ?? availableVoiceChannels.find((channel) => channel.id === id)?.name ?? id
  );

  const updateVoiceProfiles = (profiles: GuildVoiceProfile[]) => {
    void onPatch({ voiceProfiles: profiles });
  };

  const toggle247 = (channelId: string, enabled: boolean) => {
    const profiles = [...settings.voiceProfiles];
    const idx = profiles.findIndex((p) => p.channelId === channelId);
    if (idx >= 0) {
      profiles[idx] = { ...profiles[idx], stayInVoiceEnabled: enabled };
    } else {
      profiles.push({ channelId, stayInVoiceEnabled: enabled, autoplayEnabled: null, moodPreset: null });
    }
    updateVoiceProfiles(profiles);
  };

  const remove247 = (channelId: string) => {
    updateVoiceProfiles(
      settings.voiceProfiles.filter((p) => p.channelId !== channelId),
    );
  };

  const add247Channel = (channelId: string) => {
    const id = channelId.trim();
    if (!id) return;
    if (settings.voiceProfiles.some((p) => p.channelId === id)) return;
    updateVoiceProfiles([
      ...settings.voiceProfiles,
      { channelId: id, stayInVoiceEnabled: true, autoplayEnabled: null, moodPreset: null },
    ]);
  };

  const addDjRole = (value: string | null) => {
    const id = String(value ?? '').trim();
    if (!id || settings.djRoleIds.includes(id)) return;
    void onPatch({ djRoleIds: [...settings.djRoleIds, id] });
  };

  const removeDjRole = (id: string) => {
    void onPatch({ djRoleIds: settings.djRoleIds.filter((r) => r !== id) });
  };

  const profiles247 = settings.voiceProfiles.filter(
    (p) => p.stayInVoiceEnabled === true,
  );

  return (
    <div
      className={`vinto-settings-modal${open ? ' show' : ''}`}
      role="dialog"
      aria-modal="true"
      aria-labelledby="guild-settings-title"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div ref={containerRef} className="vinto-settings-container">
        <button ref={closeButtonRef} type="button" className="vinto-close-settings" onClick={onClose} aria-label="Close settings">
          <X size={18} weight="bold" />
        </button>

        <div className="vinto-settings-sidebar">
          <div id="guild-settings-title" className="vinto-settings-title">{guildName} settings</div>
          <div className="vinto-settings-nav" role="tablist" aria-label="Settings sections">
            <button
              type="button"
              className={`vinto-settings-nav-item${tab === 'general' ? ' active' : ''}`}
              onClick={() => setTab('general')}
              role="tab"
              aria-selected={tab === 'general'}
            >
              <SlidersHorizontal size={18} />
              General
            </button>
            <button
              type="button"
              className={`vinto-settings-nav-item${tab === 'voice' ? ' active' : ''}`}
              onClick={() => setTab('voice')}
              role="tab"
              aria-selected={tab === 'voice'}
            >
              <SpeakerHigh size={18} />
              Voice
            </button>
            <button
              type="button"
              className={`vinto-settings-nav-item${tab === 'queue' ? ' active' : ''}`}
              onClick={() => setTab('queue')}
              role="tab"
              aria-selected={tab === 'queue'}
            >
              <ListNumbers size={18} />
              Queue
            </button>
            <button
              type="button"
              className={`vinto-settings-nav-item${tab === 'integrations' ? ' active' : ''}`}
              onClick={() => setTab('integrations')}
              role="tab"
              aria-selected={tab === 'integrations'}
            >
              <Plugs size={18} />
              Integrations
            </button>
          </div>
        </div>

        <div className="vinto-settings-content">
          <div className={`vinto-settings-section${tab === 'general' ? ' active' : ''}`}>
            <div className="vinto-settings-section-title">General</div>

            <div className="vinto-form-group">
              <div>
                <div className="vinto-form-label">Prefix</div>
              </div>
              <input
                className="vinto-form-control small"
                value={settings.prefix}
                aria-label="Command prefix"
                maxLength={5}
                onChange={(e) => void onPatch({ prefix: e.target.value })}
              />
            </div>

            <div className="vinto-form-group">
              <div>
                <div className="vinto-form-label">Language</div>
              </div>
              <select
                className="vinto-form-control"
                value={settings.language ?? 'en'}
                aria-label="Bot response language"
                onChange={(e) => void onPatch({ language: e.target.value })}
              >
                {LANGUAGES.map((lang) => (
                  <option key={lang.value} value={lang.value}>{lang.label}</option>
                ))}
              </select>
            </div>

            <div className="vinto-form-group">
              <div>
                <div className="vinto-form-label">Minimal mode</div>
              </div>
              <input
                type="checkbox"
                className="vinto-toggle"
                  checked={settings.minimalMode}
                  aria-label="Enable minimal response mode"
                onChange={(e) => void onPatch({ minimalMode: e.target.checked })}
              />
            </div>

            <div className="vinto-form-group col">
              <div>
                <div className="vinto-form-label">DJ roles</div>
                <div className="vinto-form-desc">Empty allows everyone to control playback.</div>
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                {settings.djRoleIds.map((id) => (
                  <span
                    key={id}
                    className="vinto-badge-inline"
                    style={{ color: '#fff', background: 'rgba(255,255,255,0.1)' }}
                  >
                    {availableRoles.find((role) => role.id === id)?.name ?? id}
                    <button
                      type="button"
                      style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', padding: 0 }}
                      onClick={() => removeDjRole(id)}
                      aria-label={`Remove DJ role ${id}`}
                    >
                      <X size={12} />
                    </button>
                  </span>
                ))}
                <SearchPicker
                  options={availableRoles.filter((role) => !settings.djRoleIds.includes(role.id))}
                  value={null}
                  onChange={addDjRole}
                  placeholder="Add role"
                  ariaLabel="Add DJ role"
                  resetAfterSelect
                />
              </div>
            </div>
          </div>

          <div className={`vinto-settings-section${tab === 'voice' ? ' active' : ''}`}>
            <div className="vinto-settings-section-title">Voice & Playback</div>

            <div className="vinto-form-group">
              <div>
                <div className="vinto-form-label">Default volume</div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
                <input
                  type="range"
                  min={0}
                  max={200}
                  value={settings.volumePercent}
                  aria-label="Default volume"
                  style={{ accentColor: 'var(--vinto-pink)', cursor: 'pointer', flex: 1 }}
                  onChange={(e) => void onPatch({ volumePercent: Number(e.target.value) })}
                />
                <span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 600, width: 48 }}>
                  {settings.volumePercent}%
                </span>
              </div>
            </div>

            <div className="vinto-form-group col vinto-highlight-box">
              <div style={{ display: 'flex', justifyContent: 'space-between', width: '100%', alignItems: 'center' }}>
                <div>
                  <div className="vinto-form-label">24/7</div>
                  <div className="vinto-form-desc">Per voice channel</div>
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                {profiles247.map((profile) => (
                  <span
                    key={profile.channelId}
                    className="vinto-badge-inline"
                    style={{ color: '#fff', background: 'rgba(255,255,255,0.1)' }}
                  >
                    <SpeakerHigh size={12} weight="fill" />
                    {channelLabel(profile.channelId)}
                    <button
                      type="button"
                      style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer' }}
                      onClick={() => remove247(profile.channelId)}
                      aria-label={`Disable 24/7 mode for ${channelLabel(profile.channelId)}`}
                    >
                      <X size={12} />
                    </button>
                  </span>
                ))}
                <SearchPicker
                  options={availableVoiceChannels.filter((channel) => (
                    !profiles247.some((profile) => profile.channelId === channel.id)
                  ))}
                  value={null}
                  onChange={(value) => {
                    if (value) add247Channel(value);
                  }}
                  placeholder="Add voice channel"
                  ariaLabel="Add 24/7 voice channel"
                  resetAfterSelect
                />
              </div>
            </div>

            <div className="vinto-form-group">
              <div>
                <div className="vinto-form-label">Earrape protection</div>
              </div>
              <input
                type="checkbox"
                className="vinto-toggle"
                  checked={settings.earrapeProtectionEnabled}
                  aria-label="Enable earrape protection"
                onChange={(e) => void onPatch({ earrapeProtectionEnabled: e.target.checked })}
              />
            </div>

          </div>

          <div className={`vinto-settings-section${tab === 'queue' ? ' active' : ''}`}>
            <div className="vinto-settings-section-title">Queue & Guard</div>

            <div className="vinto-form-group">
              <div>
                <div className="vinto-form-label">Deduplicate</div>
              </div>
              <input
                type="checkbox"
                className="vinto-toggle"
                  checked={settings.dedupeEnabled}
                  aria-label="Prevent duplicate queue entries"
                onChange={(e) => void onPatch({ dedupeEnabled: e.target.checked })}
              />
            </div>

            <div className="vinto-form-group">
              <div>
                <div className="vinto-form-label">Vote-skip ratio</div>
              </div>
              <input
                type="number"
                className="vinto-form-control small"
                min={0.1}
                max={1}
                step={0.1}
                  value={settings.voteSkipRatio}
                  aria-label="Vote skip ratio"
                onChange={(e) => void onPatch({ voteSkipRatio: Number(e.target.value) })}
              />
            </div>

            <div className="vinto-form-group">
              <div>
                <div className="vinto-form-label">Vote-skip min votes</div>
              </div>
              <input
                type="number"
                className="vinto-form-control small"
                min={1}
                max={100}
                  value={settings.voteSkipMinVotes}
                  aria-label="Minimum vote skip votes"
                onChange={(e) => void onPatch({ voteSkipMinVotes: Number(e.target.value) })}
              />
            </div>

            <div className="vinto-form-group col">
              <div style={{ display: 'flex', justifyContent: 'space-between', width: '100%' }}>
                <div className="vinto-form-label">Queue guard</div>
                <input
                  type="checkbox"
                  className="vinto-toggle"
                  checked={settings.queueGuard.enabled}
                  aria-label="Enable queue guard"
                  onChange={(e) => void onPatch({
                    queueGuard: { ...settings.queueGuard, enabled: e.target.checked },
                  })}
                />
              </div>
              <div style={{ display: 'flex', gap: 12, width: '100%' }}>
                <label className="vinto-number-field">
                  <span>Per requester</span>
                <input
                  type="number"
                  className="vinto-form-control"
                  style={{ flex: 1 }}
                  value={settings.queueGuard.maxPerRequesterWindow}
                  aria-label="Maximum tracks per requester"
                  onChange={(e) => void onPatch({
                    queueGuard: {
                      ...settings.queueGuard,
                      maxPerRequesterWindow: Number(e.target.value),
                    },
                  })}
                />
                </label>
                <label className="vinto-number-field">
                  <span>Window size</span>
                <input
                  type="number"
                  className="vinto-form-control"
                  style={{ flex: 1 }}
                  value={settings.queueGuard.windowSize}
                  aria-label="Queue guard window size"
                  onChange={(e) => void onPatch({
                    queueGuard: {
                      ...settings.queueGuard,
                      windowSize: Number(e.target.value),
                    },
                  })}
                />
                </label>
                <label className="vinto-number-field">
                  <span>Artist streak</span>
                <input
                  type="number"
                  className="vinto-form-control"
                  style={{ flex: 1 }}
                  value={settings.queueGuard.maxArtistStreak}
                  aria-label="Maximum consecutive tracks per artist"
                  onChange={(e) => void onPatch({
                    queueGuard: {
                      ...settings.queueGuard,
                      maxArtistStreak: Number(e.target.value),
                    },
                  })}
                />
                </label>
              </div>
            </div>
          </div>

          <div className={`vinto-settings-section${tab === 'integrations' ? ' active' : ''}`}>
            <div className="vinto-settings-section-title">Integrations</div>

            <div className="vinto-form-group col">
              <div className="vinto-form-label">Webhook URL</div>
              <input
                className="vinto-form-control"
                style={{ width: '100%', fontFamily: 'monospace' }}
                placeholder="https://..."
                value={settings.webhookUrl ?? ''}
                aria-label="Music webhook URL"
                onChange={(e) => void onPatch({ webhookUrl: e.target.value || null })}
              />
            </div>

            <div className="vinto-form-group">
              <div className="vinto-form-label">Recap channel</div>
              <SearchPicker
                options={availableTextChannels}
                value={settings.recapChannelId}
                onChange={(value) => void onPatch({ recapChannelId: value })}
                placeholder="Off"
                ariaLabel="Weekly recap channel"
                clearable
              />
            </div>

            <div className="vinto-form-group">
              <div className="vinto-form-label">Music log channel</div>
              <SearchPicker
                options={availableTextChannels}
                value={settings.musicLogChannelId}
                onChange={(value) => void onPatch({ musicLogChannelId: value })}
                placeholder="Off"
                ariaLabel="Music log channel"
                clearable
              />
            </div>
          </div>
          <div className="vinto-settings-footer">
            <span className={saveError ? 'vinto-save-status error' : 'vinto-save-status'} role="status">
              {saveError ?? (dirty ? 'Unsaved changes' : 'All changes saved')}
            </span>
            <button
              type="button"
              className="vinto-btn vinto-btn-ghost"
              disabled={!dirty || saving}
              onClick={() => {
                setDraft(remoteSettings);
                setDirty(false);
                setSaveError(null);
              }}
            >
              Reset
            </button>
            <button
              type="button"
              className="vinto-btn vinto-btn-primary"
              disabled={!dirty || saving}
              onClick={() => void save()}
            >
              {saving ? 'Saving…' : 'Save changes'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
