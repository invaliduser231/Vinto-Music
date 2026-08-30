declare module 'ws' {
  import { EventEmitter } from 'node:events';
  import type { Server as HttpServer } from 'node:http';

  class WebSocket extends EventEmitter {
    static readonly CONNECTING: number;
    static readonly OPEN: number;
    static readonly CLOSING: number;
    static readonly CLOSED: number;
    readyState: number;
    constructor(url: string, options?: {
      handshakeTimeout?: number;
      perMessageDeflate?: boolean;
    });
    send(data: string): void;
    close(): void;
    on(event: 'close', listener: () => void): this;
    on(event: 'message', listener: (data: Buffer | ArrayBuffer | Buffer[]) => void): this;
    on(event: string, listener: (...args: unknown[]) => void): this;
  }

  class WebSocketServer extends EventEmitter {
    constructor(options: { server: HttpServer });
    close(callback?: () => void): void;
    on(event: 'connection', listener: (socket: WebSocket) => void): this;
    on(event: string, listener: (...args: unknown[]) => void): this;
  }

  export { WebSocket, WebSocketServer };
  export default WebSocket;
}
