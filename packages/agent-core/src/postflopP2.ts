/**
 * P2 feature toggles as a neutral leaf module.
 *
 * Moved verbatim out of `postflopPolicy.ts`: the signal/villain layer needs
 * `DEFAULT_P2` for its default arguments, and the policy orchestrator needs the
 * same constant, so the shared type + default live here and both import them
 * without a cycle. `P2_ALL_OFF` (the explicit all-off control) lives here too
 * (moved next to `DEFAULT_P2` in phase 6) so the two cannot drift. Everything is
 * re-exported from `postflopPolicy.ts`, so the public surface is unchanged.
 */

// ---------------------------------------------------------------------------
// P2: feature toggles
// ---------------------------------------------------------------------------

/**
 * The P2 behaviour switches that remain after the 2026-10-06 prune. Each is
 * independently injectable so a caller (or a test) can A/B or enable one without
 * touching the other.
 *
 * History: the product briefly ran P2 all-on (commit `5e8566a`); the first A/B
 * eval (`docs/plans/2026-10-06-bot-ab-eval-results.md`) judged all-four-on
 * `worse` than the all-off baseline in its narrow rig (3-handed, `always-call`
 * anchor, mirror strategy): `p2:all` cluster CI `[-85.8, -17.1]`, so it was
 * reverted to all-off on 2026-10-06. The fairer follow-up
 * (`docs/plans/2026-10-06-bot-ab-eval-v2-fair.md`, real tendentious opponents
 * TAG/station/LAG + `always-call`) then found `rangePropagation` significantly
 * harmful under two opponents (TAG -43.7 bb/100, station -55.3) and `shrinkage`
 * harmful under station (-32.0), with consistent sign; **both switches were
 * therefore deleted outright** (capability permanently off, no toggle). Only
 * `sizeGrid` / `buckets` survive.
 *
 * **Not byte-for-byte identical to the pre-P2 baseline**: this file also carries
 * an always-on `evaluateHand` fix (exclude straight draws with no hero-only rank
 * contribution; clear the draw flag at `category >= 4`), which applies to hero
 * and villain-combo evaluation regardless of the switches. See
 * `docs/plans/postflop-p2-report.md` §3 for the exact scope.
 */
export interface P2Options {
  /** Snap an observed bet size to the discrete `POSTFLOP_SIZE_GRID`. */
  sizeGrid: boolean;
  /** Tilt villain combo weights by their 24-bucket strength. */
  buckets: boolean;
}

/**
 * Default P2 configuration. **`sizeGrid` / `buckets` are ON by default.**
 *
 * ⚠️ Risk, recorded explicitly: the fair v2 A/B
 * (`docs/plans/2026-10-06-bot-ab-eval-v2-fair.md`) measured a positive mean for
 * `buckets` across all four opponents (+3.8 / +6.6 / +20.1 / +4.5 bb/100) but
 * **every interval was inconclusive** (sample too small - this is NOT proof it
 * helps), and `sizeGrid` is ≈0 against betting opponents and exactly 0 against
 * non-betting ones. **Defaulting them on is a product decision, not a
 * statistical conclusion — do not describe it as "validated".** Set
 * `FOURAM_P2_ALL_OFF=1` for the all-off fallback.
 *
 * History: this constant was all-off after the 2026-10-06 revert (commit
 * `5e8566a` had briefly made it all-on, and
 * `docs/plans/2026-10-06-bot-ab-eval-results.md` judged all-four-on `worse` in
 * its narrow rig). `rangePropagation` / `shrinkage` were subsequently deleted
 * (see {@link P2Options}); the two survivors become product-default on.
 *
 * `Object.freeze` + `Readonly<P2Options>` keep the default immutable: a runtime
 * write (`DEFAULT_P2.sizeGrid = false`) neither compiles nor takes effect, so
 * the default parameters that read this constant cannot be silently flipped.
 * Callers that want a switch off must pass their own explicit `p2` option.
 */
export const DEFAULT_P2: Readonly<P2Options> = Object.freeze({
  sizeGrid: true,
  buckets: true,
});

/**
 * Frozen explicit all-off configuration: the pre-P2 decision path
 * (`sizeGrid` / `buckets` both `false`). With {@link DEFAULT_P2} now defaulting
 * both on this is the named **kill-switch / A/B control**, and it is no longer
 * identical to the default. It is kept as a named constant because callers
 * (server env `FOURAM_P2_ALL_OFF`, the eval harness) and tests reference it
 * explicitly, so the one-import rollback cannot drift from the `DEFAULT_P2`
 * shape. Pass it as `new PostflopPolicy({ ..., p2: P2_ALL_OFF })`.
 */
export const P2_ALL_OFF: Readonly<P2Options> = Object.freeze({
  sizeGrid: false,
  buckets: false,
});
