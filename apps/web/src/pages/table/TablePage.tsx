import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { AutoDealDialog } from '../../features/table/AutoDealDialog.tsx';
import { pokerOverlayOpen } from '../../features/table/pokerHotkeys.ts';
import { motion } from 'motion/react';
import {
  ArrowLeft,
  Bomb,
  Coins,
  CornersIn,
  CornersOut,
  Cube,
  UsersThree,
  CardsThree,
  ChatCircle,
  DotsThreeVertical,
  Eye,
  Microphone,
  MicrophoneSlash,
  GearSix,
  PauseCircle,
  Play,
  Receipt,
  Skull,
  Sliders,
  Timer,
  Trophy,
  UserPlus,
  VideoCamera,
  Wallet,
  X,
} from '@phosphor-icons/react';
import NumberFlow from '@number-flow/react';
import confetti from 'canvas-confetti';
import {
  bestFive,
  describeScore,
  evaluate5,
  evaluate7,
  handCategory,
  rankOf,
  HAND_CATEGORY_NAMES,
  type CardId,
  type RoomGameplaySettings,
  type ServerMsg,
} from '@4am/shared';
import {
  agreeRunCount,
  answerPeek,
  bindGameClient,
  chooseRunCount,
  imReady,
  offerPeek,
  ritVote,
  setSitOut,
  sit,
  startHand,
} from '../../shared/gameClient.ts';
import { wsClient } from '../../shared/ws.ts';
import { useStore } from '../../shared/store.ts';
import { api, type FeatureTriggerKind } from '../../shared/api.ts';
import { GameplaySettingsDialog } from '../../features/table/GameplaySettingsDialog.tsx';
import { voice } from '../../shared/voice.ts';
import { play } from '../../shared/sounds.ts';
import { cn, fmt } from '../../shared/lib/cn.ts';
import { t, tr } from '../../shared/i18n/index.ts';
import { tNode } from '../../shared/i18n/trans.tsx';
import { tHandCategory, tScore } from '../../shared/i18n/pokerLabels.ts';
import { Badge, Button, Dialog, Panel, Spinner } from '../../shared/ui/index.tsx';
import { PlayingCard } from '../../entities/card/PlayingCard.tsx';
import type { SeatView } from '../../widgets/table/players.tsx';
import { BettingPanel } from '../../widgets/table/BettingPanel.tsx';
import { ChatPanel } from '../../widgets/table/ChatPanel.tsx';
import { RoundTable } from '../../widgets/table/RoundTable.tsx';
import { FloatingCards } from '../../widgets/table/FloatingCards.tsx';
import { ChipStack } from '../../widgets/table/ChipStack.tsx';
import { BankControls } from '../../widgets/table/BankControls.tsx';
import { LastHandStrip } from '../../widgets/table/LastHandStrip.tsx';
import { ResultFlash } from '../../widgets/table/ResultFlash.tsx';
import { TableDock } from '../../widgets/table/TableDock.tsx';
import { TableQuickControls } from '../../widgets/table/TableQuickControls.tsx';
import { PokerShortcutButton } from '../../features/settings/PokerShortcutButton.tsx';
import { BrokeBuyInDialog } from '../../features/bank/BrokeBuyInDialog.tsx';
import { InviteFriendsDialogBody } from '../../features/friends/FriendsPanel.tsx';
import { LeaderboardTable, type LeaderboardRow } from '../leaderboard/LeaderboardPage.tsx';
import { ShareHandDialog } from '../../features/share/ShareHandDialog.tsx';
import { ShareRoom } from '../../features/share/ShareRoom.tsx';
import type { ShareData } from '../../features/share/shareCard.ts';
import {
  tableUtilityGroups,
  unreadChatCount,
  type TableUtilityAction,
  type TableUtilityGroupId,
} from './tableUi.ts';

function useNow(tickMs = 500): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const iv = setInterval(() => setNow(Date.now()), tickMs);
    return () => clearInterval(iv);
  }, [tickMs]);
  return now;
}

/**
 * Review fix #8: instead of ticking the whole TablePage twice a second,
 * urgency is ONE scheduled flip per deadline (fires at T-10s, clears at T).
 */
function useUrgentAt(deadline: number | null, handLive: boolean): boolean {
  const [urgent, setUrgent] = useState(false);
  useEffect(() => {
    if (!handLive || !deadline) {
      setUrgent(false);
      return;
    }
    const check = () => setUrgent(deadline - Date.now() <= 10_000);
    check();
    const toUrgent = Math.max(0, deadline - 10_000 - Date.now());
    const toPass = Math.max(toUrgent, deadline - Date.now());
    const t1 = setTimeout(check, toUrgent);
    const t2 = setTimeout(() => setUrgent(false), toPass);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, [deadline, handLive]);
  return urgent;
}

/** The header countdown: the only component that ticks off `deadline`. */
function CountdownChip({ deadline, urgent }: { deadline: number; urgent: boolean }) {
  const now = useNow(500);
  const secs = Math.max(0, Math.ceil((deadline - now) / 1000));
  return (
    <span
      className={cn(
        'flex shrink-0 items-center gap-1.5 rounded-xl bg-slate-100 px-2.5 py-1.5 font-display text-sm font-semibold tabular-nums dark:bg-slate-900',
        urgent && 'animate-urgent bg-rose-50 text-rose-600 dark:bg-rose-950 dark:text-rose-300',
      )}
    >
      <Timer size={15} weight="bold" /> 0:{String(secs).padStart(2, '0')}
    </span>
  );
}

/** The run-it-twice vote banner, with its own countdown - ticking here, not
 *  in the page body (review fix #8). */
function RunTwicePrompt({
  offer,
  mySeat,
}: {
  offer: { deadlineTs: number; voters: number[]; voted: boolean };
  mySeat: number | null;
}) {
  const now = useNow();
  return (
    <div className="z-20 flex flex-col items-center gap-2 rounded-2xl bg-fuchsia-600/95 px-5 py-3 text-white shadow-[0_18px_50px_rgba(192,38,211,0.35)]">
      <span className="font-display text-lg font-bold">
        {t('🔁 Run it twice? · {n}s', {
          n: Math.max(0, Math.ceil((offer.deadlineTs - now) / 1000)),
        })}
      </span>
      {mySeat !== null && offer.voters.includes(mySeat) && !offer.voted ? (
        <div className="flex gap-2">
          <Button
            variant="secondary"
            className="border-0 bg-white! text-fuchsia-700! hover:bg-fuchsia-50!"
            onClick={() => ritVote(true)}
          >
            {t('Twice 🔁')}
          </Button>
          <Button
            variant="secondary"
            className="border-0 bg-white/20! text-white! hover:bg-white/30!"
            onClick={() => ritVote(false)}
          >
            {t('Once')}
          </Button>
        </div>
      ) : (
        <span className="text-xs text-fuchsia-100">
          {t('Everyone is all-in - the rest of the board deals twice if all agree.')}
        </span>
      )}
    </div>
  );
}

/**
 * v3 feedback #7a: with auto-deal on, the server dwells between hands before
 * the next ready check. This clock makes that wait legible, and the host's
 * Deal hand button (same panel) beats it outright.
 */
function AutoDealClock({ autoDealAt }: { autoDealAt: number | null }) {
  const now = useNow(1000);
  if (!autoDealAt) return null;
  const secs = Math.max(0, Math.ceil((autoDealAt - now) / 1000));
  return (
    <p className="text-center font-display text-[0.68rem] font-semibold tabular-nums text-indigo-600 dark:text-indigo-300">
      {t('Next hand in {n}s', { n: secs })}
    </p>
  );
}

interface FloatingReaction {
  id: number;
  emoji: string;
  left: number;
}

type MultiRunOfferMsg = Extract<ServerMsg, { t: 'multi_run_offer' }>;

/**
 * P2 B4 (docs/p2-gameplay-design.md): the server-authoritative staged
 * all-in multi-run negotiation, replacing the old run-it-twice vote.
 *
 * stage `choice`  - the BEHIND hand picks how many times to run the board
 *                   (1-3, countdown on offer.deadlineTs);
 * stage `agreement` - the AHEAD hand must accept the pick or fall back to
 *                   one run. Everyone else watches a read-only line.
 *
 * The pick is optimistic on the buttons only (the game client patches
 * requestedRuns); boards are NEVER created here - they arrive with the
 * board_open frames after multi_run_result resolves the hand.
 */
function MultiRunPrompt({
  offer,
  mySeat,
  nameOf,
}: {
  offer: MultiRunOfferMsg;
  mySeat: number | null;
  nameOf: (seat: number) => string;
}) {
  const now = useNow();
  const secs = Math.max(0, Math.ceil((offer.deadlineTs - now) / 1000));
  const amBehind = mySeat !== null && mySeat === offer.behindSeat;
  const amAhead = mySeat !== null && mySeat === offer.aheadSeat;
  const behind = nameOf(offer.behindSeat);
  // one in-flight decision per decisionId: after a click the buttons die until
  // the server's next offer frame (new stage, or the result clearing it)
  const [sentPick, setSentPick] = useState<string | null>(null);
  useEffect(() => {
    setSentPick(null);
  }, [offer.decisionId, offer.stage]);
  // if the socket ate the first attempt, hand the player their buttons back
  // after a few seconds - a re-sent choice the server already processed is
  // refused by its stage guard, so retrying can only help
  useEffect(() => {
    if (!sentPick) return;
    const iv = setTimeout(() => setSentPick(null), 4000);
    return () => clearTimeout(iv);
  }, [sentPick]);

  const pick = (count: 1 | 2 | 3) => {
    if (sentPick) return;
    // chooseRunCount() patches requestedRuns optimistically; the latch just
    // keeps a double-click from sending a second signed choice.
    setSentPick(`${offer.decisionId}:${count}`);
    chooseRunCount(count);
  };
  const answer = (agree: boolean) => {
    if (sentPick) return;
    setSentPick(`${offer.decisionId}:${agree ? 'y' : 'n'}`);
    agreeRunCount(agree);
  };

  const myEquity = mySeat === null ? null : (offer.equities.find((e) => e.seat === mySeat)?.bps ?? null);
  const chosen = offer.requestedRuns !== undefined && offer.requestedRuns > 1;

  let headline: string;
  let detail: string | null = null;
  if (offer.stage === 'choice') {
    if (amBehind && !chosen) {
      headline = t('You are behind');
      if (myEquity !== null) detail = t('Equity {pct}%', { pct: Math.round(myEquity / 100) });
    } else if (amBehind) {
      headline = t('Waiting for the ahead player to confirm…');
    } else {
      headline = t('The behind player is choosing how many times to run the board…');
      detail = behind;
    }
  } else {
    headline = amAhead
      ? t('They asked to run it {n} times', { n: offer.requestedRuns ?? 2 })
      : t('Waiting for the ahead player to confirm…');
    if (amAhead) detail = behind;
  }

  const acting =
    (offer.stage === 'choice' && amBehind && (!chosen || sentPick !== null)) ||
    (offer.stage === 'agreement' && amAhead);

  return (
    <div
      role="region"
      aria-live="polite"
      aria-label={t('Multi-run all-in decision')}
      className="z-20 flex flex-col items-center gap-1.5 rounded-2xl bg-fuchsia-600/95 px-5 py-3 text-white shadow-[0_18px_50px_rgba(192,38,211,0.35)]"
    >
      <div className="flex items-center gap-2">
        <span className="font-display text-lg font-bold">{t('🔁 Run it how many times?')}</span>
        <span
          className={cn(
            'rounded-full bg-white/15 px-2 py-0.5 font-display text-xs font-bold tabular-nums',
            secs <= 5 && 'bg-rose-400/80',
          )}
        >
          {t('{n}s', { n: secs })}
        </span>
      </div>
      <p className="text-center text-sm font-semibold">
        {headline}
        {detail && <span className="ml-1.5 font-normal text-fuchsia-100">{detail}</span>}
      </p>
      {offer.stage === 'choice' && amBehind ? (
        <div className="flex gap-2">
          {([1, 2, 3] as const).map((count) => (
            <Button
              key={count}
              variant="secondary"
              className={cn(
                'border-0 text-fuchsia-700!',
                count > 1 ? 'bg-white! hover:bg-fuchsia-50!' : 'bg-white/25! text-white! hover:bg-white/35!',
              )}
              disabled={sentPick !== null}
              onClick={() => pick(count)}
            >
              {t('Deal {n} times', { n: count })}
            </Button>
          ))}
        </div>
      ) : offer.stage === 'agreement' && amAhead ? (
        <div className="flex gap-2">
          <Button
            variant="success"
            disabled={sentPick !== null}
            onClick={() => answer(true)}
            className="text-sm!"
          >
            {t('Agree')}
          </Button>
          <Button
            variant="secondary"
            className="border-0 bg-white/20! text-white! hover:bg-white/30!"
            disabled={sentPick !== null}
            onClick={() => answer(false)}
          >
            {t('Just once')}
          </Button>
        </div>
      ) : null}
      {!acting && (
        <span className="text-[0.68rem] text-fuchsia-100">
          {offer.stage === 'choice'
            ? t('Only the losing side chooses; dealing more than once needs the other side to agree.')
            : t('Declining or running out of time means one run.')}
        </span>
      )}
    </div>
  );
}

const desktopIconClass =
  'relative inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-slate-500 transition-[color,background-color,transform] duration-200 hover:bg-slate-200/70 hover:text-slate-900 active:scale-[0.96] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-500 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-white';

function DesktopIconButton({
  label,
  onClick,
  children,
  active = false,
  badge = 0,
  buttonRef,
  className,
  hasPopup,
  expanded,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
  active?: boolean;
  badge?: number;
  buttonRef?: React.Ref<HTMLButtonElement>;
  className?: string;
  hasPopup?: boolean;
  expanded?: boolean;
}) {
  return (
    <button
      ref={buttonRef}
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      aria-haspopup={hasPopup ? 'menu' : undefined}
      aria-expanded={hasPopup ? expanded : undefined}
      className={cn(
        desktopIconClass,
        active && 'bg-indigo-100 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300',
        className,
      )}
    >
      {children}
      {badge > 0 && (
        <span className="absolute -right-1 -top-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-indigo-600 px-1 text-[0.62rem] font-bold text-white ring-2 ring-slate-100 dark:ring-slate-950">
          {badge > 9 ? '9+' : badge}
        </span>
      )}
    </button>
  );
}

/** Both visual tables use one room lifecycle and the same dialogs/actions. */
export interface TablePresentation {
  menuOpen: boolean;
  setMenuOpen: (open: boolean) => void;
  utilities: ReactNode;
  chatOpen: boolean;
  setChatOpen: (open: boolean) => void;
  unreadChat: number;
  voiceControl: ReactNode;
  fullscreenControl: ReactNode;
  seatPicker: ReactNode;
  peekPanel: ReactNode;
  runTwice: ReactNode;
  /** P2 Lane F (ADDITIVE - optional so the 3D page keeps compiling and
   *  rendering untouched): the felt-side feature overlays for this hand -
   *  bomb/squid badges, the bomb-pot flop notice, the multi-run outcome and
   *  the squid settlement summary. Identical nodes to the ones the 2D felt
   *  renders; a presentation may place or ignore them. */
  gameplay?: ReactNode;
  status: string | null;
  amSpectator: boolean;
  players: SeatView[];
  canManagePlayers: boolean;
  standUp: (userId: number) => void;
  showResult: () => void;
  showLargeCards: () => void;
}

/** A1 (docs/table-redesign-spec.md): the layout minimum is 1280×720. Below
 *  that, button labels drop to icon-only first; only the table canvas itself
 *  scales down (the RoundTable fits its container), never wrapping. */
function useViewportWidth(): number {
  const [width, setWidth] = useState(() =>
    typeof window === 'undefined' ? 1280 : window.innerWidth,
  );
  useEffect(() => {
    const onResize = () => setWidth(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return width;
}

/** Live hand strength of the two cards in hand (carried over from the old
 *  mobile table when phone and desktop merged into one layout). */
function holeStrengthLabel(myCards: CardId[], board: CardId[]): string | null {
  if (myCards.length < 2) return null;
  const all = [...myCards, ...board];
  if (all.length < 5) {
    return rankOf(myCards[0]!) === rankOf(myCards[1]!) ? 'Pair' : 'High Card';
  }
  let best = 0;
  if (all.length === 7) best = evaluate7(all);
  else if (all.length === 5) best = evaluate5(all);
  else
    for (let skip = 0; skip < all.length; skip++)
      best = Math.max(best, evaluate5(all.filter((_, i) => i !== skip)));
  const cat = HAND_CATEGORY_NAMES[handCategory(best)] ?? null;
  return cat ? tHandCategory(cat) : null;
}

export function TablePage({
  renderTable,
}: {
  renderTable?: (table: TablePresentation) => ReactNode;
} = {}) {
  const { id: roomId } = useParams<{ id: string }>();
  const storedRoom = useStore((s) => s.room);
  const room = storedRoom?.room.id === roomId ? storedRoom : null;
  const hand = useStore((s) => s.hand);
  const auth = useStore((s) => s.auth);
  const voiceState = useStore((s) => s.voice);
  const chat = useStore((s) => s.chat);
  const errors = useStore((s) => s.errors);
  const dismissError = useStore((s) => s.dismissError);
  const [resultDismissed, setResultDismissed] = useState(false);
  const showResult = (hand.result !== null || hand.abort !== null) && !resultDismissed;
  const [joinError, setJoinError] = useState<string | null>(null);
  const [brokeDismissed, setBrokeDismissed] = useState(false);
  const [joinSlow, setJoinSlow] = useState(false);
  const wsConnected = useStore((s) => s.wsConnected);
  // P1 redesign (A6): chat is no longer a default-docked right column - it is
  // a popover opened from the table-area dock, so it starts closed on 2D.
  const [chatOpen, setChatOpen] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  // your hole cards as a big draggable panel; hide/show is remembered
  const [bigCards, setBigCards] = useState(() =>
    renderTable
      ? localStorage.getItem('4am-big-cards') === 'on'
      : localStorage.getItem('4am-big-cards') !== 'off',
  );
  useEffect(() => {
    const sync = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', sync);
    return () => document.removeEventListener('fullscreenchange', sync);
  }, []);
  const [chatSeenCount, setChatSeenCount] = useState(0);
  const [menuOpen, setMenuOpen] = useState(false);
  const [autoDealOpen, setAutoDealOpen] = useState(false);
  // ── P2 gameplay (Lane F) ──────────────────────────────────────────────────
  // The room's stored feature rules, fetched once on join and refreshed by the
  // host's saves. room_state does not carry them; GET /api/rooms/:id does.
  const [features, setFeatures] = useState<RoomGameplaySettings | null>(null);
  const [gameplayOpen, setGameplayOpen] = useState(false);
  // Manual next-hand triggers the host armed. The requestId came back from
  // triggerFeature and is what cancelFeatureTrigger needs; the store has no
  // pending-trigger feed, so this lives here. A new deal claims (or voids)
  // them, which is also when `feature_started` says what really fired.
  const [armedTriggers, setArmedTriggers] = useState<Partial<Record<FeatureTriggerKind, string>>>(
    {},
  );
  // did THIS hand ever show a multi-run decision? gates the outcome line so a
  // plain one-run hand never mentions 发牌次数.
  const sawRunOfferRef = useRef<string | null>(null);
  const [peekAmtStr, setPeekAmtStr] = useState('');
  const [peekSent, setPeekSent] = useState<Record<number, boolean>>({});
  const [shareOpen, setShareOpen] = useState(false);
  const [standingsOpen, setStandingsOpen] = useState(false);
  // A6: the rankings popover riding the table-area dock
  const [rankOpen, setRankOpen] = useState(false);
  const closeDockPopovers = useCallback(() => {
    setRankOpen(false);
    setChatOpen(false);
  }, []);
  // review fix #7: stable identities so the dock's popover effects never see
  // callback churn - the focus behavior depends on open/close, not on render.
  const toggleRank = useCallback(() => {
    setRankOpen((open) => !open);
    setChatOpen(false);
  }, []);
  const toggleChat = useCallback(() => {
    setChatOpen((open) => !open);
    setRankOpen(false);
  }, []);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [watchOpen, setWatchOpen] = useState(false);
  const [watchInfo, setWatchInfo] = useState<{ allow: boolean; token: string } | null>(null);
  const [joinReqs, setJoinReqs] = useState<{ id: number; userId: number; displayName: string }[]>(
    [],
  );
  const [askedToJoin, setAskedToJoin] = useState(false);
  const [standings, setStandings] = useState<LeaderboardRow[] | null>(null);
  const [floats, setFloats] = useState<FloatingReaction[]>([]);
  const floatId = useRef(0);
  const lastChatLen = useRef(0);
  const beepedUrgent = useRef<string | null>(null);
  const desktopMenuRef = useRef<HTMLDivElement>(null);
  const desktopMenuTriggerRef = useRef<HTMLButtonElement>(null);
  // A1: the layout minimum is 1280×720. Review fix #3: the FIRST degradation
  // (labels → icon-only) now triggers at <1280, the spec's own minimum; 1440
  // stays only as a cosmetic refinement for the room meta line. The table
  // canvas scales to fit the stage box in BOTH dimensions (RoundTable), and
  // phones swap the switch strip for the ⋮ menu below 768.
  const viewportW = useViewportWidth();
  const isPhone = viewportW < 768;
  const compactBar = viewportW < 1280;
  const unreadChat = unreadChatCount(chat.length, chatSeenCount, chatOpen);

  useEffect(() => {
    if (!chatOpen) return;
    setChatSeenCount(chat.length);
  }, [chatOpen, chat.length]);

  // A11: one full-height viewport, no page scroll - the table area owns the
  // room; popovers close on Escape themselves.
  useEffect(() => {
    if (renderTable) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [renderTable]);

  // ⋮ menu: focus the first item on open, close on Escape.
  useEffect(() => {
    if (!menuOpen || renderTable) return;
    desktopMenuRef.current
      ?.querySelector<HTMLElement>('a[href], button:not([disabled]), select:not([disabled])')
      ?.focus();
    const closeMenu = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('keydown', closeMenu);
    return () => document.removeEventListener('keydown', closeMenu);
  }, [menuOpen, renderTable]);

  useEffect(() => {
    let alive = true;
    setJoinError(null);
    bindGameClient();
    wsClient.joinRoom(roomId!);
    // the REST payload carries `features` (the ws room_state does not) - the
    // gameplay dialog and the host trigger buttons read it from here.
    api
      .getRoom(roomId!)
      .then((r) => {
        if (alive) setFeatures((r as { features?: RoomGameplaySettings }).features ?? null);
      })
      .catch((e) => {
        if (alive) setJoinError(e instanceof Error ? e.message : 'Could not load room');
      });
    return () => {
      alive = false;
      voice.leave();
      wsClient.leaveRoom();
      useStore.getState().setRoom(null);
    };
  }, [roomId]);

  // A fresh deal claims (or abort-voids) the host's manual triggers, and the
  // feature_started announcement takes over from the armed chips from here.
  useEffect(() => {
    setArmedTriggers({});
  }, [hand.handId]);

  // remember which hand showed a multi-run decision, so the outcome line only
  // ever follows a real negotiation
  useEffect(() => {
    if (hand.multiRunOffer) sawRunOfferRef.current = hand.multiRunOffer.handId;
  }, [hand.multiRunOffer]);

  const armFeature = (feature: FeatureTriggerKind) => {
    // server prose ('this table is closed', 'wait for the current hand to
    // finish', squid's min-players gate…) goes through the phrase library;
    // anything unmatched shows the English source, never a wrong translation.
    const fail = (error: unknown) =>
      useStore
        .getState()
        .pushError(
          error instanceof Error ? tr(error.message) : t('That change did not go through. Try again.'),
        );
    const existing = armedTriggers[feature];
    if (existing) {
      // second tap on an armed chip cancels the queued trigger
      void api
        .cancelFeatureTrigger(roomId!, feature, existing)
        .then(() => setArmedTriggers((a) => ({ ...a, [feature]: undefined })))
        .catch(fail);
      return;
    }
    void api
      .triggerFeature(roomId!, feature)
      .then((r) => setArmedTriggers((a) => ({ ...a, [feature]: r.trigger.requestId })))
      .catch(fail);
  };

  /** Re-read the stored rules on the way in - the dialog edits a copy of
   *  whatever the server has right now, not the copy from page load. */
  const openGameplay = () => {
    api
      .getRoom(roomId!)
      .then((r) => setFeatures((r as { features?: RoomGameplaySettings }).features ?? null))
      .catch(() => {});
    setGameplayOpen(true);
  };

  // if the room never arrives, say so instead of spinning forever
  useEffect(() => {
    if (room) {
      setJoinSlow(false);
      return;
    }
    const timer = setTimeout(() => setJoinSlow(true), 10_000);
    return () => clearTimeout(timer);
  }, [room]);

  // floating sticker reactions over the table
  useEffect(() => {
    const fresh = chat.slice(lastChatLen.current);
    lastChatLen.current = chat.length;
    for (const m of fresh) {
      if (m.kind !== 'sticker') continue;
      const id = ++floatId.current;
      setFloats((f) => [...f, { id, emoji: m.text, left: 25 + Math.random() * 50 }]);
      setTimeout(() => setFloats((f) => f.filter((x) => x.id !== id)), 2500);
    }
  }, [chat]);

  useEffect(() => {
    if (hand.result || hand.abort) setResultDismissed(false);
  }, [hand.result, hand.abort]);

  // the flash is a glance, not a fixture: it steps aside on its own so the
  // felt is uncluttered between hands; Esc or the X still clear it sooner
  useEffect(() => {
    if (!showResult) return;
    const timer = setTimeout(() => setResultDismissed(true), 2400);
    return () => clearTimeout(timer);
  }, [showResult, hand.result, hand.abort]);

  useEffect(() => {
    if (!showResult || !room) return;
    const dismissOnEscape = (event: KeyboardEvent) => {
      if (
        event.key !== 'Escape' ||
        event.defaultPrevented ||
        event.repeat ||
        event.isComposing ||
        pokerOverlayOpen()
      )
        return;
      event.preventDefault();
      // Dismiss only the recap, without also closing docked chat or 3D controls.
      event.stopPropagation();
      setResultDismissed(true);
    };
    document.addEventListener('keydown', dismissOnEscape, true);
    return () => document.removeEventListener('keydown', dismissOnEscape, true);
  }, [showResult, room?.room.id]);

  // confetti when you win a pot
  useEffect(() => {
    if (!hand.result || mySeat === null) return;
    const myDelta = hand.result.deltas.find((d) => d.seat === mySeat)?.delta ?? 0;
    if (myDelta > 0 && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
      confetti({ particleCount: 110, spread: 75, origin: { y: 0.7 } });
      setTimeout(
        () => confetti({ particleCount: 50, angle: 60, spread: 60, origin: { x: 0, y: 0.8 } }),
        220,
      );
      setTimeout(
        () => confetti({ particleCount: 50, angle: 120, spread: 60, origin: { x: 1, y: 0.8 } }),
        380,
      );
    }
  }, [hand.result]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (errors.length === 0) return;
    const timer = setTimeout(dismissError, 4000);
    return () => clearTimeout(timer);
  }, [errors, dismissError]);

  const mySeat = room?.players.find((p) => p.userId === auth.userId)?.seat ?? null;
  // v3 feedback #7a (client side): an auto-ready player who somehow was not
  // pre-marked by the server's ready check answers it the moment it opens -
  // nobody should ever have to click per hand when they opted into auto-ready.
  const prefs = useStore((s) => s.prefs);
  useEffect(() => {
    const rc = hand.readyCheck;
    if (!rc || !prefs.autoReady || !wsConnected || auth.userId === null) return;
    if (!rc.eligible.includes(auth.userId) || rc.ready.includes(auth.userId)) return;
    imReady();
  }, [hand.readyCheck, prefs.autoReady, wsConnected, auth.userId]);
  const isHost = room?.room.hostId === auth.userId;
  const isBankerHere =
    room?.room.bankerId === auth.userId || room?.room.coBankerId === auth.userId || isHost;
  // no membership row at all means this login came through a watch link
  const amSpectator = !!room && !room.players.some((p) => p.userId === auth.userId);
  const handLive = hand.handId !== null && !hand.result && !hand.abort;
  const myRoomStack = room?.players.find((p) => p.userId === auth.userId)?.stack ?? null;
  const amBroke = mySeat !== null && myRoomStack === 0 && !handLive;
  // review fix #8: one scheduled flip per deadline, no page-wide 500ms ticker
  const urgent = useUrgentAt(hand.deadline, handLive);
  const utilityGroups = tableUtilityGroups({
    amSpectator,
    isBankerHere: !!isBankerHere,
    isHost: !!isHost,
    hasSeat: mySeat !== null,
    hasMeetLink: !!room?.room.meetLink,
  });

  useEffect(() => {
    setPeekSent({});
  }, [hand.handId]);

  useEffect(() => {
    if (!watchOpen || !isBankerHere) return;
    api
      .spectateSettings(roomId!)
      .then(setWatchInfo)
      .catch(() => {});
    const loadReqs = () =>
      api
        .joinRequests(roomId!)
        .then((r) => setJoinReqs(r.requests))
        .catch(() => {});
    loadReqs();
    const iv = setInterval(loadReqs, 5000);
    return () => clearInterval(iv);
  }, [watchOpen, isBankerHere, roomId]);

  // Standings refresh whenever the popover or the dialog is showing - and at
  // the end of every hand, which is the only moment the numbers can change.
  useEffect(() => {
    if (!standingsOpen && !rankOpen) return;
    api
      .roomLeaderboard(roomId!)
      .then((r) => setStandings(r.rows))
      .catch(() => setStandings([]));
  }, [standingsOpen, rankOpen, roomId, hand.result, hand.abort]);

  // re-arm the buy-in prompt whenever the broke state resolves (approval landed / stood up)
  useEffect(() => {
    if (!amBroke) setBrokeDismissed(false);
  }, [amBroke]);

  // urgency beep, once per deadline, when it's your turn
  useEffect(() => {
    const key = `${hand.handId}:${hand.deadline}`;
    if (urgent && hand.betting?.toAct === mySeat && beepedUrgent.current !== key) {
      beepedUrgent.current = key;
      play('urgent');
    }
  }, [urgent, hand.betting?.toAct, hand.deadline, hand.handId, mySeat]);

  // phone turn cue: a banner that holds until you act, plus one buzz pattern
  // per new action (carried over from the old mobile table into the merged
  // layout - the desktop turn signal is the pod's turn-glow).
  const [turnCue, setTurnCue] = useState(false);
  const buzzedFor = useRef<string | null>(null);
  const myTurnNow = handLive && hand.betting?.toAct === mySeat;
  useEffect(() => {
    if (!myTurnNow) {
      setTurnCue(false);
      buzzedFor.current = null;
      return;
    }
    setTurnCue(true);
    const key = `${hand.handId}:${hand.actionSeq}`;
    if (isPhone && buzzedFor.current !== key) {
      buzzedFor.current = key;
      try {
        if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
          navigator.vibrate([90, 60, 90]);
        }
      } catch {
        /* haptics are best-effort; never break the table for them */
      }
    }
  }, [myTurnNow, hand.handId, hand.actionSeq, isPhone]);

  // small and big blind seats, derived like the engine does: heads-up the
  // button IS the small blind, otherwise SB is next after the button
  const blinds = useMemo(() => {
    if (hand.buttonSeat === null || hand.seats.length < 2) return { sb: null, bb: null };
    const order = [...hand.seats.map((x) => x.seat)].sort((a, b) => a - b);
    const after = (seat: number) => order[(order.indexOf(seat) + 1) % order.length]!;
    const sb = hand.seats.length === 2 ? hand.buttonSeat : after(hand.buttonSeat);
    return { sb, bb: after(sb) };
  }, [hand.buttonSeat, hand.seats]);

  const seatViews = useMemo((): SeatView[] => {
    if (!room) return [];
    // the chip leader: up the most against their buy-ins right now
    const seated = room.players.filter((p) => p.seat !== null && !p.privateStats);
    const netOf = (p: (typeof seated)[number]) => p.stack - p.totalBought;
    const bestNet = seated.length ? Math.max(...seated.map(netOf)) : 0;
    const leaderId =
      bestNet > 0 ? (seated.find((p) => netOf(p) === bestNet)?.userId ?? null) : null;
    return room.players
      .filter((p) => p.seat !== null)
      .sort((a, b) => a.seat! - b.seat!)
      .map((p) => {
        const engineSeat = hand.betting?.seats.find((s) => s.seat === p.seat);
        const inHand =
          hand.handId !== null && !hand.abort && hand.seats.some((s) => s.seat === p.seat);
        const reveal = hand.showdown?.reveals.find((r) => r.seat === p.seat);
        const delta = hand.result?.deltas.find((d) => d.seat === p.seat)?.delta ?? 0;
        const won = !!hand.result && delta > 0;
        const stackShown = engineSeat && handLive ? engineSeat.stack : p.stack;
        return {
          seat: p.seat!,
          userId: p.userId,
          username: p.username,
          displayName: p.displayName,
          avatarVersion: p.avatarVersion,
          stack: stackShown,
          pendingBuy: p.pendingBuy ?? 0,
          broke: stackShown === 0 && !(handLive && inHand),
          isButton: inHand && hand.buttonSeat === p.seat,
          isSB: inHand && blinds.sb === p.seat,
          isBB: inHand && blinds.bb === p.seat,
          isToAct: handLive && hand.betting?.toAct === p.seat,
          folded: !!engineSeat?.folded,
          allIn: !!engineSeat?.allIn,
          inHand,
          sittingOut: !!p.sittingOut,
          isLeader: p.userId === leaderId,
          connected: p.connected,
          speaking: !!voiceState.speakingByUser[p.userId],
          voiceMuted: !!voiceState.mutedByUser[p.userId],
          revealed: reveal?.cards ?? hand.shown[p.seat!],
          won,
          wonAmount: won ? delta : 0,
          lastAction: hand.lastActions[p.seat!],
          // P2 B2: per-seat bank, in ms. Only present in rooms that run the
          // feature (betting_state carries timeBanks) - seats read it as-is.
          bankMs: hand.timeBanks[p.seat!],
        };
      });
  }, [room, hand, handLive, voiceState, blinds]);

  if (!room) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-5 p-6 text-center">
        {joinError ? (
          <>
            <p className="max-w-sm text-sm text-rose-600">
              {t('Could not join this table: {error}', { error: tr(joinError) })}
            </p>
            <div className="flex gap-2">
              <Button variant="secondary" onClick={() => location.reload()}>
                {t('Try again')}
              </Button>
              <Link to="/lobby">
                <Button>{t('Back to lobby')}</Button>
              </Link>
            </div>
          </>
        ) : (
          <>
            <Spinner label={t('Joining table…')} />
            {joinSlow && (
              <>
                <p className="max-w-sm text-sm text-slate-500">
                  {t(
                    'Still connecting. On free hosting the server sleeps when idle and can take up to a minute to wake. Hang tight, or retry.',
                  )}
                </p>
                <div className="flex gap-2">
                  <Button variant="secondary" onClick={() => location.reload()}>
                    {t('Retry')}
                  </Button>
                  <Link to="/lobby">
                    <Button variant="ghost">{t('Back to lobby')}</Button>
                  </Link>
                </div>
              </>
            )}
          </>
        )}
      </div>
    );
  }

  const pot = hand.betting ? hand.betting.seats.reduce((s, x) => s + x.total, 0) : 0;
  const me = seatViews.find((s) => s.seat === mySeat);
  // players seated but not dealt into the live hand stay hidden until the next deal
  const opponents = seatViews.filter((s) => s.seat !== mySeat && (!handLive || s.inHand));
  const takenSeats = new Set(seatViews.map((s) => s.seat));
  const notInHand = handLive && mySeat !== null && !hand.seats.some((s) => s.seat === mySeat);
  const meSittingOut = !!room.players.find((p) => p.userId === auth.userId)?.sittingOut;
  // feedback #4: the 牌型 line for every pod - yours from the hole cards, a
  // revealed opponent's from their shown ones. Evaluation is the same
  // evaluate5/7 math the recap already runs; this only feeds the seat display.
  const strengthLabels: Record<number, string> = {};
  for (const s of seatViews) {
    const cards = s.seat === mySeat ? hand.myCards : s.revealed;
    if (!cards || cards.length < 2) continue;
    if (!s.inHand && !s.revealed) continue;
    const label = holeStrengthLabel(cards, hand.board);
    if (label) strengthLabels[s.seat] = label;
  }
  // feedback #3: the balance moved out of the deleted bottom box into a small
  // chip above the dock (your on-table stack already rides the seat pod).
  const roomMeRow = room.players.find((p) => p.seat === mySeat);
  const myBought = roomMeRow?.totalBought ?? 0;
  const myNet = (roomMeRow?.stack ?? 0) - myBought;
  const seatName = (seat: number) =>
    seatViews.find((s) => s.seat === seat)?.displayName ?? t('Seat {n}', { n: seat + 1 });

  const disconnectedInHand = handLive
    ? seatViews.filter((s) => s.inHand && !s.folded && !s.connected).map((s) => s.displayName)
    : [];
  const mobileStatus = !handLive
    ? null
    : mySeat !== null && !hand.seats.some((s) => s.seat === mySeat)
      ? t('You are not in this hand. You will be dealt in at the next deal.')
      : disconnectedInHand.length > 0
        ? t('{names} lost connection. Holding the hand for them to rejoin…', {
            names: disconnectedInHand.join(', '),
          })
        : hand.betting
          ? hand.betting.toAct !== null && hand.betting.toAct !== mySeat
            ? t('Waiting for {name}…', {
                name:
                  seatViews.find((s) => s.seat === hand.betting!.toAct)?.displayName ?? t('player'),
              })
            : null
          : t('Shuffling the encrypted deck…');

  const peekAmt = Math.max(1, parseInt(peekAmtStr, 10) || room.room.bb * 5);
  const peekEligible =
    hand.result && !hand.abort
      ? seatViews.filter(
          (v) => v.inHand && v.seat !== mySeat && !v.revealed && !hand.peekResults[v.seat],
        )
      : [];
  const peekReveals = Object.entries(hand.peekResults);
  const hasPeekContent =
    hand.peekOffers.length > 0 ||
    peekReveals.length > 0 ||
    (!!hand.result && peekEligible.length > 0 && mySeat !== null);

  const peekBody = (dark: boolean) => (
    <div className="space-y-2.5">
      {hand.peekOffers.map((o) => (
        <div key={o.offerId} className="flex flex-wrap items-center gap-2 text-sm">
          <span>
            {tNode('{name} offers {amount} to privately see the cards you just had.', {
              name: <b>{o.fromName}</b>,
              amount: <b className="font-display">{fmt(o.amount)}</b>,
            })}
          </span>
          <Button
            variant="success"
            disabled={hand.myCardPoints.length === 0}
            onClick={() => answerPeek(o.offerId, true)}
          >
            {t('Accept {amount}', { amount: fmt(o.amount) })}
          </Button>
          <Button variant="secondary" onClick={() => answerPeek(o.offerId, false)}>
            {t('Decline')}
          </Button>
        </div>
      ))}
      {peekReveals.map(([seat, cards]) => (
        <div key={seat} className="flex flex-wrap items-center gap-2 text-sm">
          <span>{tNode('{name} had', { name: <b>{seatName(+seat)}</b> })}</span>
          {cards.map((c) => (
            <PlayingCard key={c} card={c} size="xs" />
          ))}
          <span className={dark ? 'text-white/50' : 'text-slate-400'}>
            {t('only you can see this')}
          </span>
        </div>
      ))}
      {hand.result && peekEligible.length > 0 && mySeat !== null && (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className={dark ? 'text-white/60' : 'text-slate-500'}>{t('Pay to peek at')}</span>
          {peekEligible.map((v) => (
            <Button
              key={v.seat}
              variant="secondary"
              disabled={!!peekSent[v.seat] || (myRoomStack ?? 0) < peekAmt}
              onClick={() => {
                setPeekSent((m) => ({ ...m, [v.seat]: true }));
                offerPeek(v.seat, peekAmt);
              }}
            >
              {peekSent[v.seat] ? t('Asked {name}', { name: v.displayName }) : v.displayName}
            </Button>
          ))}
          <input
            type="number"
            min={1}
            value={peekAmtStr}
            placeholder={String(room.room.bb * 5)}
            onChange={(e) => setPeekAmtStr(e.target.value)}
            aria-label={t('Peek offer amount')}
            className={cn(
              'w-24 rounded-lg border px-2.5 py-1.5 font-display text-sm',
              dark
                ? 'border-white/20 bg-slate-800 text-white'
                : 'border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-800',
            )}
          />
          <span className={dark ? 'text-white/60' : 'text-slate-400'}>
            {t('chips, paid only if they agree to show you')}
          </span>
        </div>
      )}
    </div>
  );

  const peekPanel = hasPeekContent && <Panel>{peekBody(false)}</Panel>;

  // the reasoning behind the result: who won, with what, over what
  const reasoning = (() => {
    if (!hand.result) return null;
    const nameOf = (seat: number) =>
      seatViews.find((s) => s.seat === seat)?.displayName ??
      hand.seats.find((s) => s.seat === seat)?.username ??
      t('Seat {n}', { n: seat + 1 });
    if (!hand.showdown) {
      const winner = hand.result.deltas.find((d) => d.delta > 0);
      if (!winner) return null;
      return {
        headline: t(
          '{name} takes the pot. Everyone else folded, so no cards had to be shown.',
          { name: nameOf(winner.seat) },
        ),
        winningFive: null,
      };
    }
    const mr = hand.showdown.multiRun;
    if (mr && mr.boards.length > 1) {
      // P2 B4: per-run awards are the truth of who took which slice; the
      // merged per-seat deltas in `hand.result` already include the rake.
      const winnersOf = (aw: { seat: number; amount: number }[]) => {
        const w = aw.filter((a) => a.amount > 0).map((a) => nameOf(a.seat));
        return w.length ? w.join(' & ') : t('chips stayed put');
      };
      const names = mr.awards.map(winnersOf);
      const allSame = names.every((nm) => nm === names[0]);
      return {
        headline: allSame
          ? t('They ran it {n} times - {name} took every run.', {
              n: mr.boards.length,
              name: names[0] ?? '',
            })
          : t('They ran it {n} times. {detail}', {
              n: mr.boards.length,
              detail: mr.awards
                .map((aw, i) => t('Run {n}: {name}', { n: i + 1, name: winnersOf(aw) }))
                .join(' · '),
            }),
        winningFive: null,
      };
    }
    const rt = hand.showdown.runTwice;
    if (rt) {
      const winnersOf = (aw: { seat: number; amount: number }[]) =>
        aw
          .filter((a) => a.amount > 0)
          .map((a) => nameOf(a.seat))
          .join(' & ');
      const w1 = winnersOf(rt.awards[0]);
      const w2 = winnersOf(rt.awards[1]);
      return {
        headline:
          w1 === w2
            ? t('They ran it twice - {name} took both boards.', { name: w1 })
            : t('They ran it twice. {w1} takes run 1, {w2} takes run 2.', { w1, w2 }),
        winningFive: null,
      };
    }
    const ranked = [...hand.showdown.reveals].sort((a, b) => b.score - a.score);
    const top = ranked[0];
    if (!top) return null;
    const tied = ranked.filter((r) => r.score === top.score);
    const runnerUp = ranked.find((r) => r.score < top.score);
    const headline =
      tied.length > 1
        ? t('Split pot: {names} tie with {hand}.', {
            names: tied.map((r) => nameOf(r.seat)).join(t(' and ')),
            hand: tScore(top.score),
          })
        : runnerUp
          ? t("{name} wins with {hand} against {other}'s {theirHand}.", {
              name: nameOf(top.seat),
              hand: tScore(top.score),
              other: nameOf(runnerUp.seat),
              theirHand: tScore(runnerUp.score),
            })
          : t('{name} wins with {hand}.', {
              name: nameOf(top.seat),
              hand: tScore(top.score),
            });
    const winningFive = hand.board.length === 5 ? bestFive([...top.cards, ...hand.board]) : null;
    return { headline, winningFive };
  })();

  const shareData: ShareData | null =
    hand.result && !hand.abort && reasoning
      ? {
          roomName: room.room.name,
          headline: reasoning.headline,
          board: hand.board,
          rows: [...hand.result.deltas]
            .filter((d) => d.delta !== 0)
            .sort((a, b) => b.delta - a.delta)
            .map((d) => {
              const reveal = hand.showdown?.reveals.find((r) => r.seat === d.seat);
              const cards = reveal?.cards ?? hand.shown[d.seat] ?? null;
              const label = reveal
                ? describeScore(reveal.score)
                : cards && hand.board.length === 5
                  ? describeScore(evaluate7([...cards, ...hand.board]))
                  : null;
              return { name: seatName(d.seat), cards, label, delta: d.delta };
            }),
          winningFive: reasoning.winningFive,
        }
      : null;

  // The recap panel is gone: on the 2D table the payoff is told by the cards
  // themselves - a WIN tag on the winner's pod while chips fly off the pot
  // (see WinnerFx / RoundTable). This pill remains for voided
  // hands and for the 3D lounge, whose chrome has no pods of its own. The
  // full story lives in the last-hand strip and in hand history (出牌记录).
  const resultWinners = (hand.result?.deltas ?? []).filter((d) => d.delta > 0);
  const winnersLine = resultWinners.length
    ? resultWinners.map((w) => `${seatName(w.seat)} +${fmt(w.delta)}`).join(' & ')
    : t('chips stayed put');
  const renderFlash = (dark: boolean) => {
    if (!showResult) return null;
    const dismiss = () => setResultDismissed(true);
    if (hand.abort) {
      return (
        <ResultFlash
          dark={dark}
          aborted
          headline={t('Hand aborted')}
          detail={tr(hand.abort.reason)}
          onDismiss={dismiss}
        />
      );
    }
    const winners = (hand.result?.deltas ?? []).filter((d) => d.delta > 0);
    const top = hand.showdown
      ? [...hand.showdown.reveals].sort((a, b) => b.score - a.score)[0]
      : undefined;
    const label = hand.showdown?.multiRun
      ? t('ran it {n} times', { n: Math.max(1, hand.showdown.multiRun.boards.length) })
      : hand.showdown?.runTwice
        ? t('ran it twice')
        : top
          ? tScore(top.score)
          : t('everyone folded');
    const commission = hand.result?.commission ?? 0;
    return (
      <ResultFlash
        dark={dark}
        headline={winners.length ? winnersLine : t('chips stayed put')}
        detail={commission > 0 ? `${label} · ${t('Rake')} ${fmt(commission)}` : label}
        onDismiss={dismiss}
        onShare={shareData ? () => setShareOpen(true) : undefined}
      />
    );
  };

  const spectatorPanel = (
    <Panel className="text-center">
      <p className="flex items-center justify-center gap-2 text-sm font-medium text-slate-600 dark:text-slate-300">
        <Eye size={16} /> {t('You are watching this table.')}
      </p>
      <p className="mt-1 text-xs text-slate-500">
        {t(
          "You can see everything public, but not anyone's cards, the join code, or the chips.",
        )}
      </p>
      <Button
        className="mt-3"
        variant="secondary"
        disabled={askedToJoin}
        onClick={() => {
          setAskedToJoin(true);
          void api.askJoin(roomId!).catch((err) => {
            setAskedToJoin(false);
            useStore
              .getState()
              .pushError(
                err instanceof Error ? err.message : t('Could not ask to join. Try again.'),
              );
          });
        }}
      >
        {askedToJoin ? t('Asked. Waiting for the host to let you in.') : t('Ask to join the game')}
      </Button>
    </Panel>
  );

  const seatPicker = (
    <Panel className="shared-seat-picker">
      <div className="mb-3 text-sm font-medium text-slate-600 dark:text-slate-300">
        {t('Pick a seat')}
      </div>
      <div className="flex flex-wrap gap-2">
        {Array.from({ length: 9 }, (_, i) => (
          <Button
            key={i}
            variant="secondary"
            disabled={takenSeats.has(i) || handLive}
            onClick={() => sit(i)}
          >
            {t('Seat {n}', { n: i + 1 })}
          </Button>
        ))}
      </div>
    </Panel>
  );

  // A6/A7 note: the old mobile-only seat grid and peek sheet are gone; the
  // merged layout reuses the desktop seatPicker Panel and peek Panel as
  // overlays inside the table area on every viewport.

  const utilityGroupLabels: Record<TableUtilityGroupId, string> = {
    people: t('People'),
    records: t('Records'),
    table: t('Table'),
    preferences: t('Preferences'),
  };
  // The switches you touch every hand - and the two record pages (出牌记录,
  // 账本) - live on the top bar itself (TableQuickControls), so the desktop ⋮
  // menu keeps only the remaining secondary items (invite, watch link,
  // standings...). Phones have no room for that strip, so the menu carries the
  // full set there. The 3D lounge chrome - which has no such row - always gets
  // the full set.
  const inlineSurfaced: TableUtilityAction[] = isPhone
    ? []
    : ['auto-deal', 'sit-out', 'timer', 'preferences', 'hands', 'ledger'];
  const desktopMenuGroups = utilityGroups
    .map((group) => ({
      ...group,
      actions: group.actions.filter((action) => !inlineSurfaced.includes(action)),
    }))
    .filter((group) => group.actions.length > 0);
  const utilityItemClass =
    'flex w-full items-center gap-2.5 rounded-xl px-3 py-2.5 text-left text-sm font-medium text-slate-700 transition-colors hover:bg-slate-100 hover:text-slate-950 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-indigo-500 dark:text-slate-200 dark:hover:bg-slate-800 dark:hover:text-white';

  const reportError = (error: unknown) =>
    useStore
      .getState()
      .pushError(
        error instanceof Error
          ? error.message
          : t('That change did not go through. Try again.'),
      );
  const closeUtilityMenu = () => setMenuOpen(false);
  // Phone view controls (A11 + review fix #1): the ⋮ menu carries 3D and
  // fullscreen where the top bar has no room for the icon buttons.
  const fullscreenSupported =
    typeof document !== 'undefined' && 'requestFullscreen' in document.documentElement;
  const toggleFullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void document.documentElement.requestFullscreen().catch(() => {});
  };
  const utilityAction = (action: TableUtilityAction) => {
    switch (action) {
      case 'auto-deal':
        return (
          <button
            type="button"
            role="menuitem"
            className={utilityItemClass}
            onClick={() => {
              closeUtilityMenu();
              setAutoDealOpen(true);
            }}
          >
            <Play size={18} /> {t('Auto-deal')}
            <span className="ml-auto text-xs text-slate-500 dark:text-slate-400">
              {room.room.autoDeal === false ? t('Off') : t('On')}
            </span>
          </button>
        );
      case 'invite':
        return (
          <button
            type="button"
            role="menuitem"
            className={utilityItemClass}
            onClick={() => {
              closeUtilityMenu();
              setInviteOpen(true);
            }}
          >
            <UserPlus size={18} /> {t('Invite friends')}
          </button>
        );
      case 'watch':
        return (
          <button
            type="button"
            role="menuitem"
            className={utilityItemClass}
            onClick={() => {
              closeUtilityMenu();
              setWatchOpen(true);
            }}
          >
            <Eye size={18} /> {t('Watch-only link')}
          </button>
        );
      case 'video':
        return (
          <a
            href={room.room.meetLink!}
            target="_blank"
            rel="noreferrer"
            role="menuitem"
            className={utilityItemClass}
            onClick={closeUtilityMenu}
          >
            <VideoCamera size={18} /> {t('Open video call')}
          </a>
        );
      case 'standings':
        return (
          <button
            type="button"
            role="menuitem"
            className={utilityItemClass}
            onClick={() => {
              closeUtilityMenu();
              setStandingsOpen(true);
            }}
          >
            <Trophy size={18} /> {t('Standings')}
          </button>
        );
      case 'ledger':
        return (
          <Link
            to={`/room/${roomId}/ledger`}
            role="menuitem"
            className={utilityItemClass}
            onClick={closeUtilityMenu}
          >
            <Receipt size={18} /> {t('Ledger')}
          </Link>
        );
      case 'hands':
        return (
          <Link
            to={`/room/${roomId}/hands`}
            role="menuitem"
            className={utilityItemClass}
            onClick={closeUtilityMenu}
          >
            <CardsThree size={18} /> {t('Hand history')}
          </Link>
        );
      case 'sit-out':
        return (
          <button
            type="button"
            role="menuitem"
            className={utilityItemClass}
            onClick={() => {
              if (wsConnected) setSitOut(!meSittingOut);
              closeUtilityMenu();
            }}
          >
            <PauseCircle size={18} />{' '}
            {meSittingOut ? t('Deal me back in') : t('Sit out next hand')}
          </button>
        );
      case 'timer':
        return (
          <label className="flex items-center gap-2.5 rounded-xl px-3 py-2.5 text-sm font-medium text-slate-700 dark:text-slate-200">
            <Timer size={18} />
            <span className="flex-1">{t('Turn timer')}</span>
            <select
              aria-label={t('Turn timer')}
              value={room.room.actionSecs ?? 45}
              disabled={handLive}
              onChange={(event) =>
                void api.roomSettings(roomId!, +event.target.value).catch(reportError)
              }
              className="rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs tabular-nums focus-visible:outline focus-visible:outline-2 focus-visible:outline-indigo-500 dark:border-slate-700 dark:bg-slate-800"
              title={handLive ? t('Applies from the next hand') : undefined}
            >
              {[15, 30, 45, 60, 90, 120].map((seconds) => (
                <option key={seconds} value={seconds}>
                  {t('{n}s', { n: seconds })}
                </option>
              ))}
              <option value={0}>{t('No limit')}</option>
            </select>
          </label>
        );
      case 'preferences':
        return (
          <Link
            to="/settings"
            target="_blank"
            rel="noreferrer"
            role="menuitem"
            className={utilityItemClass}
            onClick={closeUtilityMenu}
          >
            <GearSix size={18} /> {t('Settings')}{' '}
            <span className="sr-only">{t('(opens in a new tab)')}</span>
          </Link>
        );
    }
  };

  // P2 B4: the staged server-authoritative negotiation drives the prompt; the
  // legacy rit_offer (two-board vote) only ever appears from an old server.
  // Every seat - including spectators - gets the banner: it degrades to a
  // read-only status line for anyone who is not the one acting.
  const runTwice =
    hand.multiRunOffer && !hand.result && !hand.abort ? (
      <MultiRunPrompt offer={hand.multiRunOffer} mySeat={mySeat} nameOf={seatName} />
    ) : hand.ritOffer ? (
      <RunTwicePrompt offer={hand.ritOffer} mySeat={mySeat} />
    ) : null;

  // ── P2 feature overlays (B1/B3/B4) ────────────────────────────────────────
  // Badges ride the felt above the board so every view (seat, rest, spectator)
  // reads the same hand-state. All of it derives from server announcements -
  // nothing here invents boards, antes or settlements.
  const feat = hand.featureStarted;
  const bombActive = !!feat?.bombPot?.enabled;
  const bombBeforeFlop = bombActive && handLive && (!hand.betting || hand.betting.street === 'preflop');
  const featureBannerRow = (feat?.squid?.enabled || bombActive) && hand.handId !== null && (
    <div className="z-10 flex flex-wrap items-center justify-center gap-1.5" role="status">
      {bombActive && feat.bombPot && (
        <span className="flex items-center gap-1 rounded-full bg-amber-500 px-2.5 py-1 text-[0.68rem] font-bold text-amber-950 shadow-md">
          <Bomb size={12} weight="fill" />
          {t('Bomb pot · {n}× BB', { n: feat.bombPot.anteBb })}
        </span>
      )}
      {feat?.squid?.enabled && (
        <span className="flex items-center gap-1 rounded-full bg-violet-600 px-2.5 py-1 text-[0.68rem] font-bold text-white shadow-md">
          <Skull size={12} weight="fill" />
          {t('Squid Game · {n}× BB · {p} players', { n: feat.squid.penaltyBb, p: hand.seats.length })}
        </span>
      )}
    </div>
  );
  const bombFeltNote = bombBeforeFlop && (
    <p className="z-10 flex items-center gap-1.5 rounded-full bg-amber-400/90 px-3 py-1 text-xs font-bold text-amber-950 shadow">
      <Bomb size={13} weight="fill" />
      {t('Bomb pot ante posted - straight to the flop.')}
    </p>
  );
  // The negotiated outcome, kept honest by the server's terminal message: the
  // boards below only ever multiply when `multiRunResult.runs` says so.
  const runOutcome = hand.multiRunResult;
  const runOutcomeShown =
    runOutcome !== null &&
    runOutcome.reason !== 'ineligible' &&
    runOutcome.reason !== 'disabled' &&
    (sawRunOfferRef.current === runOutcome.handId || runOutcome.runs > 1);
  const multiRunOutcome =
    handLive && runOutcomeShown && runOutcome ? (
      <p className="z-10 rounded-full bg-white/85 px-3 py-1 text-xs font-bold text-fuchsia-600 shadow-sm ring-1 ring-fuchsia-200/70 dark:bg-slate-900/85 dark:text-fuchsia-300 dark:ring-fuchsia-500/30">
        🔁{' '}
        {runOutcome.runs > 1
          ? t('Dealing {n} runs', { n: runOutcome.runs })
          : runOutcome.reason === 'declined'
            ? t('The ahead player declined - dealt once.')
            : runOutcome.reason === 'timeout'
              ? t('Confirmation timed out - dealt once.')
              : runOutcome.reason === 'equity_failed'
                ? t('Equity did not arrive in time - dealt once.')
                : t('Dealt once.')}
      </p>
    ) : null;
  // B1: the squid settlement is its own money movement - netBySeat is the
  // authoritative per-seat number (a seat can both pay and collect), shown
  // separately from the pot deltas on the pods.
  const squid = hand.squidResult;
  const squidSummary =
    squid !== null && hand.result !== null && !hand.abort ? (
      <div
        role="region"
        aria-label={t('Squid Game settlement')}
        className="z-10 flex max-w-[min(30rem,92%)] flex-col items-center gap-1 rounded-2xl bg-violet-600/90 px-3.5 py-2 text-white shadow-[0_14px_40px_rgba(109,40,217,0.35)]"
      >
        <p className="flex items-center gap-1.5 text-xs font-bold text-white">
          <Skull size={13} weight="fill" /> {t('Squid Game settlement')}
          <span className="font-normal text-violet-200">
            {squid.noClaimant
              ? t('Nobody won every run - no bounty.')
              : t('Bounty {n}', { n: squid.winners.map((w) => seatName(w)).join(t(' and ')) })}
          </span>
        </p>
        <div className="flex flex-wrap items-center justify-center gap-1">
          {(squid.netBySeat ?? []).map((n) => (
            <span
              key={n.seat}
              className={cn(
                'rounded-full px-2 py-0.5 font-display text-[0.68rem] font-bold tabular-nums',
                n.net > 0 ? 'bg-white/20' : n.net < 0 ? 'bg-black/25' : 'bg-white/5 opacity-70',
              )}
            >
              {seatName(n.seat)} {n.net >= 0 ? `+${fmt(n.net)}` : `−${fmt(-n.net)}`}
            </span>
          ))}
        </div>
      </div>
    ) : null;

  // ── host-only dock controls (B1/B3 arming + Lane D dialog) ────────────────
  const dockChip =
    'pointer-events-auto inline-flex items-center gap-1.5 rounded-full bg-white/85 px-3 py-1.5 text-xs font-semibold text-slate-700 shadow-sm ring-1 ring-slate-200/70 backdrop-blur transition-[color,background-color,transform] duration-200 hover:bg-white hover:text-slate-950 active:scale-[0.97] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-500 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-slate-900/80 dark:text-slate-200 dark:ring-slate-700/70 dark:hover:bg-slate-800 dark:hover:text-white';
  const hostGameplay =
    isHost && !amSpectator && features ? (
      <div className="flex flex-wrap items-start gap-1.5">
        {features.squid.enabled && (
          <button
            type="button"
            disabled={handLive || !wsConnected}
            onClick={() => armFeature('squid')}
            title={
              armedTriggers.squid
                ? t('Tap again to cancel the armed Squid Game')
                : t('Trigger Squid Game next hand')
            }
            aria-pressed={!!armedTriggers.squid}
            className={cn(
              dockChip,
              armedTriggers.squid &&
                'bg-violet-100/95 text-violet-700 ring-violet-300 dark:bg-violet-950/80 dark:text-violet-300 dark:ring-violet-700',
            )}
          >
            {armedTriggers.squid ? <X size={15} /> : <Skull size={15} />}
            <span className={isPhone ? 'sr-only' : undefined}>
              {armedTriggers.squid ? t('Squid Game armed') : t('Trigger Squid Game next hand')}
            </span>
          </button>
        )}
        {features.bombPot.enabled && (
          <button
            type="button"
            disabled={handLive || !wsConnected}
            onClick={() => armFeature('bomb')}
            title={
              armedTriggers.bomb
                ? t('Tap again to cancel the armed bomb pot')
                : t('Trigger bomb pot next hand')
            }
            aria-pressed={!!armedTriggers.bomb}
            className={cn(
              dockChip,
              armedTriggers.bomb &&
                'bg-amber-100/95 text-amber-700 ring-amber-300 dark:bg-amber-950/80 dark:text-amber-300 dark:ring-amber-700',
            )}
          >
            {armedTriggers.bomb ? <X size={15} /> : <Bomb size={15} />}
            <span className={isPhone ? 'sr-only' : undefined}>
              {armedTriggers.bomb ? t('Bomb pot armed') : t('Trigger bomb pot next hand')}
            </span>
          </button>
        )}
        {/* phones have no quick-controls strip - the 玩法规则 gear lives here */}
        {isPhone && (
          <button
            type="button"
            onClick={openGameplay}
            title={t('Gameplay rules')}
            className={cn(dockChip, 'text-fuchsia-700 dark:text-fuchsia-300')}
          >
            <Sliders size={15} />
            <span className="sr-only">{t('Gameplay rules')}</span>
          </button>
        )}
      </div>
    ) : null;
  const sharedDialogs = (
    <>
      <AutoDealDialog open={autoDealOpen} onClose={() => setAutoDealOpen(false)} />
      {features && (
        <GameplaySettingsDialog
          roomId={roomId!}
          features={features}
          open={gameplayOpen}
          onOpenChange={setGameplayOpen}
          onSaved={setFeatures}
        />
      )}
      <BrokeBuyInDialog
        roomId={roomId!}
        open={amBroke && !brokeDismissed}
        onClose={() => setBrokeDismissed(true)}
      />
      <ShareHandDialog open={shareOpen} onClose={() => setShareOpen(false)} data={shareData} />
      <Dialog
        open={inviteOpen}
        onClose={() => setInviteOpen(false)}
        title={t('Invite friends to this table')}
      >
        <div className="space-y-5">
          {room.room.joinCode !== '' && (
            <ShareRoom joinCode={room.room.joinCode} roomName={room.room.name} />
          )}
          <div className="border-t border-slate-200/70 pt-4 dark:border-slate-700/70">
            <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-slate-400">
              {t('Or invite a friend directly')}
            </p>
            <InviteFriendsDialogBody
              roomId={roomId!}
              memberIds={room.players.map((p) => p.userId)}
            />
          </div>
        </div>
      </Dialog>
      <Dialog
        open={watchOpen}
        onClose={() => setWatchOpen(false)}
        title={t('Watch-only share link')}
      >
        <div className="space-y-4">
          <label className="flex items-start gap-2 text-sm text-slate-600 dark:text-slate-300">
            <input
              type="checkbox"
              checked={watchInfo?.allow ?? false}
              onChange={(e) =>
                void api
                  .spectateSettings(roomId!, e.target.checked)
                  .then(setWatchInfo)
                  .catch(reportError)
              }
              className="mt-0.5"
            />
            <span>
              {t(
                'Let anyone with the link watch this table. Viewers see the public game only: no hole cards, no join code, no chips of their own.',
              )}
            </span>
          </label>
          {watchInfo && (
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded-lg bg-slate-100 px-3 py-2 text-xs dark:bg-slate-800">
                {`${location.origin}/watch/${watchInfo.token}`}
              </code>
              <Button
                variant="secondary"
                onClick={() =>
                  void navigator.clipboard.writeText(`${location.origin}/watch/${watchInfo.token}`)
                }
              >
                {t('Copy')}
              </Button>
            </div>
          )}
          {joinReqs.length > 0 && (
            <div className="space-y-2">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">
                {t('Watchers asking to play')}
              </p>
              {joinReqs.map((r) => (
                <div
                  key={r.id}
                  className="flex items-center gap-3 rounded-xl bg-slate-50 p-2.5 dark:bg-slate-800/60"
                >
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">
                    {r.displayName}
                  </span>
                  <Button
                    variant="success"
                    onClick={() =>
                      void api
                        .admit(roomId!, r.userId, true)
                        .then(() => setJoinReqs((q) => q.filter((x) => x.id !== r.id)))
                        .catch(reportError)
                    }
                  >
                    {t('Let them in')}
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={() =>
                      void api
                        .admit(roomId!, r.userId, false)
                        .then(() => setJoinReqs((q) => q.filter((x) => x.id !== r.id)))
                        .catch(reportError)
                    }
                  >
                    {t('No')}
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>
      </Dialog>
      <Dialog
        open={standingsOpen}
        onClose={() => setStandingsOpen(false)}
        title={t('Room standings')}
        size="lg"
      >
        {standings === null ? (
          <Spinner label={t('Counting the chips…')} />
        ) : standings.length === 0 ? (
          <p className="text-sm text-slate-500">{t('No completed hands yet. Deal one and check back.')}</p>
        ) : (
          <LeaderboardTable rows={standings} minHands={room.room.minSettleHands} />
        )}
      </Dialog>

      {/* connection state */}
      {room && !wsConnected && (
        <div className="fixed left-1/2 top-3 z-50 -translate-x-1/2 rounded-full bg-amber-500 px-4 py-1.5 text-xs font-semibold text-white shadow-lg">
          {t('Connection lost. Reconnecting…')}
        </div>
      )}

      {/* error toasts */}
      {errors.length > 0 && (
        <div className="fixed bottom-4 left-4 z-50 rounded-xl bg-slate-900 px-4 py-2.5 text-sm text-white shadow-lg dark:bg-slate-100 dark:text-slate-900">
          {errors[0]}
        </div>
      )}
    </>
  );

  if (renderTable) {
    const standUp = (userId: number) => {
      if (!isBankerHere || !wsConnected || userId === auth.userId) return;
      void api
        .standUp(roomId!, userId)
        .catch((err) =>
          useStore
            .getState()
            .pushError(err instanceof Error ? err.message : tr('Could not stand them up')),
        );
    };
    return (
      <div className="table3d-experience">
        {renderTable({
          menuOpen,
          setMenuOpen,
          chatOpen,
          setChatOpen,
          unreadChat,
          utilities: (
            <div role="menu" aria-label={t('Table controls')}>
              {utilityGroups.map((group) => (
                <section
                  key={group.id}
                  className="table-utility-group"
                  aria-label={utilityGroupLabels[group.id]}
                >
                  <h3>{utilityGroupLabels[group.id]}</h3>
                  {group.actions.map((action) => (
                    <div key={action} role="none">
                      {utilityAction(action)}
                    </div>
                  ))}
                </section>
              ))}
            </div>
          ),
          voiceControl: (
            <DesktopIconButton
              label={
                voiceState.joined
                  ? voiceState.muted
                    ? t('Unmute voice')
                    : t('Mute voice')
                  : t('Join voice')
              }
              onClick={() => (voiceState.joined ? voice.toggleMute() : void voice.join())}
              active={voiceState.joined && !voiceState.muted}
            >
              {voiceState.joined && voiceState.muted ? (
                <MicrophoneSlash size={19} />
              ) : (
                <Microphone size={19} />
              )}
            </DesktopIconButton>
          ),
          fullscreenControl: (
            <DesktopIconButton
              label={isFullscreen ? t('Exit full screen') : t('Full screen')}
              onClick={() => {
                const change = document.fullscreenElement
                  ? document.exitFullscreen()
                  : document.documentElement.requestFullscreen();
                void change.catch(() =>
                  useStore.getState().pushError(t('Full screen is unavailable in this browser.')),
                );
              }}
              active={isFullscreen}
            >
              {isFullscreen ? <CornersIn size={19} /> : <CornersOut size={19} />}
            </DesktopIconButton>
          ),
          seatPicker: mySeat === null ? (amSpectator ? spectatorPanel : seatPicker) : null,
          peekPanel,
          runTwice,
          gameplay: (
            <>
              {featureBannerRow}
              {bombFeltNote}
              {multiRunOutcome}
              {squidSummary}
            </>
          ),
          status: mobileStatus,
          amSpectator,
          players: seatViews,
          canManagePlayers: !!isBankerHere,
          standUp,
          showResult: () => setResultDismissed(false),
          showLargeCards: () => {
            setBigCards(true);
            localStorage.setItem('4am-big-cards', 'on');
          },
        })}
        {sharedDialogs}
        <Dialog open={chatOpen} onClose={() => setChatOpen(false)} title={t('Table chat')}>
          <fieldset disabled={!wsConnected} className="h-[min(60dvh,36rem)] min-h-0">
            <ChatPanel chrome={false} />
          </fieldset>
        </Dialog>
        {showResult && (
          <div className="lounge-result-overlay" role="region" aria-label={t('Hand result')}>
            {renderFlash(true)}
          </div>
        )}
        {bigCards && hand.myCards.length > 0 && !notInHand && (
          <FloatingCards
            bounded
            cards={hand.myCards}
            onClose={() => {
              setBigCards(false);
              localStorage.setItem('4am-big-cards', 'off');
            }}
          />
        )}
      </div>
    );
  }

  // P1 merged table layout (docs/table-redesign-spec.md): ONE consolidated
  // 牌桌区 for desktop and phone alike. The old right column (standings dock +
  // chat) and the old bottom bar are gone: rankings/chat are dock buttons with
  // popovers (A6), status/balance/shortcuts ride inside the table area (A7),
  // sit-out anchors bottom-left (A9), and the oval is a fixed-aspect canvas
  // that scales instead of stretching (A1/A2/A3).
  return (
    <div
      className="table-app-bg flex h-[calc(100dvh-60px)] min-h-[30rem] flex-col gap-2 overflow-hidden p-2 md:h-[calc(100dvh-65px)] md:gap-2.5 md:p-3"
      style={{ paddingTop: 'calc(env(safe-area-inset-top) + 0.5rem)' }}
    >
      {/* ── compact top bar (A11) ─────────────────────────────────────────── */}
      <header className="flex h-12 shrink-0 items-center gap-2 rounded-xl bg-white/80 px-2 shadow-[0_10px_30px_rgba(15,23,42,0.06)] ring-1 ring-slate-200/70 dark:bg-slate-950/70 dark:ring-slate-800">
        <Link
          to="/lobby"
          className={desktopIconClass}
          aria-label={t('Leave table')}
          title={t('Leave table')}
        >
          <ArrowLeft size={19} weight="bold" />
        </Link>
        <div className="min-w-0 flex-1 md:flex-none md:pr-2">
          <h1 className="truncate font-display text-sm font-semibold tracking-[-0.02em] md:text-base">
            {room.room.name}
          </h1>
          {/* A1: below the layout minimum this line drops out; the code is
              always one tap away via the room name / invite dialog */}
          {/* cosmetic refinement (review fix #3): the meta line needs slack
              room (1440); the HARD icon-only degradation is compactBar (<1280) */}
          {viewportW >= 1440 && (
            <div className="mt-0.5 flex items-center gap-2 text-[0.68rem] text-slate-500">
              {room.room.joinCode !== '' && (
                <button
                  type="button"
                  onClick={() => setInviteOpen(true)}
                  title={t("Copy or share this table's invite link")}
                  className="font-display font-semibold tracking-[0.16em] text-indigo-600 hover:underline dark:text-indigo-300"
                >
                  {room.room.joinCode}
                </button>
              )}
              <span>{t('blinds {sb}/{bb}', { sb: room.room.sb, bb: room.room.bb })}</span>
              <span className="flex items-center gap-1" title={t('Seated players / in this hand')}>
                <UsersThree size={13} /> {seatViews.length}
                {handLive ? ` · ${t('{n} in hand', { n: hand.seats.length })}` : ''}
              </span>
            </div>
          )}
        </div>

        {room.room.auditMode === 'strict-audit' && <Badge tone="amber">{t('strict audit')}</Badge>}
        {room.room.voided && (
          <span title={t('The banker voided this table: results do not count anywhere')}>
            <Badge tone="rose">{t('void table')}</Badge>
          </span>
        )}
        {handLive && hand.deadline !== null && (
          <CountdownChip deadline={hand.deadline} urgent={urgent} />
        )}

        <div className="ml-auto flex flex-nowrap items-center justify-end gap-1">
          <BankControls roomId={roomId!} mode="hub" compact={isPhone || compactBar} />
          {/* phones trade the switch strip for the ⋮ menu so the bar never
              wraps (A1); desktop keeps the chips, icon-only when tight */}
          {!isPhone && (
            <TableQuickControls
              roomId={roomId!}
              isHost={!!isHost}
              autoDeal={room.room.autoDeal !== false}
              autoDealPaused={!!room.autoDealPaused}
              actionSecs={room.room.actionSecs ?? 45}
              timerDisabled={handLive}
              amSpectator={amSpectator}
              compact={compactBar}
              onChangeAutoDeal={(value) => void api.setAutoDeal(roomId!, value).catch(reportError)}
              onOpenAutoDealDialog={() => setAutoDealOpen(true)}
              onChangeActionSecs={(seconds) =>
                void api.roomSettings(roomId!, seconds).catch(reportError)
              }
              onOpenGameplay={isHost && features ? openGameplay : undefined}
            />
          )}
          <DesktopIconButton
            label={
              voiceState.joined
                ? voiceState.muted
                  ? t('Unmute voice')
                  : t('Mute voice')
                : t('Join voice')
            }
            onClick={() => (voiceState.joined ? voice.toggleMute() : void voice.join())}
            className={cn(
              voiceState.joined &&
                !voiceState.muted &&
                '!bg-emerald-100 !text-emerald-700 dark:!bg-emerald-950 dark:!text-emerald-300',
              voiceState.joined &&
                voiceState.muted &&
                '!bg-rose-100 !text-rose-700 dark:!bg-rose-950 dark:!text-rose-300',
            )}
          >
            {voiceState.joined && voiceState.muted ? (
              <MicrophoneSlash size={19} weight="bold" />
            ) : (
              <Microphone size={19} weight={voiceState.joined ? 'bold' : 'regular'} />
            )}
          </DesktopIconButton>
          {/* the dock owns chat/rankings on phones; the bar mirrors the chat
              popover on wider screens where there is room for it */}
          {!isPhone && (
            <DesktopIconButton
              label={
                unreadChat > 0
                  ? t('Toggle chat, {n} unread messages', { n: unreadChat })
                  : t('Toggle chat')
              }
              onClick={toggleChat}
              active={chatOpen}
              badge={unreadChat}
            >
              <ChatCircle size={20} weight={chatOpen ? 'fill' : 'regular'} />
            </DesktopIconButton>
          )}

          {!isPhone && (
            <Link
              to={`/room/${roomId}/3d`}
              className={desktopIconClass}
              aria-label={t('3D table')}
              title={t('3D table')}
            >
              <Cube size={19} />
            </Link>
          )}
          {!isPhone && (
            <DesktopIconButton
              label={isFullscreen ? t('Exit full screen') : t('Full screen')}
              onClick={toggleFullscreen}
              active={isFullscreen}
            >
              {isFullscreen ? <CornersIn size={19} /> : <CornersOut size={19} />}
            </DesktopIconButton>
          )}

          <div className="relative">
            <DesktopIconButton
              label={t('More table controls')}
              onClick={() => setMenuOpen((open) => !open)}
              active={menuOpen}
              hasPopup
              expanded={menuOpen}
              buttonRef={desktopMenuTriggerRef}
            >
              <DotsThreeVertical size={20} weight="bold" />
            </DesktopIconButton>
            {menuOpen && (
              <>
                <button
                  className="fixed inset-0 z-20 cursor-default"
                  aria-label={t('Close table controls')}
                  onClick={() => setMenuOpen(false)}
                />
                <div
                  ref={desktopMenuRef}
                  role="menu"
                  aria-label={t('Table controls')}
                  className="absolute right-0 top-12 z-30 max-h-[70vh] w-72 max-w-[calc(100vw-1rem)] overflow-y-auto rounded-2xl bg-white p-2 shadow-[0_20px_60px_rgba(15,23,42,0.18)] ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-700"
                >
                  {desktopMenuGroups.map((group, index) => (
                    <div
                      key={group.id}
                      role="group"
                      aria-label={utilityGroupLabels[group.id]}
                      className={cn(
                        index > 0 && 'mt-1 border-t border-slate-100 pt-1 dark:border-slate-800',
                      )}
                    >
                      <div className="px-3 pb-1 pt-2 text-[0.64rem] font-semibold uppercase tracking-[0.14em] text-slate-400 dark:text-slate-500">
                        {utilityGroupLabels[group.id]}
                      </div>
                      {group.actions.map((action) => (
                        <div key={action} role="none">
                          {utilityAction(action)}
                        </div>
                      ))}
                    </div>
                  ))}
                  {/* review fix #1: phones keep 3D + fullscreen reachable via ⋮ */}
                  {isPhone && (
                    <div
                      role="group"
                      aria-label={t('View')}
                      className="mt-1 border-t border-slate-100 pt-1 dark:border-slate-800"
                    >
                      <div className="px-3 pb-1 pt-2 text-[0.64rem] font-semibold uppercase tracking-[0.14em] text-slate-400 dark:text-slate-500">
                        {t('View')}
                      </div>
                      <Link
                        to={`/room/${roomId}/3d`}
                        role="menuitem"
                        className={utilityItemClass}
                        onClick={closeUtilityMenu}
                      >
                        <Cube size={18} /> {t('3D table')}
                      </Link>
                      <button
                        type="button"
                        role="menuitem"
                        className={cn(utilityItemClass, !fullscreenSupported && 'opacity-50')}
                        disabled={!fullscreenSupported}
                        onClick={() => {
                          toggleFullscreen();
                          closeUtilityMenu();
                        }}
                        title={
                          fullscreenSupported
                            ? isFullscreen
                              ? t('Exit full screen')
                              : t('Full screen')
                            : t('Full screen is unavailable in this browser.')
                        }
                      >
                        {isFullscreen ? <CornersIn size={18} /> : <CornersOut size={18} />}{' '}
                        {isFullscreen ? t('Exit full screen') : t('Full screen')}
                        {!fullscreenSupported && (
                          <span className="ml-auto text-xs text-slate-500 dark:text-slate-400">
                            {t('Not available')}
                          </span>
                        )}
                      </button>
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      </header>

      {/* ── the one table area (A7: no separate bottom bar) ───────────────── */}
      <section
        aria-label={t('Poker board')}
        className="relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-[1.5rem] bg-slate-200/60 ring-1 ring-slate-200 dark:bg-slate-900/60 dark:ring-slate-800 md:rounded-[2rem]"
      >
        {showResult && hand.abort && (
          <div
            className="pointer-events-none absolute inset-x-0 top-2 z-20 flex justify-center px-4"
            role="region"
            aria-label={t('Hand result')}
          >
            {renderFlash(false)}
          </div>
        )}
        {showResult && !hand.abort && hand.result && (
          <p className="sr-only" role="status" aria-live="polite">
            {winnersLine}
          </p>
        )}
        {floats.map((reaction) => (
          <span
            key={reaction.id}
            className="animate-float pointer-events-none absolute top-1/3 z-10 text-5xl"
            style={{ left: `${reaction.left}%` }}
          >
            {reaction.emoji}
          </span>
        ))}
        {/* phone turn cue: banner + buzz, the merged layout's "your turn" */}
        {isPhone && turnCue && (
          <motion.div
            key="turn-cue"
            role="status"
            aria-live="assertive"
            initial={{ y: -20, opacity: 0, scale: 0.92 }}
            animate={{ y: 0, opacity: 1, scale: 1 }}
            exit={{ y: -14, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 460, damping: 26 }}
            className="fixed inset-x-0 top-[3.6rem] z-50 mx-auto flex w-max items-center gap-2.5 rounded-2xl bg-gradient-to-b from-amber-300 to-amber-400 px-5 py-2.5 text-slate-950 shadow-[0_10px_34px_rgba(251,191,36,0.5)] ring-2 ring-amber-200/80"
          >
            <span className="relative flex h-2.5 w-2.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-slate-900/60 motion-reduce:animate-none" />
              <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-slate-900" />
            </span>
            <span className="font-display text-base font-black tracking-wide">
              {t('Your turn.')}
            </span>
          </motion.div>
        )}

        {/* the stage: a fixed-aspect oval that scales to fit - down to a
            readability floor, past which the stage itself scrolls (RoundTable).
            On phones the canvas is lifted above the betting widget + dock. */}
        <div className="relative min-h-[8rem] flex-1">
          <div
            className={cn(
              'h-full min-h-0',
              notInHand && 'opacity-60 saturate-50',
              isPhone && 'pb-[10.5rem]',
            )}
          >
          <RoundTable
            narrow={isPhone}
            seats={seatViews}
            mySeat={mySeat}
            myUserId={auth.userId}
            myCards={hand.myCards}
            committedBySeat={Object.fromEntries(
              (hand.betting?.seats ?? []).map((s) => [s.seat, s.committed]),
            )}
            urgent={urgent}
            handLive={handLive}
            canSit={mySeat === null && !amSpectator}
            onSit={sit}
            canKick={isBankerHere}
            onKick={(userId) =>
              void api
                .standUp(roomId!, userId)
                .catch((err) =>
                  useStore
                    .getState()
                    .pushError(
                      err instanceof Error ? err.message : tr('could not stand them up'),
                    ),
                )
            }
            bankerId={room.room.bankerId}
            hostId={room.room.hostId}
            coBankerId={room.room.coBankerId}
            bb={room.room.bb}
            readyCheck={!handLive ? hand.readyCheck : null}
            onShareHand={shareData ? () => setShareOpen(true) : undefined}
            handTypes={strengthLabels}
          >
            {/* A5: pot - transparent background, chip pile + number beside it,
                centered directly above the cards area */}
            <div className="flex items-center justify-center" title={t('POT')}>
              <span className="sr-only">{t('POT')}</span>
              <motion.div
                key={pot}
                initial={pot > 0 ? { scale: 1.12 } : false}
                animate={{ scale: 1 }}
                transition={{ type: 'spring', stiffness: 320, damping: 18 }}
                className="flex items-center gap-2"
              >
                {pot > 0 ? (
                  <ChipStack amount={pot} bb={room.room.bb} size={isPhone ? 'lg' : 'sm'} />
                ) : (
                  <Coins size={16} weight="duotone" className="text-slate-400 dark:text-slate-500" />
                )}
                <span
                  className={cn(
                    'font-display font-semibold tabular-nums text-slate-700 drop-shadow-[0_1px_2px_rgba(255,255,255,0.75)] dark:text-slate-200 dark:drop-shadow-[0_1px_3px_rgba(0,0,0,0.85)]',
                    isPhone ? 'text-lg' : 'text-base',
                  )}
                >
                  <NumberFlow value={pot} />
                </span>
              </motion.div>
            </div>
            {/* the felt keeps its layout while a result flashes over it */}
            <>
              {featureBannerRow}
              {bombFeltNote}
              {runTwice}
              <div className="flex flex-col items-center gap-2">
                {(() => {
                  // P2 B4: render hand.boards - run 1 owns the felt's geometry
                  // as before; run 2 / run 3 grow underneath, compact (md
                  // cards + a small 「第 N 跑」 label).
                  const runs = hand.boards.length > 0 ? hand.boards : [hand.board];
                  const [first, ...rest] = runs;
                  return (
                    <>
                      <div
                        className={cn(
                          'flex items-center justify-center',
                          isPhone ? 'gap-1' : 'gap-2.5',
                        )}
                      >
                        {[0, 1, 2, 3, 4].map((index) =>
                          first![index] !== undefined ? (
                            <PlayingCard
                              key={`${index}-${first![index]}`}
                              card={first![index]}
                              size={isPhone ? 'md' : 'table'}
                              deal
                              // the three flop cards land together, so cascade them; the
                              // turn and river arrive alone and flip immediately
                              dealDelay={first!.length === 3 ? index * 0.16 : 0}
                            />
                          ) : (
                            <div
                              key={index}
                              className={cn(
                                'border-2 border-dashed border-slate-300/80 dark:border-slate-700',
                                isPhone ? 'h-24 w-[4.2rem] rounded-xl' : 'h-36 w-24 rounded-2xl',
                              )}
                              role="img"
                              aria-label={t('Empty community card {n}', { n: index + 1 })}
                            />
                          ),
                        )}
                      </div>
                      {rest.map((run, runIdx) =>
                        run.length === 0 ? null : (
                          <div key={`run-${runIdx}`} className="flex items-center justify-center gap-1">
                            <span className="rounded-full bg-fuchsia-500/15 px-2 py-0.5 text-[0.65rem] font-bold uppercase tracking-wide text-fuchsia-500">
                              {t('Run {n}', { n: runIdx + 2 })}
                            </span>
                            {run.map((card, i) => (
                              <PlayingCard key={`r${runIdx}-${card}`} card={card} size="md" deal />
                            ))}
                          </div>
                        ),
                      )}
                    </>
                  );
                })()}
              </div>
              {multiRunOutcome}
              {squidSummary}
              {notInHand && (
                <p className="rounded-xl bg-white/90 px-4 py-2 text-sm font-semibold text-slate-600 shadow-sm dark:bg-slate-800/90 dark:text-slate-300">
                  {t("You're in the next hand.")}
                </p>
              )}
              {!handLive && opponents.length === 0 && !amSpectator && (
                <button
                  type="button"
                  onClick={() => setInviteOpen(true)}
                  className="flex items-center gap-2 rounded-full bg-white/80 px-4 py-1.5 text-xs font-semibold text-slate-600 ring-1 ring-slate-200/70 hover:text-slate-900 dark:bg-slate-900/80 dark:text-slate-300 dark:ring-slate-700/70 dark:hover:text-slate-100"
                >
                  <UserPlus size={15} /> {t('Invite friends')} · {t('code')}{' '}
                  <span className="font-display text-indigo-600 dark:text-indigo-300">
                    {room.room.joinCode}
                  </span>
                </button>
              )}
            </>
          </RoundTable>
          </div>

          {/* v3 feedback #7b: the deal command post lives in the open top-right
              corner, never on the felt (where the board rows pushed it below
              the fold). Host sees 「准备好就发牌」 + an always-reachable 发牌
              button - click beats the auto-deal dwell outright (7a) - plus the
              countdown to the next ready check. */}
          {!handLive && mySeat !== null && isHost && (
            <div className="absolute right-2 top-2 z-30 flex w-36 flex-col items-stretch gap-1.5 rounded-2xl bg-white/92 p-2.5 text-center shadow-[0_10px_30px_rgba(15,23,42,0.12)] ring-1 ring-slate-200/70 backdrop-blur dark:bg-slate-900/88 dark:ring-slate-700/70 md:w-40">
              <p className="text-xs font-semibold text-slate-700 dark:text-slate-200">
                {opponents.length === 0 ? t('Invite a friend to deal.') : t('Deal when ready.')}
              </p>
              {opponents.length > 0 && (
                <Button disabled={!wsConnected} className="w-full" onClick={startHand}>
                  <Play size={16} weight="fill" /> {t('Deal hand')}
                </Button>
              )}
              <AutoDealClock autoDealAt={hand.autoDealAt} />
            </div>
          )}

          {/* feedback #3: the last-hand recap floats over the top-left of the
              felt now - the standalone bottom panel is gone. It stops short of
              the deal corner so the two never share a row on phones. */}
          <div className="pointer-events-none absolute inset-x-2 top-1 z-20 flex justify-start [&_a]:pointer-events-auto [&_button]:pointer-events-auto">
            <div className="w-[min(23rem,calc(100%-9.5rem))]">
              <LastHandStrip roomId={roomId!} />
            </div>
          </div>

          {/* seat picker / spectator notice / buy-peek, as floating cards */}
          {(!me || peekPanel) && (
            <div className="pointer-events-none absolute inset-x-0 top-1 z-20 flex flex-col items-center gap-2 px-2">
              {!me && (
                <div className="pointer-events-auto w-[min(26rem,96%)]">
                  {amSpectator ? spectatorPanel : seatPicker}
                </div>
              )}
              {peekPanel && (
                <div className="pointer-events-auto w-[min(40rem,96%)]">{peekPanel}</div>
              )}
            </div>
          )}

          {/* popover click-away: over the felt only - the action bar stays
              usable while a dock popover is open */}
          {(rankOpen || chatOpen) && (
            <button
              className="absolute inset-0 z-20 cursor-default"
              aria-label={t('Close table controls')}
              onClick={closeDockPopovers}
            />
          )}

          {/* A8 (GGPoker ref, user feedback #5): the betting area is now a
              compact widget anchored bottom-right of the table area - % pills,
              slider + amount (chips and BB), big action buttons, action-clock
              ring. The old full-width bottom box is gone. */}
          <fieldset
            disabled={!wsConnected}
            className="absolute bottom-2 right-2 z-30 m-0 min-w-0 border-0 p-0 md:bottom-3 md:right-3"
          >
            <BettingPanel
              mySeat={mySeat}
              isHost={!!isHost}
              urgent={urgent}
              hideIdleStart
            />
          </fieldset>

          {/* A6 + A9: rankings / chat popovers, sit-out, shortcuts button and
              the balance chip - bottom-left, and on top of everything docked */}
          <TableDock
            compact={isPhone || compactBar}
            hostGameplay={hostGameplay}
            hasSeat={mySeat !== null}
            sittingOut={meSittingOut}
            sitOutDisabled={!wsConnected}
            onToggleSitOut={() => {
              if (wsConnected) setSitOut(!meSittingOut);
            }}
            rankOpen={rankOpen}
            onToggleRank={toggleRank}
            onClosePopovers={closeDockPopovers}
            standings={standings}
            minSettleHands={room.room.minSettleHands}
            chatOpen={chatOpen}
            onToggleChat={toggleChat}
            unread={unreadChat}
            chatBody={
              <fieldset disabled={!wsConnected} className="h-full min-h-0">
                <ChatPanel chrome={false} />
              </fieldset>
            }
            balance={
              me ? (
                <div
                  title={t('Your balance. Bought {n} total.', { n: fmt(myBought) })}
                  className="inline-flex items-center gap-1.5 rounded-full bg-white/85 px-3 py-1.5 font-display text-xs font-bold text-slate-800 shadow-sm ring-1 ring-slate-200/70 backdrop-blur dark:bg-slate-900/80 dark:text-slate-100 dark:ring-slate-700/70"
                >
                  <Wallet
                    size={14}
                    weight="fill"
                    className="shrink-0 text-amber-500"
                    aria-label={t('Your balance')}
                  />
                  <NumberFlow value={me.stack} />
                  {myBought > 0 && (
                    <span
                      className={cn(
                        'text-[0.65rem]',
                        myNet >= 0
                          ? 'text-emerald-600 dark:text-emerald-400'
                          : 'text-rose-600 dark:text-rose-400',
                      )}
                    >
                      {myNet >= 0 ? `+${fmt(myNet)}` : `−${fmt(-myNet)}`}
                    </span>
                  )}
                </div>
              ) : null
            }
            shortcut={
              <div className="inline-flex items-center rounded-full bg-white/85 p-0.5 shadow-sm ring-1 ring-slate-200/70 backdrop-blur dark:bg-slate-900/80 dark:ring-slate-700/70">
                <PokerShortcutButton className="!text-slate-700 dark:!text-slate-200" />
              </div>
            }
          />
        </div>
      </section>

      {sharedDialogs}
    </div>
  );
}
