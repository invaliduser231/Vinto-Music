import type { MusicPlayer } from '../MusicPlayer.ts';
import type { Track } from '../../types/domain.ts';

export class ResolverClient {
  readonly host: MusicPlayer;

  constructor(host: MusicPlayer) {
    this.host = host;
  }

  normalizeInputUrl(url: string): Promise<string> {
    return this.host._normalizeInputUrl(url);
  }

  resolveSingleUrlTrack(url: string, requestedBy: string | null): Promise<Track[]> {
    return this.host._resolveSingleUrlTrack(url, requestedBy);
  }
}
