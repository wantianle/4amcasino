import { parseServerMsg, type ServerMsg } from '@4am/shared';

export interface WsTransportHandlers {
  onOpen(): void;
  onFrame(msg: ServerMsg): void;
  onClose(): void;
}

/**
 * Owns the raw WebSocket and the wire boundary.
 *
 * This is the only place that turns network bytes into a `ServerMsg`, and the
 * only place that can reject a frame: malformed JSON, an unknown `t`, or a
 * shape mismatch is logged and dropped so it never reaches a listener. It knows
 * nothing about rooms, auth tokens or the store - those belong to the session
 * layer in `ws.ts`.
 */
export class WsTransport {
  private ws: WebSocket | null = null;

  constructor(private readonly handlers: WsTransportHandlers) {}

  get isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  open(token: string): void {
    if (this.ws) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    // The token rides in Sec-WebSocket-Protocol rather than the query string:
    // proxies and platform access logs record the request line verbatim, and
    // these sessions are long-lived, so a token in a log is a live credential.
    const ws = new WebSocket(`${proto}://${location.host}/ws`, ['bearer', token]);
    this.ws = ws;
    ws.onopen = () => this.handlers.onOpen();
    ws.onmessage = (ev) => this.receive(ev.data);
    ws.onclose = () => {
      this.ws = null;
      this.handlers.onClose();
    };
  }

  /**
   * Wire boundary. A single bad frame must never take down the table: every
   * failure path logs and returns, leaving the socket open for the frames that
   * follow. Validation is structural only (see `parseServerMsg`).
   */
  private receive(data: unknown): void {
    if (typeof data !== 'string') {
      console.warn('[ws] dropped frame: non-text payload');
      return;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(data);
    } catch {
      console.warn('[ws] dropped frame: malformed JSON');
      return;
    }
    const parsed = parseServerMsg(raw);
    if (!parsed.ok) {
      console.warn(`[ws] dropped frame: ${parsed.reason}`);
      return;
    }
    this.handlers.onFrame(parsed.msg);
  }

  send(text: string): void {
    this.ws?.send(text);
  }

  close(): void {
    const ws = this.ws;
    this.ws = null;
    ws?.close();
  }
}
