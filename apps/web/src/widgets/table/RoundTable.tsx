import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { Link } from 'react-router-dom';
import { Crown, Coins, MicrophoneSlash, Play, Timer, X } from '@phosphor-icons/react';
import type { CardId, PlayerAction } from '@4am/shared';
import { cn, fmt } from '../../shared/lib/cn.ts';
import { t } from '../../shared/i18n/index.ts';
import { Avatar } from '../../entities/user/Avatar.tsx';
import { PlayingCard } from '../../entities/card/PlayingCard.tsx';
import type { SeatView } from './players.tsx';
import { ChipStack } from './ChipStack.tsx';
import { ChipFlight, StackValue, WinBadge, useWinnerFx } from './WinnerFx.tsx';

/** A real round table: nine seat pods around an oval, your seat pinned at the
 *  bottom, everyone repositioning live as they sit, act, and fold. The banker
 *  sees every seat and can stand a player up (both requested by notpritam,
 *  docs/FEATURES.md). Empty seats are sittable in place.
 *
 *  P1 table redesign (docs/table-redesign-spec.md):
 *  - A3 ONE locked design canvas defines the oval; the phone instance is the
 *    same canvas at exact 1/2 (identical aspect and seat geometry), fitted
 *    with a uniform CSS scale(k).
 *  - User feedback #1: k has a readable FLOOR. When the viewport cannot fit
 *    the canvas at the floor, the stage SCROLLS instead of shrinking the
 *    table into illegibility. The ellipse never stretches either way.
 *  - User feedback #4: no separate big-card panel - the pod IS the card
 *    display.
 *  - User feedback v2 (#1-#3): the two hole cards sit SIDE BY SIDE next to the
 *    avatar (never fanned over it, never colliding with the position discs);
 *    name / stack / 牌型 live on a compact solid plate below the avatar, not
 *    as text floating over the felt; and the pods are anchored by arc so the
 *    bottom seat can no longer be clipped by the rim or covered by the
 *    「行动中」 badge - the pill rides in the pod's own flow. */

const SEATS = 9;

/** THE design canvas (A3). Ellipse = 87%×60% of the canvas = 1026.6×396
 *  (2.592:1) on desktop, 513.3×198 (2.592:1) on the phone half-canvas.
 *  rx/ry are the SEAT RING percentages; the pods grow off those points via
 *  anchorOf(), so the near ring sits deep enough (40) for the bottom pod -
 *  cards, plate, action pill - to clear both the board and the rim. */
export const TABLE_CANVAS = {
  w: 1180,
  h: 660,
  rx: 45,
  ryNear: 40,
  ryFar: 33,
} as const;

/** Phone instance: exact 1/2 of the locked canvas (same aspect, same rx/ry). */
export const PHONE_CANVAS = {
  w: TABLE_CANVAS.w / 2,
  h: TABLE_CANVAS.h / 2,
  rx: TABLE_CANVAS.rx,
  ryNear: TABLE_CANVAS.ryNear,
  ryFar: TABLE_CANVAS.ryFar,
} as const;

/** User feedback #1: never scale below this or the avatars/cards/labels stop
 *  being readable. At 0.55 a desktop 'table' card still renders 53px; below
 *  the floor the stage scrolls instead. */
const K_FLOOR = 0.55;

function actionLabel(a: PlayerAction & { auto?: boolean }): string {
  if (a.type === 'fold') return a.auto ? t('Timed out') : t('Fold');
  if (a.type === 'check') return t('Check');
  if (a.type === 'call') return t('Call');
  if (a.type === 'bet') return t('Bet {n}', { n: fmt(a.amount ?? 0) });
  return t('Raise to {n}', { n: fmt(a.amount ?? 0) });
}

/** Measure the stage container so the canvas can be scaled to fit it. */
function useStageBox() {
  const ref = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      if (r) setBox({ w: r.width, h: r.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, box] as const;
}

/** User feedback #2: the two hole cards sit SIDE BY SIDE - parallel, no fan,
 *  no overlap; nothing of one card hides the other. */
function HoleCards({
  size,
  cards,
  faceDown,
}: {
  size: 'xs' | 'sm';
  cards?: CardId[];
  faceDown?: boolean;
}) {
  if (faceDown) {
    return (
      <div className="flex items-center gap-1">
        <PlayingCard faceDown size={size} />
        <PlayingCard faceDown size={size} />
      </div>
    );
  }
  if (!cards || cards.length === 0) return null;
  return (
    <div className="flex items-center gap-1">
      {cards.slice(0, 2).map((c, i) => (
        <PlayingCard key={`${i}-${c}`} card={c} size={size} deal />
      ))}
    </div>
  );
}

/** User feedback #1/#3: a seat pod is anchored by its angle on the ring so it
 *  can never be clipped by the canvas edge or the stage scroll box:
 *  - bottom-arc pods hang ABOVE their anchor point,
 *  - pods at the far left/right edge grow toward the table's interior,
 *  - everything else centers on the ring point as before. */
function anchorOf(s: number, c: number): { tx: string; ty: string } {
  const tx = c > 0.7 ? '-100%' : c < -0.7 ? '0%' : '-50%';
  const ty = s > 0.55 ? 'calc(-100% - 6px)' : '-50%';
  return { tx, ty };
}

export function RoundTable({
  seats,
  mySeat,
  myUserId,
  myCards,
  committedBySeat,
  urgent,
  handLive,
  canSit,
  onSit,
  canKick,
  onKick,
  bankerId,
  coBankerId,
  hostId,
  bb,
  readyCheck = null,
  onShareHand,
  narrow = false,
  handTypes,
  children,
}: {
  seats: SeatView[];
  mySeat: number | null;
  myUserId: number | null;
  myCards: CardId[];
  committedBySeat: Record<number, number>;
  urgent: boolean;
  handLive: boolean;
  canSit: boolean;
  onSit: (seat: number) => void;
  canKick: boolean;
  onKick: (userId: number) => void;
  bankerId: number;
  coBankerId: number | null;
  /** Whoever can deal right now - it moves if the host goes offline. */
  hostId?: number | null;
  bb: number;
  /** Pre-deal ready check: green tick on the seats that clicked I'm ready. */
  readyCheck?: { eligible: number[]; ready: number[] } | null;
  /** Opens the share card for the settled hand; rides the top winner's badge. */
  onShareHand?: () => void;
  /** Phone instance of the SAME locked canvas (exact 1/2, aspect unchanged). */
  narrow?: boolean;
  /** Hand type (牌型) to show at the bottom of each pod, keyed by seat. */
  handTypes?: Record<number, string>;
  children: React.ReactNode;
}) {
  // two-tap kick: first tap arms, second confirms, so a stray click never stands anyone up
  const [kickArmed, setKickArmed] = useState<number | null>(null);
  const reduce = useReducedMotion();
  // the win moment: chips arc from the pot into the winner's pod, so both
  // elements need to be reachable; only the top winner carries the share icon
  const winners = seats.filter((s) => s.won);
  const fxLit = useWinnerFx(winners.length > 0);
  const potRef = useRef<HTMLDivElement | null>(null);
  const podEls = useRef<Record<number, HTMLDivElement | null>>({});
  const shareSeat = onShareHand ? (winners[0]?.seat ?? null) : null;

  // A3 + feedback #1: fit the locked canvas into the box (both dimensions),
  // but never below the readability floor - past it, the stage scrolls.
  const [boxRef, box] = useStageBox();
  const canvas = narrow ? PHONE_CANVAS : TABLE_CANVAS;
  const measured = box.w > 0 && box.h > 0;
  const fit = measured ? Math.min(box.w / canvas.w, box.h / canvas.h) : K_FLOOR;
  const k = Math.min(Math.max(fit, K_FLOOR), narrow ? 0.9 : 1.3);

  // only occupied seats show, auto-spread evenly around the oval; when seated,
  // the order rotates so YOUR seat sits bottom-center
  const occupied = [...seats].sort((a, b) => a.seat - b.seat);
  let order = occupied;
  if (mySeat !== null) {
    const i = occupied.findIndex((x) => x.seat === mySeat);
    if (i > 0) order = [...occupied.slice(i), ...occupied.slice(0, i)];
  }
  const n = Math.max(order.length, 1);
  const angleOf = (idx: number) => (Math.PI / 180) * (90 + (idx / n) * 360);
  const RX = canvas.rx;
  // bottom seats sit a touch lower so your pod never crowds the board
  const ry = (a: number) => (Math.sin(a) > 0 ? canvas.ryNear : canvas.ryFar);
  // an unseated member sees where they can join: one + per cyclic gap that
  // still has a free seat number in it, placed between the neighbors
  const sitSpots: { seat: number; x: number; y: number }[] = [];
  if (canSit && !handLive) {
    if (order.length === 0) {
      sitSpots.push({ seat: 0, x: 50, y: 84 });
    } else {
      for (let i = 0; i < order.length; i++) {
        const from = order[i]!.seat;
        const to = order[(i + 1) % order.length]!.seat;
        let free: number | null = null;
        for (let c = (from + 1) % SEATS; c !== to; c = (c + 1) % SEATS) {
          if (!seats.some((x) => x.seat === c)) {
            free = c;
            break;
          }
        }
        if (free !== null) {
          const a = (Math.PI / 180) * (90 + ((i + 0.5) / n) * 360);
          sitSpots.push({ seat: free, x: 50 + RX * Math.cos(a), y: 50 + ry(a) * Math.sin(a) });
        }
      }
    }
  }

  return (
    // feedback #1: the stage scrolls rather than shrinking below the floor
    <div ref={boxRef} className="flex h-full min-h-0 w-full overflow-auto">
      {/* review fix #16: invisible until the first real measurement so a
        pre-fit frame can never flash; m-auto keeps it centered while still
        scrollable when it overflows */}
      <div
        className={cn('relative m-auto shrink-0', !measured && 'invisible')}
        style={{ width: canvas.w * k, height: canvas.h * k }}
      >
        {/* the locked-aspect canvas, scaled uniformly (never stretched) */}
        <div
          className="relative"
          style={{
            width: canvas.w,
            height: canvas.h,
            transform: `scale(${k})`,
            transformOrigin: 'top left',
          }}
        >
          {/* isometric table, bottom-up: ground shadow, the table's dark side,
              a bright rim band, the felt inset on top, and a racetrack line */}
          <div
            aria-hidden="true"
            className="absolute left-1/2 top-[calc(50%+36px)] h-[60%] w-[88%] -translate-x-1/2 -translate-y-1/2 rounded-[50%] bg-slate-600/30 blur-xl dark:bg-black/70"
          />
          <div
            aria-hidden="true"
            className="absolute left-1/2 top-[calc(50%+26px)] h-[60%] w-[87%] -translate-x-1/2 -translate-y-1/2 rounded-[50%] bg-slate-500/60 dark:bg-slate-700/80"
          />
          <div
            aria-hidden="true"
            className="absolute left-1/2 top-1/2 h-[60%] w-[87%] -translate-x-1/2 -translate-y-1/2 rounded-[50%] bg-slate-300/90 dark:bg-slate-400/50"
          />
          <div
            aria-hidden="true"
            className="absolute left-1/2 top-[calc(50%+1px)] h-[56%] w-[83%] -translate-x-1/2 -translate-y-1/2 rounded-[50%] bg-gradient-to-b from-slate-200/95 to-slate-300/90 shadow-[inset_0_4px_14px_rgba(15,23,42,0.18)] dark:from-slate-900 dark:to-slate-950 dark:shadow-[inset_0_4px_18px_rgba(0,0,0,0.55)]"
          />
          <div
            aria-hidden="true"
            className="absolute left-1/2 top-1/2 h-[45%] w-[68%] -translate-x-1/2 -translate-y-1/2 rounded-[50%] border border-slate-400/50 dark:border-slate-500/40"
          />

          {/* pot, board, and status live at the center (A5: the pot row is the
              first child, i.e. centered directly above the cards area) */}
          <div
            ref={potRef}
            className={cn(
              'absolute left-1/2 top-1/2 z-10 flex w-[66%] -translate-x-1/2 -translate-y-1/2 flex-col items-center',
              narrow ? 'gap-2.5' : 'gap-5',
            )}
          >
            {children}
          </div>

          {sitSpots.map((spot) => (
            <div
              key={`sit-${spot.seat}`}
              className="absolute z-10 -translate-x-1/2 -translate-y-1/2"
              style={{ left: `${spot.x}%`, top: `${spot.y}%` }}
            >
              <button
                onClick={() => onSit(spot.seat)}
                className="flex h-14 w-14 flex-col items-center justify-center rounded-full border-2 border-dashed border-indigo-400/50 text-xs font-semibold text-indigo-500 transition-colors hover:border-indigo-400 hover:bg-indigo-500/10 dark:text-indigo-300"
              >
                {t('Sit')}
              </button>
            </div>
          ))}

          {order.map((p, i) => {
            const seat = p.seat;
            const a = angleOf(i);
            const s = Math.sin(a);
            const c = Math.cos(a);
            const x = 50 + RX * c;
            const y = 50 + ry(a) * s;
            const { tx, ty } = anchorOf(s, c);
            const committed = committedBySeat[seat] ?? 0;
            // Bet piles ride their own tighter ellipse between the pot and the
            // seats. The straight-bottom seat gets a sideways nudge: there is
            // no vertical room left between the river card and a full pod, so
            // its stack sits just off the center line (user feedback v2 #1).
            const betNudge = s > 0.55 && Math.abs(c) < 0.35 ? (c >= 0 ? 13 : -13) : 0;
            const bet = { x: 50 + 27 * c + betNudge, y: 50 + 19 * s };
            const isMe = p.userId === myUserId;
            const bbCount = Math.round(p.stack / Math.max(1, bb));
            const strength = handTypes?.[seat] ?? null;
            const cardsVisible =
              p.inHand && (isMe ? myCards.length > 0 || !p.folded : !p.folded || !!p.revealed);

            const isBanker = p.userId === bankerId;
            const isHost = hostId != null && p.userId === hostId;
            const isCoBanker = coBankerId !== null && p.userId === coBankerId;
            return (
              <div key={seat}>
                {/* chips this player has pushed toward the pot this street: they
                    slide in from the seat on every bet, and sweep into the pot
                    when the street closes */}
                <AnimatePresence>
                  {committed > 0 && (
                    <motion.div
                      exit={
                        reduce ? { opacity: 0 } : { left: '50%', top: '44%', opacity: 0, scale: 0.5 }
                      }
                      transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
                      className="absolute z-10 flex -translate-x-1/2 -translate-y-1/2 items-center gap-1"
                      style={{ left: `${bet.x}%`, top: `${bet.y}%` }}
                    >
                      <motion.div
                        key={committed}
                        initial={
                          reduce
                            ? false
                            : {
                                x: (x - bet.x) * 3.2,
                                y: (y - bet.y) * 3.2,
                                opacity: 0.4,
                              }
                        }
                        animate={{ x: 0, y: 0, opacity: 1 }}
                        transition={{ type: 'spring', stiffness: 300, damping: 26 }}
                        className="flex items-center gap-1"
                      >
                        <ChipStack amount={committed} bb={bb} size={narrow ? 'lg' : 'sm'} />
                        <span
                          className={cn(
                            'rounded-full bg-indigo-600/90 px-1.5 py-0.5 font-display font-bold text-white shadow-sm',
                            narrow ? 'text-[0.85rem]' : 'text-[0.68rem]',
                          )}
                        >
                          {fmt(committed)}
                        </span>
                      </motion.div>
                    </motion.div>
                  )}
                </AnimatePresence>
                <div
                  ref={(el) => {
                    podEls.current[seat] = el;
                  }}
                  className="absolute z-20"
                  style={{ left: `${x}%`, top: `${y}%`, transform: `translate(${tx}, ${ty})` }}
                >
                  {/* User feedback v2 (#1-#3): top-down the pod reads
                    status pill → [cards beside avatar] → name/stack plate →
                    extras. Nothing floats over anything else: the cards are
                    parallel and off the avatar, the label is a solid plate,
                    and the D/SB/BB discs stay on the avatar. Anchoring keeps
                    the whole pod inside the canvas on every arc. */}
                  <div
                    className={cn(
                      'relative flex flex-col items-center gap-[3px] text-center transition-transform',
                      p.isToAct && 'scale-[1.04]',
                      p.isLeader && !p.isToAct && 'scale-[1.02]',
                      (p.folded || !p.connected) && 'opacity-55',
                      p.sittingOut && 'opacity-60 saturate-50',
                    )}
                  >
                    {p.isToAct && (
                      <span
                        className={cn(
                          'flex items-center gap-1 rounded-full px-2 py-0.5 whitespace-nowrap font-bold text-white shadow-md',
                          narrow ? 'text-[0.72rem]' : 'text-[0.6rem]',
                          urgent ? 'bg-rose-600' : 'bg-indigo-600',
                        )}
                      >
                        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-white motion-reduce:animate-none" />
                        {t('playing')}
                      </span>
                    )}
                    {p.won && !p.isToAct && (
                      <span className="flex items-center">
                        <WinBadge
                          amount={p.wonAmount ?? 0}
                          onShare={p.seat === shareSeat ? onShareHand : undefined}
                        />
                      </span>
                    )}
                    {readyCheck && !p.won && readyCheck.eligible.includes(p.userId) && (
                      <span
                        className={cn(
                          'flex items-center rounded-full px-2 py-0.5 whitespace-nowrap font-bold text-white shadow-md',
                          narrow ? 'text-[0.72rem]' : 'text-[0.6rem]',
                          readyCheck.ready.includes(p.userId)
                            ? 'bg-emerald-500'
                            : 'animate-pulse bg-slate-500 motion-reduce:animate-none',
                        )}
                      >
                        {readyCheck.ready.includes(p.userId) ? t('✓ ready') : t('ready?')}
                      </span>
                    )}
                    {/* cards + avatar on ONE row; the side closer to the pot
                        flips so cards always face the felt's center */}
                    <div
                      className={cn(
                        'flex items-end gap-1.5',
                        c < -0.2 && 'flex-row-reverse',
                      )}
                    >
                      {cardsVisible && (
                        <HoleCards
                          size={isMe && !narrow ? 'sm' : 'xs'}
                          cards={isMe ? myCards : p.revealed}
                          faceDown={!isMe && !p.revealed}
                        />
                      )}
                      {/* the turn cue wraps the avatar; position discs ride on
                          it (never on the cards - feedback #3) */}
                      <div
                        className={cn(
                          'relative rounded-full transition-shadow',
                          p.isToAct && (urgent ? 'turn-glow-rose' : 'turn-glow'),
                          p.won && 'animate-winner',
                          p.isLeader && !p.isToAct && !p.won && 'ring-2 ring-amber-400/80',
                        )}
                      >
                        <Link to={`/players/${p.userId}`} aria-label={t("{name}'s profile", { name: p.displayName })}>
                          <Avatar
                            userId={p.userId}
                            name={p.displayName}
                            version={p.avatarVersion}
                            size={isMe ? 'md' : narrow ? 'md' : 'sm'}
                            speaking={p.speaking}
                          />
                        </Link>
                        {/* corner markers announce themselves (review fix #15) */}
                        {p.isLeader && (
                          <span
                            role="img"
                            aria-label={t('Chip leader')}
                            title={t('Chip leader')}
                            className="absolute -right-1.5 -top-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-amber-400 text-white"
                          >
                            <Crown size={9} weight="fill" />
                          </span>
                        )}
                        {isHost && (
                          <span
                            role="img"
                            aria-label={t('Host - deals the hands')}
                            title={t('Host - deals the hands')}
                            className="absolute -top-1 -left-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-amber-500 text-white"
                          >
                            <Play size={8} weight="fill" />
                          </span>
                        )}
                        {(isBanker || isCoBanker) && (
                          <span
                            role="img"
                            aria-label={isBanker ? t('Banker') : t('Backup banker')}
                            title={isBanker ? t('Banker') : t('Backup banker')}
                            className={cn(
                              'absolute -bottom-1 -left-1.5 flex h-4 w-4 items-center justify-center rounded-full text-white',
                              isBanker ? 'bg-indigo-600' : 'bg-slate-500',
                            )}
                          >
                            <Coins size={9} weight="fill" />
                          </span>
                        )}
                        {p.voiceMuted && (
                          <span
                            role="img"
                            aria-label={t('muted')}
                            title={t('muted')}
                            className="absolute -left-1.5 -top-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-slate-700 text-white"
                          >
                            <MicrophoneSlash size={9} weight="fill" />
                          </span>
                        )}
                        {/* position, unmissable: D / SB / BB discs on the avatar
                            (requested by notpritam, docs/FEATURES.md) */}
                        {p.isButton && (
                          <span
                            role="img"
                            aria-label={t('Dealer button')}
                            title={t('Dealer button')}
                            className={cn(
                              'absolute -bottom-1.5 -right-2 flex items-center justify-center rounded-full bg-white font-black text-slate-900 shadow-md ring-2 ring-slate-900/20 dark:ring-white/30',
                              narrow ? 'h-6 min-w-6 px-0.5 text-[0.72rem]' : 'h-5 w-5 text-[0.6rem]',
                            )}
                          >
                            D
                          </span>
                        )}
                        {p.isSB && !p.isButton && (
                          <span
                            role="img"
                            aria-label={t('Small blind')}
                            title={t('Small blind')}
                            className={cn(
                              'absolute -bottom-1.5 -right-2 flex items-center justify-center rounded-full bg-sky-500 px-0.5 font-black text-white shadow-md ring-2 ring-sky-300/40',
                              narrow ? 'h-6 min-w-6 text-[0.65rem]' : 'h-5 min-w-5 text-[0.55rem]',
                            )}
                          >
                            SB
                          </span>
                        )}
                        {p.isBB && (
                          <span
                            role="img"
                            aria-label={t('Big blind')}
                            title={t('Big blind')}
                            className={cn(
                              'absolute -bottom-1.5 -right-2 flex items-center justify-center rounded-full bg-amber-500 px-0.5 font-black text-amber-950 shadow-md ring-2 ring-amber-300/40',
                              narrow ? 'h-6 min-w-6 text-[0.65rem]' : 'h-5 min-w-5 text-[0.55rem]',
                            )}
                          >
                            BB
                          </span>
                        )}
                        {p.isSB && p.isButton && (
                          <span
                            role="img"
                            aria-label={t('Small blind (button)')}
                            title={t('Small blind (button)')}
                            className={cn(
                              'absolute -bottom-1.5 -left-2 flex items-center justify-center rounded-full bg-sky-500 px-0.5 font-black text-sky-950 shadow-md ring-2 ring-sky-300/40',
                              narrow ? 'h-6 min-w-6 text-[0.65rem]' : 'h-5 min-w-5 text-[0.55rem]',
                            )}
                          >
                            SB
                          </span>
                        )}
                      </div>
                    </div>
                    {/* feedback v2 #3: name + stack (+ 牌型 / state) live on a
                        compact solid plate - a designed label, not text drawn
                        over the felt, and never colliding with the cards */}
                    <div className="flex w-max max-w-[9rem] flex-col items-center rounded-xl bg-white/92 px-2 py-1 shadow-sm ring-1 ring-black/5 backdrop-blur-sm dark:bg-slate-900/90 dark:ring-white/10">
                      <div
                        className={cn(
                          'w-full truncate font-semibold leading-tight text-slate-900 dark:text-white',
                          narrow ? 'text-[0.85rem]' : 'text-xs',
                        )}
                        title={p.displayName}
                      >
                        {p.displayName}
                      </div>
                      <div
                        className={cn(
                          'font-display leading-tight text-slate-600 dark:text-slate-300',
                          narrow ? 'text-[0.8rem]' : 'text-[0.7rem]',
                          p.broke && 'font-bold text-rose-500 dark:text-rose-400',
                        )}
                      >
                        <StackValue stack={p.stack} won={p.won} />
                        <span className="opacity-60"> · {bbCount} BB</span>
                      </div>
                      {strength && (
                        <div
                          className={cn(
                            'font-semibold leading-tight text-indigo-600 dark:text-indigo-300',
                            narrow ? 'text-[0.8rem]' : 'text-[0.66rem]',
                          )}
                        >
                          {strength}
                        </div>
                      )}
                      {(p.broke || !p.connected || p.sittingOut) && (
                        <div
                          className={cn(
                            'font-semibold leading-tight',
                            narrow ? 'text-[0.8rem]' : 'text-[0.62rem]',
                            p.broke
                              ? 'text-rose-500 dark:text-rose-400'
                              : !p.connected
                                ? 'text-amber-600 dark:text-amber-400'
                                : 'text-slate-500 dark:text-slate-400',
                          )}
                        >
                          {p.broke ? t('Out of chips') : !p.connected ? t('Offline') : t('Sitting out')}
                        </div>
                      )}
                    </div>
                    {/* P2 B2: this seat's thinking-time bank, on the pod that
                        holds it - glanceable while they chew on the hand */}
                    {handLive && p.inHand && !p.folded && p.bankMs !== undefined && p.bankMs > 0 && (
                      <div
                        title={t('time bank remaining')}
                        className={cn(
                          'flex items-center gap-1 rounded-full bg-amber-400/90 px-1.5 font-display font-bold text-amber-950 shadow-sm',
                          narrow ? 'text-[0.75rem]' : 'text-[0.6rem]',
                        )}
                      >
                        <Timer size={narrow ? 10 : 8} weight="fill" aria-hidden="true" />
                        {Math.ceil(p.bankMs / 1000)}s
                      </div>
                    )}
                    {p.pendingBuy > 0 && (
                      <div
                        title={t('Buy waiting for banker approval')}
                        className={cn(
                          'rounded-full bg-amber-400/25 px-1.5 py-px font-display font-bold text-amber-600 dark:text-amber-300',
                          narrow ? 'text-[0.85rem]' : 'text-[0.62rem]',
                        )}
                      >
                        {t('+{n} soon', { n: fmt(p.pendingBuy) })}
                      </div>
                    )}
                    {!p.broke && p.connected && !p.sittingOut && (p.lastAction || p.allIn) &&
                      (() => {
                        const a = p.lastAction;
                        const aggressive = a && (a.type === 'raise' || a.type === 'bet');
                        const folded = a?.type === 'fold';
                        return (
                          <motion.div
                            key={a ? `${a.type}-${a.amount ?? 0}` : 'all-in'}
                            initial={reduce ? false : { scale: 1.45, y: -3 }}
                            animate={{ scale: 1, y: 0 }}
                            transition={{ type: 'spring', stiffness: 380, damping: 17 }}
                            className={cn(
                              'rounded-full px-2 py-0.5 whitespace-nowrap font-bold',
                              narrow ? 'text-[0.8rem]' : 'text-[0.62rem]',
                              !a || aggressive
                                ? 'bg-amber-400 text-amber-950 shadow-[0_0_14px_rgba(251,191,36,0.55)]'
                                : folded
                                  ? 'bg-rose-500/15 text-rose-600 dark:text-rose-300'
                                  : 'bg-white/80 text-slate-600 shadow-sm dark:bg-slate-800/80 dark:text-slate-200',
                            )}
                          >
                            {a ? actionLabel(a) : t('All-in')}
                          </motion.div>
                        );
                      })()}
                  </div>
                  {canKick && !isMe && (
                    <button
                      onClick={() => {
                        if (kickArmed === p.userId) {
                          setKickArmed(null);
                          onKick(p.userId);
                        } else {
                          setKickArmed(p.userId);
                          setTimeout(() => setKickArmed((v) => (v === p.userId ? null : v)), 3500);
                        }
                      }}
                      title={
                        kickArmed === p.userId
                          ? t('Tap again to stand them up')
                          : t('Stand this player up')
                      }
                      className={cn(
                        'absolute -right-2 -top-2 z-30 flex items-center justify-center rounded-full text-white shadow-sm transition-all',
                        kickArmed === p.userId
                          ? 'h-auto w-auto bg-rose-600 px-2 py-0.5 text-[0.62rem] font-bold'
                          : 'h-5 w-5 bg-slate-400 hover:bg-rose-500 dark:bg-slate-600',
                      )}
                    >
                      {kickArmed === p.userId ? t('stand up?') : <X size={11} weight="bold" />}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* the payoff: chips sweep from the pot to each winner's pod, and the
          stack number only bumps once they land (see StackValue). Measured in
          viewport space, so the canvas scale is transparent to it. */}
      {fxLit &&
        winners.map((w) => (
          <ChipFlight
            key={`fly-${w.seat}`}
            run={fxLit}
            discs={winners.length === 1 ? 6 : 4}
            getFrom={() => potRef.current}
            getTo={() => podEls.current[w.seat] ?? null}
          />
        ))}
    </div>
  );
}
