'use client';

import { useSyncExternalStore } from 'react';

export type PlaybackProgress = {
  positionSec: number;
  durationSec: number;
  paused: boolean;
  seekable: boolean;
};

export type PlaybackAnchor = {
  positionSec: number;
  atMs: number;
  durationSec: number;
  paused: boolean;
  seekable: boolean;
};

const EMPTY: PlaybackProgress = {
  positionSec: 0,
  durationSec: 0,
  paused: true,
  seekable: false,
};

const QUANTUM_SEC = 0.2;

function quantize(value: number) {
  return Math.round(value / QUANTUM_SEC) * QUANTUM_SEC;
}

export class PlaybackProgressStore {
  private listeners = new Set<() => void>();
  private anchor: PlaybackAnchor | null = null;
  private snapshot: PlaybackProgress = EMPTY;
  private frame = 0;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    this.start();
    return () => {
      this.listeners.delete(listener);
      if (!this.listeners.size) this.stop();
    };
  };

  getSnapshot = () => this.snapshot;

  getServerSnapshot = () => EMPTY;

  getAnchor() {
    return this.anchor;
  }

  estimate() {
    const anchor = this.anchor;
    if (!anchor) return 0;
    if (anchor.paused) return anchor.positionSec;
    return anchor.positionSec + ((Date.now() - anchor.atMs) / 1000);
  }

  setAnchor(anchor: PlaybackAnchor | null) {
    this.anchor = anchor;
    this.publish();
  }

  patchAnchor(patch: Partial<PlaybackAnchor>) {
    if (!this.anchor) return;
    this.anchor = { ...this.anchor, ...patch };
    this.publish();
  }

  private publish() {
    const anchor = this.anchor;
    if (!anchor) {
      if (this.snapshot === EMPTY) return;
      this.snapshot = EMPTY;
      this.emit();
      return;
    }

    const positionSec = quantize(Math.min(anchor.durationSec || Infinity, Math.max(0, this.estimate())));
    const next = this.snapshot;
    if (
      next.positionSec === positionSec
      && next.durationSec === anchor.durationSec
      && next.paused === anchor.paused
      && next.seekable === anchor.seekable
    ) {
      return;
    }

    this.snapshot = {
      positionSec,
      durationSec: anchor.durationSec,
      paused: anchor.paused,
      seekable: anchor.seekable,
    };
    this.emit();
  }

  private emit() {
    for (const listener of this.listeners) listener();
  }

  private start() {
    if (this.frame || typeof window === 'undefined') return;
    const tick = () => {
      this.publish();
      this.frame = window.requestAnimationFrame(tick);
    };
    this.frame = window.requestAnimationFrame(tick);
  }

  private stop() {
    if (!this.frame || typeof window === 'undefined') return;
    window.cancelAnimationFrame(this.frame);
    this.frame = 0;
  }

  destroy() {
    this.stop();
    this.listeners.clear();
    this.anchor = null;
    this.snapshot = EMPTY;
  }
}

export function usePlaybackProgress(store: PlaybackProgressStore): PlaybackProgress {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getServerSnapshot);
}
