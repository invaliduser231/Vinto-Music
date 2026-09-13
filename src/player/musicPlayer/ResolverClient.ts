export class ResolverClient {
  host: object;

  constructor(host: object) {
    this.host = host;
  }

  normalizeInputUrl(url: string) {
    const api = this.host as { _normalizeInputUrl: (url: string) => unknown };
    return api._normalizeInputUrl(url);
  }

  resolveSingleUrlTrack(url: string, requestedBy?: string | null) {
    const api = this.host as { _resolveSingleUrlTrack: (url: string, requestedBy?: string | null) => unknown };
    return api._resolveSingleUrlTrack(url, requestedBy);
  }
}
