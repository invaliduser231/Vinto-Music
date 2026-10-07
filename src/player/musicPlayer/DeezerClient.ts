import type { MusicPlayer } from '../MusicPlayer.ts';
import type { Track } from '../../types/domain.ts';

export class DeezerClient {
  readonly host: MusicPlayer;

  constructor(host: MusicPlayer) {
    this.host = host;
  }

  resolveTrack(url: string, requestedBy: string | null): Promise<Track[]> {
    return this.host._resolveDeezerTrack(url, requestedBy);
  }

  resolveCollection(url: string, requestedBy: string | null, limit?: number | null): Promise<Track[]> {
    return this.host._resolveDeezerCollection(url, requestedBy, limit);
  }

  resolveByGuess(url: string, requestedBy: string | null, limit?: number | null): Promise<Track[]> {
    return this.host._resolveDeezerByGuess(url, requestedBy, limit);
  }

  searchTracks(query: string, limit: number, requestedBy: string | null): Promise<Track[]> {
    return this.host._searchDeezerTracks(query, limit, requestedBy);
  }

  startPipeline(track: Partial<Track> | null | undefined, seekSec = 0): Promise<void> {
    return this.host._startDeezerPipeline(track, seekSec);
  }
}
