import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { openDb, type DB } from '../src/db.js';
import { HUD_MIN_SAMPLE, METRIC_VERSION, computeHandStats } from '../src/handStats.js';

// ---------------------------------------------------------------------------
// fixtures: write projection rows directly, so a metric's numerator and
// denominator can be asserted precisely rather than inferred from a transcript
// ---------------------------------------------------------------------------

interface PlayerOpts {
  position?: string;
  positionIndex?: number;
  preflopOrder?: number;
  postflopOrder?: number;
  blindRole?: string;
  nominalBlind?: number;
  forcedPost?: number;
  invested?: number;
  pokerAward?: number;
  pokerDelta?: number;
  squidDelta?: number;
  netDelta?: number;
  folded?: number;
  foldStreet?: string | null;
  sawFlop?: number;
  wentToShowdown?: number;
  wonPoker?: number;
  dataConfidence?: string;
}

interface ResolvedPlayerOpts {
  position: string | null;
  positionIndex: number | null;
  preflopOrder: number | null;
  postflopOrder: number | null;
  blindRole: string;
  nominalBlind: number;
  forcedPost: number;
  invested: number;
  pokerAward: number;
  pokerDelta: number;
  squidDelta: number;
  netDelta: number;
  folded: number;
  foldStreet: string | null;
  sawFlop: number;
  wentToShowdown: number;
  wonPoker: number;
  dataConfidence: string;
}

interface P {
  seat: number;
  userId: number;
  o: ResolvedPlayerOpts;
}

const P = (seat: number, userId: number, o: PlayerOpts = {}): P => ({
  seat,
  userId,
  o: {
    position: o.position ?? null,
    positionIndex: o.positionIndex ?? null,
    preflopOrder: o.preflopOrder ?? null,
    postflopOrder: o.postflopOrder ?? null,
    blindRole: o.blindRole ?? 'none',
    nominalBlind: o.nominalBlind ?? 0,
    forcedPost: o.forcedPost ?? 0,
    invested: o.invested ?? 0,
    pokerAward: o.pokerAward ?? 0,
    pokerDelta: o.pokerDelta ?? 0,
    squidDelta: o.squidDelta ?? 0,
    netDelta: o.netDelta ?? 0,
    folded: o.folded ?? 0,
    foldStreet: o.foldStreet ?? null,
    sawFlop: o.sawFlop ?? 0,
    wentToShowdown: o.wentToShowdown ?? 0,
    wonPoker: o.wonPoker ?? 0,
    dataConfidence: o.dataConfidence ?? 'exact',
  },
});

interface A {
  no: number;
  street: string;
  type: string;
  userId: number;
  forced?: number;
  added?: number;
}
const A = (no: number, street: string, type: string, userId: number, forced = 0, added = 0): A => ({
  no,
  street,
  type,
  userId,
  forced,
  added,
});

function seedWorld(db: DB, users = 6, roomId = 'r1'): void {
  const now = 1_700_000_000_000;
  for (let i = 1; i <= users; i++) {
    db.prepare(
      'INSERT INTO users (id, username, auth_hash, auth_salt, pubkey, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(i, `u${i}`, 'h', 's', `pk${i}`, now + i);
  }
  for (const id of [roomId, 'r2']) {
    db.prepare(
      'INSERT INTO rooms (id, name, join_code, host_id, banker_id, sb, bb, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(id, `Room ${id}`, `JOIN${id}`, 1, 1, 5, 10, now);
  }
  for (let i = 1; i <= users; i++) {
    db.prepare('INSERT INTO room_players (room_id, user_id, seat, stack) VALUES (?, ?, ?, ?)').run(
      roomId,
      i,
      i - 1,
      1000,
    );
  }
}

function addHand(
  db: DB,
  h: {
    id: string;
    roomId?: string;
    gameKind?: string;
    bb?: number;
    settledAt?: number;
    status?: string;
    /** false models a projection written without a confirmed settlement marker. */
    settlement?: boolean;
    players: P[];
    actions?: A[];
  },
): void {
  const roomId = h.roomId ?? 'r1';
  const head = `head-${h.id}`;
  db.prepare(
    `INSERT INTO hands (hand_id, room_id, source_head, status, game_kind, bb, settled_at, transcript_ts, parser_version, projection_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 'ok')`,
  ).run(
    h.id,
    roomId,
    head,
    h.status ?? 'settled',
    h.gameKind ?? 'normal',
    h.bb ?? 10,
    h.settledAt ?? 1000,
    1000,
  );
  if (h.settlement !== false) {
    db.prepare(
      "INSERT INTO hand_settlements (hand_id, room_id, head, rake, final_stacks, applied_at) VALUES (?, ?, ?, 0, '[]', ?)",
    ).run(h.id, roomId, head, 1000);
  }
  const insPlayer = db.prepare(
    `INSERT INTO hand_players (
       hand_id, seat, user_id, position, position_index, preflop_order, postflop_order,
       blind_role, nominal_blind, forced_post, invested, poker_award, poker_delta, squid_delta,
       net_delta, folded, fold_street, saw_flop, went_to_showdown, won_poker, data_confidence
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const p of h.players) {
    const o = p.o;
    insPlayer.run(
      h.id,
      p.seat,
      p.userId,
      o.position,
      o.positionIndex,
      o.preflopOrder,
      o.postflopOrder,
      o.blindRole,
      o.nominalBlind,
      o.forcedPost,
      o.invested,
      o.pokerAward,
      o.pokerDelta,
      o.squidDelta,
      o.netDelta,
      o.folded,
      o.foldStreet,
      o.sawFlop,
      o.wentToShowdown,
      o.wonPoker,
      o.dataConfidence,
    );
  }
  const insAction = db.prepare(
    `INSERT INTO hand_actions (hand_id, action_no, user_id, street, action_type, amount_added, is_forced)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const a of h.actions ?? []) {
    insAction.run(h.id, a.no, a.userId, a.street, a.type, a.added ?? 0, a.forced ?? 0);
  }
}

function voidHand(db: DB, handId: string, roomId = 'r1'): void {
  db.prepare(
    "INSERT INTO ledger (room_id, user_id, delta, kind, ref, ts, prev_hash, entry_hash) VALUES (?, 1, 0, 'void-hand', ?, 1, 'p', 'e')",
  ).run(roomId, handId);
}

const m = (r: ReturnType<typeof computeHandStats>, key: string) => r.stats[key]!;

// VPIP/PFR: two voluntary preflops out of three decision opportunities; the BB
// walk in h3 is not a decision and must not enter the denominator.
function vpipScenario(db: DB): void {
  const hu = [P(0, 1, { position: 'BTN', postflopOrder: 1 }), P(1, 2, { position: 'BB', postflopOrder: 0 })];
  addHand(db, {
    id: 'h1',
    players: hu,
    actions: [
      A(0, 'preflop', 'post_sb', 1, 1, 5),
      A(1, 'preflop', 'post_bb', 2, 1, 10),
      A(2, 'preflop', 'call', 1, 0, 5),
      A(3, 'preflop', 'check', 2),
    ],
  });
  addHand(db, {
    id: 'h2',
    players: hu,
    actions: [
      A(0, 'preflop', 'post_sb', 1, 1, 5),
      A(1, 'preflop', 'post_bb', 2, 1, 10),
      A(2, 'preflop', 'raise', 1, 0, 20),
      A(3, 'preflop', 'fold', 2),
    ],
  });
  // everyone folds to the big blind: user 1 IS the BB and never acts, so the
  // forced post is not a decision opportunity.
  addHand(db, {
    id: 'h3',
    players: [P(0, 2, { position: 'BTN' }), P(1, 1, { position: 'BB' })],
    actions: [A(0, 'preflop', 'post_sb', 2, 1, 5), A(1, 'preflop', 'post_bb', 1, 1, 10)],
  });
}

describe('computeHandStats - preflop metrics', () => {
  it('returns VPIP/PFR numerators and denominators, excluding forced posts', () => {
    const db = openDb(':memory:');
    seedWorld(db);
    vpipScenario(db);
    const r = computeHandStats(db, 1);
    expect(r.sample).toBe(3);
    expect(m(r, 'vpip')).toMatchObject({ hits: 2, opportunities: 2, pct: 100 });
    expect(m(r, 'pfr')).toMatchObject({ hits: 1, opportunities: 2, pct: 50 });
    db.close();
  });

  it('counts 3bet and 4bet against the right opportunities only', () => {
    const db = openDb(':memory:');
    seedWorld(db);
    // 3-handed hand: UTG opens, BB calls, CO 3bets.
    addHand(db, {
      id: 'h1',
      players: [
        P(0, 1, { position: 'CO' }),
        P(1, 2, { position: 'UTG' }),
        P(2, 3, { position: 'BB' }),
      ],
      actions: [
        A(0, 'preflop', 'raise', 2),
        A(1, 'preflop', 'call', 3),
        A(2, 'preflop', 'raise', 1),
      ],
    });
    // UTG opens, a 3bet comes back, CO 4bets.
    addHand(db, {
      id: 'h2',
      players: [
        P(0, 1, { position: 'CO' }),
        P(1, 2, { position: 'UTG' }),
        P(2, 3, { position: 'BB' }),
      ],
      actions: [
        A(0, 'preflop', 'raise', 2),
        A(1, 'preflop', 'raise', 3),
        A(2, 'preflop', 'raise', 1),
      ],
    });
    const r = computeHandStats(db, 1);
    expect(m(r, 'threeBet')).toMatchObject({ hits: 1, opportunities: 1, pct: 100 });
    expect(m(r, 'fourBet')).toMatchObject({ hits: 1, opportunities: 1, pct: 100 });
    // the target never faces a 3bet in h1, so h1 is not a 4bet opportunity
    expect(m(r, 'fourBet').opportunities).toBe(1);
    db.close();
  });

  it('returns null (not 0) for AF with no call to divide by', () => {
    const db = openDb(':memory:');
    seedWorld(db);
    addHand(db, {
      id: 'h1',
      players: [P(0, 1, { position: 'BTN' }), P(1, 2, { position: 'BB' })],
      actions: [A(0, 'preflop', 'raise', 1), A(1, 'preflop', 'fold', 2)],
    });
    const r = computeHandStats(db, 1);
    expect(m(r, 'af')).toMatchObject({ hits: 1, opportunities: 0, pct: null, unit: 'ratio' });
    db.close();
  });
});

describe('computeHandStats - postflop metrics', () => {
  it('separates c-bet from folding to a c-bet and ignores donk bets', () => {
    const db = openDb(':memory:');
    seedWorld(db);
    const hu = [P(0, 1, { position: 'BTN' }), P(1, 2, { position: 'BB' })];
    // h1: opponent (aggressor) c-bets, target folds -> fold-to-cbet hit
    addHand(db, {
      id: 'h1',
      players: [P(0, 1, { position: 'BTN', folded: 1, foldStreet: 'flop' }), P(1, 2, { position: 'BB' })],
      actions: [
        A(0, 'preflop', 'call', 1),
        A(1, 'preflop', 'raise', 2),
        A(2, 'flop', 'bet', 2),
        A(3, 'flop', 'fold', 1),
      ],
    });
    // h2: target is the aggressor but faces a DONK bet and folds: the donk is
    // not a c-bet, so this is neither a c-bet opportunity nor a fold-to-cbet.
    addHand(db, {
      id: 'h2',
      players: [P(0, 1, { position: 'BTN', folded: 1, foldStreet: 'flop' }), P(1, 2, { position: 'BB' })],
      actions: [
        A(0, 'preflop', 'raise', 1),
        A(1, 'preflop', 'call', 2),
        A(2, 'flop', 'bet', 2),
        A(3, 'flop', 'fold', 1),
      ],
    });
    // h3: target c-bets a checked flop -> hit
    addHand(db, {
      id: 'h3',
      players: hu,
      actions: [
        A(0, 'preflop', 'raise', 1),
        A(1, 'preflop', 'call', 2),
        A(2, 'flop', 'check', 2),
        A(3, 'flop', 'bet', 1),
      ],
    });
    // h4: target checks the flop and does not bet -> opportunity, not a hit
    addHand(db, {
      id: 'h4',
      players: hu,
      actions: [
        A(0, 'preflop', 'raise', 1),
        A(1, 'preflop', 'call', 2),
        A(2, 'flop', 'check', 1),
        A(3, 'flop', 'check', 2),
      ],
    });
    const r = computeHandStats(db, 1);
    expect(m(r, 'cbet')).toMatchObject({ hits: 1, opportunities: 2, pct: 50 });
    expect(m(r, 'foldToCbet')).toMatchObject({ hits: 1, opportunities: 1, pct: 100 });
    db.close();
  });

  it('computes WWSF and W$SD from saw_flop / showdown plus award', () => {
    const db = openDb(':memory:');
    seedWorld(db);
    addHand(db, {
      id: 'h1',
      players: [P(0, 1, { sawFlop: 1, wentToShowdown: 1, pokerAward: 20 })],
      actions: [],
    });
    addHand(db, {
      id: 'h2',
      players: [P(0, 1, { sawFlop: 1, wentToShowdown: 1, pokerAward: 0 })],
      actions: [],
    });
    addHand(db, { id: 'h3', players: [P(0, 1, { sawFlop: 0 })], actions: [] });
    const r = computeHandStats(db, 1);
    expect(m(r, 'wwsf')).toMatchObject({ hits: 1, opportunities: 2, pct: 50 });
    expect(m(r, 'wsd')).toMatchObject({ hits: 1, opportunities: 2, pct: 50 });
    db.close();
  });

  it('computes bb/100 from poker_delta and the hand nominal bb, never squid', () => {
    const db = openDb(':memory:');
    seedWorld(db);
    addHand(db, {
      id: 'h1',
      bb: 10,
      players: [
        P(0, 1, { pokerDelta: 10, squidDelta: 3, netDelta: 13 }),
      ],
      actions: [],
    });
    addHand(db, { id: 'h2', bb: 10, players: [P(0, 1, { pokerDelta: -5, netDelta: -5 })], actions: [] });
    const r = computeHandStats(db, 1);
    expect(m(r, 'net')).toMatchObject({ hits: 5, opportunities: 2, pct: null, unit: 'chips' });
    expect(m(r, 'bb100')).toMatchObject({ hits: 50, opportunities: 2, pct: 25, unit: 'bb/100' });
    db.close();
  });
});

describe('computeHandStats - filters, voids and confidence', () => {
  it('excludes a hand the moment a void-hand ledger row exists', () => {
    const db = openDb(':memory:');
    seedWorld(db);
    addHand(db, { id: 'h1', bb: 10, players: [P(0, 1, { pokerDelta: 10 })], actions: [] });
    addHand(db, { id: 'h2', bb: 10, players: [P(0, 1, { pokerDelta: 20 })], actions: [] });
    expect(computeHandStats(db, 1).sample).toBe(2);
    voidHand(db, 'h2');
    const r = computeHandStats(db, 1);
    expect(r.sample).toBe(1);
    expect(m(r, 'net').hits).toBe(10);
    // status stays 'settled' - the exclusion is the ledger, not the projection
    const status = db.prepare("SELECT status FROM hands WHERE hand_id='h2'").get() as {
      status: string;
    };
    expect(status.status).toBe('settled');
    db.close();
  });

  it('buckets positions and collapses heads-up BTN into SB', () => {
    const db = openDb(':memory:');
    seedWorld(db);
    // heads-up: BTN is the small blind
    addHand(db, {
      id: 'hu',
      players: [P(0, 1, { position: 'BTN', postflopOrder: 1 }), P(1, 2, { position: 'BB', postflopOrder: 0 })],
      actions: [],
    });
    // 6-max: CO is a real position
    addHand(db, {
      id: 'six',
      players: [
        P(0, 1, { position: 'CO' }),
        P(1, 2, { position: 'BTN' }),
        P(2, 3, { position: 'SB' }),
        P(3, 4, { position: 'BB' }),
        P(4, 5, { position: 'UTG' }),
        P(5, 6, { position: 'HJ' }),
      ],
      actions: [],
    });
    const r = computeHandStats(db, 1);
    expect(Object.keys(r.byPosition).sort()).toEqual(['CO', 'SB']);
    expect(r.byPosition['SB']!.sample).toBe(1); // the heads-up BTN
    expect(r.byPosition['CO']!.sample).toBe(1);
    expect(r.byPosition['BTN']).toBeUndefined();
    db.close();
  });

  it('reports data_confidence distribution and the minHands gate honestly', () => {
    const db = openDb(':memory:');
    seedWorld(db);
    addHand(db, { id: 'h1', players: [P(0, 1, { dataConfidence: 'exact' })], actions: [] });
    addHand(db, { id: 'h2', players: [P(0, 1, { dataConfidence: 'legacy' })], actions: [] });
    addHand(db, { id: 'h3', players: [P(0, 1, { dataConfidence: 'partial' })], actions: [] });
    const r = computeHandStats(db, 1, { minHands: 5 });
    expect(r.dataQuality).toEqual({ exact: 1, legacy: 1, partial: 1, total: 3 });
    expect(r.minHands).toBe(5);
    expect(r.sufficient).toBe(false);
    expect(computeHandStats(db, 1, { minHands: 3 }).sufficient).toBe(true);
    db.close();
  });

  it('filters by room, gameKind and opponent, and labels IP/OOP', () => {
    const db = openDb(':memory:');
    seedWorld(db);
    addHand(db, {
      id: 'a',
      roomId: 'r1',
      players: [P(0, 1, { position: 'BTN', postflopOrder: 1, sawFlop: 1 }), P(1, 2, { position: 'BB', postflopOrder: 0, sawFlop: 1 })],
      actions: [],
    });
    addHand(db, {
      id: 'b',
      roomId: 'r1',
      gameKind: 'bomb_pot',
      players: [P(0, 1, { position: 'BTN', postflopOrder: 1, sawFlop: 1 })],
      actions: [],
    });
    addHand(db, {
      id: 'c',
      roomId: 'r2',
      players: [P(0, 1, { position: 'BTN', postflopOrder: 1, sawFlop: 1 }), P(1, 4, { position: 'BB', postflopOrder: 0, sawFlop: 1 })],
      actions: [],
    });
    expect(computeHandStats(db, 1, { roomId: 'r1', gameKind: 'normal' }).sample).toBe(1);
    expect(computeHandStats(db, 1, { gameKind: 'bomb_pot' }).sample).toBe(1);
    // opponent 2 only shares hand 'a'
    expect(computeHandStats(db, 1, { opponentId: 2 }).sample).toBe(1);
    // hands 'a' and 'c': BTN acts last postflop -> IP; hand 'b' has a single
    // player, so there is no pairwise position to assign
    const ip = computeHandStats(db, 1, { ipOop: 'ip' });
    expect(ip.sample).toBe(2);
    expect(computeHandStats(db, 1, { ipOop: 'oop' }).sample).toBe(0);
    db.close();
  });

  it('excludes bomb-pot preflop metrics but still counts the hand', () => {
    const db = openDb(':memory:');
    seedWorld(db);
    addHand(db, {
      id: 'bomb',
      gameKind: 'bomb_pot',
      players: [P(0, 1, { position: 'BTN' }), P(1, 2, { position: 'BB' })],
      actions: [A(0, 'preflop', 'post_ante', 1, 1, 5), A(1, 'preflop', 'post_ante', 2, 1, 5)],
    });
    const r = computeHandStats(db, 1);
    expect(r.sample).toBe(1);
    expect(m(r, 'vpip')).toMatchObject({ hits: 0, opportunities: 0, pct: null });
    expect(m(r, 'pfr')).toMatchObject({ hits: 0, opportunities: 0, pct: null });
    db.close();
  });
});

describe('computeHandStats - gate regressions', () => {
  it('requires a confirmed settlement marker and a live room', () => {
    const db = openDb(':memory:');
    seedWorld(db);
    // status says settled, but there is no hand_settlements marker
    addHand(db, { id: 'unsettled', settlement: false, players: [P(0, 1, { pokerDelta: 5 })], actions: [] });
    addHand(db, { id: 'ok', players: [P(0, 1, { pokerDelta: 5 })], actions: [] });
    expect(computeHandStats(db, 1).sample).toBe(1);
    // an archived room stops counting towards stats
    db.prepare("UPDATE rooms SET archived = 1 WHERE id = 'r1'").run();
    expect(computeHandStats(db, 1).sample).toBe(0);
    db.close();
  });

  it('keeps the NEWEST hands when the limit bites, and trends oldest-first', () => {
    const db = openDb(':memory:');
    seedWorld(db);
    for (let i = 1; i <= 5; i++) {
      addHand(db, { id: `h${i}`, settledAt: i, players: [P(0, 1, { pokerDelta: i })], actions: [] });
    }
    const r = computeHandStats(db, 1, { limit: 2 });
    expect(r.sample).toBe(2);
    expect(m(r, 'net').hits).toBe(9); // 4 + 5, not 1 + 2
    expect(r.trend.map((p) => p.net)).toEqual([4, 9]); // oldest kept first
    db.close();
  });

  it('does not let the context widening escape the limited scope', () => {
    const db = openDb(':memory:');
    seedWorld(db);
    // only the oldest hand offers a 3bet spot
    addHand(db, {
      id: 'old',
      settledAt: 1,
      players: [P(0, 1, { position: 'CO' }), P(1, 2, { position: 'UTG' }), P(2, 3, { position: 'BB' })],
      actions: [A(0, 'preflop', 'raise', 2), A(1, 'preflop', 'call', 3), A(2, 'preflop', 'raise', 1)],
    });
    addHand(db, {
      id: 'n1',
      settledAt: 2,
      players: [P(0, 1, { position: 'CO' }), P(1, 2, { position: 'UTG' })],
      actions: [A(0, 'preflop', 'fold', 1)],
    });
    addHand(db, {
      id: 'n2',
      settledAt: 3,
      players: [P(0, 1, { position: 'CO' }), P(1, 2, { position: 'UTG' })],
      actions: [A(0, 'preflop', 'fold', 1)],
    });
    const r = computeHandStats(db, 1, { limit: 2 });
    expect(r.sample).toBe(2);
    expect(m(r, 'threeBet').opportunities).toBe(0);
    db.close();
  });

  it('skips hands without a nominal bb from the bb/100 denominator', () => {
    const db = openDb(':memory:');
    seedWorld(db);
    addHand(db, { id: 'a', bb: 10, players: [P(0, 1, { pokerDelta: 10 })], actions: [] });
    addHand(db, { id: 'b', bb: 0, players: [P(0, 1, { pokerDelta: 100 })], actions: [] });
    const r = computeHandStats(db, 1);
    expect(m(r, 'bb100')).toMatchObject({ hits: 100, opportunities: 1, pct: 100 });
    db.close();
  });

  it('filters position on the same HU bucket the output uses', () => {
    const db = openDb(':memory:');
    seedWorld(db);
    addHand(db, {
      id: 'hu',
      players: [P(0, 1, { position: 'BTN', postflopOrder: 1 }), P(1, 2, { position: 'BB', postflopOrder: 0 })],
      actions: [],
    });
    addHand(db, {
      id: 'six',
      players: [
        P(0, 1, { position: 'BTN' }),
        P(1, 2, { position: 'CO' }),
        P(2, 3, { position: 'BB' }),
        P(3, 4, { position: 'UTG' }),
        P(4, 5, { position: 'HJ' }),
        P(5, 6, { position: 'MP' }),
      ],
      actions: [],
    });
    expect(computeHandStats(db, 1, { position: 'SB' }).sample).toBe(1); // HU button
    expect(computeHandStats(db, 1, { position: 'BTN' }).sample).toBe(1); // 6-max button only
    db.close();
  });

  it('exposes the documented approximations', () => {
    const db = openDb(':memory:');
    seedWorld(db);
    expect(computeHandStats(db, 1).approximations.length).toBeGreaterThan(0);
    db.close();
  });

  it('counts check-then-fold as folding to a c-bet but not a call', () => {
    const db = openDb(':memory:');
    seedWorld(db);
    const hu = [P(0, 1, { position: 'BTN', folded: 1, foldStreet: 'flop' }), P(1, 2, { position: 'BB' })];
    // realistic: target checks, opponent c-bets, target folds
    addHand(db, {
      id: 'real',
      players: hu,
      actions: [
        A(0, 'preflop', 'call', 1),
        A(1, 'preflop', 'raise', 2),
        A(2, 'flop', 'check', 1),
        A(3, 'flop', 'bet', 2),
        A(4, 'flop', 'fold', 1),
      ],
    });
    // literal c-bet -> check -> fold sequence: the leading check must not mask it
    addHand(db, {
      id: 'lit',
      players: hu,
      actions: [
        A(0, 'preflop', 'call', 1),
        A(1, 'preflop', 'raise', 2),
        A(2, 'flop', 'bet', 2),
        A(3, 'flop', 'check', 1),
        A(4, 'flop', 'fold', 1),
      ],
    });
    // a call after the c-bet is not a fold
    addHand(db, {
      id: 'call',
      players: [P(0, 1, { position: 'BTN' }), P(1, 2, { position: 'BB' })],
      actions: [
        A(0, 'preflop', 'call', 1),
        A(1, 'preflop', 'raise', 2),
        A(2, 'flop', 'bet', 2),
        A(3, 'flop', 'call', 1),
      ],
    });
    const r = computeHandStats(db, 1);
    expect(m(r, 'foldToCbet')).toMatchObject({ hits: 2, opportunities: 3, pct: 66.67 });
    db.close();
  });
});

// ---------------------------------------------------------------------------
// HTTP routes
// ---------------------------------------------------------------------------

let ctx: ReturnType<typeof createApp>;
beforeEach(() => {
  ctx = createApp(':memory:');
});
afterEach(async () => {
  await ctx.app.close();
});

async function register(name: string): Promise<{ token: string; userId: number }> {
  const r = await ctx.app.inject({
    method: 'POST',
    url: '/api/register',
    payload: { username: name, authKey: 'a'.repeat(64), publicKey: 'b'.repeat(64) },
  });
  return { token: r.json().token as string, userId: r.json().userId as number };
}
const auth = (t: string) => ({ authorization: `Bearer ${t}` });

function makeRoom(db: DB, id: string, hostId: number): void {
  db.prepare(
    'INSERT INTO rooms (id, name, join_code, host_id, banker_id, sb, bb, created_at) VALUES (?, ?, ?, ?, ?, 5, 10, ?)',
  ).run(id, id, `CODE${id}`, hostId, hostId, 1000);
}
function joinRoom(db: DB, roomId: string, userId: number, seat: number): void {
  db.prepare('INSERT INTO room_players (room_id, user_id, seat, stack) VALUES (?, ?, ?, ?)').run(
    roomId,
    userId,
    seat,
    1000,
  );
}

function seedHandsFor(
  db: DB,
  roomId: string,
  userId: number,
  n: number,
  opponentId: number,
  tag = '',
): void {
  for (let i = 0; i < n; i++) {
    addHand(db, {
      id: `s-${tag}-${userId}-${i}`,
      roomId,
      players: [
        P(0, userId, { position: 'BTN', postflopOrder: 1, pokerDelta: 1 }),
        P(1, opponentId, { position: 'BB', postflopOrder: 0, pokerDelta: -1 }),
      ],
      actions: [A(0, 'preflop', 'raise', userId), A(1, 'preflop', 'fold', opponentId)],
    });
  }
}

describe('hand stats routes', () => {
  it('requires auth and returns the metric bundle for /api/me/stats', async () => {
    const alice = await register('alice');
    const bob = await register('bob');
    makeRoom(ctx.db, 'r1', alice.userId);
    joinRoom(ctx.db, 'r1', alice.userId, 0);
    joinRoom(ctx.db, 'r1', bob.userId, 1);
    seedHandsFor(ctx.db, 'r1', alice.userId, 3, bob.userId);

    const anon = await ctx.app.inject({ method: 'GET', url: '/api/me/stats' });
    expect(anon.statusCode).toBe(401);

    const res = await ctx.app.inject({ method: 'GET', url: '/api/me/stats', headers: auth(alice.token) });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.userId).toBe(alice.userId);
    expect(body.metricVersion).toBe(METRIC_VERSION);
    expect(body.sample).toBe(3);
    expect(body.stats.vpip.opportunities).toBe(3);
    expect(body.stats.vpip.hits).toBe(3);
    expect(body.dataQuality.total).toBe(3);
  });

  it('honours private_mode on /api/users/:id/stats but not for the owner', async () => {
    const alice = await register('alice2');
    const bob = await register('bob2');
    makeRoom(ctx.db, 'r1', alice.userId);
    joinRoom(ctx.db, 'r1', bob.userId, 0);
    seedHandsFor(ctx.db, 'r1', bob.userId, 2, alice.userId);
    ctx.db.prepare('UPDATE users SET private_mode = 1 WHERE id = ?').run(bob.userId);

    const hidden = await ctx.app.inject({
      method: 'GET',
      url: `/api/users/${bob.userId}/stats`,
      headers: auth(alice.token),
    });
    expect(hidden.statusCode).toBe(200);
    // the redacted contract has the same keys, with the stats explicitly null
    expect(hidden.json()).toMatchObject({
      userId: bob.userId,
      hidden: true,
      sample: 0,
      minHands: 0,
      sufficient: false,
      stats: null,
      byPosition: null,
      byStreet: null,
      byIpOop: null,
      trend: null,
      streak: null,
    });
    expect(hidden.json().dataQuality).toEqual({ exact: 0, legacy: 0, partial: 0, total: 0 });

    const self = await ctx.app.inject({
      method: 'GET',
      url: `/api/users/${bob.userId}/stats`,
      headers: auth(bob.token),
    });
    expect(self.json().hidden).toBe(false);
    expect(self.json().sample).toBe(2);

    const missing = await ctx.app.inject({
      method: 'GET',
      url: '/api/users/9999/stats',
      headers: auth(alice.token),
    });
    expect(missing.statusCode).toBe(404);
  });

  it('gates the room HUD by membership and by sample size', async () => {
    const alice = await register('alice3');
    const bob = await register('bob3');
    const carol = await register('carol3');
    makeRoom(ctx.db, 'r1', alice.userId);
    joinRoom(ctx.db, 'r1', alice.userId, 0);
    joinRoom(ctx.db, 'r1', bob.userId, 1);
    // alice: 55 hands (ok), bob: 25 hands (low); opponent 99 is not in the room
    // so the two samples do not overlap
    seedHandsFor(ctx.db, 'r1', alice.userId, 55, 99);
    seedHandsFor(ctx.db, 'r1', bob.userId, 25, 99);

    const forbidden = await ctx.app.inject({
      method: 'GET',
      url: '/api/rooms/r1/hud',
      headers: auth(carol.token),
    });
    expect(forbidden.statusCode).toBe(403);

    const notFound = await ctx.app.inject({
      method: 'GET',
      url: '/api/rooms/nope/hud',
      headers: auth(alice.token),
    });
    expect(notFound.statusCode).toBe(404);

    const res = await ctx.app.inject({ method: 'GET', url: '/api/rooms/r1/hud', headers: auth(alice.token) });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.metricVersion).toBe(METRIC_VERSION);
    expect(body.minHands).toBe(HUD_MIN_SAMPLE);
    const byId = new Map<number, any>(
      (body.players as { userId: number }[]).map((p) => [p.userId, p] as [number, any]),
    );
    expect(byId.get(alice.userId)).toMatchObject({ sample: 55, confidence: 'ok', sufficient: true });
    expect(byId.get(bob.userId)).toMatchObject({ sample: 25, confidence: 'low', sufficient: true });
    expect(byId.get(alice.userId)!.stats).not.toBeNull();
  });

  it('flags an under-minHands HUD sample as insufficient and withholds the stats', async () => {
    const alice = await register('alice4');
    const bob = await register('bob4');
    makeRoom(ctx.db, 'r1', alice.userId);
    joinRoom(ctx.db, 'r1', alice.userId, 0);
    joinRoom(ctx.db, 'r1', bob.userId, 1);
    seedHandsFor(ctx.db, 'r1', alice.userId, 1, bob.userId);

    const res = await ctx.app.inject({ method: 'GET', url: '/api/rooms/r1/hud', headers: auth(alice.token) });
    const entry = res.json().players.find((p: { userId: number }) => p.userId === alice.userId);
    expect(entry).toMatchObject({ sample: 1, sufficient: false, confidence: 'insufficient', stats: null });
  });

  it('does not let the HUD query lower the fixed 20-hand floor', async () => {
    const alice = await register('alice5');
    const bob = await register('bob5');
    makeRoom(ctx.db, 'r1', alice.userId);
    joinRoom(ctx.db, 'r1', alice.userId, 0);
    joinRoom(ctx.db, 'r1', bob.userId, 1);
    seedHandsFor(ctx.db, 'r1', alice.userId, 5, 99);

    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/rooms/r1/hud?minHands=0',
      headers: auth(alice.token),
    });
    const body = res.json();
    expect(body.minHands).toBe(HUD_MIN_SAMPLE);
    const entry = body.players.find((p: { userId: number }) => p.userId === alice.userId);
    expect(entry).toMatchObject({ sample: 5, sufficient: false, confidence: 'insufficient', stats: null });
  });

  it('hides a private-mode player from the room HUD but not from themselves', async () => {
    const alice = await register('alice6');
    const bob = await register('bob6');
    makeRoom(ctx.db, 'r1', alice.userId);
    joinRoom(ctx.db, 'r1', alice.userId, 0);
    joinRoom(ctx.db, 'r1', bob.userId, 1);
    seedHandsFor(ctx.db, 'r1', bob.userId, 25, 99);
    ctx.db.prepare('UPDATE users SET private_mode = 1 WHERE id = ?').run(bob.userId);

    const asAlice = await ctx.app.inject({
      method: 'GET',
      url: '/api/rooms/r1/hud',
      headers: auth(alice.token),
    });
    const bobSeenByAlice = asAlice
      .json()
      .players.find((p: { userId: number }) => p.userId === bob.userId);
    // full stable redacted shape: every statistic is an explicit null, not a 0
    expect(bobSeenByAlice).toMatchObject({
      userId: bob.userId,
      username: 'bob6',
      displayName: 'bob6',
      hidden: true,
      sample: 0,
      minHands: HUD_MIN_SAMPLE,
      sufficient: false,
      confidence: 'insufficient',
      dataConfidence: null,
      stats: null,
      byPosition: null,
      byStreet: null,
      byIpOop: null,
      trend: null,
      streak: null,
    });
    expect(bobSeenByAlice.dataQuality).toEqual({ exact: 0, legacy: 0, partial: 0, total: 0 });
    expect(Array.isArray(bobSeenByAlice.approximations)).toBe(true);

    const asBob = await ctx.app.inject({
      method: 'GET',
      url: '/api/rooms/r1/hud',
      headers: auth(bob.token),
    });
    const bobSeenByBob = asBob.json().players.find((p: { userId: number }) => p.userId === bob.userId);
    expect(bobSeenByBob.hidden).toBe(false);
    expect(bobSeenByBob.sample).toBe(25);
    // hidden and visible entries expose exactly the same key set
    expect(Object.keys(bobSeenByAlice).sort()).toEqual(Object.keys(bobSeenByBob).sort());
  });

  it('separates roster selection (playerId) from the opponent filter (opponentId)', async () => {
    const alice = await register('alice7');
    const bob = await register('bob7');
    makeRoom(ctx.db, 'r1', alice.userId);
    joinRoom(ctx.db, 'r1', alice.userId, 0);
    joinRoom(ctx.db, 'r1', bob.userId, 1);
    seedHandsFor(ctx.db, 'r1', alice.userId, 3, bob.userId, 'vsbob');
    seedHandsFor(ctx.db, 'r1', alice.userId, 2, 99, 'vs99');

    const one = await ctx.app.inject({
      method: 'GET',
      url: `/api/rooms/r1/hud?playerId=${bob.userId}`,
      headers: auth(alice.token),
    });
    expect(one.json().players).toHaveLength(1);
    expect(one.json().players[0].userId).toBe(bob.userId);

    const filtered = await ctx.app.inject({
      method: 'GET',
      url: `/api/rooms/r1/hud?opponentId=${bob.userId}`,
      headers: auth(alice.token),
    });
    const byId = new Map<number, any>(
      (filtered.json().players as { userId: number }[]).map((p) => [p.userId, p]),
    );
    // the roster is untouched, but every sample is restricted to hands shared
    // with bob
    expect(byId.size).toBe(2);
    expect(byId.get(alice.userId)!.sample).toBe(3);
    expect(byId.get(bob.userId)!.sample).toBe(3);
  });

  it('validates query and path parameters instead of 500ing', async () => {
    const alice = await register('alice8');
    makeRoom(ctx.db, 'r1', alice.userId);
    joinRoom(ctx.db, 'r1', alice.userId, 0);
    const bad = [
      '/api/me/stats?from=5&to=1',
      '/api/me/stats?position=UTG%2B2',
      '/api/me/stats?minHands=999999',
      '/api/users/abc/stats',
    ];
    for (const url of bad) {
      const res = await ctx.app.inject({ method: 'GET', url, headers: auth(alice.token) });
      expect(res.statusCode, url).toBe(400);
    }
    const ok = await ctx.app.inject({ method: 'GET', url: '/api/me/stats', headers: auth(alice.token) });
    expect(ok.statusCode).toBe(200);
  });

  it('pins the HUD to the room in the path and rejects a conflicting roomId', async () => {
    const alice = await register('alice9');
    const bob = await register('bob9');
    makeRoom(ctx.db, 'r1', alice.userId);
    makeRoom(ctx.db, 'r2', alice.userId);
    joinRoom(ctx.db, 'r1', alice.userId, 0);
    joinRoom(ctx.db, 'r1', bob.userId, 1);
    joinRoom(ctx.db, 'r2', alice.userId, 0);
    seedHandsFor(ctx.db, 'r1', alice.userId, 1, bob.userId, 'r1');
    seedHandsFor(ctx.db, 'r2', alice.userId, 2, bob.userId, 'r2');

    // path says r1, query says r2: membership alone would let this through
    const mismatch = await ctx.app.inject({
      method: 'GET',
      url: '/api/rooms/r1/hud?roomId=r2',
      headers: auth(alice.token),
    });
    expect(mismatch.statusCode).toBe(400);

    const r1 = await ctx.app.inject({
      method: 'GET',
      url: '/api/rooms/r1/hud?roomId=r1',
      headers: auth(alice.token),
    });
    expect(r1.statusCode).toBe(200);
    const r1Alice = r1.json().players.find((p: { userId: number }) => p.userId === alice.userId);
    expect(r1Alice.sample).toBe(1); // only the one r1 hand

    const r2 = await ctx.app.inject({
      method: 'GET',
      url: '/api/rooms/r2/hud',
      headers: auth(alice.token),
    });
    const r2Alice = r2.json().players.find((p: { userId: number }) => p.userId === alice.userId);
    expect(r2Alice.sample).toBe(2);
  });
});
