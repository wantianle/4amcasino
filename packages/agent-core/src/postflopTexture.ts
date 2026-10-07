import { rankOf, suitOf, type CardId } from '@4am/shared';

/**
 * Board texture classification (pure feature layer).
 *
 * Moved verbatim out of `postflopPolicy.ts`.
 */

export interface BoardTexture {
  maxSuit: number;
  /** Flush draw / made-flush heavy (>= 3 of a suit on the board). */
  suited: boolean;
  connected: boolean;
  paired: boolean;
  aceHigh: boolean;
  highCard: number;
  /** Connected and low — favours the caller's range. */
  lowConnected: boolean;
  wet: boolean;
}

export function classifyTexture(board: readonly CardId[]): BoardTexture {
  const suitCount = [0, 0, 0, 0];
  const seen = new Set<number>();
  let maxRank = -1;
  let minRank = 99;
  for (const card of board) {
    suitCount[suitOf(card)] = suitCount[suitOf(card)]! + 1;
    const r = rankOf(card);
    seen.add(r);
    if (r > maxRank) maxRank = r;
    if (r < minRank) minRank = r;
  }
  const ranks = [...seen].sort((a, b) => a - b);
  let adjacent = 0;
  for (let i = 1; i < ranks.length; i++) if (ranks[i]! - ranks[i - 1]! === 1) adjacent++;
  const maxSuit = Math.max(0, ...suitCount);
  const paired = seen.size < board.length;
  const suited = maxSuit >= 3;
  const connected = adjacent >= 2 || (board.length >= 3 && maxRank - minRank <= 4 && adjacent >= 1);
  const aceHigh = maxRank === 12;
  return {
    maxSuit,
    suited,
    connected,
    paired,
    aceHigh,
    highCard: maxRank,
    lowConnected: connected && maxRank <= 9,
    wet: suited || connected,
  };
}
