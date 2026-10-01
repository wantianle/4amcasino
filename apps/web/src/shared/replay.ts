import {
  applyAction,
  nextStreet,
  startHand,
  type BettingState,
  type CardId,
  type PlayerAction,
  type Street,
} from '@4am/shared';
import type { TranscriptEntry } from '@4am/mental-poker';
import { t, tr } from './i18n/index.ts';
import { fmt } from './lib/cn.ts';

export interface ReplaySeatInfo {
  seat: number;
  userId: number;
  stack: number;
}

export interface ReplayStep {
  label: string;
  board: CardId[];
  /** The second runout's cards, when the table ran it twice. */
  board2: CardId[];
  betting: BettingState | null;
  reveals: Record<number, CardId[]>;
  awards: { seat: number; amount: number }[] | null;
  actor: number | null;
  /** What each seat last did on the current street, cleared when the street
   *  turns - the same thing the live table puts on the seat pods, so a replay
   *  can render through exactly the same widgets. */
  lastActions: Record<number, PlayerAction & { auto?: boolean }>;
}

export interface Replay {
  seats: ReplaySeatInfo[];
  buttonSeat: number;
  sb: number;
  bb: number;
  steps: ReplayStep[];
  /** True when post-hand key reveals put every player's hole cards in the
   *  transcript (TV replays), so the whole hand plays back broadcast-style. */
  tv: boolean;
}

// English source for one action caption, split by whether the action carries
// an amount. These strings are the dictionary keys (docs/zh-i18n.md §6.2 B+);
// a missing key only ever shows the readable English fallback, never braces.
const ACTION_KEYS: Record<PlayerAction['type'], { withAmount: string; plain: string }> = {
  fold: { withAmount: 'Seat {seat} folds', plain: 'Seat {seat} folds' },
  check: { withAmount: 'Seat {seat} checks', plain: 'Seat {seat} checks' },
  call: { withAmount: 'Seat {seat} calls {amount}', plain: 'Seat {seat} calls' },
  bet: { withAmount: 'Seat {seat} bets {amount}', plain: 'Seat {seat} bets' },
  raise: { withAmount: 'Seat {seat} raises to {amount}', plain: 'Seat {seat} raises' },
};

/** Timeline caption for one player action, in the current UI language. */
function actionLabel(seat: number, action: PlayerAction): string {
  return action.amount !== undefined
    ? t(ACTION_KEYS[action.type].withAmount, { seat, amount: action.amount })
    : t(ACTION_KEYS[action.type].plain, { seat });
}

/**
 * Rebuild a hand's public timeline from its stored transcript.
 * Normally only public information exists: actions, opened board cards, and
 * showdown reveals. In TV-replay rooms every player's hand key is saved after
 * the hand, the server decrypts each seat's hole cards into `hole_cards`
 * entries, and the replay shows all of them from the deal - WSOP broadcast
 * style (requested by notpritam, docs/FEATURES.md).
 */
export function buildReplay(entries: TranscriptEntry[]): Replay | null {
  const start = entries.find((e) => e.type === 'hand_start');
  if (!start) return null;
  // broadcast test: key-reveal decryptions (folders) plus showdown reveals
  // both live at the transcript's tail - when together they cover every dealt
  // seat, this replay is a TV replay and every hole card shows from step 0
  const tvBySeat: Record<number, CardId[]> = {};
  for (const e of entries) {
    if (e.type === 'hole_cards') {
      const p = e.payload as { seat: number; cards: CardId[] };
      tvBySeat[p.seat] = p.cards;
    } else if (e.type === 'settlement') {
      const rl = ((e.payload as Record<string, unknown>).reveals as
        | { seat: number; cards: CardId[] }[]
        | undefined) ?? [];
      for (const r of rl) tvBySeat[r.seat] = r.cards;
    }
  }

  const sp = start.payload as {
    seats: { seat: number; userId: number; stack: number }[];
    buttonSeat: number;
    sb: number;
    bb: number;
  };
  const startSeats = (start.payload as { seats: { seat: number }[] }).seats;
  const tv = startSeats.length > 0 && startSeats.every((x) => tvBySeat[x.seat] !== undefined);
  if (!tv) for (const k of Object.keys(tvBySeat)) delete tvBySeat[+k];
  const steps: ReplayStep[] = [];
  let betting: BettingState | null = null;
  let board: CardId[] = [];
  let board2: CardId[] = [];
  let reveals: Record<number, CardId[]> = {};
  let lastActions: Record<number, PlayerAction & { auto?: boolean }> = {};

  const push = (label: string, actor: number | null = null, awards: ReplayStep['awards'] = null) =>
    steps.push({
      label,
      board: [...board],
      board2: [...board2],
      betting: betting ? { ...betting, seats: betting.seats.map((s) => ({ ...s })), needToAct: [...betting.needToAct] } : null,
      reveals: { ...tvBySeat, ...reveals },
      awards,
      actor,
      lastActions: { ...lastActions },
    });

  push(t('Cards dealt face down'));

  for (const e of entries) {
    const p = e.payload as Record<string, unknown>;
    try {
      switch (e.type) {
        case 'betting_start': {
          betting = startHand(
            sp.seats.map((s) => ({ seat: s.seat, stack: s.stack })),
            sp.buttonSeat,
            sp.sb,
            sp.bb,
          );
          push(t('Blinds posted'));
          break;
        }
        case 'action': {
          if (!betting) break;
          const action = p.action as PlayerAction;
          const seat = (p.seat as number) ?? betting.toAct;
          betting = applyAction(betting, seat!, action);
          lastActions[seat!] = action;
          push(actionLabel(seat! + 1, action), seat);
          break;
        }
        case 'timeout_fold': {
          if (!betting) break;
          const seat = p.seat as number;
          betting = applyAction(betting, seat, { type: 'fold' });
          lastActions[seat] = { type: 'fold', auto: true };
          push(t('Seat {seat} timed out and folds', { seat: seat + 1 }), seat);
          break;
        }
        case 'board_open': {
          if (p.run === 2) {
            board2.push(p.card as CardId);
            push(t('Run 2 card revealed'));
          } else {
            board.push(p.card as CardId);
            push(t('Board card revealed'));
          }
          break;
        }
        case 'rit_vote': {
          push(
            t(p.yes ? 'Seat {seat} votes to run it twice' : 'Seat {seat} votes to run it once', {
              seat: (p.seat as number) + 1,
            }),
          );
          break;
        }
        case 'rit_result': {
          // run 2 shares whatever was already open when the vote passed
          if (p.runTwice) board2 = [...board];
          push(t(p.runTwice ? 'Running it twice!' : 'Running it once'));
          break;
        }
        case 'street': {
          if (betting) betting = nextStreet(betting);
          lastActions = {}; // the seat pods clear when the street turns
          const streetName = String(p.street);
          push(t(`${streetName[0]?.toUpperCase()}${streetName.slice(1)} betting`));
          break;
        }
        case 'settlement': {
          board = (p.board as CardId[]) ?? board;
          board2 = (p.board2 as CardId[]) ?? board2;
          const rl = (p.reveals as { seat: number; cards: CardId[] }[]) ?? [];
          reveals = Object.fromEntries(rl.map((r) => [r.seat, r.cards]));
          push(t('Result'), null, (p.awards as { seat: number; amount: number }[]) ?? []);
          break;
        }
        case 'hand_abort': {
          // the reason is persisted server prose - tr() at the display step
          push(t('Hand aborted: {reason}', { reason: tr(String(p.reason ?? '')) }));
          break;
        }
        default:
          break;
      }
    } catch {
      // an entry the engine rejects (e.g. an invalid action a client sent) is skipped
    }
  }
  return { seats: sp.seats, buttonSeat: sp.buttonSeat, sb: sp.sb, bb: sp.bb, steps, tv };
}

// ── Hand summaries for the hand-history page ────────────────────────────────
// The same signed transcript a replay steps through, folded into a static
// per-street recap: who did what with how much, what the board ran, which
// hole cards went public, the final pot and the rake. No betting engine
// needed - the transcript's `street` markers tell us where each action lands.

export interface HandSummaryAction {
  seat: number;
  action: PlayerAction;
  /** Set when the fold was the timer's, not the player's. */
  timedOut: boolean;
}

export interface HandSummaryStreet {
  street: Street;
  actions: HandSummaryAction[];
}

export interface HandSummary {
  seats: { seat: number; userId: number; stack: number }[];
  buttonSeat: number;
  sb: number;
  bb: number;
  /** One bucket per street that actually saw action. */
  streets: HandSummaryStreet[];
  board: CardId[];
  board2: CardId[];
  /** Hole cards that became public: showdown reveals, voluntary shows and
   *  TV-mode key releases. Anything not in here stayed secret. */
  revealed: Record<number, CardId[]>;
  awards: { seat: number; amount: number }[];
  deltas: { seat: number; delta: number }[];
  /** Chips won + rake: everything the betting contributed. */
  pot: number;
  commission: number;
  ranItTwice: boolean;
  aborted: boolean;
  /** Persisted server prose, raw - translate at the display boundary with tr(). */
  abortReason: string | null;
}

/** English source for one summary action line, keyed by a player's name rather
 *  than the seat number - the history page reads like a story, not a log. */
const SUMMARY_ACTION_KEYS: Record<PlayerAction['type'], { withAmount: string; plain: string }> = {
  fold: { withAmount: '{name} folds', plain: '{name} folds' },
  check: { withAmount: '{name} checks', plain: '{name} checks' },
  call: { withAmount: '{name} calls {amount}', plain: '{name} calls' },
  bet: { withAmount: '{name} bets {amount}', plain: '{name} bets' },
  raise: { withAmount: '{name} raises to {amount}', plain: '{name} raises' },
};

/** One player action as a readable line in the current UI language. */
export function summaryActionLabel(name: string, entry: HandSummaryAction): string {
  if (entry.timedOut) return t('{name} timed out', { name });
  const keys = SUMMARY_ACTION_KEYS[entry.action.type];
  return entry.action.amount !== undefined
    ? t(keys.withAmount, { name, amount: fmt(entry.action.amount) })
    : t(keys.plain, { name });
}

/** Fold a stored transcript into a static per-hand recap, or null when the
 *  hand never started. Amounts are the street totals the players declared,
 *  exactly as the replay engine sees them. */
export function summarizeHand(entries: TranscriptEntry[]): HandSummary | null {
  const start = entries.find((e) => e.type === 'hand_start');
  if (!start) return null;
  const sp = start.payload as {
    seats: { seat: number; userId: number; stack: number }[];
    buttonSeat: number;
    sb: number;
    bb: number;
  };

  const streets: HandSummaryStreet[] = [];
  const board: CardId[] = [];
  const board2: CardId[] = [];
  const revealed: Record<number, CardId[]> = {};
  let awards: HandSummary['awards'] = [];
  let deltas: HandSummary['deltas'] = [];
  let commission = 0;
  let ranItTwice = false;
  let aborted = false;
  let abortReason: string | null = null;

  // actions belong to the street most recently opened by betting_start/street;
  // an action before either marker (a transcript that skips them) still lands
  // in preflop rather than vanishing
  const currentStreet = (): HandSummaryStreet => {
    let bucket = streets[streets.length - 1];
    if (!bucket) {
      bucket = { street: 'preflop', actions: [] };
      streets.push(bucket);
    }
    return bucket;
  };

  for (const e of entries) {
    const p = e.payload as Record<string, unknown>;
    switch (e.type) {
      case 'betting_start': {
        // open the preflop bucket even if the hand never reaches an action
        if (!streets.some((s) => s.street === 'preflop')) streets.push({ street: 'preflop', actions: [] });
        break;
      }
      case 'street': {
        // the server marks a street when betting RESUMES on it, so payload.street
        // is the bucket the following actions belong to
        const street = p.street as Street;
        if (!streets.some((s) => s.street === street)) streets.push({ street, actions: [] });
        break;
      }
      case 'action': {
        currentStreet().actions.push({
          seat: p.seat as number,
          action: p.action as PlayerAction,
          timedOut: false,
        });
        break;
      }
      case 'timeout_fold': {
        currentStreet().actions.push({
          seat: p.seat as number,
          action: { type: 'fold' },
          timedOut: true,
        });
        break;
      }
      case 'board_open': {
        if (p.run === 2) board2.push(p.card as CardId);
        else board.push(p.card as CardId);
        break;
      }
      case 'rit_result': {
        ranItTwice = Boolean(p.runTwice);
        break;
      }
      case 'hole_cards': {
        const h = p as { seat: number; cards: CardId[] };
        revealed[h.seat] = h.cards;
        break;
      }
      case 'settlement': {
        commission = (p.commission as number) ?? 0;
        awards = (p.awards as { seat: number; amount: number }[]) ?? [];
        deltas = (p.deltas as { seat: number; delta: number }[]) ?? [];
        for (const r of (p.reveals as { seat: number; cards: CardId[] }[]) ?? []) {
          revealed[r.seat] = r.cards;
        }
        const sb = p.board as CardId[] | undefined;
        const sb2 = p.board2 as CardId[] | undefined;
        if (sb) board.push(...sb.filter((c) => !board.includes(c)));
        if (sb2) board2.push(...sb2.filter((c) => !board2.includes(c)));
        break;
      }
      case 'hand_abort': {
        aborted = true;
        abortReason = String(p.reason ?? '');
        break;
      }
      default:
        break;
    }
  }

  const pot = awards.reduce((sum, a) => sum + a.amount, 0) + commission;
  return {
    seats: sp.seats,
    buttonSeat: sp.buttonSeat,
    sb: sp.sb,
    bb: sp.bb,
    streets,
    board,
    board2,
    revealed,
    awards,
    deltas,
    pot,
    commission,
    ranItTwice,
    aborted,
    abortReason,
  };
}
