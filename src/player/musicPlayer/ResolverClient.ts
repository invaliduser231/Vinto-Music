export class ResolverClient {
  host: object;

  constructor(host: object) {
    this.host = host;
  }

  normalizeInputUrl(url: string) {
    const api = this.host as { _normalizeInputUrl: (url: string) => unknown };
    return api._normalizeInputUrl(url);
  }

  resolveSpotifyTrack(url: string, requestedBy?: string | null) {
    const api = this.host as { _resolveSpotifyTrack: (url: string, requestedBy?: string | null) => unknown };
    return api._resolveSpotifyTrack(url, requestedBy);
  }

  resolveAppleTrack(url: string, requestedBy?: string | null) {
    const api = this.host as { _resolveAppleTrack: (url: string, requestedBy?: string | null) => unknown };
    return api._resolveAppleTrack(url, requestedBy);
  }

  resolveAmazonTrack(url: string, requestedBy?: string | null) {
    const api = this.host as { _resolveAmazonTrack: (url: string, requestedBy?: string | null) => unknown };
    return api._resolveAmazonTrack(url, requestedBy);
  }

  resolveSpotifyCollection(url: string, requestedBy?: string | null) {
    const api = this.host as { _resolveSpotifyCollection: (url: string, requestedBy?: string | null) => unknown };
    return api._resolveSpotifyCollection(url, requestedBy);
  }

  resolveAppleCollection(url: string, requestedBy?: string | null) {
    const api = this.host as { _resolveAppleCollection: (url: string, requestedBy?: string | null) => unknown };
    return api._resolveAppleCollection(url, requestedBy);
  }

  resolveAmazonCollection(url: string, requestedBy?: string | null) {
    const api = this.host as { _resolveAmazonCollection: (url: string, requestedBy?: string | null) => unknown };
    return api._resolveAmazonCollection(url, requestedBy);
  }

  resolveSpotifyByGuess(url: string, requestedBy?: string | null) {
    const api = this.host as { _resolveSpotifyByGuess: (url: string, requestedBy?: string | null) => unknown };
    return api._resolveSpotifyByGuess(url, requestedBy);
  }

  resolveAppleByGuess(url: string, requestedBy?: string | null) {
    const api = this.host as { _resolveAppleByGuess: (url: string, requestedBy?: string | null) => unknown };
    return api._resolveAppleByGuess(url, requestedBy);
  }

  resolveAmazonByGuess(url: string, requestedBy?: string | null) {
    const api = this.host as { _resolveAmazonByGuess: (url: string, requestedBy?: string | null) => unknown };
    return api._resolveAmazonByGuess(url, requestedBy);
  }

  resolveFallback(url: string, requestedBy?: string | null, source?: string | null) {
    const api = this.host as {
      _resolveFromUrlFallbackSearch: (url: string, requestedBy?: string | null, source?: string | null) => unknown;
    };
    return api._resolveFromUrlFallbackSearch(url, requestedBy, source);
  }

  resolveSingleUrlTrack(url: string, requestedBy?: string | null) {
    const api = this.host as { _resolveSingleUrlTrack: (url: string, requestedBy?: string | null) => unknown };
    return api._resolveSingleUrlTrack(url, requestedBy);
  }
}


