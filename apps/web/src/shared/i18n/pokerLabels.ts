// Chinese formatters for poker hand labels shown in the table UIs.
//
// `packages/shared` stays locale-neutral: it exposes the packed score `number`
// and `describeScore()` (English). This module re-derives the Chinese wording
// from the score's own fields (category + tiebreak nibbles), so it never has to
// parse the English sentence.
import { HAND_CATEGORY, handCategory } from '@4am/shared';
import { t } from './index.ts';

// Mirrors the rank ordering in `packages/shared/src/evaluate.ts`:
// index 0 = Two … 12 = Ace. Used to turn a tiebreak nibble into a rank token.
const RANK_WORDS = [
  'Two',
  'Three',
  'Four',
  'Five',
  'Six',
  'Seven',
  'Eight',
  'Nine',
  'Ten',
  'Jack',
  'Queen',
  'King',
  'Ace',
] as const;

function rankZh(index: number): string {
  const word = RANK_WORDS[index];
  return word === undefined ? String(index) : tRank(word);
}

/** Same bit layout as `describeScore()` in `packages/shared/src/evaluate.ts`. */
function tiebreak(score: number, i: number): number {
  return (score >> (16 - 4 * i)) & 0xf;
}

/** Chinese label for a `HAND_CATEGORY_NAMES` value, e.g. "Full House" → 「葫芦」. */
export function tHandCategory(cat: string): string {
  return t(cat);
}

/** Chinese rank token for an English rank word, e.g. "Queen" → 「Q」. */
export function tRank(word: string): string {
  return t(word);
}

/**
 * Chinese rendering of `describeScore()`. `evaluate.ts` represents a hand score
 * as a packed `number` (category in the top bits, tiebreak nibbles below), so
 * that number is the score type used here.
 */
export function tScore(score: number): string {
  const t0 = tiebreak(score, 0);
  const t1 = tiebreak(score, 1);
  switch (handCategory(score)) {
    case HAND_CATEGORY.straightFlush:
      return t0 === 12 ? '皇家同花顺' : `同花顺，${rankZh(t0)} 高`;
    case HAND_CATEGORY.quads:
      return `四条 ${rankZh(t0)}`;
    case HAND_CATEGORY.fullHouse:
      return `葫芦，${rankZh(t0)} 带 ${rankZh(t1)}`;
    case HAND_CATEGORY.flush:
      return `同花，${rankZh(t0)} 高`;
    case HAND_CATEGORY.straight:
      return `顺子，${rankZh(t0)} 高`;
    case HAND_CATEGORY.trips:
      return `三条 ${rankZh(t0)}`;
    case HAND_CATEGORY.twoPair:
      return `两对，${rankZh(t0)} 和 ${rankZh(t1)}`;
    case HAND_CATEGORY.pair:
      return `一对 ${rankZh(t0)}`;
    default:
      return `高牌 ${rankZh(t0)}`;
  }
}
