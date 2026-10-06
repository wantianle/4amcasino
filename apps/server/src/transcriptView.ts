/**
 * Read-only view over a hand transcript's `entries` JSON.
 *
 * Four read models - the room hands list (`rooms.ts`), the play-style miner,
 * `/api/me/hand-history`, and `/api/users/:id/best-hand` (all `profile.ts`) -
 * used to each re-implement the same mechanical preamble: parse the entries,
 * find `hand_start` / `settlement`, pull seats / board / reveals and a seat's
 * `hole_cards`. They had drifted (different optional chaining, different fold
 * semantics, different settlement handling).
 *
 * This module owns ONLY that mechanical extraction into a plain, immutable
 * {@link TranscriptView}. Every endpoint keeps its own *policy* at the call
 * site - what counts as a fold, how to label an outcome, how to aggregate
 * actions - because those policies genuinely differ per endpoint and must not
 * be flattened.
 *
 * Pure data: no DB, no I/O. Callers fetch the `transcripts` row themselves and
 * pass `entries` (a JSON string or an already-parsed value).
 *
 * Canonical assumptions (enforced upstream, relied on here):
 *  - `entries` is always a JSON array; anything else is treated as unreadable.
 *  - a hand carries at most one `settlement` (db.ts `parseSettlementEntry`
 *    rejects multiple), so the first one is the settlement. Since this is a
 *    readonly view, "first" and "only" are the same thing.
 */

/** A single transcript entry as serialised in `transcripts.entries`. */
export interface TranscriptEntry {
  type: string;
  payload: Record<string, unknown>;
}

/** A seat as recorded on `hand_start.payload.seats`. */
export interface TranscriptSeat {
  seat: number;
  userId: number;
}

/** One revealed hand on `settlement.payload.reveals`. */
export interface TranscriptReveal {
  seat: number;
  cards: number[];
}

/** One payout on `settlement.payload.awards`. */
export interface TranscriptAward {
  seat: number;
  amount: number;
}

/** The extracted, read-only shape every transcript reader shares. */
export interface TranscriptView {
  /** Parsed entries, or `null` when `raw` is unreadable / not an array. */
  readonly entries: readonly TranscriptEntry[] | null;
  /** The `hand_start` entry, if any. */
  readonly start: TranscriptEntry | undefined;
  /** Seats from `hand_start` (empty when absent). */
  readonly seats: readonly TranscriptSeat[];
  /** The `settlement` entry, if any. */
  readonly settlement: TranscriptEntry | undefined;
  /** Public board from the settlement (empty when absent). */
  readonly board: readonly number[];
  /** Every revealed hand on the settlement (empty when absent). */
  readonly reveals: readonly TranscriptReveal[];
}

function emptyView(): TranscriptView {
  return { entries: null, start: undefined, seats: [], settlement: undefined, board: [], reveals: [] };
}

/**
 * Parse a transcript's raw `entries` into a {@link TranscriptView}. Accepts the
 * stored JSON string or an already-parsed value. Never throws: unreadable input
 * yields a view with `entries === null` (the caller decides between "skip" and
 * "neutral outcome").
 */
export function transcriptView(raw: unknown): TranscriptView {
  let parsed: unknown = raw;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return emptyView();
    }
  }
  if (!Array.isArray(parsed)) return emptyView();
  const entries = parsed as TranscriptEntry[];
  const start = entries.find((e) => e.type === 'hand_start');
  const settlement = entries.find((e) => e.type === 'settlement');
  return {
    entries,
    start,
    seats: (start?.payload?.seats ?? []) as TranscriptSeat[],
    settlement,
    board: (settlement?.payload.board as number[] | undefined) ?? [],
    reveals: (settlement?.payload.reveals as TranscriptReveal[] | undefined) ?? [],
  };
}

/** Resolve a user's seat in this hand, or `undefined` when they sat out. */
export function seatForUser(view: TranscriptView, userId: number): number | undefined {
  return view.seats.find((s) => s.userId === userId)?.seat;
}

/** The revealed hand for a seat at settlement, or `undefined`. */
export function revealForSeat(
  view: TranscriptView,
  seat: number | undefined,
): TranscriptReveal | undefined {
  if (seat === undefined) return undefined;
  return view.reveals.find((r) => r.seat === seat);
}

/** A seat's payout from the settlement, or `0` when they won nothing. */
export function awardForSeat(view: TranscriptView, seat: number): number {
  const awards = (view.settlement?.payload?.awards as TranscriptAward[] | undefined) ?? [];
  return awards.find((a) => a.seat === seat)?.amount ?? 0;
}

/**
 * The `hole_cards` cards recorded for a seat (dealt or TV-replay decrypted), or
 * `undefined` when the transcript never made them public.
 */
export function holeCardsForSeat(view: TranscriptView, seat: number | undefined): number[] | undefined {
  if (seat === undefined || !view.entries) return undefined;
  const e = view.entries.find(
    (x) => x.type === 'hole_cards' && (x.payload.seat as number) === seat,
  );
  return e?.payload.cards as number[] | undefined;
}

/** Where (and whether) a seat folded. `street` is the fold street (0 = preflop)
 *  and is `0` when `folded` is false. */
export interface FoldInfo {
  folded: boolean;
  street: number;
}

/**
 * Whether a seat folded, and at which street.
 *
 * `timeout_folds` (default off) also counts an auto-fold as a fold. The room
 * hands list reads only explicit `action` folds; `/api/me/hand-history` counts
 * both. That divergence is intentional and stays a caller choice.
 */
export function foldForSeat(
  view: TranscriptView,
  seat: number,
  opts: { timeoutFolds?: boolean } = {},
): FoldInfo {
  if (!view.entries) return { folded: false, street: 0 };
  let street = 0;
  for (const e of view.entries) {
    if (e.type === 'street') {
      street++;
      continue;
    }
    if ((e.payload?.seat as number | undefined) !== seat) continue;
    if (e.type === 'action' && (e.payload.action as { type?: string } | undefined)?.type === 'fold') {
      return { folded: true, street };
    }
    if (opts.timeoutFolds && e.type === 'timeout_fold') {
      return { folded: true, street };
    }
  }
  return { folded: false, street: 0 };
}
