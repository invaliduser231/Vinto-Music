export class DeezerClient {
  constructor(host) {
    this.host = host;
  }

  resolveTrack(url, requestedBy) {
    return this.host._resolveDeezerTrack(url, requestedBy);
  }

  resolveCollection(url, requestedBy) {
    return this.host._resolveDeezerCollection(url, requestedBy);
  }

  resolveByGuess(url, requestedBy) {
    return this.host._resolveDeezerByGuess(url, requestedBy);
  }

  searchTracks(query, limit, requestedBy) {
    return this.host._searchDeezerTracks(query, limit, requestedBy);
  }

  startPipeline(track, seekSec = 0) {
    return this.host._startDeezerPipeline(track, seekSec);
  }
}
