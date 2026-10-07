import type { MusicPlayer } from '../MusicPlayer.ts';
import type { Track } from '../../types/domain.ts';

export class SoundCloudClient {
  readonly host: MusicPlayer;

  constructor(host: MusicPlayer) {
    this.host = host;
  }

  resolveTrack(url: string, requestedBy: string | null): Promise<Track[]> {
    return this.host._resolveSoundCloudTrack(url, requestedBy);
  }

  resolvePlaylist(url: string, requestedBy: string | null, limit?: number | null): Promise<Track[]> {
    return this.host._resolveSoundCloudPlaylist(url, requestedBy, limit);
  }

  resolveByGuess(url: string, requestedBy: string | null, limit?: number | null): Promise<Track[]> {
    return this.host._resolveSoundCloudByGuess(url, requestedBy, limit);
  }

  startPipeline(track: Partial<Track> | null | undefined, seekSec = 0): Promise<void> {
    return this.host._startSoundCloudPipeline(track, seekSec);
  }
}
