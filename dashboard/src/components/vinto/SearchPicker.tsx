'use client';

import { CaretDown, X } from '@phosphor-icons/react';
import { useEffect, useId, useMemo, useState } from 'react';

export type SearchPickerOption = {
  id: string;
  name: string;
};

export function SearchPicker({
  options,
  value,
  onChange,
  placeholder,
  ariaLabel,
  clearable = false,
  resetAfterSelect = false,
}: {
  options: SearchPickerOption[];
  value: string | null;
  onChange: (value: string | null) => void;
  placeholder: string;
  ariaLabel: string;
  clearable?: boolean;
  resetAfterSelect?: boolean;
}) {
  const listboxId = useId();
  const selected = options.find((option) => option.id === value) ?? null;
  const [query, setQuery] = useState(selected?.name ?? value ?? '');
  const [open, setOpen] = useState(false);

  useEffect(() => {
    setQuery(selected?.name ?? value ?? '');
  }, [selected?.name, value]);

  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized || selected?.name === query) return options.slice(0, 50);
    return options.filter((option) => (
      option.name.toLowerCase().includes(normalized) || option.id.includes(normalized)
    )).slice(0, 50);
  }, [options, query, selected?.name]);

  const choose = (option: SearchPickerOption) => {
    onChange(option.id);
    setQuery(resetAfterSelect ? '' : option.name);
    setOpen(false);
  };

  return (
    <div className="vinto-search-picker">
      <div className="vinto-search-picker-control">
        <input
          className="vinto-form-control"
          role="combobox"
          aria-label={ariaLabel}
          aria-autocomplete="list"
          aria-controls={listboxId}
          aria-expanded={open}
          placeholder={placeholder}
          value={query}
          onFocus={() => setOpen(true)}
          onBlur={() => window.setTimeout(() => setOpen(false), 100)}
          onChange={(event) => {
            setQuery(event.target.value);
            setOpen(true);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') setOpen(false);
            if (event.key === 'Enter' && filtered[0]) {
              event.preventDefault();
              choose(filtered[0]);
            }
          }}
        />
        {clearable && value ? (
          <button type="button" onClick={() => onChange(null)} aria-label={`Clear ${ariaLabel}`}><X size={14} /></button>
        ) : <CaretDown size={14} />}
      </div>
      {open ? (
        <div className="vinto-search-picker-menu" id={listboxId} role="listbox">
          {filtered.length > 0 ? filtered.map((option) => (
            <button
              type="button"
              role="option"
              aria-selected={option.id === value}
              key={option.id}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => choose(option)}
            >
              <span>{option.name}</span>
              <small>{option.id}</small>
            </button>
          )) : <span className="vinto-search-picker-empty">No matches</span>}
        </div>
      ) : null}
    </div>
  );
}
