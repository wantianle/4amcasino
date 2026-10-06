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
 * `public` is a security boundary, not documentation: ONLY specs marked
 * `public: true` are ever emitted by `GET /api/config`. Secrets (`LLM_API_KEY`,
 * `BOT_IDENTITY_KEY`, ...) are deliberately absent from this table, so there is
 * no code path that can leak them through the config endpoint.
 */

/** Only integers for now; kept as a named union so the shape can grow. */
export type TunableKind = 'int';

/**
 * Canonical defaults. These are the values an unset env var resolves to, and the
 * source of truth other modules import (e.g. `DEFAULT_THINK_CONFIG`).
 */
export const TUNABLE_DEFAULTS = {
  // Server self-use: bot think buffer (was `DEFAULT_THINK_CONFIG`).
  botThinkMinMs: 150,
  botThinkMaxMs: 450,
  botHardStopMs: 120_000,
  // Downstream to the web client: motion durations, read from CSS custom
  // properties. Defaults mirror `apps/web/src/app/table-tokens.css` and the
  // `WIN_FX_MS` / `STACK_LAND_MS` constants in `widgets/table/WinnerFx.tsx`.
  tableDurPulseMs: 1_600,
  tableDurGlowMs: 450,
  tableDurDimMs: 460,
  tableDurHighlightMs: 620,
  winFxMs: 3_000,
  stackLandMs: 910,
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
    max: 10_000,
    public: false,
    describe: 'Lower bound of the bot think-delay buffer (ms).',
  },
  {
    key: 'botThinkMaxMs',
    env: 'BOT_THINK_MAX_MS',
    kind: 'int',
    default: TUNABLE_DEFAULTS.botThinkMaxMs,
    min: 0,
    max: 10_000,
    public: false,
    describe: 'Upper bound of the bot think-delay buffer (ms).',
  },
  {
    key: 'botHardStopMs',
    env: 'FOURAM_BOT_HARD_STOP_MS',
    kind: 'int',
    default: TUNABLE_DEFAULTS.botHardStopMs,
    min: 1,
    max: 600_000,
    public: false,
    describe: 'Hard upper bound on a graceful bot stop (ms).',
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
