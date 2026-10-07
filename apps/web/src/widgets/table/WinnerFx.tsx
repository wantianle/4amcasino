import { useEffect, useRef, useState } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { ShareNetwork } from '@phosphor-icons/react';
import NumberFlow from '@number-flow/react';
import { cn, fmt } from '../../shared/lib/cn.ts';
import { parseDurMs } from '../../shared/lib/tableTimers.ts';
import { t } from '../../shared/i18n/index.ts';

/** Read a felt timing token from the document root. The /api/config runtime
 *  injection (app/main.tsx) publishes `--win-fx-ms` / `--stack-land-ms` in
 *  milliseconds on top of the stylesheet; the TS constants below are the
 *  fallback while no config is in effect. Both units go through parseDurMs. */
function feltDur(cssVar: string, fallbackMs: number): number {
  if (typeof document === 'undefined') return fallbackMs;
  return parseDurMs(
    getComputedStyle(document.documentElement).getPropertyValue(cssVar),
    fallbackMs,
  );
}

export const SETTLEMENT_START_DELAY_MS = 3_000;

/** The ClubGG-style win moment, shared by the desktop oval and the mobile
 *  table: a WIN tag lands on the winner's card, chips fly from the pot to
 *  their stack, and only then does the stack number bump. The rhythm reads
 *  as one deliberate celebration (~3.8s); the full recap lives in 出牌记录 /
 *  the last-hand strip.
 *  WIN_FX_MS / STACK_LAND_MS are the FALLBACKS: at run time the celebration
 *  reads `--win-fx-ms` / `--stack-land-ms` (see feltDur) so /api/config can
 *  tune them without a rebuild. The server's public defaults mirror the
 *  fallback values below, so deployment config cannot undo the rhythm. */
export const WIN_FX_MS = 3800;

/* ── the collect beat, one source of truth for its numbers ──
 * L5 (spec sync rule): the burst leads inside the first frame (glow / collect /
 * sound within ±50ms). Each disc travels COLLECT_TRAVEL_MS; the per-pile and
 * per-chip staggers below are shared with settlementTimelineMs(). */
const COLLECT_TRAVEL_MS = 1700;
/** Settlement has a visible collect beat before the pot pays out. */
export const COLLECT_TO_POT_MS = 620;
export const COLLECT_PAUSE_MS = 120;
/* ── settlement-flight geometry, one source of truth ──
 * Every stagger / chip count below is consumed BOTH by the JSX that renders the
 * discs and by settlementTimelineMs(). That is what keeps the stack reveal and
 * the WIN badge pinned to the discs they ride: a hand with many street piles
 * collects longer, so payout (and the number bump) starts later instead of a
 * fixed 620+120 that outran the collection. */
const COLLECT_SOURCE_CHIPS = 2; // discs per street pile
const COLLECT_SOURCE_STAGGER_MS = 55; // one pile leaves 55ms after the last
const COLLECT_CHIP_STAGGER_MS = 35; // the two discs of a single pile
const PAYOUT_CHIPS = 4; // discs per winner fan
const PAYOUT_TARGET_STAGGER_MS = 90; // one fan starts 90ms after the last
const PAYOUT_CHIP_STAGGER_MS = 70; // the four discs of a single fan
/** When the LAST collect disc reaches the pot, measured from the moment the
 *  flight mounts (i.e. after the settlement start delay). No sources degrades
 *  to one pile's flat travel time. */
function collectEndMs(sourceCount: number): number {
  return (
    COLLECT_TO_POT_MS +
    Math.max(0, sourceCount - 1) * COLLECT_SOURCE_STAGGER_MS +
    (COLLECT_SOURCE_CHIPS - 1) * COLLECT_CHIP_STAGGER_MS
  );
}
/** When the LAST payout disc reaches a winner, measured from flight mount:
 *  collect end + pause + the fan's own stagger + travel. */
function payoutEndMs(sourceCount: number, targetCount: number): number {
  return (
    collectEndMs(sourceCount) +
    COLLECT_PAUSE_MS +
    Math.max(0, targetCount - 1) * PAYOUT_TARGET_STAGGER_MS +
    (PAYOUT_CHIPS - 1) * PAYOUT_CHIP_STAGGER_MS +
    COLLECT_TRAVEL_MS
  );
}
/** The stack reveal rides the payout flight's trailing discs. The new collect
 *  lead is supplied by RoundTable, while this public tunable remains the
 *  winner-flight landing gate used by the runtime config contract. */
const STACK_LAND_MS = 1_950;
/** Collect-flight lead when a showdown reveal plays first: the reveal flip
 *  (--table-dur-flip, 0.9s) plus the badge pop must land before chips move. */
export const COLLECT_REVEAL_LEAD_MS = 1500;
/** One absolute clock for every settlement consumer: the settlement start
 *  delay, the collect lead, then whichever is LATER — the configured
 *  `--stack-land-ms` gate or the payout discs actually landing. `sourceCount`
 *  is how many street piles collect in, `targetCount` how many winners fan out. */
export function settlementTimelineMs(
  collectLead = 0,
  sourceCount = 0,
  targetCount = 1,
): number {
  return (
    feltDur('--settlement-start-delay-ms', SETTLEMENT_START_DELAY_MS) +
    collectLead +
    Math.max(
      feltDur('--stack-land-ms', STACK_LAND_MS),
      payoutEndMs(sourceCount, targetCount),
    )
  );
}

/** True from the moment a settled hand shows winners until the celebration
 *  has played out; drops again the instant no seat is marked won (next deal). */
export function useWinnerFx(
  anyWon: boolean,
  handId: string | null = null,
  collectLead = 0,
  sourceCount = 0,
  targetCount = 1,
): boolean {
  const reduce = useReducedMotion();
  const [lit, setLit] = useState(anyWon);
  useEffect(() => {
    if (!anyWon) {
      setLit(false);
      return;
    }
    if (reduce) {
      setLit(true);
      return;
    }
    setLit(false);
    const start = setTimeout(
      () => setLit(true),
      feltDur('--settlement-start-delay-ms', SETTLEMENT_START_DELAY_MS),
    );
    const timeline = settlementTimelineMs(collectLead, sourceCount, targetCount);
    const end = setTimeout(() => setLit(false), timeline + feltDur('--win-fx-ms', WIN_FX_MS));
    return () => {
      clearTimeout(start);
      clearTimeout(end);
    };
  }, [anyWon, handId, reduce, collectLead, sourceCount, targetCount]);
  return lit;
}

/** The WIN badge is deliberately late: it is the punctuation after the chips
 * have reached the winner, not a label that appears while money is moving. */
export function useWinnerBadge(
  anyWon: boolean,
  handId: string | null = null,
  flightLead = 0,
  sourceCount = 0,
  targetCount = 1,
): boolean {
  const reduce = useReducedMotion();
  const [lit, setLit] = useState(Boolean(reduce && anyWon));
  useEffect(() => {
    if (!anyWon) {
      setLit(false);
      return;
    }
    if (reduce) {
      setLit(true);
      return;
    }
    setLit(false);
    const timeline = settlementTimelineMs(flightLead, sourceCount, targetCount);
    const showTimer = setTimeout(() => setLit(true), timeline);
    const hideTimer = setTimeout(() => setLit(false), timeline + feltDur('--win-fx-ms', WIN_FX_MS));
    return () => {
      clearTimeout(showTimer);
      clearTimeout(hideTimer);
    };
  }, [anyWon, handId, flightLead, sourceCount, targetCount, reduce]);
  return lit;
}

/** Hold a seat's pre-win stack while the chips are mid-flight, then let the
 *  real number in so NumberFlow counts it up right as they land. `flightLead`
 *  must equal the settlement flight's delay for the same moment: the
 *  showdown-collect beat starts COLLECT_REVEAL_LEAD_MS late (the reveal plays
 *  first), and the number would otherwise bump a full second before the chips
 *  even leave. */
export function useStackReveal(
  stack: number,
  won: boolean,
  flightLead = 0,
  sourceCount = 0,
  targetCount = 1,
): number {
  const reduce = useReducedMotion();
  const [shown, setShown] = useState(stack);
  const lastLive = useRef(stack);
  useEffect(() => {
    if (!won) {
      lastLive.current = stack;
      setShown(stack);
      return;
    }
    if (stack === lastLive.current || shown === stack) return;
    const timer = setTimeout(
      () => setShown(stack),
      reduce ? 0 : settlementTimelineMs(flightLead, sourceCount, targetCount),
    );
    return () => clearTimeout(timer);
  }, [stack, won, shown, reduce, flightLead, sourceCount, targetCount]);
  return shown;
}

export function StackValue({
  stack,
  won,
  flightLead = 0,
  sourceCount = 0,
  targetCount = 1,
}: {
  stack: number;
  won: boolean;
  flightLead?: number;
  sourceCount?: number;
  targetCount?: number;
}) {
  const shown = useStackReveal(stack, won, flightLead, sourceCount, targetCount);
  return <NumberFlow value={shown} />;
}

/** The gold WIN tag with the amount won, riding on the winner's card.
 *  `onShare` lands only on the top winner's badge, where there is a share
 *  card to build - the pill's old job, folded into the moment itself. */
export function WinBadge({ amount, onShare }: { amount: number; onShare?: () => void }) {
  const reduce = useReducedMotion();
  return (
    <motion.span
      initial={reduce ? false : { scale: 0.4, y: 8, opacity: 0 }}
      animate={{ scale: 1, y: 0, opacity: 1 }}
      exit={reduce ? undefined : { scale: 0.7, opacity: 0 }}
      transition={reduce ? { duration: 0 } : { type: 'spring', stiffness: 340, damping: 24 }}
      className="pointer-events-auto flex items-center gap-1 rounded-full bg-gradient-to-b from-amber-300 to-amber-400 py-0.5 pl-2 pr-1 font-display text-[0.62rem] font-black uppercase tracking-wide text-amber-950 shadow-[0_4px_18px_rgba(251,191,36,0.5)] ring-1 ring-amber-200/80"
    >
      {t('WIN')}
      {amount > 0 && (
        <span className="rounded-full bg-amber-950/15 px-1.5 py-px text-[0.6rem] font-bold tabular-nums">
          +{fmt(amount)}
        </span>
      )}
      {onShare && (
        <button
          type="button"
          onClick={onShare}
          aria-label={t('Share')}
          title={t('Share')}
          className="rounded-full p-0.5 hover:bg-amber-950/10"
        >
          <ShareNetwork size={12} weight="bold" />
        </button>
      )}
    </motion.span>
  );
}

const DISC_TONES = [
  'bg-amber-300',
  'bg-emerald-500',
  'bg-rose-500',
  'bg-indigo-400',
  'bg-slate-200',
  'bg-amber-400',
];

/** Settlement flight: every visible street pile first collapses into the
 * center pot, then the consolidated pot fans out to the net winner(s). */
export function SettlementFlight({
  run,
  getSources,
  getPot,
  getTo,
  targets,
  delay = 0,
}: {
  run: boolean;
  getSources: () => Array<HTMLElement | DOMRect | null>;
  getPot: () => HTMLElement | null;
  getTo: (seat: number) => HTMLElement | null;
  targets: number[];
  delay?: number;
}) {
  const reduce = useReducedMotion();
  const [paths, setPaths] = useState<{
    sources: Array<{ x: number; y: number; dx: number; dy: number }>;
    targets: Array<{ seat: number; x: number; y: number; dx: number; dy: number }>;
  } | null>(null);
  useEffect(() => {
    if (!run || reduce) {
      setPaths(null);
      return;
    }
    const pot = getPot()?.getBoundingClientRect();
    if (!pot) return;
    const px = pot.left + pot.width / 2;
    const py = pot.top + pot.height / 2;
    const sources = getSources()
      .map((source) => (source instanceof DOMRect ? source : source?.getBoundingClientRect()))
      .filter((rect): rect is DOMRect => !!rect)
      .map((rect) => ({
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
        dx: px - (rect.left + rect.width / 2),
        dy: py - (rect.top + rect.height / 2),
      }));
    const destination = targets
      .map((seat) => {
        const rect = getTo(seat)?.getBoundingClientRect();
        if (!rect) return null;
        return {
          seat,
          x: px,
          y: py,
          dx: rect.left + rect.width / 2 - px,
          dy: rect.top + rect.height * 0.45 - py,
        };
      })
      .filter((path): path is NonNullable<typeof path> => !!path);
    setPaths({ sources, targets: destination });
  }, [run, reduce]); // refs are stable; measure once when the settlement lights up
  if (!paths) return null;
  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 z-[70]">
      {paths.sources.flatMap((path, sourceIndex) =>
        Array.from({ length: COLLECT_SOURCE_CHIPS }, (_, chip) => (
          <motion.span
            key={`collect-${sourceIndex}-${chip}`}
            className={cn(
              'absolute h-3.5 w-3.5 rounded-full ring-2 ring-white/60 shadow-[0_2px_8px_rgba(2,6,23,0.45)]',
              DISC_TONES[(sourceIndex + chip) % DISC_TONES.length],
            )}
            style={{ left: path.x - 7 + chip * 5, top: path.y - 7 }}
            initial={{ x: 0, y: 0, opacity: 0, scale: 0.5 }}
            animate={{
              x: path.dx,
              y: [0, path.dy * 0.35 - 20, path.dy],
              opacity: [0, 1, 1, 0],
              scale: [0.5, 1, 0.7],
            }}
            transition={{
              duration: COLLECT_TO_POT_MS / 1000,
              delay:
                (delay + sourceIndex * COLLECT_SOURCE_STAGGER_MS + chip * COLLECT_CHIP_STAGGER_MS) /
                1000,
              ease: [0.22, 1, 0.36, 1],
            }}
          />
        )),
      )}
      {paths.targets.flatMap((path, targetIndex) =>
        Array.from({ length: PAYOUT_CHIPS }, (_, chip) => (
          <motion.span
            key={`payout-${path.seat}-${chip}`}
            className={cn(
              'absolute h-3.5 w-3.5 rounded-full ring-2 ring-white/60 shadow-[0_2px_8px_rgba(2,6,23,0.45)]',
              DISC_TONES[(targetIndex + chip + 2) % DISC_TONES.length],
            )}
            style={{ left: path.x - 7 + (chip % 2) * 6, top: path.y - 7 }}
            initial={{ x: 0, y: 0, opacity: 0, scale: 0.4 }}
            animate={{
              x: path.dx,
              y: [0, path.dy * 0.45 - 36, path.dy],
              opacity: [0, 1, 1, 0],
              scale: [0.4, 1.05, 0.8],
            }}
            transition={{
              duration: COLLECT_TRAVEL_MS / 1000,
              delay:
                (delay +
                  collectEndMs(paths.sources.length) +
                  COLLECT_PAUSE_MS +
                  targetIndex * PAYOUT_TARGET_STAGGER_MS +
                  chip * PAYOUT_CHIP_STAGGER_MS) /
                1000,
              ease: [0.2, 0, 0, 1],
            }}
          />
        )),
      )}
    </div>
  );
}

/** L5 (spec row 3): the call/raise moment - a short burst of chips arcs from
 *  the acting seat's pod to its bet spot on the felt. Same viewport-space
 *  measurement as SettlementFlight, so the canvas scale is transparent to it;
 *  pure decoration (aria-hidden) and skipped under reduced motion. */
export function BetFlight({
  run,
  getFrom,
  getTo,
}: {
  /** Re-trigger key: any change re-measures and replays the burst. */
  run: number;
  getFrom: () => HTMLElement | null;
  getTo: () => HTMLElement | null;
}) {
  const reduce = useReducedMotion();
  const [path, setPath] = useState<{
    x: number;
    y: number;
    dx: number;
    dy: number;
    id: number;
  } | null>(null);
  useEffect(() => {
    if (!run || reduce) {
      setPath(null);
      return;
    }
    const from = getFrom()?.getBoundingClientRect();
    const to = getTo()?.getBoundingClientRect();
    if (!from || !to) return;
    const sx = from.left + from.width / 2;
    const sy = from.bottom - from.height * 0.25;
    setPath({
      x: sx,
      y: sy,
      dx: to.left + to.width / 2 - sx,
      dy: to.top + to.height / 2 - sy,
      id: run,
    });
    // measure once per committed bump; refs are stable by then
  }, [run, reduce]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!path) return null;
  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 z-[70]">
      {[0, 1, 2].map((i) => (
        <motion.span
          key={`${path.id}-${i}`}
          className={cn(
            'absolute h-3 w-3 rounded-full ring-2 ring-white/50 shadow-[0_2px_6px_rgba(2,6,23,0.4)]',
            DISC_TONES[(i + 1) % DISC_TONES.length],
          )}
          style={{ left: path.x - 6, top: path.y - 6 }}
          initial={{ x: 0, y: 0, opacity: 0, scale: 0.4 }}
          animate={{
            x: [0, path.dx * 0.5, path.dx],
            y: [0, path.dy * 0.5 - 14, path.dy],
            opacity: [0, 1, 1, 0],
            scale: [0.4, 1, 0.9, 0.5],
          }}
          transition={{
            duration: 0.48,
            delay: 0.08 + i * 0.09,
            ease: [0, 0, 0, 1],
          }}
        />
      ))}
    </div>
  );
}
