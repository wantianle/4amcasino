import { describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.js';
import { attachHub } from '../src/hub.js';
import {
  cardLookup,
  genIdentity,
  handKeyCommit,
  invScalar,
  maskAndShuffle,
  mulPoint,
  pointFromHex,
  pointHex,
  proveUnmask,
  randScalar,
  randomPerm,
  recoverCard,
  signContent,
} from '@4am/mental-poker';
import type { BettingState, CardId, PlayerAction, ServerMsg } from '@4am/shared';
import { awardPots, computePots, splitAmountEven, startBombPot } from '@4am/shared';
import { createSession, createUser } from '../src/auth.js';
import { setPlatformUserId } from '../src/platform.js';
import { activeHands } from '../src/liveHands.js';
import { applyHandSettlement, type GameClock } from '../src/game.js';
import { rechainRoom, verifyLedger } from '../src/ledger.js';
import {
  auditMarkerlessTranscripts,
  firstPendingHandLifecycle,
  reconcileMissingSettlements,
  recoverOrphanedFeatureTriggers,
} from '../src/db.js';
import { TestClient, type Strategy } from './helpers/testClient.js';
import { setupRoom as createRoom } from './helpers/testRoom.js';
import { awaitDeal, awaitHandEnd } from './helpers/testRoom.js';
import { useIntegrationServer } from './helpers/integrationServer.js';

const srv = useIntegrationServer();

// Thin adapter onto the shared `setupRoom`, binding this file's server URL and
// client collector so the migrated call sites stay byte-identical.
const setupRoom = (names: string[], strategies: Strategy[] = []) =>
  createRoom(srv.baseUrl, names, strategies, srv.clients);

/** The time bank is a fixed 30s feature now; zero a seat's balance (on the room
 *  epoch) before the deal so a seat that drops mid-hand auto-folds on the 1.5s
 *  base clock instead of stalling the whole bank first. */
function zeroBank(roomId: string, userId: number): void {
  const epoch = (
    srv.ctx.db.prepare('SELECT time_bank_epoch AS e FROM rooms WHERE id = ?').get(roomId) as {
      e: number;
    }
  ).e;
  srv.ctx.db
    .prepare(
      'UPDATE room_players SET time_bank_ms = 0, time_bank_hands = 0, time_bank_epoch = ? WHERE room_id = ? AND user_id = ?',
    )
    .run(epoch, roomId, userId);
}

describe('full hand integration: lifecycle, showdown and abort', () => {
  it('a reconnect before the first socket opens never flushes onto the stale socket', async () => {
    const c = new TestClient(srv.baseUrl, 'racey');
    srv.clients.push(c);
    await c.register();
    const room = await c.api('/api/rooms', { name: 'Race', sb: 10, bb: 20 });

    // These calls run in the same tick, so the first socket is guaranteed to
    // still be CONNECTING when the second connect() replaces it. This pins the
    // exact race: a queued frame plus a superseded socket that then opens.
    const first = c.connect(room.id);
    c.send({ t: 'sit', seat: 0 });
    const second = c.connect(room.id);
    await Promise.all([first, second]);
    // Wait for the second socket to complete its handshake, including the
    // server round-trip, so both the socket bookkeeping and room_state are final.
    await c.waitFor(
      () => c.roomState !== null && c.sentFrames.some((f) => f.t === 'sit'),
      5000,
    );

    // Every frame left on the second socket. If the stale first socket had
    // flushed the shared queue, `join_room`/`sit` would show socket 1 (and the
    // second socket would have been starved).
    expect(c.sentFrames.length).toBeGreaterThan(0);
    expect(c.sentFrames.every((f) => f.socket === 2)).toBe(true);
    expect(c.sentFrames.filter((f) => f.t === 'join_room').map((f) => f.socket)).toEqual([2]);
    expect(c.sentFrames.filter((f) => f.t === 'sit').map((f) => f.socket)).toEqual([2]);
    expect(c.roomState).not.toBeNull();
  });

  it('three players play a complete hand to showdown', async () => {
    const { players, room, host } = await setupRoom(['host', 'bob', 'carol']);
    host.send({ t: 'start_hand' });
    await awaitHandEnd(players);

    for (const p of players) {
      expect(p.handAbort).toBeNull();
      expect(p.myCards).toHaveLength(2);
      expect(new Set(p.myCards).size).toBe(2);
      expect(p.board).toHaveLength(5);
      expect(p.sawShowdown).toBe(true);
    }
    // all clients agree on the board
    expect(players[1]!.board).toEqual(players[0]!.board);
    expect(players[2]!.board).toEqual(players[0]!.board);
    // no card appears twice across boards + all hole cards
    const all = [...players[0]!.board, ...players.flatMap((p) => p.myCards)];
    expect(new Set(all).size).toBe(all.length);

    // chips conserved: everyone matched the BB (passive play), pot 60
    const stacks = players[0]!.handEnd!.stacks;
    expect(stacks.reduce((s, x) => s + x.stack, 0)).toBe(3000);
    const deltas = players[0]!.handEnd!.deltas;
    expect(deltas.reduce((s, x) => s + x.delta, 0)).toBe(0);

    // DB: stacks persisted, ledger has verifiable settlement entries, transcript stored
    const state = await host.api(`/api/rooms/${room.id}`);
    expect(state.players.reduce((s: number, p: { stack: number }) => s + p.stack, 0)).toBe(3000);
    const ledger = await host.api(`/api/rooms/${room.id}/ledger`);
    expect(ledger.verified.ok).toBe(true);
    const settlements = ledger.entries.filter(
      (e: { kind: string }) => e.kind === 'hand-settlement',
    );
    expect(settlements.length).toBeGreaterThan(0);
    expect(settlements[0].ref).toBe(players[0]!.handEnd!.head);
    const row = srv.ctx.db
      .prepare('SELECT head FROM transcripts WHERE hand_id = ?')
      .get(players[0]!.handEnd!.handId) as { head: string };
    expect(row.head).toBe(players[0]!.handEnd!.head);

    // the session report reflects the played hand
    const session = await host.api(`/api/rooms/${room.id}/session`);
    expect(session.hands).toBeGreaterThanOrEqual(1);
    expect(session.firstTs).toBeLessThanOrEqual(session.lastTs);
    expect(session.biggestPot).toBeGreaterThan(0);
    const nets = session.players.reduce((s: number, p: { net: number }) => s + p.net, 0);
    expect(nets).toBe(0);

    // the hands list carries YOUR per-hand result (net + outcome)
    const hands = await host.api(`/api/rooms/${room.id}/hands`);
    const mine = hands.hands.find(
      (h: { handId: string }) => h.handId === players[0]!.handEnd!.handId,
    );
    const hostDelta = players[0]!.handEnd!.deltas.find((d: { seat: number }) => d.seat === 0)!;
    expect(mine.myNet).toBe(hostDelta.delta);
    expect(['won at showdown', 'lost at showdown']).toContain(mine.outcome);
    expect(mine.voided).toBe(false);

    // Server-authoritative action sequence: every accepted transcript action
    // carries its 0-based index, and every observer sees a strictly increasing
    // sequence on action_applied (one entry per applied action, no duplicates).
    const handDetail = await host.api(
      `/api/rooms/${room.id}/hands/${players[0]!.handEnd!.handId}`,
    );
    const actionEntries = (handDetail.entries as { type: string; payload: { actionSeq?: number } }[])
      .filter((e) => e.type === 'action');
    expect(actionEntries.length).toBeGreaterThan(0);
    for (const e of actionEntries) expect(typeof e.payload.actionSeq).toBe('number');
    for (const p of players) {
      const seqs = p.actionApplied.map((a) => a.actionSeq as number);
      for (const s of seqs) expect(Number.isInteger(s)).toBe(true);
      expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
      expect(new Set(seqs).size).toBe(seqs.length);
    }
  }, 20000);

  it('mid-hand reconnect: the reconnected client gets the authoritative actionSeq after missed frames', async () => {
    const { players, room, host } = await setupRoom(['mra', 'mrb', 'mrc']);
    const a = players[0]!;
    const bob = players[1]!;
    // Space actions out so there is a window to drop the socket with actions in
    // flight, then reconnect before the hand settles.
    for (const p of players) p.thinkMs = 250;
    zeroBank(room.id, bob.userId); // bob drops mid-hand; fold him on the base clock
    host.send({ t: 'start_hand' });
    await a.waitFor(() => a.actionApplied.length >= 1, 12000);

    const bobSeenBefore = bob.actionApplied.length;
    const serverAppliedBefore = a.actionApplied.length;
    bob.disconnect();
    // At least one action is applied while bob is offline: bob provably missed it.
    await a.waitFor(() => a.actionApplied.length > serverAppliedBefore, 12000);
    await bob.connect(room.id);
    // The hand is still live; bob now receives a later action_applied.
    await bob.waitFor(() => bob.actionApplied.length > bobSeenBefore, 20000);
    const firstAfterReconnect = bob.actionApplied[bobSeenBefore]!;
    expect(typeof firstAfterReconnect.actionSeq).toBe('number');
    // A locally accumulated ordinal would have been exactly bobSeenBefore (it
    // missed a frame), but the server sequence has advanced past the gap.
    expect(firstAfterReconnect.actionSeq!).toBeGreaterThan(bobSeenBefore);

    await awaitHandEnd(players, 25000);
    expect(a.handAbort).toBeNull();

    // Direct set comparison: the continuously-connected observer's non-auto
    // actionSeq values must equal the transcript's accepted actionSeq values
    // exactly, and the reconnected observer's post-reconnect frames must be a
    // subset of the same authoritative sequence (never a fabricated ordinal).
    const handDetail = await host.api(`/api/rooms/${room.id}/hands/${a.handEnd!.handId}`);
    const transcriptSeqs = (
      handDetail.entries as { type: string; payload: { actionSeq?: number } }[]
    )
      .filter((e) => e.type === 'action')
      .map((e) => e.payload.actionSeq as number)
      .sort((x, y) => x - y);
    expect(transcriptSeqs.length).toBeGreaterThan(0);
    const observerSeqs = a.actionApplied
      .filter((x) => !x.auto)
      .map((x) => x.actionSeq as number)
      .sort((x, y) => x - y);
    expect(observerSeqs).toEqual(transcriptSeqs);
    const bobAfter = bob.actionApplied.slice(bobSeenBefore).map((x) => x.actionSeq as number);
    for (const s of bobAfter) expect(transcriptSeqs).toContain(s);
  }, 45000);

  it('a mid-hand buy survives the hand settlement', async () => {
    const { players, room, host } = await setupRoom(['heala', 'healb', 'healc']);
    host.send({ t: 'start_hand' });
    // the shuffle is still running: this purchase lands while the hand is live
    const req = await host.api(`/api/rooms/${room.id}/buy`, { amount: 500 });
    await host.api(`/api/rooms/${room.id}/approve`, { requestId: req.id, approve: true });
    await awaitHandEnd(players);

    const hostDelta = players[0]!.handEnd!.deltas.find(
      (d: { seat: number }) => d.seat === 0,
    )!.delta;
    const state = await host.api(`/api/rooms/${room.id}`);
    const me = state.players.find((p: { username: string }) => p.username === 'heala');
    // 1000 buy-in at setup, plus the hand's result, plus the mid-hand 500
    expect(me.stack).toBe(1000 + hostDelta + 500);
    // and the ledger agrees with the stack exactly
    const sum = srv.ctx.db
      .prepare('SELECT SUM(delta) as s FROM ledger WHERE room_id = ? AND user_id = ?')
      .get(room.id, me.userId) as { s: number };
    expect(sum.s).toBe(me.stack);
  }, 20000);

  it('a mid-hand kick unseats for the next deal without breaking the hand', async () => {
    const { players, room, host } = await setupRoom(['kicka', 'kickb', 'kickc']);
    host.send({ t: 'start_hand' });
    // the hand is live (shuffling): the banker stands carol up anyway
    const carol = players[2]!;
    const res = await host.api(`/api/rooms/${room.id}/stand-up`, { userId: carol.userId });
    expect(res.ok).toBe(true);
    // the running hand keeps its snapshot and finishes normally with carol in it
    await awaitHandEnd(players);
    expect(players[0]!.handAbort).toBeNull();
    const state = await host.api(`/api/rooms/${room.id}`);
    const carolRow = state.players.find((p: { username: string }) => p.username === 'kickc');
    expect(carolRow.seat).toBeNull();
    expect(state.players.reduce((t: number, p: { stack: number }) => t + p.stack, 0)).toBe(3000);
  }, 20000);

  it('a mid-hand close lets the current hand settle normally, then deals no next hand', async () => {
    const { players, room, host } = await setupRoom(['clse1', 'clse2', 'clse3']);
    host.send({ t: 'start_hand' });
    // Every seat must be in a running hand before the close fires.
    await awaitDeal(players);

    // The host archives while the hand is in flight. Closing is archiving: the
    // hand already dealt must finish and settle, never abort.
    const close = await host.api(`/api/rooms/${room.id}/close`, {});
    expect(close.ok).toBe(true);
    expect(close.archived).toBe(true);
    // The response must tell the client a hand is live, so a browser that has
    // not yet seen hand_start does not navigate into an abort.
    expect(close.handActive).toBe(true);

    await awaitHandEnd(players, 25000);
    const handId = players[0]!.handEnd!.handId;
    for (const p of players) {
      // the decisive assertion: a natural hand_end, never a hand_abort
      expect(p.handAbort).toBeNull();
      expect(p.handEnd!.handId).toBe(handId);
    }

    // settlement was durably persisted and reached its committed terminal, so
    // close neither aborted, refunded nor voided the live hand
    expect(srv.ctx.db.prepare('SELECT 1 FROM hand_settlements WHERE hand_id = ?').get(handId)).toBeTruthy();
    expect(
      (
        srv.ctx.db.prepare('SELECT status FROM hand_lifecycle WHERE hand_id = ?').get(handId) as {
          status: string;
        }
      ).status,
    ).toBe('committed');

    // no player is dealt into a next hand, even if the host asks for one
    const ends = players.map((p) => p.handEndCount);
    const starts = players.map((p) => p.handStartLog.length);
    host.send({ t: 'start_hand' });
    // Condition-based: wait for the server to reject the deal instead of a
    // fixed sleep, then assert no player was dealt in.
    await host.waitFor(() => host.errors.some((e) => /archived|closed/i.test(e)), 5000);
    expect(host.errors.some((e) => /archived|closed/i.test(e))).toBe(true);
    players.forEach((p, i) => {
      expect(p.handEndCount).toBe(ends[i]);
      expect(p.handStartLog.length).toBe(starts[i]);
    });
  }, 30000);

  it('fold-out ends the hand without any reveal', async () => {
    const { players, host } = await setupRoom(['host', 'bob'], ['fold-first', 'fold-first']);
    // heads-up: button/SB acts first and folds; BB wins blinds without showdown
    host.send({ t: 'start_hand' });
    await awaitHandEnd(players);
    for (const p of players) {
      expect(p.sawShowdown).toBe(false);
      expect(p.handAbort).toBeNull();
    }
    const deltas = players[0]!.handEnd!.deltas;
    expect(deltas.reduce((s, x) => s + x.delta, 0)).toBe(0);
    expect(Math.max(...deltas.map((d) => d.delta))).toBe(10); // BB wins the small blind
  });

  it('persists the settlement BEFORE the reveal hold, then broadcasts hand_end on expiry', async () => {
    const { players, room, host } = await setupRoom(['host', 'bob'], ['passive', 'passive']);
    srv.clock.freeze(); // take manual control of the settle hold
    host.send({ t: 'start_hand' });
    // the reveal is broadcast as soon as the hand settles...
    await host.waitFor(() => host.showdownAt !== null);
    const handId = host.handId!;
    const showdown = host.lastShowdown!;

    // ...but the terminal frame is still held: the durable write is decoupled
    // from the broadcast, so there is no "publicly revealed but unsettled" gap.
    expect(host.handEnd).toBeNull();
    expect(players[1]!.handEnd).toBeNull();

    // DB already holds the whole hand: settlement marker, ledger, transcript,
    // and the moved stacks - all before any `hand_end`.
    const marker = srv.ctx.db
      .prepare('SELECT hand_id FROM hand_settlements WHERE hand_id = ?')
      .get(handId) as { hand_id: string } | undefined;
    expect(marker?.hand_id).toBe(handId);
    const transcript = srv.ctx.db
      .prepare('SELECT head FROM transcripts WHERE hand_id = ?')
      .get(handId) as { head: string } | undefined;
    expect(transcript).toBeDefined();
    const settledStacks = srv.ctx.db
      .prepare('SELECT SUM(stack) AS total FROM room_players WHERE room_id = ?')
      .get(room.id) as { total: number };
    expect(settledStacks.total).toBe(2000);

    // release the hold: `hand_end` lands, carrying the same stacks/head
    srv.clock.advance(400);
    await host.waitFor(() => host.handEnd !== null);
    expect(host.handEnd!.handId).toBe(handId);
    expect(host.handEnd!.head).toBe(transcript!.head);
    expect(host.lastShowdown!.reveals).toEqual(showdown.reveals);
    expect(players[1]!.handEnd).not.toBeNull();

    const ledger = await host.api(`/api/rooms/${room.id}/ledger`);
    expect(ledger.verified.ok).toBe(true);
  }, 20000);

  it('a showdown frame precedes hand_end over the real socket (smoke)', async () => {
    const { players, host } = await setupRoom(['host', 'bob'], ['passive', 'passive']);
    host.send({ t: 'start_hand' });
    await awaitHandEnd(players);
    const p0 = players[0]!;
    expect(p0.sawShowdown).toBe(true);
    expect(p0.showdownAt).not.toBeNull();
    expect(p0.handEndAt).not.toBeNull();
    expect(p0.handEndAt!).toBeGreaterThanOrEqual(p0.showdownAt!);
  }, 20000);

  it('a fold-out skips the reveal and has no showdown hold', async () => {
    const { players, host } = await setupRoom(['host', 'bob'], ['fold-first', 'passive']);
    host.send({ t: 'start_hand' });
    await awaitHandEnd(players);
    const p0 = players[0]!;
    // no reveal frame at all, and settlement is not delayed by a showdown hold
    expect(p0.sawShowdown).toBe(false);
    expect(p0.showdownAt).toBeNull();
    expect(p0.handEnd).not.toBeNull();
  }, 20000);

  it('a shutdown during the hold keeps the durable settlement and drops only hand_end', async () => {
    const { players, room, host } = await setupRoom(['host', 'bob'], ['passive', 'passive']);
    srv.clock.freeze();
    host.send({ t: 'start_hand' });
    // wait for the reveal but NOT the settlement broadcast
    await host.waitFor(() => host.showdownAt !== null);
    const handId = host.handId!;
    expect(host.handEnd).toBeNull();

    // The settlement is already durable when the reveal goes out, so a crash /
    // shutdown in the hold can only lose the `hand_end` frame, never the hand.
    expect(
      srv.ctx.db.prepare('SELECT 1 FROM hand_settlements WHERE hand_id = ?').get(handId),
    ).toBeTruthy();

    void srv.hub.rooms.get(room.id)?.shutdown();
    // well past the hold: the timer was cancelled, so no hand_end...
    srv.clock.advance(5000);
    expect(host.handEnd).toBeNull();
    expect(players[1]!.handEnd).toBeNull();
    expect(activeHands.has(room.id)).toBe(false);
    // ...but the hand is fully recoverable from the database.
    expect(
      srv.ctx.db.prepare('SELECT head FROM transcripts WHERE hand_id = ?').get(handId),
    ).toBeTruthy();
    expect(
      (
        srv.ctx.db
          .prepare('SELECT COUNT(*) AS n FROM hand_settlements WHERE hand_id = ?')
          .get(handId) as { n: number }
      ).n,
    ).toBe(1);
  }, 20000);

  it('restarts onto the same DB and recovers the settlement written during the hold', async () => {
    const dir = mkdtempSync(join(tmpdir(), '4am-hold-'));
    const dbPath = join(dir, 'game.db');
    const saved = { ctx: srv.ctx, baseUrl: srv.baseUrl, hub: srv.hub };
    const app = createApp(dbPath);
    const appHub = attachHub(app.app, app.db, {
      cryptoTimeoutMs: 1500,
      actionTimeoutMs: 1500,
      autoDealMs: 3_600_000,
      readyCheckMs: 1500,
      showdownHoldMs: 400,
      settleHoldMs: 0,
      clock: srv.clock,
    });
    await app.app.listen({ port: 0 });
    const addr = app.app.server.address() as AddressInfo;
    srv.ctx = app;
    srv.hub = appHub;
    srv.baseUrl = `http://127.0.0.1:${addr.port}`;
    try {
      const { players, room, host } = await setupRoom(['ra', 'rb'], ['passive', 'passive']);
      srv.clock.freeze();
      host.send({ t: 'start_hand' });
      await host.waitFor(() => host.showdownAt !== null);
      const handId = host.handId!;
      expect(host.handEnd).toBeNull();
      // "crash" the box: no graceful hand_end, close the db handle
      for (const c of players) c.close();
      await app.app.close();

      // a fresh process opening the same file sees the settled hand
      const restarted = createApp(dbPath);
      const tr = restarted.db
        .prepare('SELECT head FROM transcripts WHERE hand_id = ?')
        .get(handId) as { head: string } | undefined;
      expect(tr).toBeDefined();
      expect(
        (
          restarted.db
            .prepare('SELECT COUNT(*) AS n FROM hand_settlements WHERE hand_id = ?')
            .get(handId) as { n: number }
        ).n,
      ).toBe(1);
      const total = restarted.db
        .prepare('SELECT SUM(stack) AS total FROM room_players WHERE room_id = ?')
        .get(room.id) as { total: number };
      expect(total.total).toBe(2000);
      await restarted.app.close();
    } finally {
      srv.ctx = saved.ctx;
      srv.baseUrl = saved.baseUrl;
      srv.hub = saved.hub;
    }
  }, 25000);

  it('a stalling player causes an abort that blames them and leaves stacks untouched', async () => {
    const { players, room, host } = await setupRoom(['host', 'bob', 'mallory']);
    players[2]!.respondShares = false; // mallory never answers unmask requests
    host.send({ t: 'start_hand' });
    await Promise.all(players.slice(0, 2).map((p) => p.waitFor(() => p.handAbort !== null, 20000)));
    expect(players[0]!.handAbort!.blamedSeat).toBe(2);
    const state = await host.api(`/api/rooms/${room.id}`);
    for (const p of state.players) expect(p.stack).toBe(1000);
  }, 20000);

  it('a disconnected player can rejoin during the grace window and the hand completes', async () => {
    const { players, room, host } = await setupRoom(['host', 'bob', 'flaky']);
    const flaky = players[2]!;
    flaky.respondShares = false; // simulates a device that missed the requests
    host.send({ t: 'start_hand' });
    await new Promise((r) => setTimeout(r, 2000)); // the deal is now stalled on flaky
    expect(host.handAbort).toBeNull();
    flaky.ws.close();
    flaky.respondShares = true;
    await flaky.connect(room.id); // rejoin: the server re-sends what it is waiting on
    await awaitHandEnd(players, 20000);
    for (const p of players) expect(p.handAbort).toBeNull();
    expect(flaky.myCards).toHaveLength(2);
  }, 20000);

  it('a folded player can voluntarily show cards while the hand continues', async () => {
    const { players, host } = await setupRoom(
      ['host', 'bob', 'carol'],
      ['fold-first', 'passive', 'passive'],
    );
    host.send({ t: 'start_hand' });
    await host.waitFor(() => host.lastRespondedActionSeq >= 0); // host has sent the fold
    await new Promise((r) => setTimeout(r, 200));
    host.showCards();
    await players[2]!.waitFor(() => players[2]!.cardsShown.length > 0);
    expect(players[2]!.cardsShown[0]!.seat).toBe(host.seat);
    expect(players[2]!.cardsShown[0]!.cards.slice().sort()).toEqual(host.myCards.slice().sort());
    await awaitHandEnd(players);
    expect(players[0]!.handAbort).toBeNull();
  });
});
