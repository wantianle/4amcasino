import type { PlayerAction } from '@4am/shared';
import type { DecisionLegalActions, DecisionView } from './decisionView.js';
import { estimateEquity, mulberry32, type EquityInput } from './equity.js';
import type { Policy, PolicyDecision } from './policy.js';
import {
  DEFAULT_POLICY_KIND,
  POLICY_STYLES,
  normalizePolicyKind,
  parseStyleOverrides,
  type PolicyKind,
  type StyleParams,
} from './policyStyles.js';
import { RulePolicy } from './rulePolicy.js';
import type { P2Options } from './postflopPolicy.js';
import { RULES_ENGINE, detectRulesEngine, parseRuleConfig } from './ruleStyles.js';
import { ScriptedPolicy } from './scriptedPolicy.js';

/**
 * Phase 2 style policy.
 *
 * It estimates its own equity with a seeded Monte-Carlo (random opponents only -
 * no peeking), compares it with the pot odds, and applies one of the four
 * stylised decision profiles from `policyStyles.ts`. Every returned action is
 * checked against `DecisionLegalActions`, including short all-in boundaries
 * (`minRaiseTo`/`maxRaiseTo`), so it can never send an illegal action.
 */

export interface StylePolicyOptions {
  /** Monte-Carlo samples per decision. Default `DEFAULT_EQUITY_SAMPLES`. */
  samples?: number;
  /** Base randomness seed; per-hand decisions derive a stable sub-seed. */
  seed?: number;
  /** Explicit params (already validated). Defaults to the kind's style table. */
  params?: StyleParams;
  /** Injection seam for tests; defaults to the seeded Monte-Carlo estimate. */
  equity?: (input: EquityInput) => number;
}

export class StylePolicy implements Policy {
  readonly name: string;
  private readonly kind: PolicyKind;
  private readonly params: StyleParams;
  private readonly samples: number;
  private readonly seed: number;
  private readonly equityOf: (input: EquityInput) => number;

  constructor(kind: PolicyKind, opts: StylePolicyOptions = {}) {
    this.kind = kind;
    this.name = `style-${kind}`;
    this.params = opts.params ?? POLICY_STYLES[kind];
    this.samples = opts.samples ?? 160;
    this.seed = opts.seed ?? 0x9e3779b9;
    this.equityOf = opts.equity ?? ((input) => estimateEquity(input).equity);
  }

  decide(view: DecisionView): PolicyDecision {
    const rawLa = view.legalActions;
    if (!rawLa) throw new Error(`${this.name} asked to act out of turn`);
    const la = this.normalizeLegal(rawLa);

    const hole = view.hand?.myCards ?? [];
    if (hole.length < 2) return this.onlyLegal(la, 'no hole cards yet');

    const board = view.hand?.board ?? [];
    // Every opponent still in the hand contests the pot, including all-in ones:
    // an all-in player holds unknown hole cards that reach showdown, so excluding
    // them would systematically overstate our equity in a multi-way pot.
    const opponents = Math.max(1, view.opponents.filter((o) => !o.folded).length);
    const raw = this.equityOf({
      hole,
      board,
      opponents,
      samples: this.samples,
      seed: this.decisionSeed(view),
    });
    // Fail closed on a bad estimate: a non-finite equity is treated as 0 (the
    // worst case), never as a neutral 0.5 that would invite a call.
    const equity = Number.isFinite(raw) ? Math.min(1, Math.max(0, raw)) : 0;

    return this.kind === 'constrained-random'
      ? this.mixedDecision(view, la, equity)
      : this.heuristicDecision(view, la, equity);
  }

  /**
   * Defensive normalisation of the supplied legal actions, so a malformed view
   * (e.g. `canCall` with `callAmount: 0`, or an inverted raise range) can never
   * make the policy return an action the real table would reject. The governing
   * rule is the shared `legalActions()`: nothing to call means checking is free.
   */
  private normalizeLegal(la: DecisionLegalActions): DecisionLegalActions {
    const canCall = la.canCall && la.callAmount > 0;
    const canCheck = la.canCheck || !canCall;
    const canRaise =
      (la.canBet || la.canRaise) && la.minRaiseTo >= 1 && la.maxRaiseTo >= la.minRaiseTo && la.maxRaiseTo > 0;
    return {
      ...la,
      canCheck,
      canCall,
      canRaise,
      canBet: canRaise && la.canBet,
    };
  }

  /** Deterministic per-decision RNG, derived from the base seed and the view. */
  private rngFor(view: DecisionView): () => number {
    let h = this.seed >>> 0;
    const id = view.hand?.handId ?? '';
    for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 0x01000193) >>> 0;
    h = (h + (view.hand?.toAct ?? 0) * 2654435761) >>> 0;
    h = (h + (view.hand?.board.length ?? 0) * 40503) >>> 0;
    return mulberry32(h);
  }

  private decisionSeed(view: DecisionView): number {
    let h = this.seed >>> 0;
    for (const c of view.hand?.myCards ?? []) h = Math.imul(h ^ (c + 1), 0x01000193) >>> 0;
    return h >>> 0;
  }

  /**
   * True when a bet/raise is available with a legal size. `normalizeLegal`
   * already folds the range checks into `canRaise`/`canBet`, so this only has
   * to read the normalised flags (no duplicated range logic).
   */
  private canRaise(la: DecisionLegalActions): boolean {
    return la.canBet || la.canRaise;
  }

  /**
   * Nothing can be decided (e.g. no cards). Return a legal fallback rather than
   * throwing, so a caller never sees an illegal action.
   */
  private onlyLegal(la: DecisionLegalActions, reason: string): PolicyDecision {
    // `normalizeLegal` guarantees `canCheck || canCall`, so the trailing fold is
    // unreachable: when we cannot check, calling is always legal.
    if (la.canCheck) return { action: { type: 'check' }, reason };
    return { action: { type: 'call' }, reason };
  }

  /** Size a bet/raise within the legal range, as `currentBet + fraction * pot`. */
  private raiseAction(
    view: DecisionView,
    la: DecisionLegalActions,
    fraction: number,
    reason: string,
  ): PolicyDecision {
    const pot = view.hand?.pot ?? 0;
    const currentBet = view.hand?.currentBet ?? 0;
    // `la.minRaiseTo` is an absolute raise-to target; use its delta over the
    // current bet as the floor so we never double-count `currentBet`.
    const minDelta = Math.max(1, la.minRaiseTo - currentBet);
    const raw = currentBet + Math.max(minDelta, Math.round(pot * fraction));
    const amount = Math.max(la.minRaiseTo, Math.min(la.maxRaiseTo, raw));
    const type: PlayerAction['type'] = la.canBet ? 'bet' : 'raise';
    return { action: { type, amount }, reason };
  }

  private heuristicDecision(
    view: DecisionView,
    la: DecisionLegalActions,
    equity: number,
  ): PolicyDecision {
    const rng = this.rngFor(view);
    const potOdds = view.potOdds?.potOdds ?? 0;
    const preflop = (view.hand?.board.length ?? 0) === 0;
    const bluffing = rng() < this.params.bluffFrequency;

    if (la.canCheck) {
      if (this.canRaise(la) && equity >= this.params.valueRaiseEquity)
        return this.raiseAction(view, la, this.params.valueRaiseFraction, 'value bet');
      // Preflop limping guard: do not voluntarily build a pot below the entry bar.
      if (preflop && equity < this.params.preflopEntryEquity && !bluffing)
        return { action: { type: 'check' }, reason: 'check below the preflop entry bar' };
      if (this.canRaise(la) && bluffing)
        return this.raiseAction(view, la, this.params.bluffRaiseFraction, 'bluff bet');
      return { action: { type: 'check' }, reason: 'check' };
    }

    // `normalizeLegal` guarantees `canCheck || canCall`, so reaching here means we
    // can call: there is no "neither" branch left to fold.
    if (this.canRaise(la) && equity >= this.params.valueRaiseEquity)
      return this.raiseAction(view, la, this.params.valueRaiseFraction, 'value raise');
    if (equity >= this.params.callEquity || equity >= potOdds + this.params.callMargin)
      return { action: { type: 'call' }, reason: 'call: equity covers the price' };
    if (this.canRaise(la) && bluffing)
      return this.raiseAction(view, la, this.params.bluffRaiseFraction, 'bluff raise');
    return { action: { type: 'fold' }, reason: 'fold: equity below the price' };
  }

  /**
   * Constrained random: pick among the *legal* actions, blending the
   * equity-driven heuristic weights with a uniform random choice by the
   * `randomness` parameter:
   *
   *   weight = (1 - randomness) * heuristicWeight + randomness * 1
   *
   * So `randomness: 0` is exactly the heuristic decision and `randomness: 1` is
   * a uniform draw over the legal candidates. Seeded, so reproducible. Folding
   * when checking is free is never offered.
   */
  private mixedDecision(
    view: DecisionView,
    la: DecisionLegalActions,
    equity: number,
  ): PolicyDecision {
    const randomness = Number.isFinite(this.params.randomness)
      ? Math.min(1, Math.max(0, this.params.randomness))
      : 0;
    if (randomness <= 0) return this.heuristicDecision(view, la, equity);

    const rng = this.rngFor(view);
    const potOdds = view.potOdds?.potOdds ?? 0;
    const value = equity >= this.params.valueRaiseEquity;
    const callish = equity >= Math.max(this.params.callEquity, potOdds + this.params.callMargin);

    const candidates: { action: PlayerAction; heuristic: number }[] = [];
    if (la.canCheck) candidates.push({ action: { type: 'check' }, heuristic: value ? 0.4 : 0.7 });
    if (la.canCall) candidates.push({ action: { type: 'call' }, heuristic: callish ? 0.7 : 0.25 });
    // `canRaise` already folds in the legal range (`minRaiseTo <= maxRaiseTo`).
    if (this.canRaise(la)) {
      const lo = la.minRaiseTo;
      const hi = la.maxRaiseTo;
      const amount = Math.max(lo, Math.min(hi, lo + Math.floor(rng() * (hi - lo + 1))));
      const type: PlayerAction['type'] = la.canBet ? 'bet' : 'raise';
      candidates.push({ action: { type, amount }, heuristic: value ? 0.6 : 0.25 });
    }
    if (!la.canCheck) candidates.push({ action: { type: 'fold' }, heuristic: callish ? 0.2 : 0.8 });
    // `normalizeLegal` guarantees at least one of check/call/raise/fold, so the
    // candidate list is never empty.

    const weights = candidates.map((c) => (1 - randomness) * c.heuristic + randomness);
    const total = weights.reduce((sum, w) => sum + w, 0);
    let roll = rng() * total;
    for (let i = 0; i < candidates.length; i++) {
      roll -= weights[i]!;
      if (roll <= 0)
        return {
          action: candidates[i]!.action,
          reason: `constrained-random ${candidates[i]!.action.type}`,
        };
    }
    const last = candidates[candidates.length - 1]!;
    return { action: last.action, reason: 'constrained-random fallback' };
  }
}

export interface PolicyResolution {
  kind: PolicyKind;
  policy: Policy;
  /** Human-readable notes: unknown kind, invalid/ignored `policy_json` fields. */
  warnings: string[];
}

/**
 * Resolve a persisted `policy_kind` + `policy_json` to a concrete policy.
 *
 * - unknown/missing kind -> `DEFAULT_POLICY_KIND` (`tight-aggressive`) + warning;
 * - aliases (e.g. the Phase 1b `scripted`) are accepted;
 * - invalid `policy_json` never throws: offending fields keep their defaults and
 *   are reported in `warnings`;
 * - `policy_json.engine === 'rules-v1'` opts into the chart-based `RulePolicy`
 *   (the `policy_kind` still selects the style preset); every other shape keeps
 *   the legacy `ScriptedPolicy`/`StylePolicy` behaviour byte-for-byte;
 * - the reference `tight-aggressive` keeps its dedicated `ScriptedPolicy`
 *   implementation unless a valid override actually changes a parameter.
 *
 * `opts.seed` is an optional seam for experiments/reproducibility: it seeds the
 * `StylePolicy`/`RulePolicy` RNG. `ScriptedPolicy` and the default
 * `tight-aggressive` path ignore it.
 *
 * `opts.p2` is forwarded to the `RulePolicy` built here, so the caller (server
 * resolver / difficulty dispatch) can inject the P2 rollback switches. Omitted
 * fields keep `DEFAULT_P2` (all on); pass `P2_ALL_OFF` for the rollback path.
 */
export function resolvePolicy(
  kindRaw: string | null | undefined,
  policyJson?: string | null,
  opts?: { seed?: number; p2?: Partial<P2Options> },
): PolicyResolution {
  const warnings: string[] = [];
  const normalized = normalizePolicyKind(kindRaw);
  if (!normalized)
    warnings.push(`unknown policyKind "${kindRaw ?? ''}"; falling back to ${DEFAULT_POLICY_KIND}`);
  const kind = normalized ?? DEFAULT_POLICY_KIND;

  // Explicit rules-v1 opt-in. The engine field is the only trigger; without it
  // the legacy style resolution below is untouched (zero regression).
  if (detectRulesEngine(policyJson) === RULES_ENGINE) {
    const cfg = parseRuleConfig(kind, policyJson);
    warnings.push(...cfg.errors);
    const presetKind = cfg.presetKind ?? kind;
    const policy: Policy = new RulePolicy({
      kind: presetKind,
      params: cfg.params,
      seed: opts?.seed,
      // P2 rollback switches from the caller (server env); omitted = DEFAULT_P2.
      p2: opts?.p2,
      // Exception fallback: `RulePolicy` runs its own rules-v1 postflop engine
      // and only uses this (legal, seeded) StylePolicy if that engine throws.
      fallback: new StylePolicy(kind, { seed: opts?.seed }),
    });
    return { kind, policy, warnings };
  }

  const { params, errors, applied } = parseStyleOverrides(kind, policyJson);
  warnings.push(...errors);
  const policy: Policy =
    kind === 'tight-aggressive' && !applied
      ? new ScriptedPolicy()
      : new StylePolicy(kind, { params, seed: opts?.seed });
  return { kind, policy, warnings };
}
