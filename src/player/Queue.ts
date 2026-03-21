function randomInt(max: number) {
  return Math.floor(Math.random() * max);
}

type QueueItem = {
  id?: unknown;
  title?: unknown;
} & Record<string, unknown>;

export class Queue<T = QueueItem> {
  tracks: T[] & { [index: number]: T };
  private _current: T | null;

  constructor() {
    this.tracks = [] as T[] & { [index: number]: T };
    this._current = null;
  }

  get current(): T {
    return this._current as T;
  }

  set current(value: T | null) {
    this._current = value;
  }

  add(track: T) {
    this.tracks.push(track);
    return this.size;
  }

  addFront(track: T) {
    this.tracks.unshift(track);
    return this.size;
  }

  next(): T {
    this._current = this.tracks.shift() ?? null;
    return this.current;
  }

  requeueCurrentFront() {
    if (!this._current) return;
    this.tracks.unshift(this._current);
  }

  requeueCurrentBack() {
    if (!this._current) return;
    this.tracks.push(this._current);
  }

  remove(index: number): T {
    if (!Number.isInteger(index)) return null as T;
    if (index < 1 || index > this.tracks.length) return null as T;
    return (this.tracks.splice(index - 1, 1)[0] ?? null) as T;
  }

  clear() {
    this.tracks = [] as T[] & { [index: number]: T };
    this._current = null;
  }

  shuffle() {
    for (let i = this.tracks.length - 1; i > 0; i -= 1) {
      const j = randomInt(i + 1);
      const current = this.tracks[i];
      const target = this.tracks[j];
      if (current === undefined || target === undefined) continue;
      this.tracks[i] = target;
      this.tracks[j] = current;
    }
  }

  list(): T[] {
    return [this._current, ...this.tracks].filter((track): track is T => track != null);
  }

  get empty() {
    return this.tracks.length === 0 && !this._current;
  }

  get size() {
    return this.tracks.length + (this._current ? 1 : 0);
  }

  get pendingSize() {
    return this.tracks.length;
  }
}


