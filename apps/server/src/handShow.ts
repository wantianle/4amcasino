import {
  cardLookup,
  pointFromHex,
  recoverCard,
  verifyUnmask,
  type Point,
} from '@4am/mental-poker';
import type { CardId } from '@4am/shared';

/** The classic house rule: 7-2 offsuit wins collect a bounty from everyone. */
export function isSevenDeuce(cards: CardId[]): boolean {
  if (cards.length !== 2) return false;
  const ranks = cards.map((c) => Math.floor(c / 4)).sort((a, b) => a - b);
  const suits = cards.map((c) => c % 4);
  return ranks[0] === 0 && ranks[1] === 5 && suits[0] !== suits[1]; // 2 and 7, offsuit
}

export interface SnapshotSeat {
  userId: number;
  pubkey: string;
  commit: Point;
  cards: { deckIndex: number; point: Point }[];
}

export interface ShowSnapshot {
  handId: string;
  bySeat: Map<number, SnapshotSeat>;
  revealedSeats: Set<number>;
  winnerSeats: number[];
  reveals: Map<number, CardId[]>;
  /** True when no one had to show: the hand was decided by a fold. Kept on the
   *  snapshot for consumers; the peek gate no longer keys off it (a peek is
   *  allowed out of any hand with still-private cards). */
  endedByFold: boolean;
}

export type Share = { deckIndex: number; out: string; proof: { A1: string; A2: string; z: string } };

/** Verifies a player's DLEQ unmask shares against a finished hand's snapshot. */
export function verifySnapshotShares(
  entry: SnapshotSeat,
  shares: Share[],
  lookup: ReturnType<typeof cardLookup>,
): CardId[] | null {
  const points = new Map(entry.cards.map((c) => [c.deckIndex, c.point]));
  const cards: CardId[] = [];
  const seen = new Set<number>();
  for (const sh of shares) {
    const pIn = points.get(sh.deckIndex);
    if (!pIn || seen.has(sh.deckIndex)) return null;
    seen.add(sh.deckIndex);
    let out: Point;
    try {
      out = pointFromHex(sh.out);
    } catch {
      return null;
    }
    if (!verifyUnmask(entry.commit, pIn, out, sh.proof)) return null;
    const card = recoverCard(out, lookup);
    if (card === null) return null;
    cards.push(card);
  }
  return cards;
}
