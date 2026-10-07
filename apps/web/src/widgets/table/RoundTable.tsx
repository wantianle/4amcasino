import { useCallback, useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import type { RoomHud } from '../../features/stats/types.ts';
import { PlayerHud } from './PlayerHud.tsx';
import { isValidHudPlayer, SeatBadges } from './SeatBadges.tsx';
import { Crown, Coins, Eye, MicrophoneSlash, Play, Robot, Timer, X } from '@phosphor-icons/react';
import type { CardId, PlayerAction } from '@4am/shared';
import { cn, fmt } from '../../shared/lib/cn.ts';
import { fmtBB } from '../../shared/lib/bb.ts';
import { t } from '../../shared/i18n/index.ts';
import { botStatusLabel, botStatusTone } from '../../features/bots/botStatus.ts';
import { Avatar } from '../../entities/user/Avatar.tsx';
import { PlayingCard } from '../../entities/card/PlayingCard.tsx';
import type { SeatView } from '../../entities/table/tableTypes.ts';
import { ChipStack } from './ChipStack.tsx';
import {
  BetFlight,
  COLLECT_REVEAL_LEAD_MS,
  SettlementFlight,
  StackValue,
  WinBadge,
  useWinnerBadge,
  useWinnerFx,
} from './WinnerFx.tsx';
import { TurnProgress } from './TurnProgress.tsx';
import { seatHandMode, TableSeat } from './TableSeat.tsx';
import { SeatEquityBubble } from './SeatEquityBubble.tsx';
import { DealCard, DEAL_STAGGER_MS, SEAT_DEAL_STAGGER_MS } from './DealCard.tsx';
import { dealMotionEpoch } from '../../shared/gameClient.ts';
import { useStore } from '../../shared/store.ts';
import {
  anchorOf,
  angleOf,
  betPoint,
  BET_RING,
  BET_RING_PHONE,
  CENTER_COLUMN,
  centerColumnBudgetPx,
  FELT,
  PHONE_FELT,
  K_CAP_DESKTOP,
  K_CAP_PHONE,
  K_FLOOR,
  PHONE_CANVAS,
  POT_SWEEP_TARGET,
  ribbonFitsRail,
  SEAT_ANCHOR,
  SEAT_ANCHOR_PHONE,
  SEAT_COUNT,
  seatPoint,
  SIT_SPOT_EMPTY,
  TABLE_CANVAS,
} from './geometry.ts';

/** A real round table: nine seat pods around an oval, your seat pinned at the
 *  bottom, everyone repositioning live as they sit, act, and fold. The banker
 *  can stand a player up (docs/FEATURES.md).
 *
 *  All positioning comes from ./geometry.ts: the locked desktop and phone
 *  canvases, the felt and bet ellipses, the seat ring, the pot sweep target
 *  and the center column's size budget (H2 - a measured backstop, not a
 *  guarantee). Chip semantics: the only chip pile is this street's bet on the
 *  bet ellipse; the seat stack is a number on the name plate (points ⇄ BB
 *  toggle) and the center pot is TablePage's pot pill. */

function actionLabel(
  a: PlayerAction & { auto?: boolean },
  unit: 'chips' | 'bb',
  bb: number,
): string {
  if (a.type === 'fold') return a.auto ? t('Timed out') : t('Fold');
  if (a.type === 'check') return t('Check');
  if (a.type === 'call') return t('Call');
  const amount = a.amount ?? 0;
  const shown = unit === 'chips' ? fmt(amount) : `${fmtBB(amount, bb)} BB`;
  if (a.type === 'bet') return t('Bet {n}', { n: shown });
  return t('Raise to {n}', { n: shown });
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

/** L2 seat hole cards: face-up pairs (hero, showdown reveals) sit strictly
 *  side by side — nothing of one card hides the other (feedback #2 kept);
 *  face-down pairs ride the avatar as the small-angle GG fan. `podFace` is
 *  the explicit rev-3 seat face (big corner index + center pip, no rotated
 *  bottom index) — applied at every size the pod uses (desktop pod, phone
 *  sm, dense-phone xs), never inferred from the size name. */
function HoleCards({
  size,
  cards,
  faceDown,
  narrow = false,
  delay = 0,
  handId = null,
  motionPrefix = 'hole:opponent',
  reveal = false,
  gold,
}: {
  size: 'xs' | 'sm' | 'pod' | 'md';
  cards?: CardId[];
  faceDown?: boolean;
  narrow?: boolean;
  delay?: number;
  handId?: string | null;
  motionPrefix?: string;
  reveal?: boolean;
  /** Cards composing this seat's made hand (see goldBySeat) — gold-framed. */
  gold?: Set<CardId>;
}) {
  // L2 (rev-3 mockup): opponents' face-down cards ride the avatar's top edge
  // as a small-angle GG fan — two burgundy backs tilted ±6° with a slight
  // overlap. Face-up cards (hero, showdown reveals) stay strictly side by
  // side: never obscure a card the player can act on (feedback v2 #2 kept).
  if (faceDown) {
    return (
      <div className="table-pod-fan">
        <DealCard
          delay={delay}
          handId={handId}
          motionKey={`${motionPrefix}:0`}
          epoch={dealMotionEpoch(handId, `${motionPrefix}:0`)}
        >
          <PlayingCard
            faceDown
            size={size}
            className="table-pod-fan-back table-pod-fan-back--first"
          />
        </DealCard>
        <DealCard
          delay={delay + DEAL_STAGGER_MS}
          handId={handId}
          motionKey={`${motionPrefix}:1`}
          epoch={dealMotionEpoch(handId, `${motionPrefix}:1`)}
        >
          <PlayingCard
            faceDown
            size={size}
            className="table-pod-fan-back table-pod-fan-back--last"
          />
        </DealCard>
      </div>
    );
  }
  if (!cards || cards.length === 0) return null;
  return (
    <div className={cn('flex items-center', narrow ? 'gap-0.5' : 'gap-[5px]')}>
      {cards.slice(0, 2).map((c, i) => (
        <DealCard
          key={`${i}-${c}`}
          reveal={reveal}
          delay={delay + i * DEAL_STAGGER_MS}
          handId={handId}
          epoch={dealMotionEpoch(handId, `${motionPrefix}:${i}`)}
          motionKey={`${motionPrefix}:${i}`}
        >
          <PlayingCard
            card={c}
            size={size}
            podFace
            className={gold?.has(c) ? 'table-card-gold' : undefined}
          />
        </DealCard>
      ))}
    </div>
  );
}

/** The table's money display UNIT (points ⇄ big blinds) is the ONE persisted
 *  preference `prefs.stackUnit` (shared store) — tapping any seat's number
 *  toggles it for every seat AND every money label on this client (the felt
 *  bets, the action bar, the betting panel). There is deliberately no second
 *  local copy: a single source is what keeps every display in agreement. */

/** The seats the settled pot flies to.
 *
 *  `collectSeats` is the page's per-payout data (every board / side-pot winner
 *  with amount > 0). A seat in it can still have LOST the hand overall — a
 *  run-it-twice split pays a seat that drops the other run — so once `hand_end`
 *  supplies the nets we keep only the true net winners (user report:
 *  跑马一输一赢、筹码两边飞).
 *
 *  The two sets are NOT guaranteed to overlap, though. A hand won by fold
 *  broadcasts no showdown at all (server `computeShowdown` returns
 *  `showdown: null` when `winnerByFold !== null`), so the page's `collectSeats`
 *  is empty while the sole winner is still net positive. The old raw
 *  intersection then produced `[]` and the table went completely silent — no
 *  chips, no win-lit state. So when the net winners are known and the payout
 *  frame is empty (or disagrees), fall back to the net winners: fly to the
 *  actual winners rather than show nothing.
 *
 *  An empty `netWinners` (a true tie, or the early showdown window before
 *  `hand_end` lands) keeps the per-payout split so the pot can still fly. */
export function collectorSeats(netWinners: number[], collectSeats?: number[]): number[] {
  if (netWinners.length === 0) return collectSeats ?? [];
  if (!collectSeats || collectSeats.length === 0) return netWinners;
  const paid = netWinners.filter((seat) => collectSeats.includes(seat));
  return paid.length > 0 ? paid : netWinners;
}

/** Build the ONE collection snapshot: exactly the seats whose street commitment
 *  is positive right now, paired with their pile rects. Both the settlement
 *  timeline's source count and the flight's origins come from this record, so
 *  they can never disagree - a street that shrank from many piles to two leaves
 *  no stale rects behind. A missing rect drops the seat from BOTH, so the
 *  timeline never waits on a source the flight cannot use. */
export function collectionSnapshot(
  committedBySeat: Record<number, number>,
  rectOf: (seat: number) => DOMRect | null,
): Record<number, DOMRect> {
  const snapshot: Record<number, DOMRect> = {};
  for (const [seatStr, amount] of Object.entries(committedBySeat)) {
    if (amount <= 0) continue;
    const seat = Number(seatStr);
    const rect = rectOf(seat);
    if (rect) snapshot[seat] = rect;
  }
  return snapshot;
}

export function RoundTable({
  seats,
  mySeat,
  myUserId,
  myCards,
  committedBySeat,
  handId,
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
  sb,
  readyCheck = null,
  onShareHand,
  narrow = false,
  centerCompact = false,
  centerRaised = false,
  centerPreflop = false,
  centerBudget = false,
  ribbon,
  handTypes,
  goldBySeat,
  collectSeats,
  equityBySeat,
  hudRoomId,
  children,
  centralPotRef,
}: {
  seats: SeatView[];
  mySeat: number | null;
  myUserId: number | null;
  myCards: CardId[];
  committedBySeat: Record<number, number>;
  /** L5: current hand id - the bet-flight baseline resets with every hand. */
  handId: string | null;
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
  /** The room's real small blind - chip denominations are SB-based, so this
   *  keeps the piles honest on non-standard structures (TablePage can pass
   *  room.room.sb). Omitted: the standard sb = bb/2 is derived instead. */
  sb?: number;
  /** Pre-deal ready check: green tick on the seats that clicked I'm ready. */
  readyCheck?: { eligible: number[]; ready: number[] } | null;
  /** Opens the share card for the settled hand; rides the top winner's badge. */
  onShareHand?: () => void;
  /** Phone uses its own vertical oval + phone anchors. */
  narrow?: boolean;
  /** Compact center tier (audit H2): TablePage collapses the pot/board stack
   *  (smaller cards, tighter gaps) when multi-run boards or a banner/summary
   *  stack would otherwise push the column into the bottom-seat pods. */
  centerCompact?: boolean;
  /** Raise the center column to CENTER_COLUMN.compactYPct. Driven ONLY by
   *  effective multi-run boards (server-declared runs > 1, or a non-empty
   *  extra run already dealt - the caller owns the predicate) - a
   *  single-run stack, even with banners
   *  piled on, keeps the canvas-centered yPct so its rendering stays
   *  baseline-identical. */
  centerRaised?: boolean;
  /** Empty preflop has no card row to provide vertical lift; keep its pot
   * above the table midpoint without rendering invisible placeholder cards. */
  centerPreflop?: boolean;
  /** Clamp the center column to the geometry budget: measured content taller
   *  than centerColumnBudgetPx() scales down (never below minScale). Off for
   *  consumers that size their own children to fit (replays). */
  centerBudget?: boolean;
  /** L3: feature banners (bomb/squid + ante note). Rendered INSIDE the locked
   *  canvas so it scales with the table. When the top rail band is free —
   *  1/3/5 seated players per geometry.ts ribbonFitsRail() — it rides the rail
   *  as an absolute strip; for every other seat count a pod sits at or near
   *  top-center, so it flows at the head of the center column instead (the
   *  only canvas position that can never cover the top seat). */
  ribbon?: React.ReactNode;
  /** Hand type (牌型) to show at the bottom of each pod, keyed by seat. */
  handTypes?: Record<number, string>;
  /** The cards composing each seat's made hand (two pair+, final board),
   *  keyed by seat. Only hero and revealed seats ever appear here — the gold
   *  frame rides exactly these cards. */
  goldBySeat?: Record<number, Set<CardId>>;
  /** Public pot awards can begin their flight before hand_end supplies game nets. */
  collectSeats?: number[];
  /** Live all-in equity per seat in basis points (10000 = 100%), while an
   *  all-in runout is dealing. Absent for replays and normal hands. */
  equityBySeat?: Record<number, number>;
  hudRoomId?: string;
  children: React.ReactNode;
  /** The actual visible central pot pill, not the whole center column. */
  centralPotRef?: { current: HTMLElement | null };
}) {
  // two-tap kick: first tap arms, second confirms, so a stray click never stands anyone up
  const [kickArmed, setKickArmed] = useState<number | null>(null);
  const [hudUserId, setHudUserId] = useState<number | null>(null);
  const [hud, setHud] = useState<RoomHud | null>(null);
  const hudOpener = useRef<HTMLElement | null>(null);
  // Closing must drop the cached HUD snapshot too: SeatBadges reads `hud`, so
  // leaving it would keep painting this seat's previous-hand badge data.
  const closeHud = useCallback(() => {
    setHudUserId(null);
    setHud(null);
  }, []);
  const openHud = useCallback(
    (userId: number, opener: HTMLElement) => {
      hudOpener.current = opener;
      setHud(null);
      setHudUserId(userId);
    },
    [hudRoomId],
  );
  // L2: one tap on ANY seat's stack flips pts ⇄ BB for every money label
  // (this device); the preference lives in the shared store so the action bar
  // and this table can never disagree.
  const stackUnit = useStore((s) => s.prefs.stackUnit);
  const setPrefs = useStore((s) => s.setPrefs);
  const toggleStackUnit = () => setPrefs({ stackUnit: stackUnit === 'chips' ? 'bb' : 'chips' });
  const reduce = useReducedMotion();
  // the win moment: chips arc from the pot into the winner's pod, so both
  // elements need to be reachable; only the top winner carries the share icon
  const winners = seats.filter((s) => s.won);
  // The highest live equity is the "advantaged" side (its bubble reads green).
  const maxEquity = equityBySeat ? Math.max(0, ...Object.values(equityBySeat)) : 0;
  // The pot flies ONCE, to the seat that actually won the hand. See
  // collectorSeats for why the per-payout set is intersected and what happens
  // when the two disagree.
  const netWinners = winners.map((s) => s.seat);
  const collectors = collectorSeats(netWinners, collectSeats);
  const winnerResultLit = collectors.length > 0;
  // TODO(settlement-bubble): once the equity bubble has an explicit exit
  // state, drive this delay from that exit / final board event instead of the
  // current result-state transition.
  // when the moment carries a showdown reveal, the chips wait for the flips
  // (one lead value feeds BOTH the flight and the stack-number gate, so the
  // bump always meets the discs). Keyed on collectSeats, i.e. "a showdown
  // reveal actually happened", NOT on collectors: a fold win has no reveal to
  // wait for, and after collectorSeats' fallback a non-empty collectSeats
  // always yields a non-empty collectors on a won hand, so they agree exactly
  // when it matters and disagree (lead 0) precisely on the no-showdown win.
  const collectLead = collectSeats && collectSeats.length > 0 ? COLLECT_REVEAL_LEAD_MS : 0;
  // How many street piles collect in, from the same snapshot the flight flies
  // from (see collectionSources). The settlement timeline needs it so the
  // payout starts only after the last pile has finished collecting, instead of
  // a fixed gap that a big board would outrun.
  const [collectSourceCount, setCollectSourceCount] = useState(0);
  const fxLit = useWinnerFx(
    collectors.length > 0,
    handId,
    collectLead,
    collectSourceCount,
    collectors.length,
  );
  const badgeLit = useWinnerBadge(
    collectors.length > 0,
    handId,
    collectLead,
    collectSourceCount,
    collectors.length,
  );
  const potRef = useRef<HTMLDivElement | null>(null);
  const podEls = useRef<Record<number, HTMLDivElement | null>>({});
  const betEls = useRef<Record<number, HTMLDivElement | null>>({});
  // ONE collection snapshot: the rects the flight starts from AND the count
  // that drives the settlement timeline are measured together, from the same
  // pile set, on every live street. Keeping a single source means a street that
  // drops from many piles to two cannot leave stale rects behind, so the payout
  // starts exactly when the last rendered pile has finished collecting.
  const collectionSources = useRef<Record<number, DOMRect>>({});
  // L5 (spec row 3): when a seat's street bet GROWS, burst chips from its pod
  // to its bet spot. Seeding waits for the first NON-EMPTY snapshot: the real
  // message order is hand_start (no betting yet) -> first betting_state
  // (blinds ALREADY posted), so seeding on the empty map would misread the
  // blinds as growth and fire a volley - on every hand AND every rejoin.
  // Baseline + flights reset whenever handId changes (incl. -> null between
  // hands, which also clears stale flight entries).
  const prevCommitted = useRef<Record<number, number>>({});
  const committedSeeded = useRef(false);
  const lastFlightHand = useRef<string | null>(null);
  const [betFlights, setBetFlights] = useState<Record<number, number>>({});
  useEffect(() => {
    if (handId !== lastFlightHand.current) {
      lastFlightHand.current = handId;
      committedSeeded.current = false;
      prevCommitted.current = {};
      setBetFlights({});
      collectionSources.current = {};
      setCollectSourceCount(0);
    }
    if (handLive) {
      // Measure the count and the rects from the SAME pile set, in one pass.
      const snapshot = collectionSnapshot(committedBySeat, (seat) =>
        betEls.current[seat]?.getBoundingClientRect() ?? null,
      );
      collectionSources.current = snapshot;
      setCollectSourceCount(Object.keys(snapshot).length);
    }
    if (!handLive || handId === null) return; // replay (no hand) never flies
    if (!committedSeeded.current) {
      if (Object.keys(committedBySeat).length === 0) return; // wait for the first betting_state
      committedSeeded.current = true;
      prevCommitted.current = { ...committedBySeat };
      return;
    }
    const runs: Record<number, number> = {};
    for (const [seatStr, amount] of Object.entries(committedBySeat)) {
      const seat = Number(seatStr);
      if (amount > (prevCommitted.current[seat] ?? 0)) runs[seat] = Date.now() + seat;
      prevCommitted.current[seat] = amount;
    }
    if (Object.keys(runs).length > 0) setBetFlights((f) => ({ ...f, ...runs }));
  }, [committedBySeat, handLive, handId]);
  const shareSeat = onShareHand ? (winners[0]?.seat ?? null) : null;

  // A3 + feedback #1: fit the locked canvas into the box (both dimensions),
  // but never below the readability floor - past it, the stage scrolls.
  const [boxRef, box] = useStageBox();
  const canvas = narrow ? PHONE_CANVAS : TABLE_CANVAS;
  const measured = box.w > 0 && box.h > 0;
  const fit = measured ? Math.min(box.w / canvas.w, box.h / canvas.h) : K_FLOOR;
  const k = Math.min(Math.max(fit, K_FLOOR), narrow ? K_CAP_PHONE : K_CAP_DESKTOP);

  // H2 size budget: the center column's layout height (contentRect is
  // pre-transform, so the canvas scale never skews it). When the page opts
  // into centerBudget, content taller than the geometry budget scales down
  // uniformly - a backstop that keeps most overruns off the bottom-seat
  // pods, but it floors at minScale, so an extreme pile can still touch one.
  const [colH, setColH] = useState(0);
  useEffect(() => {
    const el = potRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      if (r) setColH(r.height);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // only occupied seats show, auto-spread evenly around the oval; when seated,
  // the order rotates so YOUR seat sits bottom-center
  const occupied = [...seats].sort((a, b) => a.seat - b.seat);
  let order = occupied;
  if (mySeat !== null) {
    const i = occupied.findIndex((x) => x.seat === mySeat);
    if (i > 0) order = [...occupied.slice(i), ...occupied.slice(0, i)];
  }
  const n = Math.max(order.length, 1);
  // L2 phone readability: on the half-size canvas a 7+ seat ring cannot fit
  // the enlarged desktop pods — dense phone seats ride their hole cards back
  // down to xs (the fan/pair geometry follows via .table-canvas--dense vars).
  const dense = narrow && n >= 7;
  const holeSize: 'xs' | 'sm' | 'pod' = narrow ? (dense ? 'xs' : 'sm') : 'pod';
  // Face-up hero cards overhang the plaque toward the board. Keep the
  // historical default budget unless the actual hero has visible cards; the
  // phone uses its own CSS overhang (including the dense xs tier).
  const heroCardsVisible =
    mySeat !== null && myCards.length > 0 && seats.some((p) => p.seat === mySeat && p.inHand);
  const heroHoloOverhangPx = heroCardsVisible ? (narrow ? (dense ? 4 : 13) : 38) : 0;
  const budgetPx = centerColumnBudgetPx(
    canvas,
    narrow ? SEAT_ANCHOR_PHONE : SEAT_ANCHOR,
    heroHoloOverhangPx,
  );
  // L6: the clamp guards BOTH canvases — the phone's board tiers
  // (sm single-run, sm multi-run) need the same budget backstop desktop has.
  const colScale =
    centerBudget && colH > budgetPx ? Math.max(CENTER_COLUMN.minScale, budgetPx / colH) : 1;
  // L3 rail-band check — shared with TablePage's column budget via
  // geometry.ts, so placement and budget can never disagree.
  const ribbonOnRail = !!ribbon && ribbonFitsRail(n);
  // an unseated member sees where they can join: one + per cyclic gap that
  // still has a free seat number in it, placed between the neighbors
  const sitSpots: { seat: number; x: number; y: number }[] = [];
  if (canSit && !handLive) {
    if (order.length === 0) {
      sitSpots.push({ seat: 0, x: SIT_SPOT_EMPTY.xPct, y: SIT_SPOT_EMPTY.yPct });
    } else {
      for (let i = 0; i < order.length; i++) {
        const from = order[i]!.seat;
        const to = order[(i + 1) % order.length]!.seat;
        let free: number | null = null;
        for (let c = (from + 1) % SEAT_COUNT; c !== to; c = (c + 1) % SEAT_COUNT) {
          if (!seats.some((x) => x.seat === c)) {
            free = c;
            break;
          }
        }
        if (free !== null) {
          const spot = seatPoint(angleOf(i + 0.5, n), canvas);
          sitSpots.push({ seat: free, x: spot.x, y: spot.y });
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
          className={cn(
            'table-canvas relative',
            narrow && 'table-canvas--narrow',
            dense && 'table-canvas--dense',
          )}
          style={{
            width: canvas.w,
            height: canvas.h,
            transform: `scale(${k})`,
            transformOrigin: 'top left',
          }}
        >
          {/* The GG-modeled table, bottom-up: ground shadow, the table's dark
              underside, the charcoal rail top with its single gold hairline,
              and the deep-green felt (vignette + noise) — layer
              sizes/offsets from FELT in ./geometry.ts (TS is the coordinate
              authority); paint + colors from table-surface.css (L0 tokens).
              The old racetrack stitch line was dropped in rev 3. */}
          <div
            aria-hidden="true"
            className="table-ground absolute left-1/2 -translate-x-1/2 -translate-y-1/2"
            style={{
              top: `calc(50% + ${(narrow ? PHONE_FELT : FELT).shadow.dropPx}px)`,
              width: `${(narrow ? PHONE_FELT : FELT).shadow.wPct}%`,
              height: `${(narrow ? PHONE_FELT : FELT).shadow.hPct}%`,
            }}
          />
          <div
            aria-hidden="true"
            className="table-rail-side absolute left-1/2 -translate-x-1/2 -translate-y-1/2"
            style={{
              top: `calc(50% + ${(narrow ? PHONE_FELT : FELT).side.dropPx}px)`,
              width: `${(narrow ? PHONE_FELT : FELT).side.wPct}%`,
              height: `${(narrow ? PHONE_FELT : FELT).side.hPct}%`,
            }}
          />
          <div
            aria-hidden="true"
            className="table-rail-top absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2"
            style={{
              width: `${(narrow ? PHONE_FELT : FELT).rim.wPct}%`,
              height: `${(narrow ? PHONE_FELT : FELT).rim.hPct}%`,
            }}
          />
          <div
            aria-hidden="true"
            className="table-felt absolute left-1/2 -translate-x-1/2 -translate-y-1/2"
            style={{
              top: `calc(50% + ${(narrow ? PHONE_FELT : FELT).inset.dropPx}px)`,
              width: `${(narrow ? PHONE_FELT : FELT).inset.wPct}%`,
              height: `${(narrow ? PHONE_FELT : FELT).inset.hPct}%`,
            }}
          />

          <div
            className="table-deck"
            data-table-deck
            data-table-deck-state="source"
            aria-hidden="true"
          >
            <PlayingCard faceDown size="xs" />
          </div>
          {/* pot, board, and status live at the center (A5: the pot row is the
              first child, i.e. centered directly above the cards area).
              H2 size budget: with centerBudget on (the live table), content
              taller than centerColumnBudgetPx() scales down uniformly - a
              mitigation, not a guarantee: the page's compact tier shrinks
              the content first so the clamp usually only nudges, but it
              floors at minScale (0.72) and an extreme pile (3 runs +
              banners + summary) can overrun past that floor. */}
          <div
            ref={potRef}
            className={cn(
              'table-center-col absolute z-10 flex flex-col items-center',
              centerCompact ? 'gap-2' : narrow ? 'gap-2.5' : 'gap-5',
            )}
            style={{
              left: `${CENTER_COLUMN.xPct}%`,
              top: `${centerPreflop ? 43 : centerRaised ? CENTER_COLUMN.compactYPct : CENTER_COLUMN.yPct}%`,
              width: `${CENTER_COLUMN.widthPct}%`,
              transform: `translate(-50%, -50%) scale(${colScale})`,
            }}
          >
            {!ribbonOnRail && ribbon}
            {children}
          </div>

          {/* L3: rail-band ribbon — inside the canvas so it scales with the
              table, z below the pods so a seat can never be covered by it */}
          {ribbonOnRail && <div className="table-ribbon-rail">{ribbon}</div>}

          {sitSpots.map((spot) => (
            <div
              key={`sit-${spot.seat}`}
              className="absolute z-10 -translate-x-1/2 -translate-y-1/2"
              style={{ left: `${spot.x}%`, top: `${spot.y}%` }}
            >
              <button onClick={() => onSit(spot.seat)} className="table-sit-spot">
                {t('Sit')}
              </button>
            </div>
          ))}

          {order.map((p, i) => {
            const seat = p.seat;
            const a = angleOf(i, n);
            const { x, y, sin: s, cos: c } = seatPoint(a, canvas);
            // L6: the phone oval has its own anchors (no pod hangs and none
            // flips inward) and its own, wider bet ellipse.
            const { tx, ty } = anchorOf(s, c, narrow ? SEAT_ANCHOR_PHONE : SEAT_ANCHOR);
            const committed = committedBySeat[seat] ?? 0;
            // Bet piles ride their own tighter ellipse between the pot and the
            // seats. The straight-bottom seat gets a sideways nudge: there is
            // no vertical room left between the river card and a full pod, so
            // its stack sits just off the center line (user feedback v2 #1).
            const bet = betPoint(a, narrow ? BET_RING_PHONE : BET_RING);
            const isMe = p.userId === myUserId;
            const bbCount = fmtBB(p.stack, bb);
            const strength = handTypes?.[seat] ?? null;
            const cardsVisible =
              p.inHand && (isMe ? myCards.length > 0 || !p.folded : !p.folded || !!p.revealed);
            const handMode = seatHandMode({
              isHero: isMe,
              cardsVisible,
              revealed: !!p.revealed,
            });

            const isBanker = p.userId === bankerId;
            const isHost = hostId != null && p.userId === hostId;
            const isCoBanker = coBankerId !== null && p.userId === coBankerId;

            const lastAction = p.lastAction;
            const aggressive =
              !!lastAction && (lastAction.type === 'raise' || lastAction.type === 'bet');
            const folded = lastAction?.type === 'fold';
            const showAction =
              !p.broke && p.connected && !p.sittingOut && (!!lastAction || p.allIn);
            // L5 (spec row 6): during the winner moment the beaten hands dim
            // alongside the folded ones - the 300ms transition lives in
            // table-motion.css, and it lifts the instant the moment ends (or
            // the next hand starts).
            const lostNow = winnerResultLit && p.inHand && !p.won && !p.folded;
            const dim = p.folded || !p.connected || p.sittingOut || lostNow;
            // the stack's display unit is a shared local preference; one tap
            // flips pts ⇄ BB for EVERY seat on this device.
            const stackHint =
              stackUnit === 'chips'
                ? t('{n} chips · tap to show BB', { n: fmt(p.stack) })
                : t('{n} BB · tap to show points', { n: bbCount });
            // AT MOST ONE role corner; every role folds into its tip.
            const roles: { key: string; pos: string; icon: React.ReactNode; label: string }[] = [];
            if (isHost)
              roles.push({
                key: 'host',
                pos: '-left-[3px] -top-[3px]',
                icon: <Play size={8} weight="fill" />,
                label: t('Host - deals the hands'),
              });
            if (isBanker || isCoBanker)
              roles.push({
                key: 'banker',
                pos: '-left-[3px] -bottom-[3px]',
                icon: <Coins size={9} weight="fill" />,
                label: isBanker ? t('Banker') : t('Backup banker'),
              });
            if (p.isLeader)
              roles.push({
                key: 'leader',
                pos: '-right-[3px] -top-[3px]',
                icon: <Crown size={9} weight="fill" />,
                label: t('Chip leader'),
              });
            // A bot never produces a muted corner: its identity badge owns the
            // bottom-right slot (see the badge below), and bots have no voice
            // session to mute anyway - the guard makes the slot conflict
            // impossible by construction, not by assumption.
            if (p.voiceMuted && !p.bot)
              roles.push({
                key: 'muted',
                pos: '-right-[3px] -bottom-[3px]',
                icon: <MicrophoneSlash size={9} weight="fill" />,
                label: t('muted'),
              });
            const corner = roles[0];
            const cornerTip = roles.map((r) => r.label).join(' · ');

            return (
              <div key={seat}>
                {/* v3 feedback #3 + chip semantics: this slot on the inner bet
                    ellipse is the seat's money spot ON THE FELT. It carries the
                    D/SB/BB position discs (kept all hand, even after the player
                    folds - like a real button on the table) plus, when they've
                    acted, the current-street chip pile + amount pill sliding in
                    from the seat and sweeping to the pot when the street
                    closes. */}
                {(committed > 0 || (p.inHand && p.isButton)) && (
                  <div
                    ref={(el) => {
                      betEls.current[seat] = el;
                    }}
                    className="absolute z-20 flex -translate-x-1/2 -translate-y-1/2 items-center gap-1.5"
                    style={{ left: `${bet.x}%`, top: `${bet.y}%` }}
                  >
                    {/* L2 (rev-2 user decision #3): pure-GG position — the ONE
                        gold dealer disc plus the posted blind chips carry the
                        button and the blinds; the SB/BB letter discs are gone.
                        The disc stays all hand, even after the player folds —
                        like a real button on the table. */}
                    {p.inHand && p.isButton && (
                      <span
                        role="img"
                        aria-label={t('Dealer button')}
                        title={t('Dealer button')}
                        className="table-disc-d shrink-0"
                      >
                        D
                      </span>
                    )}
                    <AnimatePresence>
                      {committed > 0 && (
                        <motion.div
                          key="pile"
                          exit={
                            reduce
                              ? { opacity: 0 }
                              : {
                                  // sweep into the pot when the street closes
                                  x: ((POT_SWEEP_TARGET.xPct - bet.x) / 100) * canvas.w,
                                  y: ((POT_SWEEP_TARGET.yPct - bet.y) / 100) * canvas.h,
                                  opacity: 0,
                                  scale: 0.5,
                                }
                          }
                          transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
                          className="flex items-center gap-1"
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
                            <ChipStack
                              amount={committed}
                              bb={bb}
                              sb={sb}
                              // L6: the phone's bet lanes are a few design px
                              // wide (board edge ↔ pod top) — only the xs tier
                              // fits between them without covering a card.
                              size={narrow ? 'xs' : 'sm'}
                            />
                            <span className="table-bet-amt">
                              {stackUnit === 'chips'
                                ? fmt(committed)
                                : `${fmtBB(committed, bb)} BB`}
                            </span>
                          </motion.div>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>
                )}
                <TableSeat
                  seat={seat}
                  x={x}
                  y={y}
                  tx={tx}
                  ty={ty}
                  heroTop={isMe && narrow}
                  handMode={handMode}
                  podRef={(el) => {
                    podEls.current[seat] = el;
                  }}
                >
                  {/* L2 seat unit (rev-3 mockup): ONE dark plaque card holds
                      avatar → name → stack → action → strength → state, with
                      the hole cards riding the card's top edge and a single
                      gold avatar ring. Status pills ride BELOW the unit.
                      rev-3 rules: one hairline + one shadow, ≤1 role corner
                      (merged tooltip), dimmed folded/offline/sitting-out. */}

                  <div className="table-pod-visual" data-testid={`seat-pod-${seat}`}>
                    {handMode === 'hero' && myCards.length > 0 && (
                      <div
                        className={cn(
                          narrow
                            ? 'table-pod-holo table-pod-holo--side table-pod-holo--hero'
                            : 'table-hero-cards',
                          dim && 'table-hero-cards--dim',
                        )}
                        data-testid="hero-hole-cards"
                        aria-label={t('Your cards')}
                      >
                        <HoleCards
                          key={handId}
                          delay={i * SEAT_DEAL_STAGGER_MS}
                          size={narrow ? holeSize : 'md'}
                          narrow={narrow}
                          cards={myCards}
                          handId={handId}
                          motionPrefix="hole:hero"
                          gold={goldBySeat?.[p.seat]}
                        />
                      </div>
                    )}
                    <div
                      className={cn(
                        'table-pod-card transition-transform',
                        !cardsVisible && 'table-pod-card--bare',
                        p.isToAct && 'table-pod-card--acting scale-[1.04]',
                        p.won && 'table-pod-card--won',
                        dim && 'table-pod-card--dim',
                      )}
                    >
                      {cardsVisible && handMode !== 'hero' && (
                        <div
                          className={cn(
                            'table-pod-holo',
                            handMode === 'showdown'
                              ? 'table-pod-holo--side'
                              : 'table-pod-holo--fan',
                          )}
                        >
                          <HoleCards
                            key={handId}
                            delay={i * SEAT_DEAL_STAGGER_MS}
                            size={holeSize}
                            narrow={narrow}
                            cards={isMe ? myCards : p.revealed}
                            faceDown={handMode === 'hidden'}
                            handId={handId}
                            motionPrefix={p.revealed ? `reveal:${p.seat}` : `hole:seat:${p.seat}`}
                            reveal={!!p.revealed}
                            gold={goldBySeat?.[p.seat]}
                          />
                        </div>
                      )}
                      <div
                        className={cn(
                          'table-avatar-ring',
                          p.isToAct && !urgent && 'table-avatar-ring--acting',
                          // L5 danger: last 10s - the glow shifts red and
                          // breathes at 1Hz (table-motion.css)
                          p.isToAct && urgent && 'table-avatar-ring--hot',
                          p.won && 'table-avatar-ring--won',
                          p.speaking && 'table-avatar-ring--speaking',
                          dim && 'table-avatar-ring--dim',
                        )}
                      >
                        {hudRoomId ? (
                          <button
                            type="button"
                            onClick={(event) => openHud(p.userId, event.currentTarget)}
                            aria-label={`${p.displayName} · ${t('Player HUD')}`}
                            aria-haspopup="dialog"
                            className="block rounded-full focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-amber-300"
                          >
                            <Avatar
                              userId={p.userId}
                              name={p.displayName}
                              version={p.avatarVersion}
                              // L6: phone avatars ride one tier down (hero 42,
                              // opponents 32 design px) so the compact pod
                              // clears the board budget at 9 seats.
                              size={isMe ? 'md' : 'sm'}
                              className={cn(
                                'rounded-full',
                                // gg-polish #3 (slim portrait prototype):
                                // desktop rides the mockup's portrait head for
                                // EVERY seated player (was hero 48 / opp 40
                                // in the sideways plaque). 64, not the
                                // mockup's 74: at 9 seats the ±40° ring points
                                // sit 178 design px apart and a 74 head makes
                                // the plaque 134 tall - the strength+pills
                                // stack under it then lands on the NEIGHBOUR'S
                                // plaque (measured podPair 881px², seat 6↔7).
                                // 64 keeps the worst pair ≥3px clear AND the
                                // plaque ≤ ~124 inside the podWorstPx=150
                                // budget. Phone keeps its compact tiers (hero
                                // 42 / opp 32) - the phone ring has no room
                                // for any portrait head.
                                isMe && (narrow ? 'h-[42px]! w-[42px]!' : 'h-[64px]! w-[64px]!'),
                                !isMe && !narrow && 'h-[64px]! w-[64px]!',
                              )}
                            />
                          </button>
                        ) : (
                          <div aria-hidden="true">
                            <Avatar
                              userId={p.userId}
                              name={p.displayName}
                              version={p.avatarVersion}
                              size={isMe ? 'md' : 'sm'}
                              className={cn(
                                'rounded-full',
                                // gg-polish #3: desktop portrait head, see the
                                // 64-not-74 note on the HUD-button branch.
                                isMe && (narrow ? 'h-[42px]! w-[42px]!' : 'h-[64px]! w-[64px]!'),
                                !isMe && !narrow && 'h-[64px]! w-[64px]!',
                              )}
                            />
                          </div>
                        )}
                        {corner && (
                          <span
                            role="img"
                            aria-label={cornerTip}
                            title={cornerTip}
                            className={cn(
                              'table-role-badge',
                              corner.pos,
                              corner.key === 'muted' && 'table-role-badge--muted',
                            )}
                          >
                            {corner.icon}
                          </span>
                        )}
                        {/* The bot identity badge rides outside the one-role
                                corner rule on purpose: who is a bot must stay
                                visible even when the seat also holds a crown.
                                The bottom-right slot is reserved for it - the
                                roles list above cannot emit a `muted` corner
                                for a bot, so no collision is possible. */}
                        {p.bot && (
                          <span
                            role="img"
                            aria-label={t('Bot - {status}', {
                              status: botStatusLabel(p.bot.status),
                            })}
                            title={t('Bot opponent - {status}', {
                              status: botStatusLabel(p.bot.status),
                            })}
                            className="table-role-badge table-role-badge--bot -bottom-[3px] -right-[3px]"
                          >
                            <Robot size={9} weight="fill" />
                          </span>
                        )}
                        {equityBySeat?.[p.seat] !== undefined && (
                          <SeatEquityBubble
                            bps={equityBySeat[p.seat]!}
                            advantaged={equityBySeat[p.seat]! >= maxEquity}
                          />
                        )}
                      </div>
                      <div className="table-pod-info">
                        <div className="table-pod-name-row">
                          <div className="table-pname" title={p.displayName}>
                            {p.displayName}
                          </div>
                          {hudRoomId && (
                            <SeatBadges
                              player={(Array.isArray(hud?.players)
                                ? hud.players.filter(isValidHudPlayer)
                                : []
                              ).find((v) => v.userId === p.userId)}
                              minHands={hud?.minHands ?? 0}
                            />
                          )}
                        </div>
                        <div className="table-pod-detail-row">
                          <button
                            type="button"
                            onClick={toggleStackUnit}
                            aria-label={stackHint}
                            title={stackHint}
                            className={cn('table-pstack', p.broke && 'table-pstack--out')}
                          >
                            {stackUnit === 'chips' ? (
                              <>
                                <StackValue
                                  stack={p.stack}
                                  won={p.won}
                                  flightLead={collectLead}
                                  sourceCount={collectSourceCount}
                                  targetCount={collectors.length}
                                />
                                <span className="table-pstack-unit">{t('pts')}</span>
                              </>
                            ) : (
                              <>
                                {bbCount}
                                <span className="table-pstack-unit">BB</span>
                              </>
                            )}
                          </button>
                          {showAction && lastAction?.type !== 'check' && (
                            <motion.div
                              key={
                                lastAction
                                  ? `${lastAction.type}-${lastAction.amount ?? 0}`
                                  : 'all-in'
                              }
                              initial={reduce ? false : { scale: 1.35, y: -2 }}
                              animate={{ scale: 1, y: 0 }}
                              transition={{ type: 'spring', stiffness: 220, damping: 22 }}
                              className={cn(
                                'table-paction',
                                !lastAction
                                  ? 'table-paction--allin'
                                  : aggressive
                                    ? 'table-paction--aggr'
                                    : folded
                                      ? 'table-paction--fold'
                                      : '',
                              )}
                            >
                              {lastAction ? actionLabel(lastAction, stackUnit, bb) : t('All-in')}
                            </motion.div>
                          )}
                          {lastAction?.type === 'check' && (
                            <span className="table-paction table-paction--check">{t('Check')}</span>
                          )}
                        </div>
                        <CheckFeedback action={lastAction} handId={handId} />
                        {/* gg-polish #3 (slim portrait): the strength line
                            leaves the plaque on desktop (it would make the
                            worst plaque ~140 and its pill row then reaches
                            into the neighbouring seat's card — the 9-seat
                            ring gives plates + anything under them only
                            ~30 design px of pitch). It rides the pills row
                            instead (below, absolutely, ONE row high). The
                            phone keeps its in-flow line inside the compact
                            plaque - its ring never hangs a pill row into a
                            neighbour at these heights. */}
                        {narrow && strength && (
                          <div className="table-pstrength">{strength}</div>
                        )}
                        {(p.broke || !p.connected || p.sittingOut) && (
                          <div
                            className={cn(
                              'table-pstate',
                              p.broke
                                ? 'table-pstate--out'
                                : !p.connected
                                  ? 'table-pstate--off'
                                  : 'table-pstate--sit',
                            )}
                          >
                            {p.broke
                              ? t('Out of chips')
                              : !p.connected
                                ? t('Offline')
                                : t('Sitting out')}
                          </div>
                        )}
                        {p.isToAct && <TurnProgress seat={p.seat} />}
                      </div>
                    </div>
                    {/* pills ride BELOW the unit (rev-3); wrapped so the
                            phone rule can collapse them to one capped row.
                            gg-polish #3: on desktop the strength chip joins
                            this row (its plaque has no spare line for it). */}
                    {(!narrow && strength) ||
                      p.isToAct ||
                      (p.won && !p.isToAct) ||
                      (readyCheck &&
                        !p.won &&
                        !p.isToAct &&
                        readyCheck.eligible.includes(p.userId)) ||
                      (handLive && p.inHand && !p.folded && p.bankMs !== undefined) ||
                      p.pendingBuy > 0 ||
                      (!!p.bot && p.bot.status !== 'running') ? (
                      <div className="table-pod-pills">
                        {!narrow && strength && (
                          <span className="table-pill table-pod-strength" title={strength}>
                            {strength}
                          </span>
                        )}
                        {p.isToAct && (
                          <span
                            className={cn(
                              'table-pill',
                              urgent ? 'table-pill--acting-hot' : 'table-pill--acting',
                            )}
                          >
                            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current motion-reduce:animate-none" />
                            {t('playing')}
                          </span>
                        )}
                        {p.won && !p.isToAct && (
                          <AnimatePresence>
                            {badgeLit && (
                              <WinBadge
                                amount={p.wonAmount}
                                onShare={p.seat === shareSeat ? onShareHand : undefined}
                              />
                            )}
                          </AnimatePresence>
                        )}
                        {readyCheck &&
                          !p.won &&
                          !p.isToAct &&
                          readyCheck.eligible.includes(p.userId) && (
                            <span
                              className={cn(
                                'table-pill',
                                readyCheck.ready.includes(p.userId)
                                  ? 'table-pill--ready'
                                  : 'table-pill--wait',
                              )}
                            >
                              {readyCheck.ready.includes(p.userId) ? t('✓ ready') : t('ready?')}
                            </span>
                          )}
                        {handLive && p.inHand && !p.folded && p.bankMs !== undefined && (
                          <div
                            title={t('Bank {n}s', { n: Math.ceil(p.bankMs / 1000) })}
                            className={cn(
                              'table-pill table-pill--bank',
                              p.isToAct && 'table-pill--bank-loud',
                              !p.isToAct && p.bankMs === 0 && 'table-pill--bank-quiet',
                            )}
                          >
                            <Timer size={narrow ? 10 : 8} weight="fill" aria-hidden="true" />
                            {Math.ceil(p.bankMs / 1000)}s
                          </div>
                        )}
                        {p.pendingBuy > 0 && (
                          <div
                            title={t('Buy waiting for banker approval')}
                            className="table-pill table-pill--buy"
                          >
                            {t('+{n} soon', { n: fmt(p.pendingBuy) })}
                          </div>
                        )}
                        {/* a bot that is NOT actually playing says why: the
                            host sees waiting/starting/error at a glance */}
                        {p.bot && p.bot.status !== 'running' && (
                          <span
                            className={cn(
                              'table-pill table-pill--bot',
                              botStatusTone(p.bot.status) === 'bad' && 'table-pill--bot-bad',
                            )}
                          >
                            <Robot size={9} weight="fill" aria-hidden="true" />
                            {botStatusLabel(p.bot.status)}
                          </span>
                        )}
                      </div>
                    ) : null}
                    {canKick && !isMe && (
                      <button
                        onClick={() => {
                          if (kickArmed === p.userId) {
                            setKickArmed(null);
                            onKick(p.userId);
                          } else {
                            setKickArmed(p.userId);
                            setTimeout(
                              () => setKickArmed((v) => (v === p.userId ? null : v)),
                              3500,
                            );
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
                            ? 'h-auto w-auto bg-[var(--table-red)] px-2 py-0.5 text-[0.62rem] font-bold'
                            : 'h-5 w-5 bg-[var(--table-faint)] hover:bg-[var(--table-red)]',
                        )}
                      >
                        {kickArmed === p.userId ? t('stand up?') : <X size={11} weight="bold" />}
                      </button>
                    )}
                  </div>
                </TableSeat>
              </div>
            );
          })}
        </div>
      </div>

      {/* Settlement is intentionally two beats: each street pile first gathers
          into the center pot, then the consolidated pot pays the net winner(s).
          StackValue and the WIN badge use the same lead, so neither jumps early. */}
      {fxLit && (
        <SettlementFlight
          key={`settle-${handId}`}
          run={fxLit}
          getSources={() =>
            // The snapshot is the exact pile set whose count drove the timeline
            // (see collectionSources): same street, same seats, same number.
            Object.values(collectionSources.current)
          }
          getPot={() => centralPotRef?.current ?? null}
          getTo={(seat) => podEls.current[seat] ?? null}
          targets={collectors}
          delay={collectLead}
        />
      )}

      {/* L5 (spec row 3): the mirror moment on every street - a call/raise
          bursts from the seat's pod to its bet spot on the felt. */}
      {handLive &&
        handId !== null &&
        Object.entries(betFlights).map(([seatStr, run]) => {
          const seat = Number(seatStr);
          if ((committedBySeat[seat] ?? 0) === 0) return null;
          return (
            <BetFlight
              key={`bet-fly-${seat}`}
              run={run}
              getFrom={() => podEls.current[seat] ?? null}
              getTo={() => betEls.current[seat] ?? null}
            />
          );
        })}
      {hudRoomId && hudUserId !== null && (
        <PlayerHud
          roomId={hudRoomId}
          userId={hudUserId}
          onClose={closeHud}
          opener={hudOpener.current}
          onData={setHud}
        />
      )}
    </div>
  );
}

function CheckFeedback({
  action,
  handId,
}: {
  action?: SeatView['lastAction'];
  handId: string | null;
}) {
  const [run, setRun] = useState(0);
  useEffect(() => {
    if (action?.type !== 'check') return;
    setRun((n) => n + 1);
  }, [action, handId]);
  useEffect(() => {
    if (!run) return;
    const timer = setTimeout(() => setRun(0), 1800);
    return () => clearTimeout(timer);
  }, [run]);
  return run ? (
    <span key={run} className="table-check-feedback" role="status">
      {t('Check')}
    </span>
  ) : null;
}
