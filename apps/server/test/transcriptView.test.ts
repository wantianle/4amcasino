import { describe, expect, it } from 'vitest';
import {
  awardForSeat,
  foldForSeat,
  holeCardsForSeat,
  revealForSeat,
  seatForUser,
  transcriptView,
} from '../src/transcriptView.js';

/** Build a transcript entry the way the server serialises them. */
const e = (type: string, payload: Record<string, unknown> = {}): { type: string; payload: Record<string, unknown> } => ({
  type,
  payload,
});

const HAND = [
  e('hand_start', {
    seats: [
      { seat: 0, userId: 10 },
      { seat: 1, userId: 20 },
    ],
  }),
  e('action', { seat: 0, action: { type: 'raise' } }), // preflop
  e('street'), // flop begins
  e('action', { seat: 1, action: { type: 'fold' } }),
  e('hole_cards', { seat: 0, cards: [7, 8] }),
  e('settlement', {
    board: [1, 2, 3, 4, 5],
    awards: [{ seat: 0, amount: 120 }],
    reveals: [{ seat: 0, cards: [7, 8] }],
  }),
];

describe('transcriptView', () => {
  it('accepts a JSON string or an already-parsed array', () => {
    for (const raw of [JSON.stringify(HAND), HAND]) {
      const view = transcriptView(raw);
      expect(view.entries).toHaveLength(HAND.length);
      expect(view.start?.type).toBe('hand_start');
    }
  });

  it('treats unreadable JSON and non-arrays as an empty view', () => {
    for (const raw of ['not json', JSON.stringify({ nope: 1 }), 42, null, undefined]) {
      const view = transcriptView(raw);
      expect(view.entries).toBeNull();
      expect(view.start).toBeUndefined();
      expect(view.seats).toEqual([]);
      expect(view.board).toEqual([]);
      expect(view.reveals).toEqual([]);
    }
  });

  it('extracts seats, settlement, board and reveals', () => {
    const view = transcriptView(HAND);
    expect(view.seats).toEqual([
      { seat: 0, userId: 10 },
      { seat: 1, userId: 20 },
    ]);
    expect(view.settlement?.type).toBe('settlement');
    expect(view.board).toEqual([1, 2, 3, 4, 5]);
    expect(view.reveals).toEqual([{ seat: 0, cards: [7, 8] }]);
  });

  it('resolves a seat / reveal / award / hole cards by identity', () => {
    const view = transcriptView(HAND);
    expect(seatForUser(view, 10)).toBe(0);
    expect(seatForUser(view, 20)).toBe(1);
    expect(seatForUser(view, 99)).toBeUndefined();
    expect(revealForSeat(view, 0)).toEqual({ seat: 0, cards: [7, 8] });
    expect(revealForSeat(view, 1)).toBeUndefined();
    expect(revealForSeat(view, undefined)).toBeUndefined();
    expect(awardForSeat(view, 0)).toBe(120);
    expect(awardForSeat(view, 1)).toBe(0);
    expect(holeCardsForSeat(view, 0)).toEqual([7, 8]);
    expect(holeCardsForSeat(view, 1)).toBeUndefined();
  });

  it('reports the fold street for explicit action folds', () => {
    const view = transcriptView(HAND);
    expect(foldForSeat(view, 1)).toEqual({ folded: true, street: 1 });
    expect(foldForSeat(view, 0)).toEqual({ folded: false, street: 0 });
  });

  it('counts a timeout fold only when asked, and keeps street 0', () => {
    const view = transcriptView([e('hand_start', { seats: [{ seat: 0, userId: 10 }] }), e('timeout_fold', { seat: 0 })]);
    expect(foldForSeat(view, 0)).toEqual({ folded: false, street: 0 });
    expect(foldForSeat(view, 0, { timeoutFolds: true })).toEqual({ folded: true, street: 0 });
  });
});
