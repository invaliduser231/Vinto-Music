export class ResolverClient {
  constructor(host) {
    this.host = host;
  }

  normalizeInputUrl(url) {
    return this.host._normalizeInputUrl(url);
  }

  resolveSpotifyTrack(url, requestedBy) {
    return this.host._resolveSpotifyTrack(url, requestedBy);
  }

  resolveSpotifyCollection(url, requestedBy) {
    return this.host._resolveSpotifyCollection(url, requestedBy);
  }

  resolveSpotifyByGuess(url, requestedBy) {
    return this.host._resolveSpotifyByGuess(url, requestedBy);
  }

  resolveFallback(url, requestedBy, source) {
    return this.host._resolveFromUrlFallbackSearch(url, requestedBy, source);
  }

  resolveSingleUrlTrack(url, requestedBy) {
    return this.host._resolveSingleUrlTrack(url, requestedBy);
  }
}
