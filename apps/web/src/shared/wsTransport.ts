import { parseServerMsg, type ServerMsg } from '@4am/shared';

export interface WsTransportHandlers {
  onOpen(): void;
  onFrame(msg: ServerMsg): void;
  onClose(): void;
}

/** Length of the bad-frame logging window. */
const DROP_WARN_WINDOW_MS = 10_000;
/** Frames of one reason logged verbatim per window before the rest are counted. */
const DROP_WARN_MAX_PER_REASON = 3;

/** Per-reason tally for the current logging window. */
interface DropBucket {
  /** Frames dropped with this exact reason in the window. */
  total: number;
  /** How many have been logged verbatim (capped at `DROP_WARN_MAX_PER_REASON`). */
  logged: number;
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
  private dropBuckets = new Map<string, DropBucket>();
  private dropWindowTimer: ReturnType<typeof setTimeout> | null = null;

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
      // Only the current socket may report the close. If `this.ws` has moved on
      // (we closed this one and already opened its replacement, and this close
      // event arrived late) then this socket is stale: clearing the reference
      // would drop the live socket and a spurious `onClose` would tear down the
      // freshly reconnected session. Explicit `close()` reports `onClose` itself
      // (see below), so returning here never swallows a deliberate close.
      if (this.ws !== ws) return;
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
      this.warnDropped('non-text payload');
      return;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(data);
    } catch {
      this.warnDropped('malformed JSON');
      return;
    }
    const parsed = parseServerMsg(raw);
    if (!parsed.ok) {
      this.warnDropped(parsed.reason);
      return;
    }
    this.handlers.onFrame(parsed.msg);
  }

  /**
   * Rate-limited bad-frame logging.
   *
   * A fixed window with a per-reason cap. The first `DROP_WARN_MAX_PER_REASON`
   * frames of each reason are logged verbatim, so the onset of any new failure
   * is always visible; everything beyond that is counted and reported once when
   * the window closes. Without it, a server bug, a corrupting proxy or a hostile
   * peer can turn every inbound frame into a synchronous `console.warn`, and the
   * logging itself becomes the outage.
   *
   * Side effects stay here and never reach `parseServerMsg`, which must remain a
   * pure, non-throwing guard.
   */
  private warnDropped(reason: string): void {
    let bucket = this.dropBuckets.get(reason);
    if (!bucket) {
      bucket = { total: 0, logged: 0 };
      this.dropBuckets.set(reason, bucket);
    }
    bucket.total++;
    if (bucket.logged < DROP_WARN_MAX_PER_REASON) {
      bucket.logged++;
      console.warn(`[ws] dropped frame: ${reason}`);
    }
    // Lazily open the window on the first drop, so an idle transport keeps no
    // timer alive.
    if (this.dropWindowTimer === null) {
      this.dropWindowTimer = setTimeout(() => this.flushDropWindow(), DROP_WARN_WINDOW_MS);
    }
  }

  /** Close the current window: report the frames it had to suppress, reset. */
  private flushDropWindow(): void {
    this.dropWindowTimer = null;
    for (const [reason, bucket] of this.dropBuckets) {
      const suppressed = bucket.total - bucket.logged;
      if (suppressed > 0) {
        console.warn(`[ws] dropped ${bucket.total} frames: ${reason} (+${suppressed} more)`);
      }
    }
    this.dropBuckets.clear();
  }

  send(text: string): void {
    this.ws?.send(text);
  }

  close(): void {
    const ws = this.ws;
    // Null first: the socket's own `onclose` (if it fires later) must see a
    // stale reference and no-op, so `onClose` below is the only notification.
    this.ws = null;
    ws?.close();
    // Closing ends the current logging window: clear its timer so it can never
    // leak past the transport's lifetime, and emit the summary it still owed.
    if (this.dropWindowTimer !== null) {
      clearTimeout(this.dropWindowTimer);
    }
    this.flushDropWindow();
    // The socket's `onclose` is swallowed by the guard above, so a deliberate
    // close reports itself exactly once.
    if (ws) this.handlers.onClose();
  }
}
