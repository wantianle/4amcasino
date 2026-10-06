import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerMsg } from '@4am/shared';

/**
 * Socket-generation guards in `HeadlessClient.openSocket`: every handler is
 * bound to its own socket instance and must ignore events from a socket that has
 * been superseded by a newer one (a rapid `close()` -> `connect()` handoff). A
 * late `close`/`message`/`error` from the old socket must not tear down or
 * pollute the live connection.
 *
 * The `ws` module is mocked so the handoff can be driven deterministically,
 * without real sockets or drain timers.
 */

const { FakeWebSocket } = vi.hoisted(() => {
  class FakeWebSocket {
    static instances: FakeWebSocket[] = [];
    readonly url: string;
    readonly protocols: string[];
    readyState = 0; // CONNECTING
    sent: string[] = [];
    closed = false;
    private handlers = new Map<string, ((...args: unknown[]) => void)[]>();

    constructor(url: string, protocols?: string[]) {
      this.url = url;
      this.protocols = protocols ?? [];
      FakeWebSocket.instances.push(this);
    }
    on(event: string, cb: (...args: unknown[]) => void): this {
      const list = this.handlers.get(event) ?? [];
      list.push(cb);
      this.handlers.set(event, list);
      return this;
    }
    emit(event: string, ...args: unknown[]): void {
      for (const cb of this.handlers.get(event) ?? []) cb(...args);
    }
    send(data: string): void {
      if (this.closed) throw new Error('WebSocket is not open (closed)');
      this.sent.push(data);
    }
    close(): void {
      this.closed = true;
      this.readyState = 3;
    }
    open(): void {
      this.readyState = 1;
      this.emit('open');
    }
  }
  return { FakeWebSocket };
});

vi.mock('ws', () => ({ default: FakeWebSocket }));

import { HeadlessClient } from '../src/client.js';

function roomState(handActive: boolean): ServerMsg {
  return {
    t: 'room_state',
    room: {
      id: 'r1',
      name: 'R',
      joinCode: 'ABCDEF',
      hostId: 1,
      bankerId: 1,
      sb: 10,
      bb: 20,
      auditMode: false,
      actionTimeoutMs: 30_000,
      actionSecs: null,
      coBankerId: null,
      minSettleHands: 0,
      autoApproveBuys: false,
      tvReplays: false,
      autoDeal: false,
      autoDealerId: null,
      commissionBps: 0,
      sevenDeuceBonus: 0,
      voided: false,
    },
    players: [],
    handActive,
    autoDealAt: null,
    autoDealPaused: false,
    readyCheck: null,
  } as unknown as ServerMsg;
}

const frame = (msg: ServerMsg): Buffer => Buffer.from(JSON.stringify(msg));

/** Open the current socket of a fresh client and resolve its `connect()`. */
async function connectedClient(): Promise<{
  c: HeadlessClient;
  ws: InstanceType<typeof FakeWebSocket>;
}> {
  const c = new HeadlessClient('http://127.0.0.1:1', 'unit', 'pw');
  const p = c.connect('room1');
  const ws = FakeWebSocket.instances.at(-1)!;
  ws.open();
  await p;
  return { c, ws };
}

beforeEach(() => {
  FakeWebSocket.instances = [];
});

afterEach(() => {
  vi.useRealTimers();
});

describe('HeadlessClient socket handoff', () => {
  it('ignores a stale socket close (no state reset, no spurious reconnect)', async () => {
    vi.useFakeTimers();
    const { c, ws: ws1 } = await connectedClient();
    expect(c.connected).toBe(true);

    // Immediate handoff, no drain window.
    c.close();
    const p2 = c.connect('room1');
    const ws2 = FakeWebSocket.instances.at(-1)!;
    ws2.open();
    await p2;
    const epoch = c.connectionEpoch;
    expect(c.connected).toBe(true);

    // The old socket's close lands late: it must not touch the live connection.
    ws1.emit('close', 1006);
    expect(c.connected).toBe(true);
    expect(c.connectionEpoch).toBe(epoch);

    // ...nor arm a reconnect for the live socket.
    vi.advanceTimersByTime(10_000);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it('ignores a stale socket message after a new socket is installed', async () => {
    const { c, ws: ws1 } = await connectedClient();
    c.close();
    const p2 = c.connect('room1');
    const ws2 = FakeWebSocket.instances.at(-1)!;
    ws2.open();
    await p2;

    // The new socket's snapshot lands: no live hand, gate open.
    ws2.emit('message', frame(roomState(false)));
    expect(c.room?.handActive).toBe(false);
    expect(c.isResynced).toBe(true);

    // A late frame from the old socket must not pollute the new epoch.
    ws1.emit('message', frame(roomState(true)));
    expect(c.room?.handActive).toBe(false);
    expect(c.isResynced).toBe(true);
  });

  it('ignores a stale socket error', async () => {
    const { c, ws: ws1 } = await connectedClient();
    c.close();
    const p2 = c.connect('room1');
    const ws2 = FakeWebSocket.instances.at(-1)!;
    ws2.open();
    await p2;

    expect(() => ws1.emit('error', new Error('stale boom'))).not.toThrow();
    expect(c.connected).toBe(true);
  });

  it('drops a stale socket that opens after being superseded', async () => {
    const c = new HeadlessClient('http://127.0.0.1:1', 'unit', 'pw');
    const p1 = c.connect('room1');
    const ws1 = FakeWebSocket.instances[0]!;
    // A second connect supersedes ws1 before it ever opens.
    const p2 = c.connect('room1');
    const ws2 = FakeWebSocket.instances[1]!;
    ws2.open();
    await p2;
    expect(c.connectionEpoch).toBe(1);

    // Late stale open: settles the first caller but must not join or bump epoch.
    ws1.open();
    await p1;
    expect(c.connectionEpoch).toBe(1);
    expect(c.connected).toBe(true);
    expect(ws1.sent).toEqual([]);
    expect(ws1.closed).toBe(true);
  });

  it('close() immediately invalidates the connection state', async () => {
    const { c, ws } = await connectedClient();
    ws.emit('message', frame(roomState(false)));
    expect(c.isResynced).toBe(true);

    c.close();
    // No socket, and no stale snapshot: a runner must not consult a policy or
    // send through the dead connection in the pre-next-open window.
    expect(c.connected).toBe(false);
    expect(c.isResynced).toBe(false);
  });

  it('cancels a pending auto-reconnect when connect() is called explicitly', async () => {
    vi.useFakeTimers();
    const { c, ws: ws1 } = await connectedClient();
    // A network drop (not a deliberate close) schedules the 1500ms reconnect.
    ws1.emit('close', 1006);
    expect(FakeWebSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(500); // still pending

    const p2 = c.connect('room1');
    const ws2 = FakeWebSocket.instances.at(-1)!;
    ws2.open();
    await p2;

    // The stale timer must not fire a third, redundant socket.
    vi.advanceTimersByTime(10_000);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it('close() cancels a pending auto-reconnect', async () => {
    vi.useFakeTimers();
    const { c, ws } = await connectedClient();
    ws.emit('close', 1006); // drop -> schedules reconnect
    c.close();
    vi.advanceTimersByTime(10_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('closes the previous socket when connect() supersedes it (no orphan)', async () => {
    const c = new HeadlessClient('http://127.0.0.1:1', 'unit', 'pw');
    const p1 = c.connect('room1');
    const ws1 = FakeWebSocket.instances[0]!;
    // A concurrent connect before ws1 ever opened.
    const p2 = c.connect('room1');
    const ws2 = FakeWebSocket.instances[1]!;

    await p1; // must settle, not hang
    ws2.open();
    await p2;

    expect(ws1.closed).toBe(true); // the orphan was closed
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(c.connectionEpoch).toBe(1);
    expect(c.connected).toBe(true);
  });

  it('settles a connect() that is closed before its socket opens', async () => {
    const c = new HeadlessClient('http://127.0.0.1:1', 'unit', 'pw');
    let settled = false;
    const p = c.connect('room1').then(() => {
      settled = true;
    });
    expect(FakeWebSocket.instances).toHaveLength(1);

    c.close(); // the socket is still CONNECTING
    await p; // must not hang forever
    expect(settled).toBe(true);
    expect(c.connected).toBe(false);
    expect(c.isResynced).toBe(false);
  });

  it('isResynced is false before the first connect and stays false while unsynced', async () => {
    const c = new HeadlessClient('http://127.0.0.1:1', 'unit', 'pw');
    expect(c.isResynced).toBe(false); // never connected

    const p = c.connect('room1');
    const ws = FakeWebSocket.instances[0]!;
    ws.open();
    await p;
    // Open, but this epoch's snapshot has not landed yet.
    expect(c.isResynced).toBe(false);
    ws.emit('message', frame(roomState(false)));
    expect(c.isResynced).toBe(true);
    c.close();
    expect(c.isResynced).toBe(false);
  });

  it('refuses act() while connected but not resynced', async () => {
    const { c, ws } = await connectedClient();
    // Open, connected, but no room_state yet: barrier closed.
    expect(c.connected).toBe(true);
    expect(c.isResynced).toBe(false);
    const before = ws.sent.length; // only join_room
    expect(() => c.act({ type: 'check' })).toThrow(/resync/i);
    expect(ws.sent).toHaveLength(before);
  });

  it('keeps state coherent across three rapid reconnects', async () => {
    const c = new HeadlessClient('http://127.0.0.1:1', 'unit', 'pw');
    const open = async (room: string): Promise<void> => {
      const p = c.connect(room);
      FakeWebSocket.instances.at(-1)!.open();
      await p;
    };
    const p1 = c.connect('room1');
    const ws1 = FakeWebSocket.instances[0]!;
    ws1.open();
    await p1;
    c.close();
    await open('room1');
    c.close();
    await open('room1');

    expect(FakeWebSocket.instances).toHaveLength(3);
    expect(c.connected).toBe(true);
    expect(c.connectionEpoch).toBe(3);

    // Late closes from the superseded sockets are ignored.
    const ws2 = FakeWebSocket.instances[1]!;
    ws1.emit('close', 1006);
    ws2.emit('close', 1006);
    expect(c.connected).toBe(true);
    expect(c.connectionEpoch).toBe(3);
  });
});
