import { describe, expect, it } from 'vitest';
import {
  applyAction,
  legalActions,
  nextStreet,
  startHand,
  startBombPot,
  streetClosed,
  computePots,
  awardPots,
  bestScoreSeats,
  intersectSeatSets,
  splitAmountEven,
} from '../src/betting.js';

const seats3 = [
  { seat: 2, stack: 1000 },
  { seat: 5, stack: 800 },
  { seat: 7, stack: 50 },
]; // dealing order: SB=2, BB=5, button=7

describe('startHand', () => {
  it('posts blinds and sets first to act (3-handed)', () => {
    const st = startHand(seats3, 7, 10, 20);
    expect(st.seats[0]).toMatchObject({ seat: 2, committed: 10, stack: 990 });
    expect(st.seats[1]).toMatchObject({ seat: 5, committed: 20, stack: 780 });
    expect(st.currentBet).toBe(20);
    expect(st.toAct).toBe(7); // UTG = button in 3-handed
    expect(st.needToAct).toEqual([7, 2, 5]); // BB has the option
  });
  it('heads-up: button posts SB and acts first', () => {
    const st = startHand(
      [
        { seat: 1, stack: 500 },
        { seat: 3, stack: 500 },
      ],
      1,
      5,
      10,
    );
    expect(st.seats[0]).toMatchObject({ seat: 1, committed: 5 });
    expect(st.seats[1]).toMatchObject({ seat: 3, committed: 10 });
    expect(st.toAct).toBe(1);
  });
  it('short stack posts all-in blind', () => {
    const st = startHand(
      [
        { seat: 0, stack: 8 },
        { seat: 1, stack: 100 },
        { seat: 2, stack: 100 },
      ],
      2,
      10,
      20,
    );
    expect(st.seats[0]).toMatchObject({ seat: 0, committed: 8, stack: 0, allIn: true });
  });
});

const mk = () =>
  startHand(
    [
      { seat: 0, stack: 1000 },
      { seat: 1, stack: 1000 },
      { seat: 2, stack: 1000 },
    ],
    2,
    10,
    20,
  );

describe('preflop action', () => {
  it('call, call, check closes the street (BB option)', () => {
    let st = mk();
    st = applyAction(st, 2, { type: 'call' });
    st = applyAction(st, 0, { type: 'call' });
    expect(streetClosed(st)).toBe(false); // BB still has the option
    st = applyAction(st, 1, { type: 'check' });
    expect(streetClosed(st)).toBe(true);
  });
  it('raise reopens action', () => {
    let st = mk();
    st = applyAction(st, 2, { type: 'call' });
    st = applyAction(st, 0, { type: 'raise', amount: 60 });
    expect(st.currentBet).toBe(60);
    expect(st.needToAct).toEqual([1, 2]);
    const la = legalActions(st)!;
    expect(la).toMatchObject({ seat: 1, callAmount: 40, minRaiseTo: 100, canRaise: true });
  });
  it('rejects illegal moves', () => {
    const st = mk();
    expect(() => applyAction(st, 0, { type: 'call' })).toThrow(); // not their turn
    expect(() => applyAction(st, 2, { type: 'check' })).toThrow(); // facing a bet
    expect(() => applyAction(st, 2, { type: 'raise', amount: 30 })).toThrow(); // below min raise-to 40
  });
  it('fold to one player ends the hand', () => {
    let st = mk();
    st = applyAction(st, 2, { type: 'fold' });
    st = applyAction(st, 0, { type: 'fold' });
    expect(st.winnerByFold).toBe(1);
    expect(streetClosed(st)).toBe(true);
  });
});

describe('postflop', () => {
  const flop = () => {
    let st = mk();
    st = applyAction(st, 2, { type: 'call' });
    st = applyAction(st, 0, { type: 'call' });
    st = applyAction(st, 1, { type: 'check' });
    return nextStreet(st);
  };
  it('first to act is SB; checks around close the street', () => {
    let st = flop();
    expect(st.street).toBe('flop');
    expect(st.toAct).toBe(0);
    st = applyAction(st, 0, { type: 'check' });
    st = applyAction(st, 1, { type: 'check' });
    st = applyAction(st, 2, { type: 'check' });
    expect(streetClosed(st)).toBe(true);
  });
  it('heads-up: BB acts first postflop (button last)', () => {
    let st = startHand(
      [
        { seat: 4, stack: 500 },
        { seat: 6, stack: 500 },
      ],
      4,
      5,
      10,
    );
    st = applyAction(st, 4, { type: 'call' });
    st = applyAction(st, 6, { type: 'check' });
    st = nextStreet(st);
    expect(st.toAct).toBe(6); // BB first, button (seat 4) last
  });
  it('bet must be at least the big blind', () => {
    const st = flop();
    expect(() => applyAction(st, 0, { type: 'bet', amount: 5 })).toThrow();
    expect(applyAction(st, 0, { type: 'bet', amount: 20 }).currentBet).toBe(20);
  });
});

describe('incomplete all-in raise', () => {
  it('does not reopen raise rights', () => {
    // seat 1 has only 70: raise-to 70 over a 60 bet is incomplete (min would be 100)
    let st = startHand(
      [
        { seat: 0, stack: 1000 },
        { seat: 1, stack: 70 },
        { seat: 2, stack: 1000 },
      ],
      2,
      10,
      20,
    );
    st = applyAction(st, 2, { type: 'raise', amount: 60 });
    st = applyAction(st, 0, { type: 'call' });
    st = applyAction(st, 1, { type: 'raise', amount: 70 }); // all-in incomplete raise
    expect(st.currentBet).toBe(70);
    // seats 2 and 0 must respond but cannot re-raise
    const la2 = legalActions(st)!;
    expect(la2.seat).toBe(2);
    expect(la2.canRaise).toBe(false);
    st = applyAction(st, 2, { type: 'call' });
    const la0 = legalActions(st)!;
    expect(la0).toMatchObject({ seat: 0, canRaise: false, callAmount: 10 });
  });
});

const potSeat = (seat: number, total: number, folded = false) => ({
  seat,
  stack: 0,
  committed: 0,
  total,
  folded,
  allIn: false,
  lastActedAt: null,
});

describe('computePots', () => {
  it('single pot when everyone matched', () => {
    expect(computePots([potSeat(0, 100), potSeat(1, 100), potSeat(2, 100)])).toEqual([
      { amount: 300, eligible: [0, 1, 2] },
    ]);
  });
  it('side pots for two different all-ins', () => {
    expect(computePots([potSeat(0, 50), potSeat(1, 200), potSeat(2, 500), potSeat(3, 500)])).toEqual([
      { amount: 200, eligible: [0, 1, 2, 3] },
      { amount: 450, eligible: [1, 2, 3] },
      { amount: 600, eligible: [2, 3] },
    ]);
  });
  it('folded chips stay in the pot but folded seats are ineligible', () => {
    expect(computePots([potSeat(0, 100), potSeat(1, 100, true), potSeat(2, 100)])).toEqual([
      { amount: 300, eligible: [0, 2] },
    ]);
  });
});

describe('awardPots', () => {
  it('splits ties and gives odd chip to earliest in order', () => {
    const pots = [{ amount: 101, eligible: [0, 1] }];
    const scores = new Map([
      [0, 5000],
      [1, 5000],
    ]);
    expect(awardPots(pots, scores, [1, 0])).toEqual(
      new Map([
        [1, 51],
        [0, 50],
      ]),
    );
  });
  it('side pot goes to best eligible even if overall best is ineligible', () => {
    const pots = [
      { amount: 150, eligible: [0, 1, 2] },
      { amount: 200, eligible: [1, 2] },
    ];
    const scores = new Map([
      [0, 9000],
      [1, 4000],
      [2, 3000],
    ]);
    expect(awardPots(pots, scores, [0, 1, 2])).toEqual(
      new Map([
        [0, 150],
        [1, 200],
      ]),
    );
  });
});

describe('startBombPot', () => {
  const seats = [
    { seat: 2, stack: 1000 },
    { seat: 5, stack: 800 },
    { seat: 7, stack: 1000 },
  ];

  it('antes everyone equally and opens a closed synthetic preflop', () => {
    const st = startBombPot(seats, 7, 20, 25);
    for (const s of st.seats) {
      expect(s).toMatchObject({ committed: 0, total: 25, allIn: false });
    }
    expect(st.seats.map((s) => s.stack)).toEqual([975, 775, 975]);
    expect(st).toMatchObject({
      street: 'preflop',
      sb: 0,
      bb: 20,
      currentBet: 0,
      toAct: null,
      needToAct: [],
      winnerByFold: null,
    });
  });

  it('marks a short stack all-in for what it has', () => {
    const st = startBombPot(
      [
        { seat: 0, stack: 100 },
        { seat: 1, stack: 100 },
        { seat: 2, stack: 3 },
      ],
      1,
      10,
      10,
    );
    expect(st.seats[2]).toMatchObject({ seat: 2, stack: 0, total: 3, allIn: true, committed: 0 });
    expect(st.seats[0]).toMatchObject({ stack: 90, total: 10, allIn: false });
    expect(st.seats[1]).toMatchObject({ stack: 90, total: 10, allIn: false });
  });

  it('produces main and side pots from unequal ante posting', () => {
    const st = startBombPot(
      [
        { seat: 0, stack: 100 },
        { seat: 1, stack: 100 },
        { seat: 2, stack: 4 },
      ],
      1,
      10,
      10,
    );
    // totals: 10, 10, 4 -> main pot 12 (all), side pot 12 (two big stacks)
    expect(computePots(st.seats)).toEqual([
      { amount: 12, eligible: [0, 1, 2] },
      { amount: 12, eligible: [0, 1] },
    ]);
  });

  it('never posts blinds', () => {
    const st = startBombPot(
      [
        { seat: 0, stack: 500 },
        { seat: 1, stack: 500 },
        { seat: 2, stack: 500 },
      ],
      2,
      20,
      5,
    );
    // the SB seat keeps its full blind and only pays the ante
    expect(st.seats[0]).toMatchObject({ committed: 0, stack: 495, total: 5 });
    expect(st.sb).toBe(0);
  });

  it('conserves chips', () => {
    const st = startBombPot(
      [
        { seat: 0, stack: 37 },
        { seat: 1, stack: 100 },
        { seat: 2, stack: 7 },
      ],
      2,
      20,
      10,
    );
    const before = 37 + 100 + 7;
    const behind = st.seats.reduce((s, x) => s + x.stack, 0);
    const posted = st.seats.reduce((s, x) => s + x.total, 0);
    expect(behind + posted).toBe(before);
    expect(posted).toBe(Math.min(37, 10) + Math.min(100, 10) + Math.min(7, 10));
  });

  it('requires at least two players', () => {
    expect(() => startBombPot([{ seat: 0, stack: 100 }], 0, 10, 5)).toThrow();
  });
});

describe('multi-run / winner helpers', () => {
  it('bestScoreSeats returns the top scorers in seat order', () => {
    const scores = new Map([
      [0, 100],
      [1, 250],
      [2, 250],
    ]);
    expect(bestScoreSeats([2, 0, 1], scores)).toEqual([1, 2]);
    expect(bestScoreSeats([0, 1], new Map([[0, 5]]))).toEqual([0]);
    expect(bestScoreSeats([0, 1], new Map())).toEqual([]);
  });

  it('intersectSeatSets keeps only seats that win every run', () => {
    expect(intersectSeatSets([[0, 1], [1, 2]])).toEqual([1]);
    expect(intersectSeatSets([[0, 1], [1, 0]])).toEqual([0, 1]);
    expect(intersectSeatSets([[0], [1]])).toEqual([]);
    expect(intersectSeatSets([])).toEqual([]);
  });

  it('splitAmountEven hands the remainder to earlier runs', () => {
    expect(splitAmountEven(100, 3)).toEqual([34, 33, 33]);
    expect(splitAmountEven(101, 3)).toEqual([34, 34, 33]);
    expect(splitAmountEven(10, 1)).toEqual([10]);
    expect(splitAmountEven(0, 3)).toEqual([0, 0, 0]);
    expect(() => splitAmountEven(10, 0)).toThrow();
  });
});
