export class AudiusClient {
  constructor(host) {
    this.host = host;
  }

  resolveByUrl(url, requestedBy) {
    return this.host._resolveAudiusByUrl(url, requestedBy);
  }

  startPipeline(track, seekSec = 0) {
    return this.host._startAudiusPipeline(track, seekSec);
  }
}
