import { describe, expect, it } from 'vitest';
import {
  metricsFrom,
  replayHand,
} from '../scripts/decision-stats-lib.mjs';

/**
 * Pins the numerator/denominator contract of the decision-stats reconstruction.
 * The whole point of the tool is that a ratio is over *opportunities*, so the
 * cases below deliberately distinguish:
 *   - RFI from a limped pot (a limp in front is not an RFI opportunity),
 *   - fold-to-bet from a checked-to fold (impossible) and from "all folds",
 *   - an auto timeout from a voluntary action,
 *   - the HU/multiway split after preflop folds.
 */

const POSITIONS = ['SB', 'BB', 'UTG', 'HJ', 'CO', 'BTN'];

/** Six-handed table: seat 0..5, userId 10..15, position from POSITIONS. */
function table() {
  return POSITIONS.map((position, seat) => ({ seat, userId: 10 + seat, position }));
}

/** Action-row builder that keeps a running pot (only deltas matter to replay). */
function makeActions() {
  let pot = 0;
  return {
    act(street, seat, userId, actionType, opts = {}) {
      const added = opts.added ?? 0;
      const potBefore = pot;
      pot += added;
      return {
        street,
        seat,
        userId,
        actionType,
        potBefore,
        potAfter: pot,
        isForced: opts.forced ?? 0,
        isAuto: opts.auto ?? 0,
      };
    },
    posts() {
      // SB 10, BB 20 (forced).
      return [
        this.act('preflop', 0, 10, 'post_sb', { added: 10, forced: 1 }),
        this.act('preflop', 1, 11, 'post_bb', { added: 20, forced: 1 }),
      ];
    },
  };
}

function run(actions) {
  const players = table();
  const meta = { policyKindByUser: new Map(players.map((p) => [p.userId, 'constrained-random'])) };
  return replayHand({ gameKind: 'normal', bb: 20 }, players, actions, meta);
}

const U = (seat) => 10 + seat; // userId for a seat

describe('decision-stats: preflop denominators', () => {
  it('counts a first-in raise as RFI, and a raise over a limp as limped (not RFI)', () => {
    const a = makeActions();
    // UTG (seat 2) raises first in; rest fold.
    const firstIn = run([
      ...a.posts(),
      a.act('preflop', 2, U(2), 'raise', { added: 40 }),
      a.act('preflop', 3, U(3), 'fold'),
      a.act('preflop', 4, U(4), 'fold'),
      a.act('preflop', 5, U(5), 'fold'),
      a.act('preflop', 0, U(0), 'fold'),
      a.act('preflop', 1, U(1), 'fold'),
    ]);
    const m1 = metricsFrom(firstIn.dealtPlayers, firstIn.nodes);
    expect(m1.rfi).toEqual({ hits: 1, opportunities: 1, pct: 100 });
    expect(m1.limped.opportunities).toBe(0);
    // The raiser is the only VPIP/PFR hand; the folders are dealt but not VPIP.
    expect(m1.vpip).toEqual({ hits: 1, opportunities: 6, pct: 16.67 });
    expect(m1.pfr).toEqual({ hits: 1, opportunities: 6, pct: 16.67 });

    const b = makeActions();
    // UTG limps, HJ/CO fold, BTN raises over the limp: the raise is a limped-pot
    // isolation, never an RFI hit. (UTG's limp is itself an unopened node where
    // the RFI was declined, so it is an RFI opportunity with no hit.)
    const overLimp = run([
      ...b.posts(),
      b.act('preflop', 2, U(2), 'call', { added: 20 }), // limp
      b.act('preflop', 3, U(3), 'fold'),
      b.act('preflop', 4, U(4), 'fold'),
      b.act('preflop', 5, U(5), 'raise', { added: 40 }), // iso raise
      b.act('preflop', 0, U(0), 'fold'),
      b.act('preflop', 1, U(1), 'fold'),
    ]);
    const m2 = metricsFrom(overLimp.dealtPlayers, overLimp.nodes);
    expect(m2.rfi).toEqual({ hits: 0, opportunities: 1, pct: 0 }); // the limp declined RFI
    // HJ fold + CO fold + BTN raise are the three limped-pot nodes.
    expect(m2.limped).toEqual({ hits: 1, opportunities: 3, pct: 33.33 });
  });

  it('splits facing-open fold/call/3bet and facing-3bet fold/call/4bet by opportunity', () => {
    const a = makeActions();
    // UTG opens, HJ folds, CO 3-bets, BTN folds, SB folds, BB folds.
    const { dealtPlayers, nodes } = run([
      ...a.posts(),
      a.act('preflop', 2, U(2), 'raise', { added: 40 }), // UTG open (RFI)
      a.act('preflop', 3, U(3), 'fold'), // HJ faces open -> fold
      a.act('preflop', 4, U(4), 'raise', { added: 120 }), // CO faces open -> 3bet
      a.act('preflop', 5, U(5), 'fold'), // BTN faces 3bet -> fold
      a.act('preflop', 0, U(0), 'fold'), // SB faces 3bet -> fold
      a.act('preflop', 1, U(1), 'fold'), // BB faces 3bet -> fold
    ]);
    const m = metricsFrom(dealtPlayers, nodes);
    // Facing exactly one open: HJ (fold) + CO (raise) = 2 nodes.
    expect(m.facingOpenFold).toEqual({ hits: 1, opportunities: 2, pct: 50 });
    expect(m.facingOpenCall).toEqual({ hits: 0, opportunities: 2, pct: 0 });
    expect(m.threeBet).toEqual({ hits: 1, opportunities: 2, pct: 50 });
    // Facing exactly two raises: BTN, SB, BB = 3 fold nodes.
    expect(m.facing3BetFold).toEqual({ hits: 3, opportunities: 3, pct: 100 });
    expect(m.fourBet.opportunities).toBe(3);
  });

  it('excludes forced posts and auto timeout folds from every strategic node', () => {
    const a = makeActions();
    const { dealtPlayers, nodes } = run([
      ...a.posts(),
      a.act('preflop', 2, U(2), 'timeout_fold', { auto: 1 }), // real auto action
      a.act('preflop', 3, U(3), 'fold'),
      a.act('preflop', 4, U(4), 'fold'),
      a.act('preflop', 5, U(5), 'fold'),
      a.act('preflop', 0, U(0), 'fold'),
      a.act('preflop', 1, U(1), 'fold'),
    ]);
    // The five VOLUNTARY folders are unopened nodes (they could have raised),
    // so RFI opportunities = 5 with 0 hits. The auto timeout is not a node.
    const m = metricsFrom(dealtPlayers, nodes);
    expect(m.rfi).toEqual({ hits: 0, opportunities: 5, pct: 0 });
    expect(m.vpip.hits).toBe(0);
    expect(nodes.length).toBe(5);
    expect(nodes.every((n) => n.playerId !== U(2))).toBe(true);
  });
});

describe('decision-stats: all-in / non-voluntary encoding', () => {
  it('excludes a forced short-blind all-in from nodes and from VPIP', () => {
    // Evidence: a short blind is `post_sb` with isForced=1/isAuto=1
    // (handProjection.ts:1026-1027); forced posts are never in the active set.
    const a = makeActions();
    const { dealtPlayers, nodes } = run([
      a.act('preflop', 0, U(0), 'post_sb', { added: 5, forced: 1 }), // all-in short SB
      a.act('preflop', 1, U(1), 'post_bb', { added: 20, forced: 1 }),
      a.act('preflop', 2, U(2), 'raise', { added: 40 }), // UTG first-in
      a.act('preflop', 3, U(3), 'fold'),
      a.act('preflop', 4, U(4), 'fold'),
      a.act('preflop', 5, U(5), 'fold'),
      a.act('preflop', 0, U(0), 'fold', { auto: 1 }), // SB times out
      a.act('preflop', 1, U(1), 'fold'),
    ]);
    const m = metricsFrom(dealtPlayers, nodes);
    expect(nodes.some((n) => n.playerId === U(0))).toBe(false);
    expect(dealtPlayers.find((d) => d.playerId === U(0)).vpip).toBe(0);
    expect(m.rfi).toEqual({ hits: 1, opportunities: 1, pct: 100 });
  });

  it('counts a voluntary all-in raise as aggression, not as a distinct type', () => {
    // There is no all_in action type (betting.ts:27-30); an all-in jam is a
    // `raise` with isForced=0/isAuto=0 and must be a full RFI hit.
    const a = makeActions();
    const { dealtPlayers, nodes } = run([
      ...a.posts(),
      a.act('preflop', 2, U(2), 'raise', { added: 1000 }), // UTG jams all-in
      a.act('preflop', 3, U(3), 'fold'),
      a.act('preflop', 4, U(4), 'fold'),
      a.act('preflop', 5, U(5), 'fold'),
      a.act('preflop', 0, U(0), 'fold'),
      a.act('preflop', 1, U(1), 'fold'),
    ]);
    const m = metricsFrom(dealtPlayers, nodes);
    expect(m.rfi).toEqual({ hits: 1, opportunities: 1, pct: 100 });
    expect(m.pfr.hits).toBe(1);
  });

  it('counts a voluntary all-in call as a call at the facing-open node', () => {
    const a = makeActions();
    const { dealtPlayers, nodes } = run([
      ...a.posts(),
      a.act('preflop', 2, U(2), 'raise', { added: 40 }), // UTG opens
      a.act('preflop', 3, U(3), 'call', { added: 40 }), // HJ calls all-in
      a.act('preflop', 4, U(4), 'fold'),
      a.act('preflop', 5, U(5), 'fold'),
      a.act('preflop', 0, U(0), 'fold'),
      a.act('preflop', 1, U(1), 'fold'),
    ]);
    const m = metricsFrom(dealtPlayers, nodes);
    // HJ is the only caller; the four folders also have facing-open nodes.
    expect(m.facingOpenCall).toEqual({ hits: 1, opportunities: 5, pct: 20 });
  });
});

describe('decision-stats: postflop denominators', () => {
  /**
   * Two players reach the flop: UTG (seat 2) limp-called and BB (seat 1)
   * checked. On the flop BB checks and UTG bets; BB folds.
   */
  function headsUpToFlop() {
    const a = makeActions();
    const actions = [
      ...a.posts(),
      a.act('preflop', 2, U(2), 'call', { added: 20 }),
      a.act('preflop', 3, U(3), 'fold'),
      a.act('preflop', 4, U(4), 'fold'),
      a.act('preflop', 5, U(5), 'fold'),
      a.act('preflop', 0, U(0), 'fold'),
      a.act('preflop', 1, U(1), 'check'),
      // flop: BB checks, UTG bets 50, BB folds.
      a.act('flop', 1, U(1), 'check'),
      a.act('flop', 2, U(2), 'bet', { added: 50 }),
      a.act('flop', 1, U(1), 'fold'),
    ];
    return run(actions);
  }

  it('counts a bet into a checked-to opponent and a fold facing that bet', () => {
    const { dealtPlayers, nodes } = headsUpToFlop();
    const m = metricsFrom(dealtPlayers, nodes);
    // UTG's bet: no outstanding bet -> checked-to node, hit.
    // Denominator is all no-outstanding-bet nodes (BB check + UTG bet = 2).
    expect(m.betWhenCheckedTo).toEqual({ hits: 1, opportunities: 2, pct: 50 });
    // BB's check is the non-bet half of the same checked-to nodes.
    expect(m.checkedTo).toEqual({ hits: 1, opportunities: 2, pct: 50 });
    // BB's fold faces UTG's bet -> the ONLY fold-to-bet opportunity.
    expect(m.foldToBet).toEqual({ hits: 1, opportunities: 1, pct: 100 });
    expect(m.callVsBet.opportunities).toBe(1);
    expect(m.raiseVsBet.opportunities).toBe(1);
    // The preflop fold never inflates fold-to-bet: 4 preflop folds exist and
    // the denominator is still 1.
    expect(m.foldToBet.opportunities).toBe(1);
  });

  it('attributes a postflop node to HU only once preflop folds are applied', () => {
    const { nodes } = headsUpToFlop();
    const postflop = nodes.filter((n) => n.kind === 'facingBet' || n.kind === 'checkedTo');
    expect(postflop.length).toBe(3);
    for (const n of postflop) expect(n.activeOpponents).toBe(1);
  });

  it('counts a call facing a bet as call-vs-bet, not a checked-to action', () => {
    const a = makeActions();
    const { dealtPlayers, nodes } = run([
      ...a.posts(),
      a.act('preflop', 2, U(2), 'call', { added: 20 }),
      a.act('preflop', 3, U(3), 'fold'),
      a.act('preflop', 4, U(4), 'fold'),
      a.act('preflop', 5, U(5), 'fold'),
      a.act('preflop', 0, U(0), 'fold'),
      a.act('preflop', 1, U(1), 'check'),
      a.act('flop', 1, U(1), 'bet', { added: 50 }),
      a.act('flop', 2, U(2), 'call', { added: 50 }),
    ]);
    const m = metricsFrom(dealtPlayers, nodes);
    expect(m.callVsBet).toEqual({ hits: 1, opportunities: 1, pct: 100 });
    expect(m.foldToBet.hits).toBe(0);
    expect(m.betWhenCheckedTo).toEqual({ hits: 1, opportunities: 1, pct: 100 });
  });
});
