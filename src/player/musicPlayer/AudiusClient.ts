import type { MusicPlayer } from '../MusicPlayer.ts';
import type { Track } from '../../types/domain.ts';

export class AudiusClient {
  readonly host: MusicPlayer;

  constructor(host: MusicPlayer) {
    this.host = host;
  }

  resolveByUrl(url: string, requestedBy: string | null): Promise<Track[]> {
    return this.host._resolveAudiusByUrl(url, requestedBy);
  }

  startPipeline(track: Partial<Track> | null | undefined, seekSec = 0): Promise<void> {
    return this.host._startAudiusPipeline(track, seekSec);
  }
}
