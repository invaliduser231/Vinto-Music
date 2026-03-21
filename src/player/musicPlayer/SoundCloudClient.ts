export class SoundCloudClient {
  host: object;

  constructor(host: object) {
    this.host = host;
  }

  resolveTrack(url: string, requestedBy?: string | null) {
    const api = this.host as { _resolveSoundCloudTrack: (url: string, requestedBy?: string | null) => unknown };
    return api._resolveSoundCloudTrack(url, requestedBy);
  }

  resolvePlaylist(url: string, requestedBy?: string | null) {
    const api = this.host as { _resolveSoundCloudPlaylist: (url: string, requestedBy?: string | null) => unknown };
    return api._resolveSoundCloudPlaylist(url, requestedBy);
  }

  resolveByGuess(url: string, requestedBy?: string | null) {
    const api = this.host as { _resolveSoundCloudByGuess: (url: string, requestedBy?: string | null) => unknown };
    return api._resolveSoundCloudByGuess(url, requestedBy);
  }

  startPipeline(track: unknown, seekSec = 0) {
    const api = this.host as { _startSoundCloudPipeline: (track: unknown, seekSec?: number) => unknown };
    return api._startSoundCloudPipeline(track, seekSec);
  }
}


