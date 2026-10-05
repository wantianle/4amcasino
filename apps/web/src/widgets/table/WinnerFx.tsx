import { useEffect, useRef, useState } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { ShareNetwork } from '@phosphor-icons/react';
import NumberFlow from '@number-flow/react';
import { cn, fmt } from '../../shared/lib/cn.ts';
import { t } from '../../shared/i18n/index.ts';

/** The ClubGG-style win moment, shared by the desktop oval and the mobile
 *  table: a WIN tag lands on the winner's card, chips fly from the pot to
 *  their stack, and only then does the stack number bump. The whole thing
 *  is a ~2.6s glance; the full recap lives in 出牌记录 / the last-hand strip. */

export const WIN_FX_MS = 3000;
// L5: the collect burst leads within the first frame (spec sync rule: glow /
// collect / sound within ±50ms) and its last disc lands ~0.91s in (0.04 lead +
// 5x70ms stagger + 0.52 travel), so the stack reveal meets it there.
const STACK_LAND_MS = 910;

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
    const timer = setTimeout(() => setLit(false), WIN_FX_MS);
    return () => clearTimeout(timer);
  }, [anyWon, handId]);
  return lit;
}

/** Hold a seat's pre-win stack while the chips are mid-flight, then let the
 *  real number in so NumberFlow counts it up right as they land. */
export function useStackReveal(stack: number, won: boolean): number {
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
    const timer = setTimeout(() => setShown(stack), reduce ? 0 : STACK_LAND_MS);
    return () => clearTimeout(timer);
  }, [stack, won, shown, reduce]);
  return shown;
}

export function StackValue({ stack, won }: { stack: number; won: boolean }) {
  const shown = useStackReveal(stack, won);
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
      transition={reduce ? { duration: 0 } : { type: 'spring', stiffness: 480, damping: 22 }}
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
            transition={{ duration: 1.4, delay: delay / 1000 + 0.04 + i * 0.07, ease: [0.2, 0, 0, 1] }}
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
