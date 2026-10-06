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
  return parseDurMs(getComputedStyle(document.documentElement).getPropertyValue(cssVar), fallbackMs);
}

/** The ClubGG-style win moment, shared by the desktop oval and the mobile
 *  table: a WIN tag lands on the winner's card, chips fly from the pot to
 *  their stack, and only then does the stack number bump. The rhythm reads
 *  as one deliberate celebration (~3.8s); the full recap lives in 出牌记录 /
 *  the last-hand strip.
 *  WIN_FX_MS / STACK_LAND_MS are the FALLBACKS: at run time the celebration
 *  reads `--win-fx-ms` / `--stack-land-ms` (see feltDur) so /api/config can
 *  tune them without a rebuild. The server's tunables defaults still mirror
 *  the OLD rhythm (3000/910) — they must be synced to the values below, or
 *  the injection will undo the retune in any deployment that serves config. */
export const WIN_FX_MS = 3800;

/* ── the collect beat, one source of truth for its numbers ──
 * L5 (spec sync rule): the burst leads inside the first frame (glow / collect /
 * sound within ±50ms). Disc i starts at LEAD + i*STAGGER after the flight delay
 * and travels TRAVEL, so the FIRST disc settles at LEAD+TRAVEL and the sixth
 * (single winner, discs=6) at LEAD + 5*STAGGER + TRAVEL (~2.25s). */
const COLLECT_LEAD_MS = 50;
const COLLECT_STAGGER_MS = 100;
const COLLECT_TRAVEL_MS = 1700;
/** The stack reveal rides the first discs' landing (the old 910 was hand-synced
 *  to a 0.52s travel and had drifted a full second behind the live 1.4s arc);
 *  the trailing discs settle into the NumberFlow count-up so the number and the
 *  chips finish together. */
const STACK_LAND_MS = COLLECT_LEAD_MS + COLLECT_TRAVEL_MS + 2 * COLLECT_STAGGER_MS; // 1950
/** Collect-flight lead when a showdown reveal plays first: the reveal flip
 *  (--table-dur-flip, 0.9s) plus the badge pop must land before chips move. */
export const COLLECT_REVEAL_LEAD_MS = 1500;

/** True from the moment a settled hand shows winners until the celebration
 *  has played out; drops again the instant no seat is marked won (next deal). */
export function useWinnerFx(anyWon: boolean, handId: string | null = null): boolean {
  const [lit, setLit] = useState(anyWon);
  useEffect(() => {
    if (!anyWon) {
      setLit(false);
      return;
    }
    setLit(true);
    const timer = setTimeout(() => setLit(false), feltDur('--win-fx-ms', WIN_FX_MS));
    return () => clearTimeout(timer);
  }, [anyWon, handId]);
  return lit;
}

/** Hold a seat's pre-win stack while the chips are mid-flight, then let the
 *  real number in so NumberFlow counts it up right as they land. `flightLead`
 *  must equal the ChipFlight delay for the same moment: the showdown-collect
 *  beat starts COLLECT_REVEAL_LEAD_MS late (the reveal plays first), and the
 *  number would otherwise bump a full second before the chips even leave. */
export function useStackReveal(stack: number, won: boolean, flightLead = 0): number {
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
      reduce ? 0 : flightLead + feltDur('--stack-land-ms', STACK_LAND_MS),
    );
    return () => clearTimeout(timer);
  }, [stack, won, shown, reduce, flightLead]);
  return shown;
}

export function StackValue({ stack, won, flightLead = 0 }: { stack: number; won: boolean; flightLead?: number }) {
  const shown = useStackReveal(stack, won, flightLead);
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

/** A short cascade of chips arcing from the pot element to the winner's
 *  card, measured in viewport space so it works on the oval and on phones
 *  alike. Pure decoration - aria-hidden, and skipped under reduced motion. */
export function ChipFlight({
  run,
  getFrom,
  getTo,
  discs = 6,
  delay = 0,
}: {
  run: boolean;
  getFrom: () => HTMLElement | null;
  getTo: () => HTMLElement | null;
  discs?: number;
  /** Leave room for the reveal to land before the collection beat begins. */
  delay?: number;
}) {
  const reduce = useReducedMotion();
  const [path, setPath] = useState<{
    x: number;
    y: number;
    dx: number;
    dy: number;
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
    const sy = from.top + from.height / 2;
    setPath({
      x: sx,
      y: sy,
      dx: to.left + to.width / 2 - sx,
      dy: to.top + to.height * 0.45 - sy,
    });
    // measure once when the moment lights up; the refs are stable by then
  }, [run, reduce]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!path) return null;
  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 z-[70]">
      {Array.from({ length: discs }, (_, i) => {
        const spread = (i % 3) * 6 - 6;
        return (
          <motion.span
            key={i}
            className={cn(
              'absolute h-3.5 w-3.5 rounded-full ring-2 ring-white/60 shadow-[0_2px_8px_rgba(2,6,23,0.45)]',
              DISC_TONES[i % DISC_TONES.length],
            )}
            style={{ left: path.x - 7 + spread, top: path.y - 7 }}
            initial={{ x: 0, y: 0, opacity: 0, scale: 0.4 }}
            animate={{
              x: path.dx,
              y: [0, path.dy * 0.45 - 36, path.dy],
              opacity: [0, 1, 1, 0],
              scale: [0.5, 1.05, 0.95, 0.4],
            }}
            transition={{
              duration: COLLECT_TRAVEL_MS / 1000,
              delay: delay / 1000 + COLLECT_LEAD_MS / 1000 + i * (COLLECT_STAGGER_MS / 1000),
              ease: [0.2, 0, 0, 1],
            }}
          />
        );
      })}
    </div>
  );
}

/** L5 (spec row 3): the call/raise moment - a short burst of chips arcs from
 *  the acting seat's pod to its bet spot on the felt. Same viewport-space
 *  measurement as ChipFlight, so the canvas scale is transparent to it;
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
