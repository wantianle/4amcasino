/**
 * Pure join between the actions a policy actually routed and the actions the
 * server actually accepted.
 *
 * Both sides are keyed by the server-authoritative `(handId, actionSeq)` plus
 * seat. Keeping this as a pure function lets it be unit-tested with the exact
 * shapes a mid-hand reconnect/missed frame produces (a gap in `actionSeq`),
 * independently of the playtest harness that also uses it.
 *
 * Every counter except the acceptance buckets is an *integrity* signal and must
 * be zero for the acceptance numbers to be trustworthy:
 *  - `acceptedWithoutRoute` : an accepted action with no routed decision
 *  - `routeWithoutAccepted`  : a routed send the server never accepted
 *  - `duplicateRoute`        : two routed decisions share one (handId, actionSeq)
 *  - `seatMismatch`          : routed seat disagrees with the transcript seat
 *  - `acceptedMissingActionSeq`: an accepted action with no authoritative seq
 *    (its join key is unknowable, so it is reported rather than silently skipped)
 */

export interface RoutedSend {
  handId: string;
  actionSeq: number;
  seat: number | null;
  source?: 'model' | 'fallback';
}

export interface AcceptedAction {
  handId: string;
  actionSeq: number;
  seat: number;
}

/** Per-policy LLM metrics the human gate reads (see `humanLlmTookEffect`). */
export interface HumanLlmMetrics {
  calls: number;
  decisions: number;
  harnessFallbacks: number;
}

export interface ActionAttribution {
  modelAccepted: number;
  fallbackAccepted: number;
  otherAccepted: number;
  acceptedWithoutRoute: number;
  routeWithoutAccepted: number;
  duplicateRoute: number;
  seatMismatch: number;
  acceptedMissingActionSeq: number;
  modelAcceptedBySeat: Map<number, number>;
  samples: {
    acceptedWithoutRoute: string[];
    routeWithoutAccepted: string[];
    duplicateRoute: string[];
    seatMismatch: string[];
  };
}

const key = (handId: string, actionSeq: number): string => `${handId}:${actionSeq}`;
const MAX_SAMPLES = 10;

export function joinActionAttribution(
  sends: RoutedSend[],
  accepted: AcceptedAction[],
  acceptedMissingActionSeq = 0,
): ActionAttribution {
  const byKey = new Map<string, RoutedSend[]>();
  for (const s of sends) {
    const k = key(s.handId, s.actionSeq);
    const arr = byKey.get(k);
    if (arr) arr.push(s);
    else byKey.set(k, [s]);
  }

  const duplicateRouteSamples: string[] = [];
  let duplicateRoute = 0;
  for (const [k, arr] of byKey) {
    if (arr.length <= 1) continue;
    duplicateRoute += arr.length - 1;
    if (duplicateRouteSamples.length < MAX_SAMPLES) duplicateRouteSamples.push(`${k} x${arr.length}`);
  }

  let modelAccepted = 0;
  let fallbackAccepted = 0;
  let otherAccepted = 0;
  let acceptedWithoutRoute = 0;
  let seatMismatch = 0;
  const modelAcceptedBySeat = new Map<number, number>();
  const acceptedWithoutRouteSamples: string[] = [];
  const seatMismatchSamples: string[] = [];

  for (const a of accepted) {
    const k = key(a.handId, a.actionSeq);
    const rec = byKey.get(k)?.[0];
    if (!rec) {
      acceptedWithoutRoute++;
      if (acceptedWithoutRouteSamples.length < MAX_SAMPLES)
        acceptedWithoutRouteSamples.push(`${k}#seat${a.seat}`);
      continue;
    }
    if (rec.seat !== a.seat) {
      seatMismatch++;
      if (seatMismatchSamples.length < MAX_SAMPLES)
        seatMismatchSamples.push(`${k}: route seat ${rec.seat} vs transcript seat ${a.seat}`);
      continue; // do not attribute a mis-matched action
    }
    if (rec.source === 'model') {
      modelAccepted++;
      modelAcceptedBySeat.set(a.seat, (modelAcceptedBySeat.get(a.seat) ?? 0) + 1);
    } else if (rec.source === 'fallback') fallbackAccepted++;
    else otherAccepted++;
  }

  const acceptedKeys = new Set(accepted.map((a) => key(a.handId, a.actionSeq)));
  const routeWithoutAcceptedSamples: string[] = [];
  let routeWithoutAccepted = 0;
  for (const s of sends) {
    const k = key(s.handId, s.actionSeq);
    if (acceptedKeys.has(k)) continue;
    routeWithoutAccepted++;
    if (routeWithoutAcceptedSamples.length < MAX_SAMPLES)
      routeWithoutAcceptedSamples.push(`${k}#seat${s.seat}`);
  }

  return {
    modelAccepted,
    fallbackAccepted,
    otherAccepted,
    acceptedWithoutRoute,
    routeWithoutAccepted,
    duplicateRoute,
    seatMismatch,
    acceptedMissingActionSeq,
    modelAcceptedBySeat,
    samples: {
      acceptedWithoutRoute: acceptedWithoutRouteSamples,
      routeWithoutAccepted: routeWithoutAcceptedSamples,
      duplicateRoute: duplicateRouteSamples,
      seatMismatch: seatMismatchSamples,
    },
  };
}

/**
 * The playtest's "human llm decisions took effect" gate.
 *
 * Extracted so the CONSUMER side of the attribution map is unit-testable, not
 * just the producer (`joinActionAttribution`). `modelAcceptedBySeat` is keyed by
 * the NUMERIC seat, so the human (seat 0) must be looked up as `0`; a string
 * label such as `human:<style>#0` (only ever meant for report serialisation)
 * always misses and would silently score every human model run as 0.
 */
export function humanLlmTookEffect(
  modelAcceptedBySeat: Map<number, number>,
  seat: number,
  metrics: HumanLlmMetrics | null,
  expectModel: boolean,
): { ok: boolean; accepted: number } {
  const accepted = modelAcceptedBySeat.get(seat) ?? 0;
  const ok =
    metrics !== null &&
    metrics.calls > 0 &&
    metrics.decisions > 0 &&
    metrics.harnessFallbacks === 0 &&
    (!expectModel || accepted > 0);
  return { ok, accepted };
}
