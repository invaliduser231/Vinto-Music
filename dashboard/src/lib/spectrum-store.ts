'use client';

export const SPECTRUM_BANDS = 24;

const FRAME_INTERVAL_MS = 1_000 / 30;
const IDLE_TIMEOUT_MS = 1_400;
const ATTACK_TAU_SEC = 0.035;
const DECAY_TAU_SEC = 0.14;
const MAX_QUEUE = 120;
const MAX_SCHEDULE_AHEAD_MS = 2_500;
const STARVED_DECAY_TAU_SEC = 0.45;

function readLeadMs(): number {
  const raw = Number.parseInt(String(process.env.NEXT_PUBLIC_VISUALIZER_LEAD_MS ?? ''), 10);
  if (!Number.isFinite(raw)) return 600;
  return Math.max(0, Math.min(2_000, raw));
}

export class SpectrumStore {
  private listeners = new Set<() => void>();
  private values = new Float32Array(SPECTRUM_BANDS);
  private targets = new Float32Array(SPECTRUM_BANDS);
  private queue: Array<{ dueAt: number; bands: Float32Array }> = [];
  private nextDueAt = 0;
  private lastFrameAt = 0;
  private leadMs = readLeadMs();

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  get active() {
    return this.lastFrameAt > 0 && (Date.now() - this.lastFrameAt) < IDLE_TIMEOUT_MS;
  }

  push(bands: number[]) {
    const frame = new Float32Array(SPECTRUM_BANDS);
    const count = Math.min(SPECTRUM_BANDS, bands.length);
    for (let i = 0; i < count; i += 1) {
      frame[i] = Math.max(0, Math.min(1, (bands[i] ?? 0) / 255));
    }

    const now = Date.now();
    const wasActive = this.lastFrameAt > 0;
    this.lastFrameAt = now;

    const earliest = now + this.leadMs;
    if (
      !this.nextDueAt
      || this.nextDueAt < now
      || this.nextDueAt > earliest + MAX_SCHEDULE_AHEAD_MS
    ) {
      this.nextDueAt = earliest;
    }

    this.queue.push({ dueAt: this.nextDueAt, bands: frame });
    this.nextDueAt += FRAME_INTERVAL_MS;
    if (this.queue.length > MAX_QUEUE) this.queue.splice(0, this.queue.length - MAX_QUEUE);
    if (!wasActive) this.emit();
  }

  advance(delta: number) {
    const now = Date.now();
    let drained = false;
    while (this.queue.length && (this.queue[0]?.dueAt ?? Infinity) <= now) {
      const frame = this.queue.shift();
      if (frame) {
        this.targets.set(frame.bands);
        drained = true;
      }
    }

    const step = Math.max(0, delta);
    const silent = !this.active && !this.queue.length;
    const starved = !silent && !drained && !this.queue.length;
    if (starved) {
      const ease = Math.exp(-step / STARVED_DECAY_TAU_SEC);
      for (let i = 0; i < SPECTRUM_BANDS; i += 1) {
        this.targets[i] = (this.targets[i] ?? 0) * ease;
      }
    }

    const attack = 1 - Math.exp(-step / ATTACK_TAU_SEC);
    const decay = 1 - Math.exp(-step / DECAY_TAU_SEC);
    let changed = false;

    for (let i = 0; i < SPECTRUM_BANDS; i += 1) {
      const target = silent ? 0 : (this.targets[i] ?? 0);
      const current = this.values[i] ?? 0;
      const rate = target > current ? attack : decay;
      const next = current + ((target - current) * rate);
      if (Math.abs(next - current) > 0.0005) changed = true;
      this.values[i] = next;
    }
    return changed;
  }

  read() {
    return this.values;
  }

  reset() {
    this.values.fill(0);
    this.targets.fill(0);
    this.queue = [];
    this.nextDueAt = 0;
    this.lastFrameAt = 0;
    this.emit();
  }

  private emit() {
    for (const listener of this.listeners) listener();
  }
}
