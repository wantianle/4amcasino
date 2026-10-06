import {
  awardPots,
  bestScoreSeats,
  evaluate7,
  intersectSeatSets,
  splitAmountEven,
  type CardId,
  type ServerMsg,
} from '@4am/shared';
import type { HandFeatureSnapshot, SquidSettlement } from './gameTypes.js';

/** Inputs to the pure showdown/award computation. Values only: the settlement
 *  function never reads engine state. */
export interface ShowdownInput {
  handId: string;
  winnerByFold: number | null;
  reveals: Map<number, CardId[]>;
  runs: number;
  /** Run r's board at index `r - 1`; only read when `runs > 1`. */
  runBoards: CardId[][];
  /** The shared board (run 1 / single-run showdown). */
  board: CardId[];
  pots: { amount: number; eligible: number[] }[];
  dealingOrder: number[];
}

export interface ShowdownResult {
  awards: Map<number, number>;
  showdown: ServerMsg | null;
  winnerSets: number[][];
}

/**
 * Compare the revealed hands and award the (already raked) pots, for a fold win
 * or a showdown across one or more runs.
 */
export function computeShowdown({
  handId,
  winnerByFold,
  reveals,
  runs,
  runBoards,
  board,
  pots,
  dealingOrder,
}: ShowdownInput): ShowdownResult {
  const awards = new Map<number, number>();
  let showdownMsg: ServerMsg | null = null;
  /** Per-run winner sets, used for the squid intersection. */
  let winnerSets: number[][] = [];

  if (winnerByFold !== null) {
    awards.set(winnerByFold, pots.reduce((s, p) => s + p.amount, 0));
    winnerSets = [[winnerByFold]];
  } else {
    const revealList: { seat: number; cards: CardId[]; score: number }[] = [];
    for (const [seat, cards] of reveals) revealList.push({ seat, cards, score: 0 });

    if (runs > 1) {
      const boards: CardId[][] = [];
      const perRun: { seat: number; amount: number }[][] = [];
      // every pot splits across the runs; the odd chip rides on the earlier run
      const slicesByPot = pots.map((p) => splitAmountEven(p.amount, runs));
      const runWinnerSets: number[][] = [];
      for (let r = 0; r < runs; r++) {
        const runBoard = runBoards[r]!;
        boards.push(runBoard);
        const scores = new Map<number, number>();
        for (const [seat, cards] of reveals) {
          const score = evaluate7([...cards, ...runBoard]);
          scores.set(seat, score);
          if (r === 0) {
            const entry = revealList.find((x) => x.seat === seat);
            if (entry) entry.score = score;
          }
        }
        const slicePots = pots.map((p, i) => ({
          amount: slicesByPot[i]![r]!,
          eligible: p.eligible,
        }));
        const awardsR = awardPots(slicePots, scores, dealingOrder);
        perRun.push([...awardsR.entries()].map(([seat, amount]) => ({ seat, amount })));
        runWinnerSets.push(bestScoreSeats([...scores.keys()], scores));
        for (const [seat, amount] of awardsR) awards.set(seat, (awards.get(seat) ?? 0) + amount);
      }
      winnerSets = runWinnerSets;
      showdownMsg = {
        t: 'showdown',
        handId,
        reveals: revealList,
        awards: [...awards.entries()].map(([seat, amount]) => ({ seat, amount })),
        multiRun: { boards, awards: perRun },
      };
    } else {
      const scores = new Map<number, number>();
      for (const [seat, cards] of reveals) {
        const score = evaluate7([...cards, ...board]);
        scores.set(seat, score);
        const entry = revealList.find((x) => x.seat === seat);
        if (entry) entry.score = score;
      }
      const awards1 = awardPots(pots, scores, dealingOrder);
      for (const [seat, amount] of awards1) awards.set(seat, amount);
      winnerSets = [bestScoreSeats([...scores.keys()], scores)];
      showdownMsg = {
        t: 'showdown',
        handId,
        reveals: revealList,
        awards: [...awards.entries()].map(([seat, amount]) => ({ seat, amount })),
      };
    }
  }
  return { awards, showdown: showdownMsg, winnerSets };
}

/**
 * B1 squid game. Only a claimed manual trigger reaches here. Every
 * non-winner pays `penaltyBb x bb x (participants - 1)`, capped by the chips
 * they have left after the pot, split evenly among every other participant.
 * With multiple runs you must win every run to be a winner; if the runs have
 * no common winner nobody collects and no chips move.
 */
export function computeSquidSettlement(
  settings: HandFeatureSnapshot['squid']['settings'],
  participants: number[],
  bb: number,
  winnerSets: number[][],
  stacks: { seat: number; stack: number }[],
): SquidSettlement | null {
  if (!settings) return null;
  const winners = intersectSeatSets(winnerSets);
  const opponentCount = participants.length - 1;
  const requestedPerLoser = settings.penaltyBb * bb * opponentCount;
  const netBySeat = new Map<number, number>();
  const transfers: { from: number; to: number; amount: number }[] = [];
  const paidBySeat: { seat: number; amount: number }[] = [];
  if (winners.length === 0 || opponentCount <= 0) {
    return {
      winners: [],
      transfers: [],
      requestedPerLoser,
      paidBySeat: [],
      noClaimant: true,
      netBySeat,
    };
  }
  const available = new Map(stacks.map((s) => [s.seat, Math.max(0, s.stack)]));
  for (const loser of participants) {
    if (winners.includes(loser)) continue;
    const paid = Math.min(requestedPerLoser, available.get(loser) ?? 0);
    if (paid <= 0) continue;
    paidBySeat.push({ seat: loser, amount: paid });
    const recipients = participants.filter((s) => s !== loser);
    const shares = splitAmountEven(paid, recipients.length);
    recipients.forEach((to, i) => {
      const amount = shares[i]!;
      if (amount <= 0) return;
      transfers.push({ from: loser, to, amount });
      netBySeat.set(loser, (netBySeat.get(loser) ?? 0) - amount);
      netBySeat.set(to, (netBySeat.get(to) ?? 0) + amount);
    });
  }
  return {
    winners,
    transfers,
    requestedPerLoser,
    paidBySeat,
    noClaimant: false,
    netBySeat,
  };
}
