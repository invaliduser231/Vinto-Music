export class SpotifyClient {
  host: object;

  constructor(host: object) {
    this.host = host;
  }

  resolveTrack(url: string, requestedBy?: string | null) {
    const api = this.host as { _resolveSpotifyTrack: (url: string, requestedBy?: string | null) => unknown };
    return api._resolveSpotifyTrack(url, requestedBy);
  }

  resolveCollection(url: string, requestedBy?: string | null, limit?: number | null) {
    const api = this.host as { _resolveSpotifyCollection: (url: string, requestedBy?: string | null, limit?: number | null) => unknown };
    return api._resolveSpotifyCollection(url, requestedBy, limit);
  }

  resolveArtist(url: string, requestedBy?: string | null, limit?: number | null) {
    const api = this.host as { _resolveSpotifyArtist: (url: string, requestedBy?: string | null, limit?: number | null) => unknown };
    return api._resolveSpotifyArtist(url, requestedBy, limit);
  }

  resolveByGuess(url: string, requestedBy?: string | null, limit?: number | null) {
    const api = this.host as { _resolveSpotifyByGuess: (url: string, requestedBy?: string | null, limit?: number | null) => unknown };
    return api._resolveSpotifyByGuess(url, requestedBy, limit);
  }
}


