export class DeezerClient {
  host: object;

  constructor(host: object) {
    this.host = host;
  }

  resolveTrack(url: string, requestedBy?: string | null) {
    const api = this.host as { _resolveDeezerTrack: (url: string, requestedBy?: string | null) => unknown };
    return api._resolveDeezerTrack(url, requestedBy);
  }

  resolveCollection(url: string, requestedBy?: string | null, limit?: number | null) {
    const api = this.host as { _resolveDeezerCollection: (url: string, requestedBy?: string | null, limit?: number | null) => unknown };
    return api._resolveDeezerCollection(url, requestedBy, limit);
  }

  resolveByGuess(url: string, requestedBy?: string | null, limit?: number | null) {
    const api = this.host as { _resolveDeezerByGuess: (url: string, requestedBy?: string | null, limit?: number | null) => unknown };
    return api._resolveDeezerByGuess(url, requestedBy, limit);
  }

  searchTracks(query: string, limit?: number, requestedBy?: string | null) {
    const api = this.host as { _searchDeezerTracks: (query: string, limit?: number, requestedBy?: string | null) => unknown };
    return api._searchDeezerTracks(query, limit, requestedBy);
  }

  startPipeline(track: unknown, seekSec = 0) {
    const api = this.host as { _startDeezerPipeline: (track: unknown, seekSec?: number) => unknown };
    return api._startDeezerPipeline(track, seekSec);
  }
}


