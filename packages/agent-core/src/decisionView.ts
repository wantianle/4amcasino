import {
  legalActions,
  type CardId,
  type PlayerAction,
  type Street,
} from '@4am/shared';
import type { HeadlessClient } from './client.js';

/**
 * A structured, agent-facing snapshot of everything a bot is allowed to see at
 * the moment it must decide.
 *
 * This view is deliberately built only from public protocol frames plus the
 * bot's own private hole cards. It never exposes the deck, opponents' hole
 * cards, key material, deck points, unmask shares, or any internal `Hand`
 * state - a policy that consumes a `DecisionView` cannot cheat, because the
 * information simply is not here.
 */

/**
 * One publicly observed action, accumulated from `action_applied` frames.
 * Ordering is local (see `actionSeq`); a client that reconnects mid-hand may
 * have missed earlier frames, since the server does not replay them.
 */
export interface PublicAction {
  /**
   * Authoritative, server-assigned 0-based index of the action within the hand
   * (matches `betting_state.actionSeq` at the moment the action was taken).
   * Stable across reconnects/missed frames when the server supplies it; only a
   * legacy server falls back to a local ordinal.
   */
  actionSeq: number;
  street: Street;
  seat: number;
  action: PlayerAction;
  /** True when the server applied the action on timeout rather than by choice. */
  auto: boolean;
  /** Local wall-clock receipt time (ms epoch). */
  ts: number;
}

export interface DecisionRoom {
  id: string;
  name: string;
  sb: number;
  bb: number;
  minSettleHands: number;
  sevenDeuceBonus: number;
}

export interface DecisionSeat {
  seat: number;
  userId: number;
  displayName: string;
  isMe: boolean;
  stack: number;
  /** Chips committed on the current street. */
  committed: number;
  /** Chips committed this hand (side-pot basis). */
  total: number;
  folded: boolean;
  allIn: boolean;
  sittingOut: boolean;
  connected: boolean;
}

export interface DecisionHand {
  handId: string;
  street: Street;
  buttonSeat: number;
  /** Board cards that are already public. Never contains undealt cards. */
  board: CardId[];
  /** Total chips in the pot. */
  pot: number;
  currentBet: number;
  /** Absolute seat whose turn it is, or null between actions/streets. */
  toAct: number | null;
  /** Epoch ms by which the current actor must act, or null when untimed. */
  deadline: number | null;
  /** The decision-maker's own hole cards only. */
  myCards: CardId[];
  mySeat: number | null;
}

/**
 * The bot's legal actions, mirrored verbatim from `legalActions()` in
 * `@4am/shared` (the single authority for min/max raises). Null when it is not
 * the bot's turn.
 */
export interface DecisionLegalActions {
  canCheck: boolean;
  canCall: boolean;
  callAmount: number;
  canBet: boolean;
  canRaise: boolean;
  minRaiseTo: number;
  maxRaiseTo: number;
}

export interface DecisionPotOdds {
  /** Chips required to call. */
  callAmount: number;
  /** Total chips already in the pot. */
  pot: number;
  /** callAmount / (pot + callAmount), in [0, 1]; 0 when calling is free. */
  potOdds: number;
  /** The equity (0..1) a call needs to break even - equal to `potOdds`. */
  breakEvenEquity: number;
}

/** One settled hand's public outcome, from this bot's point of view. */
export interface RecentHandSummary {
  /** This bot's net chip change for the hand, or null when it was not observed. */
  myDelta: number | null;
  /** Last street the hand reached (from the public board), or null if unknown. */
  endedStreet: Street | null;
  /** True when the hand reached a showdown. */
  showdown: boolean;
  /**
   * False when this bot had a disconnect gap during the hand; such a hand is
   * excluded from the per-opponent statistics (its action history is partial).
   */
  historyComplete: boolean;
}

/**
 * A bounded, public-only read on one currently-seated opponent, keyed by their
 * public `userId` in the tracker but exposed here against their current seat.
 * Counts are over that opponent's most recent `MAX_OPPONENT_SAMPLES` complete,
 * observed hands; `auto` (timeout) actions are excluded.
 */
export interface OpponentStats {
  seat: number;
  /** Complete observed hands this opponent was dealt into (the denominator). */
  sampleHands: number;
  /** Hands in which they voluntarily put chips in preflop (call/bet/raise). */
  vpipHands: number;
  /** Hands in which they raised (bet/raise) preflop. */
  pfrHands: number;
  /** Postflop bet/raise actions observed. */
  postflopBetsRaises: number;
  /** Postflop call actions observed. */
  postflopCalls: number;
}

/** Cross-hand memory the caller maintains and feeds back into the view. */
export interface SessionMemory {
  /** How many hands this bot has observed in the session. */
  handsObserved: number;
  /** Net chips won/lost this session, or null when unknown. */
  netChips: number | null;
  /** Up to `MAX_RECENT_HANDS` most recent hand summaries, oldest first. */
  recentHands: RecentHandSummary[];
  /** Up to `MAX_OPPONENTS` current opponents, in seat order. */
  opponents: OpponentStats[];
}

export interface DecisionView {
  room: DecisionRoom | null;
  hand: DecisionHand | null;
  me: DecisionSeat | null;
  /** My legal actions, or null when it is not my turn. */
  legalActions: DecisionLegalActions | null;
  potOdds: DecisionPotOdds | null;
  /**
   * Public actions observed for the current hand, oldest first. Incomplete
   * after a mid-hand reconnect (the server does not replay past frames).
   */
  actionHistory: PublicAction[];
  opponents: DecisionSeat[];
  sessionMemory: SessionMemory;
  /**
   * False when this bot missed frames this hand (a disconnect gap or a mid-hand
   * join). A policy must treat the history as partial, not as full silence.
   */
  historyComplete: boolean;
  /**
   * Current-street seat numbers in dealing order (index 0 = small blind, or the
   * button heads-up), as supplied by the server's betting snapshot. Purely
   * public information (no hole cards, no deck): it lets a policy resolve
   * positions without re-deriving table order. Empty when unavailable.
   */
  seatOrder?: number[];
  /**
   * Authoritative server-assigned 0-based action index within the hand
   * (`betting_state.actionSeq`, the same value `PublicAction.actionSeq` carries),
   * or -1 when unknown. Public, and used to derive a per-action seed so mixed
   * frequencies differ within one hand while staying reproducible.
   */
  actionSeq?: number;
}

const EMPTY_MEMORY: SessionMemory = {
  handsObserved: 0,
  netChips: null,
  recentHands: [],
  opponents: [],
};

/**
 * Build the decision view for `client` right now. Safe to call at any time:
 * with no room or no live hand the missing sections come back as null/empty.
 */
export function buildDecisionView(
  client: HeadlessClient,
  sessionMemory: SessionMemory = EMPTY_MEMORY,
): DecisionView {
  const r = client.room?.room ?? null;
  const room: DecisionRoom | null = r
    ? {
        id: r.id,
        name: r.name,
        sb: r.sb,
        bb: r.bb,
        minSettleHands: r.minSettleHands,
        sevenDeuceBonus: r.sevenDeuceBonus,
      }
    : null;

  const mySeat = client.mySeat();
  // Only surface a live hand. After hand_end/hand_abort the client keeps its
  // last `betting` snapshot, so gating on `handLive()` keeps the view (and its
  // legal actions / pot odds) consistent with `client.myTurn()`.
  const live = client.handLive();
  const betting = live ? client.betting : null;
  const pot = betting ? betting.seats.reduce((sum, s) => sum + s.total, 0) : 0;

  const seats: DecisionSeat[] = betting
    ? betting.seats.map((s) => {
        const handSeat = client.seats.find((x) => x.seat === s.seat);
        const player = client.room?.players.find((p) => p.userId === handSeat?.userId);
        return {
          seat: s.seat,
          userId: handSeat?.userId ?? -1,
          displayName: player?.displayName ?? handSeat?.username ?? `seat ${s.seat + 1}`,
          isMe: s.seat === mySeat,
          stack: s.stack,
          committed: s.committed,
          total: s.total,
          folded: s.folded,
          allIn: s.allIn,
          sittingOut: player?.sittingOut ?? false,
          connected: player?.connected ?? true,
        };
      })
    : (client.room?.players ?? [])
        .filter((p) => p.seat !== null)
        .map((p) => ({
          seat: p.seat!,
          userId: p.userId,
          displayName: p.displayName,
          isMe: p.userId === client.userId,
          stack: p.stack,
          committed: 0,
          total: 0,
          folded: false,
          allIn: false,
          sittingOut: p.sittingOut,
          connected: p.connected,
        }));

  const me = seats.find((s) => s.isMe) ?? null;

  const hand: DecisionHand | null = betting
    ? {
        handId: client.handId ?? '',
        street: betting.street,
        buttonSeat: betting.buttonSeat,
        board: [...client.board],
        pot,
        currentBet: betting.currentBet,
        toAct: betting.toAct,
        deadline: client.deadline,
        myCards: [...client.myCards],
        mySeat,
      }
    : null;

  // Reuse the client's own turn decision as the single source of truth: it
  // also carries the anti-double-send guard (`actionSeq === lastActedSeq`).
  // Without this, a view built between `act()` and the next `betting_state`
  // would still advertise actions and invite a duplicate submit.
  const la = betting ? legalActions(betting) : null;
  const myTurn = client.myTurn();

  let legal: DecisionLegalActions | null = null;
  if (myTurn && la && betting) {
    legal = {
      canCheck: la.canCheck,
      canCall: !la.canCheck && la.callAmount > 0,
      callAmount: la.callAmount,
      canBet: la.canRaise && betting.currentBet === 0,
      canRaise: la.canRaise && betting.currentBet > 0,
      minRaiseTo: la.minRaiseTo,
      maxRaiseTo: la.maxRaiseTo,
    };
  }

  const potOdds: DecisionPotOdds | null = legal
    ? (() => {
        const call = legal.callAmount;
        const odds = call > 0 ? call / (pot + call) : 0;
        return { callAmount: call, pot, potOdds: odds, breakEvenEquity: odds };
      })()
    : null;

  return {
    room,
    hand,
    me,
    legalActions: legal,
    potOdds,
    actionHistory: client.actionHistory.map((a) => ({ ...a, action: { ...a.action } })),
    opponents: seats.filter((s) => !s.isMe),
    sessionMemory,
    historyComplete: client.historyComplete,
    // Public table order (dealing order from the SB) and the authoritative
    // action index; both are safe to expose and let RulePolicy resolve
    // positions / per-action seeds without guessing. Empty/-1 when no live hand.
    seatOrder: betting ? betting.seats.map((s) => s.seat) : [],
    actionSeq: betting ? client.actionSeq : -1,
  };
}
