import { createHash } from 'node:crypto';

/**
 * Central declaration of every runtime-tunable parameter.
 *
 * The product requirement is "change a value and restart, no rebuild": the
 * server loads the repo-root `.env` at boot (`scripts/start.mjs` ->
 * `process.loadEnvFile`), so any parameter read from `process.env` honours that
 * contract. This module is the ONE place that declares those parameters -
 * name, env key, default, bounds, and whether the value may be sent to clients -
 * so the `/api/config` whitelist and the env parser can never drift apart.
 *
 * Parsing follows the project's existing convention (`botPolicy.ts`'s
 * `positiveInt` / `nonNegativeInt`): a non-finite, out-of-range, or malformed
 * value falls back to the declared default rather than erroring, so a typo in
 * `.env` can never crash the server.
 *
 * `min`/`max` encode SEMANTIC validity, not product taste: they exist only to
 * reject values that would break the machine (a `0` hard-stop turning every stop
 * into an immediate abort; a timer delay past what `setTimeout` can represent).
 * A large-but-legal operator value must genuinely take effect - the whole point
 * of this table is "change `.env`, restart, done" - so the bounds are set as
 * wide as the consuming mechanism allows and are never an arbitrary ceiling.
 * (The runtime has its own independent safety caps where they matter: the bot
 * think buffer is capped against the action clock by `planThinkWaitMs`, so its
 * configured max needs no upper bound at all.)
 *
 * Behavior note vs. the pre-`tunables.ts` parsers: `FOURAM_BOT_HARD_STOP_MS`
 * used to accept any positive number and `Math.floor` it - so `0.5` silently
 * became `0`, i.e. an immediate hard abort. The table instead treats `< 1` as
 * invalid and falls back to the 2-minute default; that is a deliberate fix, not
 * an accident (see the spec's `min`).
 *
 * `public` is a security boundary, not documentation: ONLY specs marked
 * `public: true` are ever emitted by `GET /api/config`. Secrets (`LLM_API_KEY`,
 * `BOT_IDENTITY_KEY`, ...) are deliberately absent from this table, so there is
 * no code path that can leak them through the config endpoint.
 */

/** Only integers for now; kept as a named union so the shape can grow. */
export type TunableKind = 'int';

/**
 * Largest delay `setTimeout` can represent (2^31 - 1 ms, ~24.8 days). Used as
 * the upper bound for parameters that are handed straight to a timer: Node
 * fires any larger delay immediately and emits a `TimeoutOverflowWarning`,
 * which would silently invert the meaning of a huge configured value. This is
 * a platform ceiling, not a product cap.
 */
export const MAX_TIMER_MS = 2_147_483_647;

/**
 * Canonical defaults. These are the values an unset env var resolves to, and the
 * source of truth other modules import (e.g. `DEFAULT_THINK_CONFIG`).
 */
export const TUNABLE_DEFAULTS = {
  // Server self-use: bot think buffer (was `DEFAULT_THINK_CONFIG`).
  botThinkMinMs: 150,
  botThinkMaxMs: 450,
  botHardStopMs: 120_000,
  // Server self-use: auto-deal cadence (was `hub.ts`'s `defaultGameOpts`).
  autoDealIntervalMs: 3_500,
  autoDealReadyCheckMs: 1_500,
  // Downstream to the web client: motion durations, read from CSS custom
  // properties. Defaults mirror `apps/web/src/app/table-tokens.css` and the
  // `WIN_FX_MS` / `STACK_LAND_MS` constants in `widgets/table/WinnerFx.tsx`.
  // The deal/flip entrances were split out of `--table-dur-highlight` (the
  // highlight token is the WIN fade-in only now), so they carry their own keys.
  tableDurPulseMs: 1_600,
  tableDurGlowMs: 450,
  tableDurDimMs: 550,
  tableDurHighlightMs: 780,
  tableDurDealMs: 820,
  tableDurFlipMs: 900,
  // Flop pull: the board's horizontal slide and its per-card beat are their own
  // pair so the flop can read as "first card, then the rest" without touching
  // the seat hole-card flight (which still reads tableDurDealMs).
  tableDurFlopPullMs: 400,
  tableDurFlopStaggerMs: 300,
  winFxMs: 3_800,
  stackLandMs: 1_950,
} as const;

export interface TunableSpec {
  /** camelCase key used in the `/api/config` `tunables` payload. */
  readonly key: string;
  /** Environment variable that overrides it. */
  readonly env: string;
  readonly kind: TunableKind;
  /** Value returned when the env var is unset/empty/invalid. */
  readonly default: number;
  /** Inclusive lower/upper bounds; anything outside falls back to `default`. */
  readonly min: number;
  readonly max: number;
  /** Whether this value may be sent to unauthenticated clients. */
  readonly public: boolean;
  readonly describe: string;
}

export const TUNABLES = [
  {
    key: 'botThinkMinMs',
    env: 'BOT_THINK_MIN_MS',
    kind: 'int',
    default: TUNABLE_DEFAULTS.botThinkMinMs,
    min: 0,
    // No practical upper bound: `planThinkWaitMs` already caps the actual wait
    // against the action clock, so a huge configured max cannot wedge a hand.
    max: Number.MAX_SAFE_INTEGER,
    public: false,
    describe: 'Lower bound of the bot think-delay buffer (ms).',
  },
  {
    key: 'botThinkMaxMs',
    env: 'BOT_THINK_MAX_MS',
    kind: 'int',
    default: TUNABLE_DEFAULTS.botThinkMaxMs,
    min: 0,
    max: Number.MAX_SAFE_INTEGER,
    public: false,
    describe: 'Upper bound of the bot think-delay buffer (ms).',
  },
  {
    key: 'botHardStopMs',
    env: 'FOURAM_BOT_HARD_STOP_MS',
    kind: 'int',
    default: TUNABLE_DEFAULTS.botHardStopMs,
    // `< 1` is invalid: `0.5` floors to 0, and a zero hard-stop aborts every
    // graceful stop immediately. That differs from the old parser, which accepted
    // any positive number and returned the floored `0` (see module note).
    min: 1,
    // `stop()` schedules this through a real `setTimeout` (`settlesWithin`), so
    // the ceiling is the timer limit, not an opinion about stop duration.
    max: MAX_TIMER_MS,
    public: false,
    describe: 'Hard upper bound on a graceful bot stop (ms).',
  },
  {
    key: 'autoDealIntervalMs',
    env: 'FOURAM_AUTO_DEAL_INTERVAL_MS',
    kind: 'int',
    default: TUNABLE_DEFAULTS.autoDealIntervalMs,
    // Positive only, matching the old `hub.ts` `positiveInt`: a `0`/negative
    // cadence would make the room deal as fast as the event loop allows.
    min: 1,
    max: MAX_TIMER_MS,
    public: false,
    describe: 'Auto-deal cadence after a hand settles (ms).',
  },
  {
    key: 'autoDealReadyCheckMs',
    env: 'FOURAM_AUTO_DEAL_READY_CHECK_MS',
    kind: 'int',
    default: TUNABLE_DEFAULTS.autoDealReadyCheckMs,
    min: 1,
    max: MAX_TIMER_MS,
    public: false,
    describe: 'Auto-deal ready-check consent window (ms).',
  },
  {
    key: 'tableDurPulseMs',
    env: 'TABLE_DUR_PULSE_MS',
    kind: 'int',
    default: TUNABLE_DEFAULTS.tableDurPulseMs,
    min: 0,
    max: 10_000,
    public: true,
    describe: 'Ready-seat breathing pulse (--table-dur-pulse).',
  },
  {
    key: 'tableDurGlowMs',
    env: 'TABLE_DUR_GLOW_MS',
    kind: 'int',
    default: TUNABLE_DEFAULTS.tableDurGlowMs,
    min: 0,
    max: 10_000,
    public: true,
    describe: 'Acting-seat glow entrance (--table-dur-glow).',
  },
  {
    key: 'tableDurDimMs',
    env: 'TABLE_DUR_DIM_MS',
    kind: 'int',
    default: TUNABLE_DEFAULTS.tableDurDimMs,
    min: 0,
    max: 10_000,
    public: true,
    describe: 'Fold/leave/lost dimming (--table-dur-dim).',
  },
  {
    key: 'tableDurHighlightMs',
    env: 'TABLE_DUR_HIGHLIGHT_MS',
    kind: 'int',
    default: TUNABLE_DEFAULTS.tableDurHighlightMs,
    min: 0,
    max: 10_000,
    public: true,
    describe: 'Winner-highlight fade-in (--table-dur-highlight).',
  },
  {
    key: 'tableDurDealMs',
    env: 'TABLE_DUR_DEAL_MS',
    kind: 'int',
    default: TUNABLE_DEFAULTS.tableDurDealMs,
    min: 0,
    max: 10_000,
    public: true,
    describe: 'Card deal entrance - deck flight / flop push (--table-dur-deal).',
  },
  {
    key: 'tableDurFlipMs',
    env: 'TABLE_DUR_FLIP_MS',
    kind: 'int',
    default: TUNABLE_DEFAULTS.tableDurFlipMs,
    min: 0,
    max: 10_000,
    public: true,
    describe: 'In-place flip reveal - showdown hole cards / board (--table-dur-flip).',
  },
  {
    key: 'tableDurFlopPullMs',
    env: 'TABLE_DUR_FLOP_PULL_MS',
    kind: 'int',
    default: TUNABLE_DEFAULTS.tableDurFlopPullMs,
    min: 0,
    max: 10_000,
    public: true,
    describe: 'Flop pull - one community card sliding out (--table-dur-flop-pull).',
  },
  {
    key: 'tableDurFlopStaggerMs',
    env: 'TABLE_DUR_FLOP_STAGGER_MS',
    kind: 'int',
    default: TUNABLE_DEFAULTS.tableDurFlopStaggerMs,
    min: 0,
    max: 10_000,
    public: true,
    describe: 'Flop pull - gap before the next flop card follows (--table-dur-flop-stagger).',
  },
  {
    key: 'winFxMs',
    env: 'WIN_FX_MS',
    kind: 'int',
    default: TUNABLE_DEFAULTS.winFxMs,
    min: 0,
    max: 60_000,
    public: true,
    describe: 'How long the win celebration stays lit (--win-fx-ms); must cover the server showdown hold.',
  },
  {
    key: 'stackLandMs',
    env: 'STACK_LAND_MS',
    kind: 'int',
    default: TUNABLE_DEFAULTS.stackLandMs,
    min: 0,
    max: 60_000,
    public: true,
    describe: 'Delay before the winner stack number reveals (--stack-land-ms).',
  },
] as const satisfies readonly TunableSpec[];

/** The union of every declared key; `readTunable` accepts only these. */
export type TunableKey = (typeof TUNABLES)[number]['key'];

const SPECS: Record<TunableKey, TunableSpec> = Object.fromEntries(
  TUNABLES.map((spec) => [spec.key, spec as TunableSpec]),
) as Record<TunableKey, TunableSpec>;

function parseTunable(spec: TunableSpec, raw: string | undefined): number {
  if (raw === undefined || raw === '') return spec.default;
  const n = Number(raw);
  if (!Number.isFinite(n)) return spec.default;
  const value = Math.floor(n);
  if (value < spec.min || value > spec.max) return spec.default;
  return value;
}

/** Resolve one tunable from env (or the declared default). */
export function readTunable(key: TunableKey, env: NodeJS.ProcessEnv = process.env): number {
  const spec = SPECS[key];
  return parseTunable(spec, env[spec.env]);
}

/** Resolve every declared tunable (server self-use + public), by key. */
export function resolveTunables(env: NodeJS.ProcessEnv = process.env): Record<TunableKey, number> {
  const out = {} as Record<TunableKey, number>;
  for (const spec of TUNABLES) out[spec.key] = readTunable(spec.key, env);
  return out;
}

/**
 * The `/api/config` payload's `tunables` map: ONLY specs declared `public`.
 * Everything else (`botThink*`, `botHardStopMs`) is filtered out, and secrets
 * are not in the table at all.
 */
export function publicTunables(env: NodeJS.ProcessEnv = process.env): Partial<Record<TunableKey, number>> {
  const out: Partial<Record<TunableKey, number>> = {};
  for (const spec of TUNABLES) {
    if (spec.public) out[spec.key] = readTunable(spec.key, env);
  }
  return out;
}

/** Stable content revision of a public tunables map (12 hex chars), so a client
 *  can detect a change across restarts without diffing every field. */
export function tunablesRevision(tunables: Partial<Record<TunableKey, number>>): string {
  const canonical = Object.keys(tunables)
    .sort()
    .map((k) => `${k}=${tunables[k as TunableKey]}`)
    .join('&');
  return createHash('sha256').update(canonical).digest('hex').slice(0, 12);
}
