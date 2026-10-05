import { describe, expect, it } from 'vitest';
import { computeHead, type TranscriptEntry } from '@4am/mental-poker';
import { openDb, type DB } from '../src/db.js';
import {
  auditMarkerlessTranscripts,
  reconcileMissingSettlements,
} from '../src/db.js';
import {
  HAND_PARSER_VERSION,
  VOIDED_HAND_EXCLUSION_SQL,
  backfillHandStats,
  deleteHandProjection,
  materializeHandProjection,
  migrateHandStats,
  parseHandEntries,
  positionAssignments,
  writeParsedHand,
} from '../src/handProjection.js';
import { applyHandSettlement } from '../src/game.js';

type Entry = { seq: number; type: string; from: string; payload: unknown; sig: string };
const srv = (seq: number, type: string, payload: unknown): Entry => ({
  seq,
  type,
  from: 'server',
  payload,
  sig: 'sig',
});
const headOf = (entries: unknown[]): string => computeHead(entries as TranscriptEntry[]);

function seedRoom(db: DB, n: number, stacks: number[] = []): { roomId: string; users: number[] } {
  const now = 1_700_000_000_000;
  const users: number[] = [];
  for (let i = 0; i < n; i++) {
    const id = i + 1;
    users.push(id);
    db.prepare(
      'INSERT INTO users (id, username, auth_hash, auth_salt, pubkey, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(id, `u${id}`, 'h', 's', `pk${id}`, now + i);
    db.prepare(
      'INSERT INTO room_players (room_id, user_id, seat, stack) VALUES (?, ?, ?, ?)',
    ).run('r1', id, i, stacks[i] ?? 1000);
  }
  db.prepare(
    'INSERT INTO rooms (id, name, join_code, host_id, banker_id, sb, bb, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).run('r1', 'Room', 'JOIN', 1, 1, 5, 10, now);
  return { roomId: 'r1', users };
}

const nHands = (db: DB): number =>
  (db.prepare('SELECT COUNT(*) AS n FROM hands').get() as { n: number }).n;
const nLedger = (db: DB): number =>
  (db.prepare('SELECT COUNT(*) AS n FROM ledger').get() as { n: number }).n;
const stackOf = (db: DB, userId: number): number =>
  (db.prepare('SELECT stack FROM room_players WHERE room_id = ? AND user_id = ?').get('r1', userId) as {
    stack: number;
  }).stack;

describe('hand stats migration', () => {
  it('creates the three projection tables idempotently', () => {
    const db = openDb(':memory:');
    expect(() => migrateHandStats(db)).not.toThrow();
    expect(() => migrateHandStats(db)).not.toThrow();
    const names = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]
    ).map((r) => r.name);
    for (const t of ['hands', 'hand_players', 'hand_actions', 'hand_projection_errors']) {
      expect(names).toContain(t);
    }
    const idx = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as { name: string }[]
    ).map((r) => r.name);
    for (const i of [
      'idx_hands_room_settled',
      'idx_hands_status_settled',
      'idx_hp_user',
      'idx_hp_user_pos',
      'idx_hp_hand_user',
      'idx_ha_source',
      'idx_ha_street',
      'idx_ha_user_street_action',
      'idx_ha_user_action',
    ]) {
      expect(idx).toContain(i);
    }
    db.close();
  });

  it('labels positions from the button ring for 2..9 handed', () => {
    const cases: Record<number, string[]> = {
      2: ['BTN', 'BB'],
      3: ['BTN', 'SB', 'BB'],
      4: ['BTN', 'SB', 'BB', 'CO'],
      5: ['BTN', 'SB', 'BB', 'HJ', 'CO'],
      6: ['BTN', 'SB', 'BB', 'UTG', 'HJ', 'CO'],
      7: ['BTN', 'SB', 'BB', 'UTG', 'LJ', 'HJ', 'CO'],
      8: ['BTN', 'SB', 'BB', 'UTG', 'MP', 'LJ', 'HJ', 'CO'],
      9: ['BTN', 'SB', 'BB', 'UTG', 'UTG+1', 'MP', 'LJ', 'HJ', 'CO'],
    };
    for (const [nStr, expected] of Object.entries(cases)) {
      const n = Number(nStr);
      const seats = Array.from({ length: n }, (_, i) => ({ seat: i }));
      const map = positionAssignments(seats, 0);
      const byIndex = [...map.values()].sort((a, b) => a.positionIndex - b.positionIndex);
      expect(byIndex.map((p) => p.position)).toEqual(expected);
      if (n === 2) expect(map.get(0)!.preflopOrder).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
// settlement materialization
// ---------------------------------------------------------------------------

function huEntries(opts: { rake?: number; showdown?: boolean } = {}): Entry[] {
  const rake = opts.rake ?? 0;
  const showdown = opts.showdown ?? true;
  return [
    srv(0, 'hand_start', {
      schemaVersion: 2,
      startedAt: 1,
      gameKind: 'normal',
      seats: [
        { seat: 0, userId: 1, stack: 1000 },
        { seat: 1, userId: 2, stack: 1000 },
      ],
      buttonSeat: 0,
      sb: 5,
      bb: 10,
      commissionBps: 50,
    }),
    srv(1, 'blind_post', {
      posts: [
        { seat: 0, userId: 1, kind: 'sb', nominal: 5, amount: 5, stackAfter: 995, allIn: false },
        { seat: 1, userId: 2, kind: 'bb', nominal: 10, amount: 10, stackAfter: 990, allIn: false },
      ],
      ts: 2,
    }),
    srv(2, 'betting_start', { street: 'preflop' }),
    srv(3, 'action', {
      action: { type: 'call' },
      seat: 0,
      actionSeq: 0,
      street: 'preflop',
      amountAdded: 5,
      potBefore: 15,
      potAfter: 20,
      ts: 3,
    }),
    srv(4, 'action', {
      action: { type: 'check' },
      seat: 1,
      actionSeq: 1,
      street: 'preflop',
      amountAdded: 0,
      potBefore: 20,
      potAfter: 20,
      ts: 4,
    }),
    srv(5, 'street', { street: 'flop', streetIndex: 1, potAfter: 20, ts: 5 }),
    srv(6, 'action', {
      action: { type: 'check' },
      seat: 0,
      actionSeq: 2,
      street: 'flop',
      amountAdded: 0,
      potBefore: 20,
      potAfter: 20,
      ts: 6,
    }),
    srv(7, 'action', {
      action: { type: 'check' },
      seat: 1,
      actionSeq: 3,
      street: 'flop',
      amountAdded: 0,
      potBefore: 20,
      potAfter: 20,
      ts: 7,
    }),
    srv(8, 'settlement', {
      board: [0, 5, 9],
      commission: rake,
      awards: [{ seat: 0, amount: 20 - rake }],
      deltas: [
        { seat: 0, delta: 10 - rake },
        { seat: 1, delta: -10 },
      ],
      pokerDeltas: [
        { seat: 0, delta: 10 - rake },
        { seat: 1, delta: -10 },
      ],
      runCount: 1,
      grossPot: 20,
      showdown,
      reveals: showdown
        ? [
            { seat: 0, cards: [0, 5] },
            { seat: 1, cards: [1, 6] },
          ]
        : [],
      ts: 9,
    }),
  ];
}

function settleArgs(entries: Entry[], opts: { rake?: number; handId?: string; head?: string } = {}) {
  const rake = opts.rake ?? 0;
  return {
    handId: opts.handId ?? 'h1',
    roomId: 'r1',
    head: opts.head ?? headOf(entries),
    entries,
    rake,
    commissionBps: 50,
    stackDeltas: [
      { userId: 1, delta: 10 - rake },
      { userId: 2, delta: -10 },
    ],
    pokerLedger: [
      { userId: 1, delta: 10 - rake },
      { userId: 2, delta: -10 },
    ],
    squidLedger: [] as { userId: number; delta: number }[],
    squidNote: 'Squid Game penalty/payout',
    timeBanks: [],
    timeBankEpoch: null,
    triggerIds: [],
    bombRan: false,
    rakeRecipientId: 1,
    now: 100,
  };
}

describe('settlement materialization', () => {
  it('writes hands/hand_players/hand_actions in the settlement transaction', () => {
    const db = openDb(':memory:');
    seedRoom(db, 2);
    const out = applyHandSettlement(db, settleArgs(huEntries()));
    expect(out.status).toBe('applied');

    const hand = db.prepare('SELECT * FROM hands WHERE hand_id = ?').get('h1') as Record<string, unknown>;
    expect(hand.status).toBe('settled');
    expect(hand.game_kind).toBe('normal');
    expect(hand.run_count).toBe(1);
    expect(hand.gross_pot).toBe(20);
    expect(hand.projection_status).toBe('ok');
    expect(hand.parser_version).toBe(HAND_PARSER_VERSION);

    const players = db
      .prepare('SELECT * FROM hand_players WHERE hand_id = ? ORDER BY seat')
      .all('h1') as Record<string, unknown>[];
    expect(players).toHaveLength(2);
    const sb = players[0]!;
    expect(sb.position).toBe('BTN');
    expect(sb.blind_role).toBe('sb');
    expect(sb.nominal_blind).toBe(5);
    expect(sb.forced_post).toBe(5);
    expect(sb.invested).toBe(10);
    expect(sb.poker_delta).toBe(10);
    expect(sb.poker_award).toBe(20);
    expect(sb.won_poker).toBe(1);
    expect(sb.went_to_showdown).toBe(1);
    expect(sb.saw_flop).toBe(1);
    expect(sb.data_confidence).toBe('exact');
    expect(JSON.parse(String(sb.revealed_cards_json))).toEqual([0, 5]);
    // ending_stack is the ACTUAL post-settlement room stack, not starting+delta
    expect(sb.ending_stack).toBe(stackOf(db, 1));
    expect(players[1]!.ending_stack).toBe(stackOf(db, 2));

    const actions = db
      .prepare('SELECT * FROM hand_actions WHERE hand_id = ? ORDER BY action_no')
      .all('h1') as Record<string, unknown>[];
    expect(actions.map((a) => a.action_type)).toEqual([
      'post_sb',
      'post_bb',
      'call',
      'check',
      'check',
      'check',
    ]);
    expect(actions[0]!.is_forced).toBe(1);
    expect(actions[1]!.is_forced).toBe(1);
    expect(actions[2]!.is_forced).toBe(0);
    expect(actions[2]!.amount_added).toBe(5);
    expect(actions[0]!.street).toBe('preflop');
    expect(actions[4]!.street).toBe('flop');
    db.close();
  });

  it('accumulates potBefore/potAfter across blind posts', () => {
    const db = openDb(':memory:');
    seedRoom(db, 2);
    applyHandSettlement(db, settleArgs(huEntries()));
    const posts = db
      .prepare(
        "SELECT action_type, pot_before, pot_after, amount_added FROM hand_actions WHERE hand_id = 'h1' AND action_type IN ('post_sb','post_bb') ORDER BY action_no",
      )
      .all() as { action_type: string; pot_before: number; pot_after: number; amount_added: number }[];
    expect(posts[0]).toMatchObject({ action_type: 'post_sb', pot_before: 0, pot_after: 5, amount_added: 5 });
    expect(posts[1]).toMatchObject({ action_type: 'post_bb', pot_before: 5, pot_after: 15, amount_added: 10 });
    db.close();
  });

  it('counts a timeout fold as folded and keeps sum(poker_delta) = -rake', () => {
    const db = openDb(':memory:');
    seedRoom(db, 2);
    const entries: Entry[] = [
      ...huEntries({ showdown: false }).slice(0, 3),
      srv(3, 'timeout_fold', {
        seat: 0,
        street: 'preflop',
        actionSeq: 0,
        amountAdded: 0,
        potBefore: 15,
        potAfter: 15,
        ts: 3,
      }),
      srv(4, 'settlement', {
        board: [],
        awards: [{ seat: 1, amount: 15 }],
        deltas: [
          { seat: 0, delta: -5 },
          { seat: 1, delta: 5 },
        ],
        pokerDeltas: [
          { seat: 0, delta: -5 },
          { seat: 1, delta: 5 },
        ],
        runCount: 1,
        grossPot: 15,
        showdown: false,
        reveals: [],
        ts: 9,
      }),
    ];
    const args = {
      ...settleArgs(entries),
      stackDeltas: [
        { userId: 1, delta: -5 },
        { userId: 2, delta: 5 },
      ],
      pokerLedger: [
        { userId: 1, delta: -5 },
        { userId: 2, delta: 5 },
      ],
    };
    expect(applyHandSettlement(db, args).status).toBe('applied');
    const p = db
      .prepare("SELECT folded, fold_street, saw_flop, went_to_showdown FROM hand_players WHERE hand_id='h1' AND seat=0")
      .get() as { folded: number; fold_street: string; saw_flop: number; went_to_showdown: number };
    expect(p.folded).toBe(1);
    expect(p.fold_street).toBe('preflop');
    expect(p.saw_flop).toBe(0);
    expect(p.went_to_showdown).toBe(0);
    db.close();
  });

  it('stores audit/TV hole_cards as public but never as a showdown', () => {
    const db = openDb(':memory:');
    seedRoom(db, 2);
    const entries: Entry[] = [
      ...huEntries({ showdown: false }).slice(0, 3),
      srv(3, 'timeout_fold', { seat: 0, street: 'preflop', actionSeq: 0, amountAdded: 0, potBefore: 15, potAfter: 15, ts: 3 }),
      // TV replay decrypted this folder's cards into the transcript: public
      srv(4, 'hole_cards', { seat: 0, cards: [10, 11] }),
      srv(5, 'settlement', {
        board: [],
        awards: [{ seat: 1, amount: 15 }],
        deltas: [
          { seat: 0, delta: -5 },
          { seat: 1, delta: 5 },
        ],
        pokerDeltas: [
          { seat: 0, delta: -5 },
          { seat: 1, delta: 5 },
        ],
        runCount: 1,
        grossPot: 15,
        showdown: false,
        reveals: [],
        ts: 9,
      }),
    ];
    const args = {
      ...settleArgs(entries),
      stackDeltas: [
        { userId: 1, delta: -5 },
        { userId: 2, delta: 5 },
      ],
      pokerLedger: [
        { userId: 1, delta: -5 },
        { userId: 2, delta: 5 },
      ],
    };
    expect(applyHandSettlement(db, args).status).toBe('applied');
    const p = db
      .prepare("SELECT revealed_cards_json, went_to_showdown, folded FROM hand_players WHERE hand_id='h1' AND seat=0")
      .get() as { revealed_cards_json: string | null; went_to_showdown: number; folded: number };
    expect(JSON.parse(String(p.revealed_cards_json))).toEqual([10, 11]);
    expect(p.went_to_showdown).toBe(0); // public via TV, not a showdown
    expect(p.folded).toBe(1);
    db.close();
  });

  it('leaves revealed_cards_json NULL when nothing was ever made public', () => {
    const db = openDb(':memory:');
    seedRoom(db, 2);
    const entries: Entry[] = [
      ...huEntries({ showdown: false }).slice(0, 3),
      srv(3, 'timeout_fold', { seat: 0, street: 'preflop', actionSeq: 0, amountAdded: 0, potBefore: 15, potAfter: 15, ts: 3 }),
      srv(4, 'settlement', {
        board: [],
        awards: [{ seat: 1, amount: 15 }],
        deltas: [
          { seat: 0, delta: -5 },
          { seat: 1, delta: 5 },
        ],
        pokerDeltas: [
          { seat: 0, delta: -5 },
          { seat: 1, delta: 5 },
        ],
        runCount: 1,
        grossPot: 15,
        showdown: false,
        reveals: [],
        ts: 9,
      }),
    ];
    const args = {
      ...settleArgs(entries),
      stackDeltas: [
        { userId: 1, delta: -5 },
        { userId: 2, delta: 5 },
      ],
      pokerLedger: [
        { userId: 1, delta: -5 },
        { userId: 2, delta: 5 },
      ],
    };
    expect(applyHandSettlement(db, args).status).toBe('applied');
    const rows = db
      .prepare('SELECT revealed_cards_json FROM hand_players WHERE hand_id = ?')
      .all('h1') as { revealed_cards_json: string | null }[];
    for (const r of rows) expect(r.revealed_cards_json).toBeNull();
    db.close();
  });

  it('rolls the whole settlement back when the transcript cannot be projected', () => {
    const db = openDb(':memory:');
    seedRoom(db, 2);
    const bad = [
      srv(0, 'hand_start', {
        schemaVersion: 2,
        seats: [
          { seat: 0, userId: 1, stack: 1000 },
          { seat: 1, userId: 2, stack: 1000 },
        ],
        buttonSeat: 0,
        sb: 5,
        bb: 10,
      }),
      srv(1, 'settlement', { board: [], awards: [], deltas: { not: 'an array' }, ts: 1 }),
    ];
    expect(() => applyHandSettlement(db, settleArgs(bad))).toThrow();
    expect((db.prepare('SELECT COUNT(*) AS n FROM hand_settlements').get() as { n: number }).n).toBe(0);
    expect(nLedger(db)).toBe(0);
    expect((db.prepare('SELECT COUNT(*) AS n FROM transcripts').get() as { n: number }).n).toBe(0);
    expect(nHands(db)).toBe(0);
    expect(stackOf(db, 1)).toBe(1000);
    db.close();
  });

  it('rolls back a live settlement whose non-empty transcript has no hand_start', () => {
    const db = openDb(':memory:');
    seedRoom(db, 2);
    // content exists (a settlement) but the hand_start is missing
    const noStart = [srv(0, 'settlement', { board: [], awards: [], deltas: [], pokerDeltas: [], ts: 1 })];
    expect(() => applyHandSettlement(db, settleArgs(noStart))).toThrow();
    expect((db.prepare('SELECT COUNT(*) AS n FROM hand_settlements').get() as { n: number }).n).toBe(0);
    expect(nLedger(db)).toBe(0);
    expect(nHands(db)).toBe(0);
    db.close();
  });

  it('aborts when the projection disagrees with the ledger', () => {
    const db = openDb(':memory:');
    seedRoom(db, 2);
    const args = settleArgs(huEntries());
    args.pokerLedger = [
      { userId: 1, delta: 999 },
      { userId: 2, delta: -10 },
    ];
    expect(() => applyHandSettlement(db, args)).toThrow(/mismatch/);
    expect(nLedger(db)).toBe(0);
    expect(nHands(db)).toBe(0);
    db.close();
  });

  it('rejects duplicate and unknown seat deltas in a live transcript', () => {
    const db = openDb(':memory:');
    seedRoom(db, 2);
    const dup = huEntries();
    (dup[8]!.payload as { pokerDeltas: unknown }).pokerDeltas = [
      { seat: 0, delta: 0 },
      { seat: 0, delta: 10 },
      { seat: 1, delta: -10 },
    ];
    expect(() => applyHandSettlement(db, settleArgs(dup))).toThrow(/duplicate seat/);

    const unknown = huEntries();
    (unknown[8]!.payload as { pokerDeltas: unknown }).pokerDeltas = [
      { seat: 0, delta: 10 },
      { seat: 1, delta: -10 },
      { seat: 7, delta: 0 },
    ];
    expect(() => applyHandSettlement(db, settleArgs(unknown))).toThrow(/unknown seat/);
    expect(nHands(db)).toBe(0);
    db.close();
  });

  it('rejects a live transcript whose hash head does not match', () => {
    const db = openDb(':memory:');
    seedRoom(db, 2);
    const entries = huEntries();
    expect(() => applyHandSettlement(db, settleArgs(entries, { head: 'deadbeef' }))).toThrow(/head/);
    expect(nHands(db)).toBe(0);
    db.close();
  });

  it('records a bomb pot as ante-only with no preflop betting or VPIP action', () => {
    const db = openDb(':memory:');
    seedRoom(db, 3);
    const entries: Entry[] = [
      srv(0, 'hand_start', {
        schemaVersion: 2,
        startedAt: 1,
        gameKind: 'bomb_pot',
        seats: [
          { seat: 0, userId: 1, stack: 1000 },
          { seat: 1, userId: 2, stack: 1000 },
          { seat: 2, userId: 3, stack: 1000 },
        ],
        buttonSeat: 0,
        sb: 5,
        bb: 10,
        commissionBps: 50,
      }),
      srv(1, 'bomb_pot_start', { ante: 5, anteBb: 1 }),
      srv(2, 'ante_post', {
        posts: [
          { seat: 0, userId: 1, kind: 'ante', nominal: 5, amount: 5, stackAfter: 995, allIn: false },
          { seat: 1, userId: 2, kind: 'ante', nominal: 5, amount: 5, stackAfter: 995, allIn: false },
          { seat: 2, userId: 3, kind: 'ante', nominal: 5, amount: 5, stackAfter: 995, allIn: false },
        ],
        ts: 2,
      }),
      srv(3, 'street', { street: 'flop', streetIndex: 1, potAfter: 15, ts: 3 }),
      srv(4, 'action', { action: { type: 'check' }, seat: 1, actionSeq: 0, street: 'flop', amountAdded: 0, potBefore: 15, potAfter: 15, ts: 4 }),
      srv(5, 'action', { action: { type: 'bet', amount: 15 }, seat: 2, actionSeq: 1, street: 'flop', amountAdded: 15, potBefore: 15, potAfter: 30, ts: 5 }),
      srv(6, 'action', { action: { type: 'fold' }, seat: 0, actionSeq: 2, street: 'flop', amountAdded: 0, potBefore: 30, potAfter: 30, ts: 6 }),
      srv(7, 'settlement', {
        board: [0, 4, 8],
        awards: [{ seat: 2, amount: 30 }],
        deltas: [
          { seat: 0, delta: -5 },
          { seat: 1, delta: 15 },
          { seat: 2, delta: -10 },
        ],
        pokerDeltas: [
          { seat: 0, delta: -5 },
          { seat: 1, delta: 15 },
          { seat: 2, delta: -10 },
        ],
        runCount: 1,
        grossPot: 30,
        showdown: false,
        reveals: [],
        ts: 7,
      }),
    ];
    const args = {
      ...settleArgs(entries),
      stackDeltas: [
        { userId: 1, delta: -5 },
        { userId: 2, delta: 15 },
        { userId: 3, delta: -10 },
      ],
      pokerLedger: [
        { userId: 1, delta: -5 },
        { userId: 2, delta: 15 },
        { userId: 3, delta: -10 },
      ],
      bombRan: true,
    };
    expect(applyHandSettlement(db, args).status).toBe('applied');
    const hand = db.prepare('SELECT game_kind, bomb_ante FROM hands WHERE hand_id = ?').get('h1') as {
      game_kind: string;
      bomb_ante: number;
    };
    expect(hand.game_kind).toBe('bomb_pot');
    expect(hand.bomb_ante).toBe(5);
    const posts = db
      .prepare("SELECT pot_before, pot_after FROM hand_actions WHERE hand_id='h1' AND action_type='post_ante' ORDER BY action_no")
      .all() as { pot_before: number; pot_after: number }[];
    expect(posts.map((p) => [p.pot_before, p.pot_after])).toEqual([
      [0, 5],
      [5, 10],
      [10, 15],
    ]);
    const types = (
      db.prepare('SELECT action_type FROM hand_actions WHERE hand_id = ?').all('h1') as {
        action_type: string;
      }[]
    ).map((r) => r.action_type);
    expect(types).not.toContain('post_sb');
    expect(types).not.toContain('post_bb');
    expect(types).toContain('post_ante');
    const preflopNonAnte = (
      db
        .prepare("SELECT COUNT(*) AS n FROM hand_actions WHERE hand_id = ? AND street = 'preflop' AND action_type != 'post_ante'")
        .get('h1') as { n: number }
    ).n;
    expect(preflopNonAnte).toBe(0);
    const roles = (
      db.prepare('SELECT blind_role FROM hand_players WHERE hand_id = ?').all('h1') as {
        blind_role: string;
      }[]
    ).map((r) => r.blind_role);
    expect(roles).toEqual(['ante', 'ante', 'ante']);
    db.close();
  });

  it('keeps multi-run as a single hand and folds squid out of poker_delta', () => {
    const db = openDb(':memory:');
    seedRoom(db, 2);
    const entries: Entry[] = [
      srv(0, 'hand_start', {
        schemaVersion: 2,
        startedAt: 1,
        gameKind: 'normal',
        seats: [
          { seat: 0, userId: 1, stack: 1000 },
          { seat: 1, userId: 2, stack: 1000 },
        ],
        buttonSeat: 0,
        sb: 5,
        bb: 10,
        commissionBps: 50,
      }),
      srv(1, 'blind_post', {
        posts: [
          { seat: 0, userId: 1, kind: 'sb', nominal: 5, amount: 5, stackAfter: 995, allIn: false },
          { seat: 1, userId: 2, kind: 'bb', nominal: 10, amount: 10, stackAfter: 990, allIn: false },
        ],
        ts: 2,
      }),
      srv(2, 'settlement', {
        board: [0, 4, 8, 12, 16],
        boards: [
          [0, 4, 8, 12, 16],
          [1, 5, 9, 13, 17],
          [2, 6, 10, 14, 18],
        ],
        commission: 0,
        awards: [{ seat: 0, amount: 20 }],
        deltas: [
          { seat: 0, delta: 10 },
          { seat: 1, delta: -10 },
        ],
        pokerDeltas: [
          { seat: 0, delta: 10 },
          { seat: 1, delta: -10 },
        ],
        runCount: 3,
        grossPot: 20,
        showdown: true,
        reveals: [
          { seat: 0, cards: [0, 4] },
          { seat: 1, cards: [1, 5] },
        ],
        ts: 3,
      }),
    ];
    expect(applyHandSettlement(db, settleArgs(entries)).status).toBe('applied');
    const hand = db.prepare('SELECT run_count, boards_json FROM hands WHERE hand_id = ?').get('h1') as {
      run_count: number;
      boards_json: string;
    };
    expect(hand.run_count).toBe(3);
    expect(JSON.parse(hand.boards_json)).toHaveLength(3);
    const n = (
      db.prepare('SELECT COUNT(*) AS n FROM hand_players WHERE hand_id = ?').get('h1') as { n: number }
    ).n;
    expect(n).toBe(2);

    const db2 = openDb(':memory:');
    seedRoom(db2, 2);
    const squidEntries: Entry[] = [
      srv(0, 'hand_start', {
        schemaVersion: 2,
        gameKind: 'normal',
        seats: [
          { seat: 0, userId: 1, stack: 1000 },
          { seat: 1, userId: 2, stack: 1000 },
        ],
        buttonSeat: 0,
        sb: 5,
        bb: 10,
      }),
      srv(1, 'settlement', {
        board: [0, 4, 8],
        awards: [{ seat: 0, amount: 15 }],
        deltas: [
          { seat: 0, delta: 8 },
          { seat: 1, delta: -8 },
        ],
        pokerDeltas: [
          { seat: 0, delta: 5 },
          { seat: 1, delta: -5 },
        ],
        squid: { netBySeat: [{ seat: 0, net: 3 }, { seat: 1, net: -3 }] },
        runCount: 1,
        grossPot: 15,
        showdown: false,
        reveals: [],
        ts: 2,
      }),
    ];
    const squidArgs = {
      ...settleArgs(squidEntries),
      stackDeltas: [
        { userId: 1, delta: 8 },
        { userId: 2, delta: -8 },
      ],
      pokerLedger: [
        { userId: 1, delta: 5 },
        { userId: 2, delta: -5 },
      ],
      squidLedger: [
        { userId: 1, delta: 3 },
        { userId: 2, delta: -3 },
      ],
    };
    expect(applyHandSettlement(db2, squidArgs).status).toBe('applied');
    const squid = db2
      .prepare('SELECT poker_delta, squid_delta, net_delta FROM hand_players WHERE hand_id = ? ORDER BY seat')
      .all('h1') as { poker_delta: number; squid_delta: number; net_delta: number }[];
    expect(squid[0]).toMatchObject({ poker_delta: 5, squid_delta: 3, net_delta: 8 });
    expect(squid[1]).toMatchObject({ poker_delta: -5, squid_delta: -3, net_delta: -8 });
    db.close();
    db2.close();
  });

  it('uses the true post-rake stack when the rake recipient is in the hand', () => {
    const db = openDb(':memory:');
    seedRoom(db, 2);
    applyHandSettlement(db, settleArgs(huEntries({ rake: 5 }), { rake: 5 }));
    const p = db
      .prepare("SELECT ending_stack FROM hand_players WHERE hand_id='h1' AND user_id=1")
      .get() as { ending_stack: number };
    const hs = db
      .prepare("SELECT final_stacks FROM hand_settlements WHERE hand_id='h1'")
      .get() as { final_stacks: string };
    const final = JSON.parse(hs.final_stacks) as { userId: number; stack: number }[];
    expect(stackOf(db, 1)).toBe(1010); // 1000 + (10 - 5) poker + 5 rake
    expect(p.ending_stack).toBe(stackOf(db, 1));
    expect(final.find((f) => f.userId === 1)!.stack).toBe(stackOf(db, 1));
    db.close();
  });

  it('rejects unknown blind/ante seats and malformed posts in a live transcript', () => {
    const db = openDb(':memory:');
    seedRoom(db, 2);

    const unknownSeat = huEntries();
    (unknownSeat[1]!.payload as { posts: { seat: number }[] }).posts[0]!.seat = 77;
    expect(() => applyHandSettlement(db, settleArgs(unknownSeat))).toThrow(/unknown blind_post seat/);

    const missingAmount = huEntries();
    delete (missingAmount[1]!.payload as { posts: Record<string, unknown>[] }).posts[0]!.amount;
    expect(() => applyHandSettlement(db, settleArgs(missingAmount))).toThrow(/missing\/invalid amount/);

    const duplicate = huEntries();
    const posts = (duplicate[1]!.payload as { posts: { seat: number }[] }).posts;
    posts[1]!.seat = posts[0]!.seat;
    expect(() => applyHandSettlement(db, settleArgs(duplicate))).toThrow(/duplicate blind_post seat/);

    const missingKind = huEntries();
    delete (missingKind[1]!.payload as { posts: Record<string, unknown>[] }).posts[0]!.kind;
    expect(() => applyHandSettlement(db, settleArgs(missingKind))).toThrow(/missing kind/);

    const negativeNominal = huEntries();
    (negativeNominal[1]!.payload as { posts: { nominal: number }[] }).posts[0]!.nominal = -5;
    expect(() => applyHandSettlement(db, settleArgs(negativeNominal))).toThrow(/missing\/invalid amount/);

    const fractionalAmount = huEntries();
    (fractionalAmount[1]!.payload as { posts: { amount: number }[] }).posts[0]!.amount = 1.5;
    expect(() => applyHandSettlement(db, settleArgs(fractionalAmount))).toThrow(/missing\/invalid amount/);

    expect(nHands(db)).toBe(0);
    expect(nLedger(db)).toBe(0);
    db.close();
  });

  it('rejects a negative rake online and in the transcript', () => {
    const db = openDb(':memory:');
    seedRoom(db, 2);
    expect(() => applyHandSettlement(db, { ...settleArgs(huEntries()), rake: -1 })).toThrow(/invalid rake/);
    const negCommission = huEntries();
    (negCommission[8]!.payload as { commission: number }).commission = -5;
    expect(() => applyHandSettlement(db, settleArgs(negCommission))).toThrow(/invalid rake/);
    expect(nHands(db)).toBe(0);
    expect(nLedger(db)).toBe(0);
    db.close();
  });

  it('labels a backfilled hand exact only when hand_settlements has final stacks', () => {
    const db = openDb(':memory:');
    seedRoom(db, 2);
    insertTranscript(db, 'no-final', huEntries());
    const withFinal = huEntries();
    (withFinal[0]!.payload as { startedAt: number }).startedAt = 42; // distinct head
    insertTranscript(db, 'with-final', withFinal, {
      finalStacks: [
        { userId: 1, stack: 1010 },
        { userId: 2, stack: 990 },
      ],
    });
    backfillHandStats(db);

    const noFinal = db
      .prepare(
        `SELECT p.data_confidence AS c, p.ending_stack AS e, h.projection_status AS s
           FROM hand_players p JOIN hands h ON h.hand_id = p.hand_id
          WHERE p.hand_id = 'no-final'`,
      )
      .all() as { c: string; e: number; s: string }[];
    expect(noFinal).toHaveLength(2);
    for (const r of noFinal) {
      expect(r.c).toBe('legacy');
      expect(r.s).toBe('legacy');
    }
    // no reliable final stack: derived from starting + net (1000 + -10/-10)
    expect(noFinal.every((r) => r.e === 990 || r.e === 1010)).toBe(true);

    const withFinalRows = db
      .prepare(
        `SELECT p.data_confidence AS c, p.ending_stack AS e, p.seat AS seat, h.projection_status AS s
           FROM hand_players p JOIN hands h ON h.hand_id = p.hand_id
          WHERE p.hand_id = 'with-final' ORDER BY p.seat`,
      )
      .all() as { c: string; e: number; seat: number; s: string }[];
    expect(withFinalRows[0]).toMatchObject({ c: 'exact', e: 1010, s: 'ok' });
    expect(withFinalRows[1]).toMatchObject({ c: 'exact', e: 990, s: 'ok' });
    db.close();
  });

  it('aborts when stack deltas disagree with the projection', () => {
    const db = openDb(':memory:');
    seedRoom(db, 2);
    const args = settleArgs(huEntries());
    // conserves (sum 0) but contradicts the +10/-10 projection
    args.stackDeltas = [
      { userId: 1, delta: 0 },
      { userId: 2, delta: 0 },
    ];
    expect(() => applyHandSettlement(db, args)).toThrow(/stack delta/);
    expect(nLedger(db)).toBe(0);
    expect(nHands(db)).toBe(0);
    db.close();
  });
});

// ---------------------------------------------------------------------------
// backfill
// ---------------------------------------------------------------------------

function insertTranscript(
  db: DB,
  handId: string,
  entries: unknown,
  opts: { ts?: number; head?: string; finalStacks?: unknown } = {},
): void {
  const ts = opts.ts ?? 500;
  const head = opts.head ?? headOf(Array.isArray(entries) ? entries : []);
  db.prepare(
    'INSERT INTO transcripts (hand_id, room_id, head, entries, ts) VALUES (?, ?, ?, ?, ?)',
  ).run(handId, 'r1', head, JSON.stringify(entries), ts);
  db.prepare(
    "INSERT INTO hand_settlements (hand_id, room_id, head, rake, final_stacks, applied_at) VALUES (?, 'r1', ?, 0, ?, ?)",
  ).run(handId, head, JSON.stringify(opts.finalStacks ?? []), ts);
}

describe('backfill', () => {
  it('is idempotent and only projects settled, non-voided hands', () => {
    const db = openDb(':memory:');
    seedRoom(db, 2);
    insertTranscript(db, 'h1', huEntries());

    const first = backfillHandStats(db);
    expect(first.projected).toBe(1);
    expect(first.skipped).toBe(0);
    const n1 = (db.prepare('SELECT COUNT(*) AS n FROM hand_actions').get() as { n: number }).n;

    const second = backfillHandStats(db);
    expect(second.projected).toBe(0);
    expect(second.skipped).toBe(1);
    expect((db.prepare('SELECT COUNT(*) AS n FROM hand_actions').get() as { n: number }).n).toBe(n1);

    const forced = backfillHandStats(db, { force: true });
    expect(forced.projected).toBe(1);
    expect((db.prepare('SELECT COUNT(*) AS n FROM hand_actions').get() as { n: number }).n).toBe(n1);
    db.close();
  });

  it('drops a hand that has since been voided', () => {
    const db = openDb(':memory:');
    seedRoom(db, 2);
    insertTranscript(db, 'h1', huEntries());
    expect(backfillHandStats(db).projected).toBe(1);
    db.prepare(
      "INSERT INTO ledger (room_id, user_id, delta, kind, ref, ts, prev_hash, entry_hash) VALUES ('r1', 1, 0, 'void-hand', 'h1', 1, 'p', 'e')",
    ).run();
    const report = backfillHandStats(db);
    expect(report.voided).toBe(1);
    expect((db.prepare("SELECT COUNT(*) AS n FROM hands WHERE hand_id = 'h1'").get() as { n: number }).n).toBe(0);
    expect((db.prepare("SELECT COUNT(*) AS n FROM hand_players WHERE hand_id = 'h1'").get() as { n: number }).n).toBe(0);
    db.close();
  });

  it('records unreadable transcripts in hand_projection_errors without touching them', () => {
    const db = openDb(':memory:');
    seedRoom(db, 2);
    insertTranscript(db, 'h9', []);
    const report = backfillHandStats(db);
    expect(report.errors).toBe(1);
    const err = db
      .prepare('SELECT error_code, attempts FROM hand_projection_errors WHERE hand_id = ?')
      .get('h9') as { error_code: string; attempts: number };
    expect(err.error_code).toBe('no_hand_start');
    expect(err.attempts).toBe(1);
    const raw = db.prepare('SELECT entries FROM transcripts WHERE hand_id = ?').get('h9') as {
      entries: string;
    };
    expect(JSON.parse(raw.entries)).toEqual([]);
    db.close();
  });

  it('refuses to overwrite an existing projection when the source head changed', () => {
    const db = openDb(':memory:');
    seedRoom(db, 2);
    insertTranscript(db, 'h1', huEntries());
    expect(backfillHandStats(db).projected).toBe(1);

    // the same hand_id now points at a different head (e.g. a repaired transcript)
    db.prepare("UPDATE transcripts SET head = 'different-head' WHERE hand_id = 'h1'").run();
    const report = backfillHandStats(db, { force: true });
    expect(report.errors).toBe(1);
    const err = db
      .prepare('SELECT error_code FROM hand_projection_errors WHERE hand_id = ?')
      .get('h1') as { error_code: string };
    expect(err.error_code).toBe('head_mismatch');
    const hand = db.prepare("SELECT source_head FROM hands WHERE hand_id = 'h1'").get() as {
      source_head: string;
    };
    expect(hand.source_head).toBe(headOf(huEntries())); // old projection untouched
    db.close();
  });

  it('records a hash-head mismatch as a projection error', () => {
    const db = openDb(':memory:');
    seedRoom(db, 2);
    insertTranscript(db, 'h1', huEntries(), { head: 'not-the-real-head' });
    const report = backfillHandStats(db);
    expect(report.errors).toBe(1);
    const err = db
      .prepare('SELECT error_code FROM hand_projection_errors WHERE hand_id = ?')
      .get('h1') as { error_code: string };
    expect(err.error_code).toBe('parse_error');
    expect(nHands(db)).toBe(0);
    db.close();
  });

  it('flags legacy transcripts that predate the enriched record fields', () => {
    const db = openDb(':memory:');
    seedRoom(db, 2);
    const legacy: Entry[] = [
      srv(0, 'hand_start', {
        seats: [
          { seat: 0, userId: 1, stack: 1000 },
          { seat: 1, userId: 2, stack: 1000 },
        ],
        buttonSeat: 0,
        sb: 5,
        bb: 10,
      }),
      srv(1, 'betting_start', { street: 'preflop' }),
      srv(2, 'action', { action: { type: 'call' }, seat: 0 }),
      srv(3, 'settlement', {
        board: [0, 4, 8],
        awards: [{ seat: 0, amount: 20 }],
        deltas: [
          { seat: 0, delta: 10 },
          { seat: 1, delta: -10 },
        ],
        reveals: [{ seat: 0, cards: [0, 4] }],
      }),
    ];
    insertTranscript(db, 'legacy-1', legacy);
    expect(backfillHandStats(db).projected).toBe(1);
    const conf = (
      db.prepare('SELECT data_confidence FROM hand_players WHERE hand_id = ?').all('legacy-1') as {
        data_confidence: string;
      }[]
    ).map((r) => r.data_confidence);
    expect(conf).toEqual(['legacy', 'legacy']);
    const p = db
      .prepare("SELECT position, blind_role, poker_delta FROM hand_players WHERE hand_id = 'legacy-1' AND seat = 0")
      .get() as { position: string; blind_role: string; poker_delta: number };
    expect(p.position).toBe('BTN');
    expect(p.blind_role).toBe('sb');
    expect(p.poker_delta).toBe(10);
    const hs = db
      .prepare("SELECT projection_status FROM hands WHERE hand_id = 'legacy-1'")
      .get() as { projection_status: string };
    expect(hs.projection_status).toBe('legacy');
    db.close();
  });

  it('writeParsedHand leaves no partial rows when a write fails', () => {
    const db = openDb(':memory:');
    seedRoom(db, 2);
    const parsed = parseHandEntries(huEntries(), {
      handId: 'h1',
      roomId: 'r1',
      head: 'head-1',
      entries: huEntries(),
      transcriptTs: 1,
    })!;
    db.exec(
      "CREATE TRIGGER fail_action_insert BEFORE INSERT ON hand_actions BEGIN SELECT RAISE(abort, 'boom'); END",
    );
    expect(() => db.transaction(() => writeParsedHand(db, parsed))()).toThrow();
    expect((db.prepare("SELECT COUNT(*) AS n FROM hands WHERE hand_id='h1'").get() as { n: number }).n).toBe(0);
    expect((db.prepare("SELECT COUNT(*) AS n FROM hand_players WHERE hand_id='h1'").get() as { n: number }).n).toBe(0);
    db.close();
  });

  it('deleteHandProjection removes all four tables or none', () => {
    const db = openDb(':memory:');
    seedRoom(db, 2);
    insertTranscript(db, 'h1', huEntries());
    expect(backfillHandStats(db).projected).toBe(1);
    db.exec(
      "CREATE TRIGGER fail_player_delete BEFORE DELETE ON hand_players BEGIN SELECT RAISE(abort, 'boom'); END",
    );
    expect(() => deleteHandProjection(db, 'h1')).toThrow();
    // the failed delete rolled back: the hand row is still there
    expect((db.prepare("SELECT COUNT(*) AS n FROM hands WHERE hand_id='h1'").get() as { n: number }).n).toBe(1);
    db.close();
  });

  it('writeParsedHand is keyed by hand_id so a re-parse replaces cleanly', () => {
    const db = openDb(':memory:');
    seedRoom(db, 2);
    const parsed = parseHandEntries(huEntries(), {
      handId: 'h1',
      roomId: 'r1',
      head: 'head-1',
      entries: huEntries(),
      transcriptTs: 1,
    })!;
    db.transaction(() => writeParsedHand(db, parsed))();
    db.transaction(() => writeParsedHand(db, parsed))();
    expect((db.prepare('SELECT COUNT(*) AS n FROM hand_actions').get() as { n: number }).n).toBe(
      parsed.actions.length,
    );
    expect(nHands(db)).toBe(1);
    db.close();
  });

  it('materializeHandProjection skips an empty transcript but rejects a non-empty one without hand_start', () => {
    const db = openDb(':memory:');
    seedRoom(db, 2);
    const empty = materializeHandProjection(db, {
      handId: 'x',
      roomId: 'r1',
      head: 'hx',
      entries: [],
      transcriptTs: 1,
    });
    expect(empty.projectable).toBe(false);
    expect(() =>
      materializeHandProjection(db, {
        handId: 'y',
        roomId: 'r1',
        head: 'hy',
        entries: [srv(0, 'settlement', { deltas: [] })],
        transcriptTs: 1,
        strict: true,
      }),
    ).toThrow(/hand_start/);
    expect(nHands(db)).toBe(0);
    db.close();
  });

  it('excludes a voided hand through VOIDED_HAND_EXCLUSION_SQL by hand_id', () => {
    const db = openDb(':memory:');
    seedRoom(db, 2);
    applyHandSettlement(db, settleArgs(huEntries()));
    const visible = () =>
      (
        db.prepare(`SELECT hand_id FROM hands WHERE ${VOIDED_HAND_EXCLUSION_SQL}`).all() as {
          hand_id: string;
        }[]
      ).map((r) => r.hand_id);
    expect(visible()).toEqual(['h1']);
    // the void API writes ref = handId
    db.prepare(
      "INSERT INTO ledger (room_id, user_id, delta, kind, ref, ts, prev_hash, entry_hash) VALUES ('r1', 1, 0, 'void-hand', 'h1', 1, 'p', 'e')",
    ).run();
    expect(visible()).toEqual([]);
    db.close();
  });
});

describe('pre-lifecycle reconciliation of a genuine seven-deuce bounty', () => {
  it('reconciles a real auto 7-2 bounty hand to committed (no over-quarantine)', () => {
    const db = openDb(':memory:');
    seedRoom(db, 2);
    // A heads-up hand whose winner also takes the automatic 7-2 bounty (6 from
    // the loser). The combined stack move is 16/-16 while the pure poker ledger
    // legs stay 10/-10; the writer stores the bounty as separate seven-deuce
    // legs, so the reconciliation must tie them back together.
    const entries = huEntries();
    const settle = entries.find((e) => e.type === 'settlement')!;
    (settle.payload as Record<string, unknown>).deltas = [
      { seat: 0, delta: 16 },
      { seat: 1, delta: -16 },
    ];
    (settle.payload as Record<string, unknown>).pokerDeltas = [
      { seat: 0, delta: 16 },
      { seat: 1, delta: -16 },
    ];
    const out = applyHandSettlement(db, {
      ...settleArgs(entries),
      stackDeltas: [
        { userId: 1, delta: 16 },
        { userId: 2, delta: -16 },
      ],
      pokerLedger: [
        { userId: 1, delta: 10 },
        { userId: 2, delta: -10 },
      ],
      projectionPokerLedger: [
        { userId: 1, delta: 16 },
        { userId: 2, delta: -16 },
      ],
      sevenDeuce: {
        winnerUserId: 1,
        winnerSeat: 0,
        winnerAmount: 6,
        payerAmounts: [{ userId: 2, amount: 6 }],
      },
    });
    expect(out.status).toBe('applied');
    // Now pretend it was a markerless pre-lifecycle hand.
    db.prepare('DELETE FROM hand_settlements WHERE hand_id = ?').run('h1');
    db.prepare('DELETE FROM hand_lifecycle WHERE hand_id = ?').run('h1');

    const audit = auditMarkerlessTranscripts(db);
    expect(audit.markerless).toBe(1);
    expect(audit.reconciled).toBe(1);
    expect(audit.quarantined).toEqual([]);
    reconcileMissingSettlements(db);
    const row = db.prepare('SELECT status FROM hand_lifecycle WHERE hand_id = ?').get('h1') as {
      status: string;
    };
    expect(row.status).toBe('committed');
    db.close();
  });
});
