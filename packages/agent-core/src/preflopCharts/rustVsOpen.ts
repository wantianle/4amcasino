import { RUST_VS_OPEN, type RustVsOpenTriple } from './data/rustVsOpen.js';

/**
 * Rust (GGPoker, rake-aware) cold-3-bet raise provider for the **non-BB**
 * `X-vs-open-Y` spot.
 *
 * Scope: only the *raise* (cold-3-bet) frequency of a non-BB defender facing a
 * single open is taken from the Rust export. The flat-call range stays on the
 * legacy `preflopRanges.ts` tables (`CALL_VS_OPEN`), and the BB / RFI /
 * vs-3bet / vs-4bet spots keep their existing providers. See
 * `preflopPolicy.buildColdAdaptiveMix` for the merge.
 *
 * ## Position mapping (6-max export -> our 9-max table)
 *
 * The export has six seat names (UTG/MP/CO/BTN/SB/BB); ours has up to nine.
 * A seat is keyed by "how many players still act after it in preflop action
 * order" (the action order suffix), NOT by its name: once the players before a
 * seat have folded, the remaining players form the *same* subgame regardless of
 * the dealt table size. So:
 *
 *   behind 5 -> Rust UTG   behind 4 -> Rust MP   behind 3 -> Rust CO
 *   behind 2 -> Rust BTN   behind 1 -> Rust SB   behind 0 -> Rust BB
 *
 * A 9-max hero at LJ/HJ/CO/BTN/SB maps exactly (behind 5/4/3/2/1). The 9-max
 * **early** seats UTG (behind 8), UTG1 (7) and MP (6) have no 6-max equivalent
 * — their open/defence subgames are genuinely wider — so they return `null` and
 * stay on the legacy tables. Likewise any opener whose behind count is outside
 * 1..5 is unmapped. The same rule holds for 7/8/5-max tables: only the seats
 * whose action-order suffix matches a 6-max seat are connected.
 *
 * ## Three-state cells
 *
 * `normalizeRustTriple` returns:
 *   - a number in [0, 1] when the export has data for the class (a pure
 *     `fold` cell normalises to `0` — a *known* "do not raise");
 *   - `null` when the class is absent / `na` — *unknown*: the caller must fall
 *     back to the legacy raise, never read it as a fold.
 *
 * ## Normalisation
 *
 * The export's action frequencies do not always sum to 1 (worst case 0.007 for
 * BTN-vs-open-UTG). The raise probability is normalised by the cell total on
 * read, and the raw per-spot residual is carried in the provenance (both the
 * generated `RUST_VS_OPEN.provenance.residualMaxBySpot` and the runtime
 * `provenance` returned here) so the correction is never silent.
 *
 * ## ⚠️ APPROXIMATION DISCLAIMER — read this before trusting any frequency
 *
 * This provider is **not a GTO baseline**. The embedded numbers are a
 * **`round3=true` display chart**, produced by a proxy-leaf / finite-iteration
 * approximate solver:
 *
 *   - Source: `~/dev/gto-trainer/data/preflop/charts_rust_gg.json`.
 *   - `round3=true` is the *display* layer; the untrimmed `round3=false` raw
 *     snapshot (`raw_<k>.json` from the outer loop) is **not** what is embedded.
 *   - Solver: proxy leaves (`builtin_proxy_fill`), mean-field CFR, 2000 iterations,
 *     approximate EV. Good shape, **not equilibrium**.
 *
 * ### Round3 display clipping (accepted cost, not a bug)
 *   - actions with `f <= 0.005` are dropped (`main.rs:1454`);
 *   - frequencies are stored to 3 decimals (a displayed `1.0` may be `0.995–1.0`);
 *   - hands with `reach < 1e-4` are written as `na` (`main.rs:1437`).
 *
 * ### `na` semantics (the important one)
 *   `na` means `reach[hand] < 1e-4`: the hand can practically not reach this node,
 *   so its strategy here is meaningless. It does **NOT** mean "unsolved" and it
 *   **MUST NOT** be read as fold — treat an `na` hand as **out of range at this
 *   node** and fall back to the legacy raise (see the three-state contract below).
 *   The generator currently emits `na` hands by omission, so in today's data
 *   `null` only arises for absent/degenerate rows — behaviour is correct today.
 *
 *   A `na` (unreachable) hand is distinct from a legitimate all-zero cell (a class
 *   that *can* be dealt here but genuinely does not take the action). A stored
 *   triple cannot tell them apart, so **when a future `round3=false` raw snapshot
 *   is wired in, the conversion layer must carry the `reach`/`na` source semantics
 *   through — `normalizeRustTriple` alone cannot recover it from `[0,0,0]`.**
 *
 * ### Known calibration / leaf facts (explain the shape; not bugs)
 *   - gamma = 1.70 / erf = 0.16 were calibrated at rake = 0 but used at rake 0.05;
 *   - leaves are proxy ranges (IP 53 classes / OOP 57 classes).
 *
 * ### Scope (plan C)
 *   Only the non-BB cold-3bet **raise** comes from this export. RFI / BB defence /
 *   vs-3bet / vs-4bet are untouched; the legacy baseline is not replaced and no old
 *   table is spliced in; `call` stays legacy. The 113 non-premium >0.99 frequencies
 *   (10 non-BB vs-open spots x non-premium x normalised raise > 0.99) are a symptom
 *   of this approximation, passed through verbatim (no filtering/smoothing);
 *   watch-list: `test/fixtures/rustVsOpenExtremeFrequencies.json`. Planned fix:
 *   real leaves + converged iterations, then swap the data source.
 */

export interface RustVsOpenProvenance {
  provider: string;
  url: string;
  ref: string;
  license: string;
  capturedAt: string;
  sourceFile: string;
  note: string;
  /** Worst |1 - sum(actions)| for this spot, measured on the stored export. */
  residualMax: number;
  /** Hand classes in this spot whose stored sum deviated from 1 (>1e-9). */
  residualCount: number;
  /** The raise was divided by the cell total on read, never silently clamped. */
  normalisedOnRead: true;
}

export interface RustVsOpenRaiseTable {
  /** Export key, e.g. `BTN-vs-open-UTG`. */
  spotKey: string;
  /**
   * Hand class -> normalised raise probability in [0, 1], or `null` when the
   * export carries no data for the class (`na`/absent). `null` MUST fall back
   * to the legacy raise; `0` means "the solver does not raise this class".
   */
  raise: Map<string, number | null>;
  provenance: RustVsOpenProvenance;
}

/** behind-unacted count in preflop action order -> 6-max export seat name. */
const BEHIND_TO_RUST_SEAT: Record<number, string> = {
  0: 'BB',
  1: 'SB',
  2: 'BTN',
  3: 'CO',
  4: 'MP',
  5: 'UTG',
};

/**
 * The 6-max export seat name for a seat with `behind` players to act after it,
 * or `null` when no 6-max seat has that action-order suffix.
 */
export function rustPositionForBehind(behind: number): string | null {
  if (!Number.isFinite(behind)) return null;
  return BEHIND_TO_RUST_SEAT[Math.trunc(behind)] ?? null;
}

/**
 * The export spot key for a non-BB hero facing a single open, or `null` when
 * either seat has no exact 6-max equivalent. `BB`/`SB` openers are refused:
 * a non-BB hero can never face them (only the BB acts after the SB open), and
 * the BB-facing-an-open route is served by the FRLA anchor.
 */
export function rustVsOpenSpotKey(heroBehind: number, openerBehind: number): string | null {
  const hero = rustPositionForBehind(heroBehind);
  const opener = rustPositionForBehind(openerBehind);
  if (hero === null || opener === null) return null;
  if (hero === 'BB' || opener === 'BB' || opener === 'SB') return null;
  const key = `${hero}-vs-open-${opener}`;
  return key in RUST_VS_OPEN.spots ? key : null;
}

/**
 * Normalise one stored `[raise, call, fold]` cell to its raise probability, or
 * `null` when there is no data (`undefined`/`null`, or a degenerate all-zero
 * cell). A pure-fold cell returns `0` — data, not `null`.
 *
 * NOTE (future raw-snapshot integration): an all-zero triple is ambiguous — it is
 * either an unreachable `na` hand or a legitimate all-zero cell. This function
 * cannot distinguish them, so the **conversion layer must preserve the source
 * `reach`/`na` semantics** rather than trying to recover them from `[0,0,0]` here.
 */
export function normalizeRustTriple(raw: RustVsOpenTriple | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;
  // INTENTIONAL RUNTIME HARDENING (beyond the plain Rust integration). This
  // provider reads generated embedded data at runtime, so the read boundary is
  // hardened against a malformed row: wrong length, a non-number component, or
  // a negative frequency all read as `null` ("unknown") and fall back to the
  // legacy raise. `null` is the conservative choice; a malformed row must never
  // be read as a *known* frequency — a fabricated number could widen or shift a
  // range on corrupt data. `Number.isFinite` also rejects `NaN`/`Infinity`.
  // (A negative component is impossible in a valid distribution, so it is
  // unknown, not "known do-not-raise".)
  if (!Array.isArray(raw) || raw.length !== 3) return null;
  const [raise, call, fold] = raw;
  if (!Number.isFinite(raise) || !Number.isFinite(call) || !Number.isFinite(fold)) return null;
  if (raise < 0 || call < 0 || fold < 0) return null;
  const total = raise + call + fold;
  if (!(total > 0)) return null;
  const p = raise / total;
  return Math.min(1, Math.max(0, p));
}

const tableCache = new Map<string, RustVsOpenRaiseTable>();

/**
 * Build (and memoise) the raise table for a mapped non-BB vs-open spot, or
 * `null` when the position pair has no exact 6-max equivalent (early 9-max
 * seats). Every class present in the export is included; a class the exporter
 * marked `na` is included as `null` so the caller can fall back.
 */
export function rustVsOpenRaiseTable(
  heroBehind: number,
  openerBehind: number,
): RustVsOpenRaiseTable | null {
  const spotKey = rustVsOpenSpotKey(heroBehind, openerBehind);
  if (spotKey === null) return null;
  const cached = tableCache.get(spotKey);
  if (cached) return cached;

  const spot = RUST_VS_OPEN.spots[spotKey];
  if (!spot) return null;
  const raise = new Map<string, number | null>();
  for (const key of Object.keys(spot)) {
    raise.set(key, normalizeRustTriple(spot[key]));
  }

  const prov = RUST_VS_OPEN.provenance;
  const table: RustVsOpenRaiseTable = {
    spotKey,
    raise,
    provenance: {
      provider: prov.provider,
      url: prov.url,
      ref: prov.ref,
      license: prov.license,
      capturedAt: prov.capturedAt,
      sourceFile: prov.sourceFile,
      note: prov.note,
      residualMax: prov.residualMaxBySpot[spotKey] ?? 0,
      residualCount: prov.residualCountBySpot[spotKey] ?? 0,
      normalisedOnRead: true,
    },
  };
  tableCache.set(spotKey, table);
  return table;
}
