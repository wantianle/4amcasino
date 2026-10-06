import { describe, expect, it } from 'vitest';
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
import { awaitHandEnd } from './helpers/testRoom.js';
import { useIntegrationServer } from './helpers/integrationServer.js';

const srv = useIntegrationServer();

// Thin adapter onto the shared `setupRoom`, binding this file's server URL and
// client collector so the migrated call sites stay byte-identical.
const setupRoom = (names: string[], strategies: Strategy[] = []) =>
  createRoom(srv.baseUrl, names, strategies, srv.clients);

describe('full hand integration: paid peek', () => {
  it('a paid peek costs a fixed 1bb, reveals only to the buyer and is ledger-conserving', async () => {
    const { players, room, host } = await setupRoom(['host', 'bob'], ['fold-first', 'passive']);
    const [h, bob] = players as [TestClient, TestClient];
    host.send({ t: 'start_hand' });
    await awaitHandEnd(players);
    // park the table between hands: this test is about the peek, not auto-deal
    for (const p of players) p.send({ t: 'sit_out', sittingOut: true });

    // heads-up, host folded: bob pays the server-fixed 1bb (=bb=20) to see
    // host's mucked cards. The client's 100 is deliberately ignored.
    bob.send({ t: 'peek_offer', handId: bob.handId, targetSeat: h.seat, amount: 100 });
    await h.waitFor(() => h.peekOffers.length > 0);
    expect(h.peekOffers[0]!.amount).toBe(20);
    h.acceptPeek(h.peekOffers[0]!.offerId);
    await bob.waitFor(() => bob.peekResults.length > 0);

    const result = bob.peekResults[0]!;
    expect(result.status).toBe('accepted');
    expect(result.cards!.slice().sort()).toEqual(h.myCards.slice().sort());
    // the reveal went only to the buyer
    expect(h.peekResults).toHaveLength(0);
    expect(h.cardsShown).toHaveLength(0);

    // ...but the TARGET still gets a terminal receipt so its banner can close,
    // and that receipt is narrow: no reveal, no price.
    await h.waitFor(() => h.peekClosures.length > 0);
    const closure = h.peekClosures.at(-1)!;
    expect(closure.status).toBe('accepted');
    expect(closure.handId).toBe(bob.handId);
    expect(closure.raw.cards).toBeUndefined();
    expect(closure.raw.amount).toBeUndefined();
    // the buyer gets `peek_result`, never the target-only closure
    expect(bob.peekClosures).toHaveLength(0);

    // chips moved: bob paid host exactly 20 on top of the blind results
    const state = await host.api(`/api/rooms/${room.id}`);
    const stack = (name: string) => state.players.find((p: any) => p.username === name).stack;
    expect(stack('host')).toBe(1010); // folded the sb, then sold a look for 1bb
    expect(stack('bob')).toBe(990); // won the 10 blind, paid 20
    const ledger = await host.api(`/api/rooms/${room.id}/ledger`);
    expect(ledger.verified.ok).toBe(true);
    const peeks = ledger.entries.filter((e: any) => e.kind === 'peek');
    expect(peeks).toHaveLength(2);
    expect(peeks.reduce((s: number, e: any) => s + e.delta, 0)).toBe(0); // zero-sum
  });

  it('allows a ring fold-out peek but refuses cards already shown at showdown', async () => {
    // Ring: three players, fold-out. This used to be refused (not heads-up);
    // now any still-private participant is a valid target, so the winner can buy
    // a look at the folder's mucked cards.
    const ring = await setupRoom(['ra', 'rb', 'rc'], ['fold-first', 'fold-first', 'passive']);
    ring.host.send({ t: 'start_hand' });
    await Promise.all(ring.players.map((p) => p.waitFor(() => p.handEnd !== null)));
    for (const p of ring.players) p.send({ t: 'sit_out', sittingOut: true });
    const [ra, rb, rc] = ring.players as [TestClient, TestClient, TestClient];
    const targetSeat = ring.host.seat!;
    rc.errors = [];
    rc.send({ t: 'peek_offer', handId: rc.handId, targetSeat });
    await ra.waitFor(() => ra.peekOffers.length > 0);
    expect(rc.errors).toHaveLength(0);
    ra.acceptPeek(ra.peekOffers[0]!.offerId);
    await rc.waitFor(() => rc.peekResults.length > 0);
    expect(rc.peekResults.at(-1)!.status).toBe('accepted');
    expect(rc.peekResults.at(-1)!.cards!.slice().sort()).toEqual(ra.myCards.slice().sort());
    // the third player never receives the reveal
    expect(rb.peekResults).toHaveLength(0);
    expect(rb.peekOffers).toHaveLength(0);

    // Showdown: the players who showed have no private cards left to sell.
    const hu = await setupRoom(['sa', 'sb'], ['passive', 'passive']);
    hu.host.send({ t: 'start_hand' });
    await Promise.all(hu.players.map((p) => p.waitFor(() => p.handEnd !== null)));
    for (const p of hu.players) p.send({ t: 'sit_out', sittingOut: true });
    const sb = hu.players[1]!;
    sb.errors = [];
    sb.send({ t: 'peek_offer', handId: sb.handId, targetSeat: hu.host.seat });
    await sb.waitFor(() => sb.errors.length > 0);
    expect(sb.errors[0]).toMatch(/already public/i);
    expect(hu.players[0]!.peekOffers).toHaveLength(0);
  }, 25000);

  it('refuses a peek for a hand that is not the last one', async () => {
    const { players, host } = await setupRoom(['host', 'bob'], ['fold-first', 'passive']);
    const [h, bob] = players as [TestClient, TestClient];
    host.send({ t: 'start_hand' });
    await awaitHandEnd(players);
    for (const p of players) p.send({ t: 'sit_out', sittingOut: true });
    bob.errors = [];
    bob.send({ t: 'peek_offer', handId: 'deadbeef', targetSeat: h.seat });
    await bob.waitFor(() => bob.errors.length > 0);
    expect(bob.errors[0]).toMatch(/between hands|no such hand|last hand/i);
  });

  it('expires an unanswered peek offer after the 5s contract and tells the requester', async () => {
    const { players, host } = await setupRoom(['host', 'bob'], ['fold-first', 'passive']);
    const [h, bob] = players as [TestClient, TestClient];
    host.send({ t: 'start_hand' });
    await awaitHandEnd(players);
    for (const p of players) p.send({ t: 'sit_out', sittingOut: true });

    bob.send({ t: 'peek_offer', handId: bob.handId, targetSeat: h.seat });
    await h.waitFor(() => h.peekOffers.length > 0);
    // the target never answers (disconnected/ignoring): the offer must lapse
    await bob.waitFor(() => bob.peekResults.length > 0, 9000);
    expect(bob.peekResults.at(-1)!.status).toBe('expired');
    // the ignoring target is told too, so it can withdraw the pending offer
    await h.waitFor(() => h.peekClosures.length > 0);
    expect(h.peekClosures.at(-1)!.status).toBe('expired');
    expect(h.peekClosures.at(-1)!.raw.cards).toBeUndefined();
    // answering the lapsed id is rejected, not silently accepted
    h.errors = [];
    h.acceptPeek(h.peekOffers[0]!.offerId);
    await h.waitFor(() => h.errors.length > 0);
    expect(h.errors[0]).toMatch(/gone/i);
  }, 15000);

  it('fails the peek explicitly when the buyer cannot pay at accept time', async () => {
    const { players, room, host } = await setupRoom(['host', 'bob'], ['fold-first', 'passive']);
    const [h, bob] = players as [TestClient, TestClient];
    host.send({ t: 'start_hand' });
    await awaitHandEnd(players);
    for (const p of players) p.send({ t: 'sit_out', sittingOut: true });

    bob.send({ t: 'peek_offer', handId: bob.handId, targetSeat: h.seat });
    await h.waitFor(() => h.peekOffers.length > 0);
    // the buyer spends/loses chips after offering: the accept must not silently
    // hang the requester - it gets an explicit failed result.
    srv.ctx.db
      .prepare('UPDATE room_players SET stack = 0 WHERE room_id = ? AND user_id = ?')
      .run(room.id, bob.userId);
    h.acceptPeek(h.peekOffers[0]!.offerId);
    await bob.waitFor(() => bob.peekResults.length > 0);
    expect(bob.peekResults.at(-1)!.status).toBe('failed');
    // not public: the reveal never reached the buyer
    expect(bob.peekResults.at(-1)!.cards).toBeUndefined();
    // the target that answered is told the accept failed, not left hanging
    await h.waitFor(() => h.peekClosures.length > 0);
    expect(h.peekClosures.at(-1)!.status).toBe('failed');
    expect(h.peekClosures.at(-1)!.raw.cards).toBeUndefined();
    expect(h.peekClosures.at(-1)!.raw.amount).toBeUndefined();
  }, 20000);

  it('allows a peek with exactly 1bb and rejects one chip short', async () => {
    const first = await setupRoom(['h1a', 'b1a'], ['fold-first', 'passive']);
    first.host.send({ t: 'start_hand' });
    await Promise.all(first.players.map((p) => p.waitFor(() => p.handEnd !== null)));
    for (const p of first.players) p.send({ t: 'sit_out', sittingOut: true });
    const h1 = first.players[0]!;
    const b1 = first.players[1]!;
    srv.ctx.db
      .prepare('UPDATE room_players SET stack = 20 WHERE room_id = ? AND user_id = ?')
      .run(first.room.id, b1.userId);
    b1.send({ t: 'peek_offer', handId: b1.handId, targetSeat: h1.seat });
    await h1.waitFor(() => h1.peekOffers.length > 0);
    expect(h1.peekOffers).toHaveLength(1);
    // exactly 1bb is enough: the offer must be answerable and the payment complete
    h1.acceptPeek(h1.peekOffers[0]!.offerId);
    await b1.waitFor(() => b1.peekResults.length > 0);
    expect(b1.peekResults.at(-1)!.status).toBe('accepted');
    expect(b1.peekResults.at(-1)!.cards!.slice().sort()).toEqual(h1.myCards.slice().sort());
    const stack1 = (u: number) =>
      (
        srv.ctx.db
          .prepare('SELECT stack FROM room_players WHERE room_id = ? AND user_id = ?')
          .get(first.room.id, u) as { stack: number }
      ).stack;
    expect(stack1(b1.userId)).toBe(0);
    expect(stack1(h1.userId)).toBe(1010);
    const peekRows1 = srv.ctx.db
      .prepare("SELECT delta FROM ledger WHERE room_id = ? AND kind = 'peek'")
      .all(first.room.id) as { delta: number }[];
    expect(peekRows1.reduce((s, r) => s + r.delta, 0)).toBe(0);

    const second = await setupRoom(['h2a', 'b2b'], ['fold-first', 'passive']);
    second.host.send({ t: 'start_hand' });
    await Promise.all(second.players.map((p) => p.waitFor(() => p.handEnd !== null)));
    for (const p of second.players) p.send({ t: 'sit_out', sittingOut: true });
    const h2 = second.players[0]!;
    const b2 = second.players[1]!;
    srv.ctx.db
      .prepare('UPDATE room_players SET stack = 19 WHERE room_id = ? AND user_id = ?')
      .run(second.room.id, b2.userId);
    b2.errors = [];
    b2.send({ t: 'peek_offer', handId: b2.handId, targetSeat: h2.seat });
    await b2.waitFor(() => b2.errors.length > 0);
    expect(b2.errors[0]).toMatch(/enough chips/i);
    expect(h2.peekOffers).toHaveLength(0);
  }, 25000);

  it('a declined, badly-signed, badly-proven, or superseded peek sends exactly one result and moves no chips', async () => {
    const { players, room, host } = await setupRoom(['host', 'bob'], ['fold-first', 'passive']);
    // disable auto-deal so an offer can be exercised across the between-hands window
    srv.ctx.db.prepare('UPDATE rooms SET auto_deal = 0 WHERE id = ?').run(room.id);
    const [h, bob] = players as [TestClient, TestClient];
    host.send({ t: 'start_hand' });
    await awaitHandEnd(players);
    for (const p of players) p.send({ t: 'sit_out', sittingOut: true });

    const peekLedger = () =>
      (
        srv.ctx.db
          .prepare("SELECT COUNT(*) AS n FROM ledger WHERE room_id = ? AND kind = 'peek'")
          .get(room.id) as { n: number }
      ).n;
    const stacks = () =>
      (
        srv.ctx.db
          .prepare('SELECT user_id, stack FROM room_players WHERE room_id = ? ORDER BY user_id')
          .all(room.id) as { user_id: number; stack: number }[]
      );
    const before = stacks();

    // decline: one terminal receipt, no money
    bob.send({ t: 'peek_offer', handId: bob.handId, targetSeat: h.seat });
    await h.waitFor(() => h.peekOffers.length > 0);
    h.declinePeek(h.peekOffers.at(-1)!.offerId);
    await bob.waitFor(() => bob.peekResults.length > 0);
    expect(bob.peekResults.at(-1)!.status).toBe('declined');
    await h.waitFor(() => h.peekClosures.length > 0);
    expect(h.peekClosures.at(-1)!.status).toBe('declined');
    // a second answer is rejected and never yields a second receipt
    h.errors = [];
    h.declinePeek(h.peekOffers.at(-1)!.offerId);
    await h.waitFor(() => h.errors.length > 0);
    expect(bob.peekResults).toHaveLength(1);

    // bad signature: explicit failure, no money
    bob.send({ t: 'peek_offer', handId: bob.handId, targetSeat: h.seat });
    await h.waitFor(() => h.peekOffers.length > 1);
    h.acceptPeekBadSig(h.peekOffers.at(-1)!.offerId);
    await bob.waitFor(() => bob.peekResults.length > 1);
    expect(bob.peekResults.at(-1)!.status).toBe('failed');
    expect(bob.peekResults).toHaveLength(2);
    await h.waitFor(() => h.peekClosures.length > 1);
    expect(h.peekClosures.at(-1)!.status).toBe('failed');

    // bad proof: explicit failure, no money
    bob.send({ t: 'peek_offer', handId: bob.handId, targetSeat: h.seat });
    await h.waitFor(() => h.peekOffers.length > 2);
    h.acceptPeekBadProof(h.peekOffers.at(-1)!.offerId);
    await bob.waitFor(() => bob.peekResults.length > 2);
    expect(bob.peekResults.at(-1)!.status).toBe('failed');
    expect(bob.peekResults.at(-1)!.cards).toBeUndefined();
    await h.waitFor(() => h.peekClosures.length > 2);
    expect(h.peekClosures.at(-1)!.status).toBe('failed');

    expect(peekLedger()).toBe(0);
    expect(stacks()).toEqual(before);

    // a new hand supersedes an open offer with exactly one expiry receipt
    bob.send({ t: 'peek_offer', handId: bob.handId, targetSeat: h.seat });
    await h.waitFor(() => h.peekOffers.length > 3);
    for (const p of players) p.send({ t: 'sit_out', sittingOut: false });
    await Promise.all(
      players.map((p) =>
        p.waitFor(
          () =>
            p.roomState?.players.find((x) => x.userId === p.userId)?.sittingOut === false,
          3000,
        ),
      ),
    );
    host.send({ t: 'start_hand' });
    await bob.waitFor(() => bob.peekResults.length > 3, 5000);
    expect(bob.peekResults.at(-1)!.status).toBe('expired');
    expect(bob.peekResults).toHaveLength(4);
    // The target saw exactly one terminal receipt per offer it was asked to
    // answer: declined, then two failures, then the superseded offer expired.
    expect(h.peekClosures.map((c) => c.status)).toEqual([
      'declined',
      'failed',
      'failed',
      'expired',
    ]);
    // none of them carried the buyer-only reveal/price payload
    for (const c of h.peekClosures) {
      expect(c.raw.cards).toBeUndefined();
      expect(c.raw.amount).toBeUndefined();
    }
    expect(peekLedger()).toBe(0);
  }, 30000);

  it('a target that reconnects after its offer expired is cleared by the snapshot', async () => {
    const { players, room, host } = await setupRoom(['host', 'bob'], ['fold-first', 'passive']);
    srv.ctx.db.prepare('UPDATE rooms SET auto_deal = 0 WHERE id = ?').run(room.id);
    const [h, bob] = players as [TestClient, TestClient];
    host.send({ t: 'start_hand' });
    await awaitHandEnd(players);
    for (const p of players) p.send({ t: 'sit_out', sittingOut: true });

    bob.send({ t: 'peek_offer', handId: bob.handId, targetSeat: h.seat });
    await h.waitFor(() => h.peekOffers.length > 0);
    const offerId = h.peekOffers[0]!.offerId;

    // The target loses the socket BEFORE the offer resolves, so the terminal
    // `peek_offer_closed` has nowhere to go and is dropped (the v1 bug).
    h.disconnect();
    await bob.waitFor(() => bob.peekResults.length > 0, 9000);
    expect(bob.peekResults.at(-1)!.status).toBe('expired');
    expect(h.peekClosures.find((c) => c.offerId === offerId)).toBeUndefined();

    // Reconnect: the server re-asserts the (now empty) open-offer set, and the
    // client drops the stale banner. This is the reconnect-safe clearing.
    const before = h.peekSnapshots.length;
    await h.connect(room.id);
    await h.waitFor(() => h.peekSnapshots.length > before);
    const snap = h.peekSnapshots.at(-1)!;
    expect(snap.incomingOfferIds).toEqual([]);
    expect(h.peekOffers.find((o) => o.offerId === offerId)).toBeUndefined();
    // narrow: no buyer-only or identifying payload on the resync frame
    expect(snap.raw.cards).toBeUndefined();
    expect(snap.raw.amount).toBeUndefined();
    expect(snap.raw.fromUserId).toBeUndefined();
    expect(snap.raw.fromName).toBeUndefined();
  }, 20000);

  it('a still-open offer is reasserted over a replacement socket and stays answerable', async () => {
    const { players, room, host } = await setupRoom(['host', 'bob'], ['fold-first', 'passive']);
    srv.ctx.db.prepare('UPDATE rooms SET auto_deal = 0 WHERE id = ?').run(room.id);
    const [h, bob] = players as [TestClient, TestClient];
    host.send({ t: 'start_hand' });
    await awaitHandEnd(players);
    for (const p of players) p.send({ t: 'sit_out', sittingOut: true });

    bob.send({ t: 'peek_offer', handId: bob.handId, targetSeat: h.seat });
    await h.waitFor(() => h.peekOffers.length > 0);
    const offerId = h.peekOffers[0]!.offerId;

    // A fresh socket replaces the old one while the offer is still within TTL.
    const before = h.peekSnapshots.length;
    await h.connect(room.id);
    await h.waitFor(() => h.peekSnapshots.length > before);
    const snap = h.peekSnapshots.at(-1)!;
    expect(snap.incomingOfferIds).toEqual([offerId]);
    // the pending banner survived reconciliation...
    expect(h.peekOffers.map((o) => o.offerId)).toContain(offerId);
    // ...and the offer can still be answered over the NEW socket
    h.acceptPeek(offerId);
    await bob.waitFor(() => bob.peekResults.length > 0);
    expect(bob.peekResults.at(-1)!.status).toBe('accepted');
    expect(bob.peekResults.at(-1)!.cards!.slice().sort()).toEqual(h.myCards.slice().sort());
    // the terminal closure also reaches the replacement socket
    await h.waitFor(() => h.peekClosures.length > 0);
    expect(h.peekClosures.at(-1)!.status).toBe('accepted');
  }, 20000);

  it('a room shutdown tells a still-connected target its offer is over', async () => {
    const { players, room, host } = await setupRoom(['host', 'bob'], ['fold-first', 'passive']);
    srv.ctx.db.prepare('UPDATE rooms SET auto_deal = 0 WHERE id = ?').run(room.id);
    const [h, bob] = players as [TestClient, TestClient];
    host.send({ t: 'start_hand' });
    await awaitHandEnd(players);
    for (const p of players) p.send({ t: 'sit_out', sittingOut: true });

    bob.send({ t: 'peek_offer', handId: bob.handId, targetSeat: h.seat });
    await h.waitFor(() => h.peekOffers.length > 0);

    await srv.hub.rooms.get(room.id)!.shutdown();
    await h.waitFor(() => h.peekClosures.length > 0);
    const closure = h.peekClosures.at(-1)!;
    expect(closure.status).toBe('expired');
    expect(closure.raw.cards).toBeUndefined();
    expect(closure.raw.amount).toBeUndefined();
    // the requester is told too, so it never waits forever
    await bob.waitFor(() => bob.peekResults.length > 0);
    expect(bob.peekResults.at(-1)!.status).toBe('expired');
  }, 20000);

  it('an idle-reclaimed room clears a pending target banner on reconnect', async () => {
    const { players, room, host } = await setupRoom(['host', 'bob'], ['fold-first', 'passive']);
    srv.ctx.db.prepare('UPDATE rooms SET auto_deal = 0 WHERE id = ?').run(room.id);
    const [h, bob] = players as [TestClient, TestClient];
    host.send({ t: 'start_hand' });
    await awaitHandEnd(players);
    for (const p of players) p.send({ t: 'sit_out', sittingOut: true });

    bob.send({ t: 'peek_offer', handId: bob.handId, targetSeat: h.seat });
    await h.waitFor(() => h.peekOffers.length > 0);
    const offerId = h.peekOffers[0]!.offerId;

    // Everyone drops: the hub reclaims the idle GameRoom, which runs the same
    // shutdown path the process preClose uses. There is no socket to notify.
    h.disconnect();
    bob.disconnect();
    await h.waitFor(() => srv.hub.rooms.get(room.id) === undefined, 5000);

    // A new socket rebuilds the room with no offers; the empty snapshot clears
    // the banner (this is the cross-instance / restart boundary).
    const before = h.peekSnapshots.length;
    await h.connect(room.id);
    await h.waitFor(() => h.peekSnapshots.length > before);
    const snap = h.peekSnapshots.at(-1)!;
    expect(snap.incomingOfferIds).toEqual([]);
    expect(h.peekOffers.find((o) => o.offerId === offerId)).toBeUndefined();
    expect(snap.raw.cards).toBeUndefined();
    expect(snap.raw.amount).toBeUndefined();
    expect(snap.raw.fromUserId).toBeUndefined();
  }, 20000);

  it('a player who left their seat cannot buy a peek, but a seated player still can', async () => {
    const ring = await setupRoom(
      ['la', 'lb', 'lc'],
      ['fold-first', 'fold-first', 'passive'],
    );
    ring.host.send({ t: 'start_hand' });
    await Promise.all(ring.players.map((p) => p.waitFor(() => p.handEnd !== null)));
    for (const p of ring.players) p.send({ t: 'sit_out', sittingOut: true });
    // one participant walks away from their seat
    const leaver = ring.players[0]!;
    leaver.send({ t: 'leave_seat' });
    await leaver.waitFor(
      () => leaver.roomState?.players.find((p) => p.userId === leaver.userId)?.seat === null,
      5000,
    );
    const target = ring.players[1]!;
    // no seat means no stake: the leaver may not buy a look
    leaver.errors = [];
    leaver.send({ t: 'peek_offer', handId: leaver.handId, targetSeat: target.seat! });
    await leaver.waitFor(() => leaver.errors.length > 0);
    expect(leaver.errors[0]).toMatch(/seated/i);
    // a still-seated player can still buy the folded target's cards
    const rc = ring.players[2]!;
    rc.errors = [];
    rc.send({ t: 'peek_offer', handId: rc.handId, targetSeat: target.seat! });
    await target.waitFor(() => target.peekOffers.length > 0);
    expect(rc.errors).toHaveLength(0);
    target.acceptPeek(target.peekOffers[0]!.offerId);
    await rc.waitFor(() => rc.peekResults.length > 0);
    expect(rc.peekResults.at(-1)!.status).toBe('accepted');
    expect(rc.peekResults.at(-1)!.cards!.slice().sort()).toEqual(target.myCards.slice().sort());
  }, 25000);

  it('a folder can buy a look at the still-private winner (the requester is the folder)', async () => {
    const { players, room, host } = await setupRoom(['host', 'bob'], ['fold-first', 'passive']);
    srv.ctx.db.prepare('UPDATE rooms SET auto_deal = 0 WHERE id = ?').run(room.id);
    const [h, bob] = players as [TestClient, TestClient];
    host.send({ t: 'start_hand' });
    await awaitHandEnd(players);
    for (const p of players) p.send({ t: 'sit_out', sittingOut: true });

    // The user's example: host folded, bob won, and host pays to see bob's
    // cards (which were never shown because the hand ended by a fold).
    h.errors = [];
    h.send({ t: 'peek_offer', handId: h.handId, targetSeat: bob.seat! });
    await bob.waitFor(() => bob.peekOffers.length > 0);
    expect(h.errors).toHaveLength(0);
    expect(bob.peekOffers.at(-1)!.fromUserId).toBe(h.userId);
    bob.acceptPeek(bob.peekOffers[0]!.offerId);
    await h.waitFor(() => h.peekResults.length > 0);
    expect(h.peekResults.at(-1)!.status).toBe('accepted');
    expect(h.peekResults.at(-1)!.cards!.slice().sort()).toEqual(bob.myCards.slice().sort());
    // the target sees only its closure, never the revealed cards
    await bob.waitFor(() => bob.peekClosures.length > 0);
    expect(bob.peekClosures.at(-1)!.status).toBe('accepted');
    expect(bob.peekClosures.at(-1)!.raw.cards).toBeUndefined();
  }, 20000);

  it('a seated player who sat the hand out can still buy a look', async () => {
    const { players, room, host } = await setupRoom(['na', 'nb', 'nc']);
    srv.ctx.db.prepare('UPDATE rooms SET auto_deal = 0 WHERE id = ?').run(room.id);
    const [na, nb, nc] = players as [TestClient, TestClient, TestClient];
    // nc sits the hand out: only na and nb are dealt in
    nc.send({ t: 'sit_out', sittingOut: true });
    await nc.waitFor(
      () => nc.roomState?.players.find((p) => p.userId === nc.userId)?.sittingOut === true,
      3000,
    );
    na.strategy = 'fold-first';
    na.send({ t: 'start_hand' });
    await awaitHandEnd(players, 15000);
    expect(na.handEnd!.stacks.map((s) => s.seat).sort()).toEqual([0, 1]);

    // nc holds a seat but took no part in the hand, so it may still buy nb's
    // mucked cards (its hand id comes from the broadcast `hand_end`).
    nc.errors = [];
    nc.send({ t: 'peek_offer', handId: nc.handEnd!.handId, targetSeat: nb.seat! });
    await nb.waitFor(() => nb.peekOffers.length > 0);
    expect(nc.errors).toHaveLength(0);
    nb.acceptPeek(nb.peekOffers[0]!.offerId);
    await nc.waitFor(() => nc.peekResults.length > 0);
    expect(nc.peekResults.at(-1)!.status).toBe('accepted');
    expect(nc.peekResults.at(-1)!.cards!.slice().sort()).toEqual(nb.myCards.slice().sort());
  }, 25000);

  it('allows several parallel offers to the same target and settles each independently', async () => {
    const { players, room, host } = await setupRoom(
      ['pa', 'pb', 'pc'],
      ['fold-first', 'fold-first', 'passive'],
    );
    srv.ctx.db.prepare('UPDATE rooms SET auto_deal = 0 WHERE id = ?').run(room.id);
    host.send({ t: 'start_hand' });
    await awaitHandEnd(players);
    for (const p of players) p.send({ t: 'sit_out', sittingOut: true });
    const [pa, pb, pc] = players as [TestClient, TestClient, TestClient];

    const stackOf = (uid: number) =>
      (
        srv.ctx.db
          .prepare('SELECT stack FROM room_players WHERE room_id = ? AND user_id = ?')
          .get(room.id, uid) as { stack: number }
      ).stack;
    const before = { pa: stackOf(pa.userId), pb: stackOf(pb.userId), pc: stackOf(pc.userId) };
    const bb = room.bb;

    // two different requesters target the same folder concurrently
    pc.send({ t: 'peek_offer', handId: pc.handId, targetSeat: pa.seat! });
    pb.send({ t: 'peek_offer', handId: pb.handId, targetSeat: pa.seat! });
    await pa.waitFor(() => pa.peekOffers.length === 2);
    const pcOffer = pa.peekOffers.find((o) => o.fromUserId === pc.userId)!;
    const pbOffer = pa.peekOffers.find((o) => o.fromUserId === pb.userId)!;
    expect(pcOffer).toBeTruthy();
    expect(pbOffer).toBeTruthy();
    expect(pcOffer.offerId).not.toBe(pbOffer.offerId);

    // accept BOTH: each offer settles independently and only its own buyer sees
    // pa's cards
    pa.acceptPeek(pcOffer.offerId);
    await pc.waitFor(() => pc.peekResults.length > 0);
    expect(pc.peekResults.at(-1)!.status).toBe('accepted');
    expect(pc.peekResults.at(-1)!.cards!.slice().sort()).toEqual(pa.myCards.slice().sort());
    pa.acceptPeek(pbOffer.offerId);
    await pb.waitFor(() => pb.peekResults.length > 0);
    expect(pb.peekResults.at(-1)!.status).toBe('accepted');
    expect(pb.peekResults.at(-1)!.cards!.slice().sort()).toEqual(pa.myCards.slice().sort());
    // both offers are terminally closed for the target, and it never received
    // a reveal of its own cards
    await pa.waitFor(() => pa.peekClosures.length === 2);
    expect(pa.peekClosures.map((c) => c.status)).toEqual(['accepted', 'accepted']);
    expect(pa.peekResults).toHaveLength(0);

    // exact ledger shape: two requester -bb rows and two target +bb rows
    const peekRows = srv.ctx.db
      .prepare(
        "SELECT user_id, delta FROM ledger WHERE room_id = ? AND kind = 'peek' ORDER BY user_id, delta",
      )
      .all(room.id) as { user_id: number; delta: number }[];
    expect(peekRows).toHaveLength(4);
    expect(peekRows.filter((r) => r.user_id === pc.userId)).toEqual([
      { user_id: pc.userId, delta: -bb },
    ]);
    expect(peekRows.filter((r) => r.user_id === pb.userId)).toEqual([
      { user_id: pb.userId, delta: -bb },
    ]);
    expect(peekRows.filter((r) => r.user_id === pa.userId)).toEqual([
      { user_id: pa.userId, delta: bb },
      { user_id: pa.userId, delta: bb },
    ]);
    // stacks match the two settled transfers
    expect(stackOf(pa.userId)).toBe(before.pa + 2 * bb);
    expect(stackOf(pc.userId)).toBe(before.pc - bb);
    expect(stackOf(pb.userId)).toBe(before.pb - bb);
  }, 25000);

  it('refuses a peek when the target shows its cards after the offer was made', async () => {
    const { players, room, host } = await setupRoom(['host', 'bob'], ['fold-first', 'passive']);
    srv.ctx.db.prepare('UPDATE rooms SET auto_deal = 0 WHERE id = ?').run(room.id);
    const [h, bob] = players as [TestClient, TestClient];
    host.send({ t: 'start_hand' });
    await awaitHandEnd(players);
    for (const p of players) p.send({ t: 'sit_out', sittingOut: true });

    const peekLedger = () =>
      (
        srv.ctx.db
          .prepare("SELECT COUNT(*) AS n FROM ledger WHERE room_id = ? AND kind = 'peek'")
          .get(room.id) as { n: number }
      ).n;
    const stacks = () =>
      srv.ctx.db
        .prepare('SELECT user_id, stack FROM room_players WHERE room_id = ? ORDER BY user_id')
        .all(room.id) as { user_id: number; stack: number }[];
    const before = stacks();
    expect(peekLedger()).toBe(0);

    // host (the folder) offers to see bob's (the winner's) still-private cards
    h.send({ t: 'peek_offer', handId: h.handId, targetSeat: bob.seat! });
    await bob.waitFor(() => bob.peekOffers.length > 0);
    const offerId = bob.peekOffers[0]!.offerId;

    // bob voluntarily shows before answering: the cards are public now
    bob.showCards();
    await h.waitFor(() => h.cardsShown.length > 0);
    expect(h.cardsShown.at(-1)!.seat).toBe(bob.seat);

    // accepting the stale offer must fail before any money moves
    bob.errors = [];
    bob.acceptPeek(offerId);
    await h.waitFor(() => h.peekResults.length > 0);
    expect(h.peekResults.at(-1)!.status).toBe('failed');
    expect(h.peekResults.at(-1)!.cards).toBeUndefined();
    await bob.waitFor(() => bob.peekClosures.length > 0);
    expect(bob.peekClosures.at(-1)!.status).toBe('failed');
    await bob.waitFor(() => bob.errors.length > 0);
    expect(bob.errors[0]).toMatch(/already public/i);

    // no transfer, no stack change
    expect(peekLedger()).toBe(0);
    expect(stacks()).toEqual(before);
  }, 25000);

  it('refuses a spectator peek explicitly instead of dropping it', async () => {
    const { players, room, host } = await setupRoom(['sa', 'sb'], ['fold-first', 'passive']);
    srv.ctx.db.prepare('UPDATE rooms SET auto_deal = 0 WHERE id = ?').run(room.id);
    // a watch-only observer: a `spectators` row and NO `room_players` row
    const link = await host.api(`/api/rooms/${room.id}/spectate-settings`, { allow: true });
    const spec = new TestClient(srv.baseUrl, 'watcher');
    srv.clients.push(spec);
    await spec.register();
    const watch = await spec.api(`/api/watch/${link.token}`);
    expect(watch.roomId).toBe(room.id);

    const [h, bob] = players as [TestClient, TestClient];
    host.send({ t: 'start_hand' });
    await awaitHandEnd(players);
    for (const p of players) p.send({ t: 'sit_out', sittingOut: true });
    await spec.connect(room.id);

    const peekLedger = () =>
      (
        srv.ctx.db
          .prepare("SELECT COUNT(*) AS n FROM ledger WHERE room_id = ? AND kind = 'peek'")
          .get(room.id) as { n: number }
      ).n;
    expect(peekLedger()).toBe(0);

    spec.errors = [];
    spec.send({ t: 'peek_offer', handId: h.handEnd!.handId, targetSeat: bob.seat! });
    await spec.waitFor(() => spec.errors.length > 0);
    expect(spec.errors[0]).toMatch(/seated/i);
    // nothing was created for the target and nothing moved
    expect(bob.peekOffers).toHaveLength(0);
    expect(peekLedger()).toBe(0);
  }, 25000);

  it('refuses a peek accepted after the buyer left their seat, moving no money', async () => {
    const { players, room, host } = await setupRoom(['host', 'bob'], ['fold-first', 'passive']);
    srv.ctx.db.prepare('UPDATE rooms SET auto_deal = 0 WHERE id = ?').run(room.id);
    const [h, bob] = players as [TestClient, TestClient];
    host.send({ t: 'start_hand' });
    await awaitHandEnd(players);
    for (const p of players) p.send({ t: 'sit_out', sittingOut: true });

    const peekLedger = () =>
      (
        srv.ctx.db
          .prepare("SELECT COUNT(*) AS n FROM ledger WHERE room_id = ? AND kind = 'peek'")
          .get(room.id) as { n: number }
      ).n;
    const stacks = () =>
      srv.ctx.db
        .prepare('SELECT user_id, stack FROM room_players WHERE room_id = ? ORDER BY user_id')
        .all(room.id) as { user_id: number; stack: number }[];
    const before = stacks();

    // host (the requester) offers to see bob's still-private cards
    h.send({ t: 'peek_offer', handId: h.handId, targetSeat: bob.seat! });
    await bob.waitFor(() => bob.peekOffers.length > 0);
    const offerId = bob.peekOffers[0]!.offerId;

    // host leaves their seat while the offer is pending: the client will drop a
    // reveal once `seat` is null, so the server must not charge it
    h.send({ t: 'leave_seat' });
    await h.waitFor(
      () => h.roomState?.players.find((p) => p.userId === h.userId)?.seat === null,
      5000,
    );
    // Explicitly: the offer is NOT cleaned up on leave, it is still pending for
    // bob. This distinguishes the acceptance-time seat gate from an eager
    // "leave closes outgoing offers" implementation - the latter would have
    // dropped the offer here and the accept below would be `that offer is gone`.
    expect(bob.peekOffers.map((o) => o.offerId)).toContain(offerId);

    // bob (the target) accepts within the 5s TTL: the seat re-check fails it
    bob.errors = [];
    bob.acceptPeek(offerId);
    await h.waitFor(() => h.peekResults.length > 0);
    expect(h.peekResults.at(-1)!.status).toBe('failed');
    expect(h.peekResults.at(-1)!.cards).toBeUndefined();
    await bob.waitFor(() => bob.peekClosures.length > 0);
    expect(bob.peekClosures.at(-1)!.status).toBe('failed');
    await bob.waitFor(() => bob.errors.length > 0);
    expect(bob.errors[0]).toMatch(/no longer seated/i);

    // no transfer, no stack change
    expect(peekLedger()).toBe(0);
    expect(stacks()).toEqual(before);
  }, 25000);

  it('refuses a peek when the buyer membership row is gone, moving no money', async () => {
    const { players, room, host } = await setupRoom(['host', 'bob'], ['fold-first', 'passive']);
    srv.ctx.db.prepare('UPDATE rooms SET auto_deal = 0 WHERE id = ?').run(room.id);
    const [h, bob] = players as [TestClient, TestClient];
    host.send({ t: 'start_hand' });
    await awaitHandEnd(players);
    for (const p of players) p.send({ t: 'sit_out', sittingOut: true });

    const peekLedger = () =>
      (
        srv.ctx.db
          .prepare("SELECT COUNT(*) AS n FROM ledger WHERE room_id = ? AND kind = 'peek'")
          .get(room.id) as { n: number }
      ).n;
    const stackOf = (uid: number) =>
      (
        srv.ctx.db
          .prepare('SELECT stack FROM room_players WHERE room_id = ? AND user_id = ?')
          .get(room.id, uid) as { stack: number }
      ).stack;
    const bobStackBefore = stackOf(bob.userId);

    // host (the requester) offers to see bob's still-private cards
    h.send({ t: 'peek_offer', handId: h.handId, targetSeat: bob.seat! });
    await bob.waitFor(() => bob.peekOffers.length > 0);
    const offerId = bob.peekOffers[0]!.offerId;

    // The requester's membership row disappears entirely (an account merge or
    // an eviction, not merely `seat = NULL`), so there is no buyer to authorize.
    srv.ctx.db
      .prepare('DELETE FROM room_players WHERE room_id = ? AND user_id = ?')
      .run(room.id, h.userId);
    expect(
      srv.ctx.db
        .prepare('SELECT 1 FROM room_players WHERE room_id = ? AND user_id = ?')
        .get(room.id, h.userId),
    ).toBeUndefined();

    // bob accepts within the 5s TTL: the missing buyer row fails the offer
    bob.errors = [];
    bob.acceptPeek(offerId);
    await h.waitFor(() => h.peekResults.length > 0);
    expect(h.peekResults.at(-1)!.status).toBe('failed');
    expect(h.peekResults.at(-1)!.cards).toBeUndefined();
    await bob.waitFor(() => bob.peekClosures.length > 0);
    expect(bob.peekClosures.at(-1)!.status).toBe('failed');
    await bob.waitFor(() => bob.errors.length > 0);
    expect(bob.errors[0]).toMatch(/no longer seated/i);

    // no transfer, and the remaining player's stack is untouched
    expect(peekLedger()).toBe(0);
    expect(stackOf(bob.userId)).toBe(bobStackBefore);
  }, 25000);
});
