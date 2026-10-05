import { describe, expect, it } from 'vitest';
import {
  MAX_OPPONENT_SAMPLES,
  MAX_OPPONENTS,
  MAX_RECENT_HANDS,
  SessionTracker,
  type HandObservation,
} from '../src/sessionMemory.js';

/**
 * The bounded session memory: a hand ring plus a per-opponent ring of complete
 * observations. These pin the discovery rules (incomplete hands and auto actions
 * excluded) and every upper bound.
 */

const MY_USER = 1;

function hand(over: Partial<HandObservation> = {}): HandObservation {
  return {
    historyComplete: true,
    mySeat: 0,
    myDelta: 0,
    endedStreet: 'preflop',
    showdown: false,
    participants: [
      { seat: 0, userId: MY_USER },
      { seat: 1, userId: 2 },
    ],
    actions: [],
    ...over,
  };
}

const twoSeats = [
  { seat: 0, userId: MY_USER },
  { seat: 1, userId: 2 },
];

describe('SessionTracker', () => {
  it('bounds recentHands to the most recent 8, oldest first', () => {
    const t = new SessionTracker();
    for (let i = 0; i < 12; i++) t.observeHand(hand({ myDelta: i }));
    const mem = t.snapshot(MY_USER, twoSeats);
    expect(mem.handsObserved).toBe(12);
    expect(mem.netChips).toBe(66); // 0..11
    expect(mem.recentHands).toHaveLength(MAX_RECENT_HANDS);
    expect(mem.recentHands[0]!.myDelta).toBe(4);
    expect(mem.recentHands.at(-1)!.myDelta).toBe(11);
  });

  it('counts vpip/pfr/postflop from complete hands only and excludes auto', () => {
    const t = new SessionTracker();
    // Complete hand: opponent raises preflop and calls the flop.
    t.observeHand(
      hand({
        endedStreet: 'flop',
        actions: [
          { seat: 1, street: 'preflop', type: 'raise', auto: false },
          { seat: 1, street: 'flop', type: 'call', auto: false },
        ],
      }),
    );
    // Complete hand: opponent calls preflop only.
    t.observeHand(hand({ actions: [{ seat: 1, street: 'preflop', type: 'call', auto: false }] }));
    // Complete hand: an AUTO preflop call must not count as voluntary.
    t.observeHand(
      hand({ actions: [{ seat: 1, street: 'preflop', type: 'call', auto: true }] }),
    );
    // Incomplete hand: actions must not create a sample at all.
    t.observeHand(
      hand({
        historyComplete: false,
        actions: [
          { seat: 1, street: 'preflop', type: 'raise', auto: false },
          { seat: 1, street: 'flop', type: 'bet', auto: false },
        ],
      }),
    );

    const o = t.snapshot(MY_USER, twoSeats).opponents[0]!;
    expect(o.sampleHands).toBe(3); // the four hands minus the incomplete one
    expect(o.vpipHands).toBe(2); // raise + call; the auto call does not count
    expect(o.pfrHands).toBe(1);
    expect(o.postflopBetsRaises).toBe(0);
    expect(o.postflopCalls).toBe(1);
  });

  it('caps each opponent at the most recent 32 complete samples', () => {
    const t = new SessionTracker();
    for (let i = 0; i < 40; i++) {
      t.observeHand(
        hand({
          // Every 5th hand the opponent voluntarily calls preflop.
          actions:
            i % 5 === 0
              ? [{ seat: 1, street: 'preflop', type: 'call', auto: false }]
              : [],
        }),
      );
    }
    const o = t.snapshot(MY_USER, twoSeats).opponents[0]!;
    expect(o.sampleHands).toBe(MAX_OPPONENT_SAMPLES);
    // The window is hands 8..39: i%5===0 for 10,15,20,25,30,35 -> 6.
    expect(o.vpipHands).toBe(6);
  });

  it('tracks an opponent by userId across a seat change', () => {
    const t = new SessionTracker();
    t.observeHand(hand({ actions: [{ seat: 1, street: 'preflop', type: 'raise', auto: false }] }));
    // Same user id moves to seat 3; the stats must follow the user, not the seat.
    const moved = [
      { seat: 0, userId: MY_USER },
      { seat: 3, userId: 2 },
    ];
    const o = t.snapshot(MY_USER, moved).opponents[0]!;
    expect(o.seat).toBe(3);
    expect(o.sampleHands).toBe(1);
    expect(o.pfrHands).toBe(1);
  });

  it('caps the exposed opponent list at 8 current seats', () => {
    const t = new SessionTracker();
    const seats = [{ seat: 0, userId: MY_USER }];
    for (let i = 0; i < 12; i++) {
      const userId = 100 + i;
      seats.push({ seat: i + 1, userId });
      t.observeHand(
        hand({
          participants: [
            { seat: 0, userId: MY_USER },
            { seat: i + 1, userId },
          ],
        }),
      );
    }
    const mem = t.snapshot(MY_USER, seats);
    expect(mem.opponents).toHaveLength(MAX_OPPONENTS);
  });

  it('preserves an unknown delta as null in the hand ring and netChips', () => {
    const t = new SessionTracker();
    t.observeHand(hand({ myDelta: null }));
    const mem = t.snapshot(MY_USER, twoSeats);
    expect(mem.netChips).toBeNull();
    expect(mem.recentHands[0]!.myDelta).toBeNull();
  });

  it('keeps an exactly-zero delta distinct from an unknown one', () => {
    const t = new SessionTracker();
    t.observeHand(hand({ myDelta: 0 }));
    t.observeHand(hand({ myDelta: null }));
    const mem = t.snapshot(MY_USER, twoSeats);
    expect(mem.recentHands[0]!.myDelta).toBe(0);
    expect(mem.recentHands[1]!.myDelta).toBeNull();
    expect(mem.netChips).toBe(0);
  });
});
