import type { ClientMsg, ServerMsg } from '@4am/shared';
import { api } from './api.ts';
import { useStore } from './store.ts';
import { RECONNECT_PROFILE_AFTER, reconnectDelay } from './wsReconnect.ts';
import { WsTransport } from './wsTransport.ts';

type Listener = (msg: ServerMsg) => void;

/**
 * Session layer over `WsTransport`.
 *
 * Partitioned by responsibility:
 *   - `WsTransport` (wsTransport.ts): socket lifecycle + the wire boundary
 *     (JSON parse + runtime frame validation).
 *   - `wsReconnect.ts`: the pure reconnect backoff policy.
 *   - this class: room/join state, listener fan-out and the store binding.
 *
 * Public API is unchanged: `wsClient.on / joinRoom / leaveRoom / send /
 * consumeResync`.
 */
class WsClient {
  private listeners = new Set<Listener>();
  private roomId: string | null = null;
  private retry = 0;
  private closedByUs = false;
  private needResync = false;

  private readonly transport = new WsTransport({
    onOpen: () => this.handleOpen(),
    onFrame: (msg) => this.dispatch(msg),
    onClose: () => this.handleClose(),
  });

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
    if (this.transport.isOpen) {
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
    this.transport.close();
    // A leave is a session boundary. Drop the held hand too: otherwise the next
    // `joinRoom` (a switch to another room) would read this hand's `handId` in
    // `sendJoin()` and announce it as `resumeHandId` to the NEW room, and its
    // durable `handRecovery` / terminal state would leak across rooms. Runs
    // BEFORE any later sendJoin, so the previous room's hand is never resumed
    // elsewhere. (TablePage's room effect cleanup calls this on switch/unmount.)
    useStore.getState().resetHand();
  }

  send(msg: ClientMsg): void {
    this.transport.send(JSON.stringify(msg));
  }

  private connect(): void {
    const token = useStore.getState().auth.token;
    if (!token) return;
    this.closedByUs = false;
    this.transport.open(token);
  }

  private handleOpen(): void {
    this.retry = 0;
    useStore.getState().setWsConnected(true);
    if (this.roomId) this.sendJoin();
  }

  private dispatch(msg: ServerMsg): void {
    for (const fn of this.listeners) fn(msg);
  }

  private handleClose(): void {
    this.needResync = true;
    useStore.getState().setWsConnected(false);
    if (!this.closedByUs && this.roomId) {
      // if reconnects keep failing, the server may have restarted with fresh
      // data and our token is dead; api's 401 handler sends us to login
      if (this.retry >= RECONNECT_PROFILE_AFTER) void api.profile().catch(() => {});
      const delay = reconnectDelay(this.retry++);
      setTimeout(() => this.connect(), delay);
    }
  }
}

export const wsClient = new WsClient();
