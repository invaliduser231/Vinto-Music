export class AudiusClient {
  host: object;

  constructor(host: object) {
    this.host = host;
  }

  resolveByUrl(url: string, requestedBy?: string | null) {
    const api = this.host as { _resolveAudiusByUrl: (url: string, requestedBy?: string | null) => unknown };
    return api._resolveAudiusByUrl(url, requestedBy);
  }

  startPipeline(track: unknown, seekSec = 0) {
    const api = this.host as { _startAudiusPipeline: (track: unknown, seekSec?: number) => unknown };
    return api._startAudiusPipeline(track, seekSec);
  }
}


