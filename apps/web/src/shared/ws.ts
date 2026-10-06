import type { ClientMsg, ServerMsg } from '@4am/shared';
import { api } from './api.ts';
import { useStore } from './store.ts';

type Listener = (msg: ServerMsg) => void;

class WsClient {
  private ws: WebSocket | null = null;
  private listeners = new Set<Listener>();
  private roomId: string | null = null;
  private retry = 0;
  private closedByUs = false;
  private needResync = false;

  /** True once after a dropped connection; the game client uses it to reconcile state. */
  consumeResync(): boolean {
    const v = this.needResync;
    this.needResync = false;
    return v;
  }

  on(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  joinRoom(roomId: string): void {
    this.roomId = roomId;
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.sendJoin();
    } else {
      this.connect();
    }
  }

  /** Tell the server which hand we still hold so it can answer, from durable
   *  data, whether that hand actually committed (the terminal frames it kept in
   *  memory are gone after a restart). Sent on every join/reconnect: after a
   *  refresh `hand.handId` is null and the live hand's own resend covers us. */
  private sendJoin(): void {
    if (!this.roomId) return;
    const handId = useStore.getState().hand.handId;
    this.send({
      t: 'join_room',
      roomId: this.roomId,
      ...(handId ? { resumeHandId: handId } : {}),
    });
  }

  leaveRoom(): void {
    this.roomId = null;
    this.closedByUs = true;
    this.ws?.close();
    this.ws = null;
    // A leave is a session boundary. Drop the held hand too: otherwise the next
    // `joinRoom` (a switch to another room) would read this hand's `handId` in
    // `sendJoin()` and announce it as `resumeHandId` to the NEW room, and its
    // durable `handRecovery` / terminal state would leak across rooms. Runs
    // BEFORE any later sendJoin, so the previous room's hand is never resumed
    // elsewhere. (TablePage's room effect cleanup calls this on switch/unmount.)
    useStore.getState().resetHand();
  }

  send(msg: ClientMsg): void {
    this.ws?.send(JSON.stringify(msg));
  }

  private connect(): void {
    const token = useStore.getState().auth.token;
    if (!token || this.ws) return;
    this.closedByUs = false;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    // The token rides in Sec-WebSocket-Protocol rather than the query string:
    // proxies and platform access logs record the request line verbatim, and
    // these sessions are long-lived, so a token in a log is a live credential.
    const ws = new WebSocket(`${proto}://${location.host}/ws`, ['bearer', token]);
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      useStore.getState().setWsConnected(true);
      if (this.roomId) this.sendJoin();
    };
    ws.onmessage = (ev) => {
      let msg: ServerMsg;
      try {
        msg = JSON.parse(ev.data as string) as ServerMsg;
      } catch {
        return;
      }
      for (const fn of this.listeners) fn(msg);
    };
    ws.onclose = () => {
      this.ws = null;
      this.needResync = true;
      useStore.getState().setWsConnected(false);
      if (!this.closedByUs && this.roomId) {
        // if reconnects keep failing, the server may have restarted with fresh
        // data and our token is dead; api's 401 handler sends us to login
        if (this.retry >= 4) void api.profile().catch(() => {});
        const delay = Math.min(500 * 2 ** this.retry++, 8000);
        setTimeout(() => this.connect(), delay);
      }
    };
  }
}

export const wsClient = new WsClient();
