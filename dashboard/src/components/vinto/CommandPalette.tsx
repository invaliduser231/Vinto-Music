'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { MagnifyingGlass } from '@phosphor-icons/react';

export type PaletteCommand = {
  id: string;
  label: string;
  group: string;
  hint?: string;
  disabled?: boolean;
  run: () => void;
};

function score(command: PaletteCommand, query: string): number {
  if (!query) return 1;
  const haystack = `${command.group} ${command.label}`.toLowerCase();
  const needle = query.toLowerCase();
  if (haystack.includes(needle)) return 100 - haystack.indexOf(needle);

  let index = 0;
  for (const char of needle) {
    index = haystack.indexOf(char, index);
    if (index < 0) return 0;
    index += 1;
  }
  return 1;
}

export function CommandPalette({
  open,
  commands,
  onClose,
  onSearch,
}: {
  open: boolean;
  commands: PaletteCommand[];
  onClose: () => void;
  onSearch: ((query: string) => void) | null;
}) {
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const matches = useMemo(() => {
    const trimmed = query.trim();
    return commands
      .map((command) => ({ command, value: score(command, trimmed) }))
      .filter((entry) => entry.value > 0)
      .sort((a, b) => b.value - a.value)
      .slice(0, 8)
      .map((entry) => entry.command);
  }, [commands, query]);

  const trimmedQuery = query.trim();
  const canQueue = Boolean(onSearch) && trimmedQuery.length >= 2;
  const optionCount = matches.length + (canQueue ? 1 : 0);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setCursor(0);
    const timer = window.setTimeout(() => inputRef.current?.focus(), 10);
    return () => window.clearTimeout(timer);
  }, [open]);

  useEffect(() => {
    setCursor(0);
  }, [query]);

  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  useEffect(() => {
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [cursor, matches.length]);

  if (!open) return null;

  const runAt = (index: number) => {
    if (index < matches.length) {
      const command = matches[index];
      if (!command || command.disabled) return;
      command.run();
      onClose();
      return;
    }
    if (canQueue && onSearch) {
      onSearch(trimmedQuery);
      onClose();
    }
  };

  return (
    <div className="vinto-palette-backdrop" role="presentation" onClick={onClose}>
      <div
        className="vinto-palette"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="vinto-palette-input">
          <MagnifyingGlass size={18} />
          <input
            ref={inputRef}
            value={query}
            placeholder="Commands, views, or a track to queue"
            aria-label="Command or search"
            role="combobox"
            aria-expanded="true"
            aria-controls="vinto-palette-list"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') {
                event.preventDefault();
                setCursor((value) => (optionCount ? (value + 1) % optionCount : 0));
              } else if (event.key === 'ArrowUp') {
                event.preventDefault();
                setCursor((value) => (optionCount ? (value - 1 + optionCount) % optionCount : 0));
              } else if (event.key === 'Enter') {
                event.preventDefault();
                runAt(cursor);
              }
            }}
          />
        </div>
        <div className="vinto-palette-list" id="vinto-palette-list" role="listbox" ref={listRef}>
          {matches.map((command, index) => (
            <button
              key={command.id}
              type="button"
              role="option"
              aria-selected={index === cursor}
              data-active={index === cursor}
              className={`vinto-palette-item${index === cursor ? ' active' : ''}`}
              disabled={command.disabled}
              onMouseEnter={() => setCursor(index)}
              onClick={() => runAt(index)}
            >
              <span className="vinto-palette-group">{command.group}</span>
              <span className="vinto-palette-label">{command.label}</span>
              {command.hint ? <span className="vinto-palette-hint">{command.hint}</span> : null}
            </button>
          ))}
          {canQueue ? (
            <button
              type="button"
              role="option"
              aria-selected={cursor === matches.length}
              data-active={cursor === matches.length}
              className={`vinto-palette-item${cursor === matches.length ? ' active' : ''}`}
              onMouseEnter={() => setCursor(matches.length)}
              onClick={() => runAt(matches.length)}
            >
              <span className="vinto-palette-group">Queue</span>
              <span className="vinto-palette-label">{trimmedQuery}</span>
              <span className="vinto-palette-hint">Search and add</span>
            </button>
          ) : null}
          {!optionCount ? <div className="vinto-palette-empty">No matches</div> : null}
        </div>
      </div>
    </div>
  );
}
