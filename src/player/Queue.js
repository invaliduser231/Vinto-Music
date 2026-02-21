function randomInt(max) {
  return Math.floor(Math.random() * max);
}

export class Queue {
  constructor() {
    this.tracks = [];
    this.current = null;
  }

  add(track) {
    this.tracks.push(track);
    return this.size;
  }

  addFront(track) {
    this.tracks.unshift(track);
    return this.size;
  }

  next() {
    this.current = this.tracks.shift() ?? null;
    return this.current;
  }

  requeueCurrentFront() {
    if (!this.current) return;
    this.tracks.unshift(this.current);
  }

  requeueCurrentBack() {
    if (!this.current) return;
    this.tracks.push(this.current);
  }

  remove(index) {
    if (!Number.isInteger(index)) return null;
    if (index < 1 || index > this.tracks.length) return null;
    return this.tracks.splice(index - 1, 1)[0] ?? null;
  }

  clear() {
    this.tracks = [];
    this.current = null;
  }

  shuffle() {
    for (let i = this.tracks.length - 1; i > 0; i -= 1) {
      const j = randomInt(i + 1);
      [this.tracks[i], this.tracks[j]] = [this.tracks[j], this.tracks[i]];
    }
  }

  list() {
    return [this.current, ...this.tracks].filter(Boolean);
  }

  get empty() {
    return this.tracks.length === 0 && !this.current;
  }

  get size() {
    return this.tracks.length + (this.current ? 1 : 0);
  }

  get pendingSize() {
    return this.tracks.length;
  }
}
