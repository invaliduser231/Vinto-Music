export class SoundCloudClient {
  constructor(host) {
    this.host = host;
  }

  resolveTrack(url, requestedBy) {
    return this.host._resolveSoundCloudTrack(url, requestedBy);
  }

  resolvePlaylist(url, requestedBy) {
    return this.host._resolveSoundCloudPlaylist(url, requestedBy);
  }

  resolveByGuess(url, requestedBy) {
    return this.host._resolveSoundCloudByGuess(url, requestedBy);
  }

  startPipeline(track, seekSec = 0) {
    return this.host._startSoundCloudPipeline(track, seekSec);
  }
}
