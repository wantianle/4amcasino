import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { AutoDealDialog } from '../../features/table/AutoDealDialog.tsx';
import { pokerOverlayOpen } from '../../features/table/pokerHotkeys.ts';
import { motion } from 'motion/react';
import {
  ArrowLeft,
  CaretDown,
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
  Timer,
  Trophy,
  UserPlus,
  VideoCamera,
  X,
} from '@phosphor-icons/react';
import NumberFlow from '@number-flow/react';
import confetti from 'canvas-confetti';
import {
  bestFive,
  describeScore,
  evaluate7,
} from '@4am/shared';
import {
  answerPeek,
  bindGameClient,
  offerPeek,
  ritVote,
  setSitOut,
  sit,
  startHand,
} from '../../shared/gameClient.ts';
import { wsClient } from '../../shared/ws.ts';
import { useStore } from '../../shared/store.ts';
import { api } from '../../shared/api.ts';
import { voice } from '../../shared/voice.ts';
import { play } from '../../shared/sounds.ts';
import { cn, fmt } from '../../shared/lib/cn.ts';
import { t, tr } from '../../shared/i18n/index.ts';
import { tNode } from '../../shared/i18n/trans.tsx';
import { tScore } from '../../shared/i18n/pokerLabels.ts';
import { Badge, Button, Dialog, Panel, Spinner } from '../../shared/ui/index.tsx';
import { PlayingCard } from '../../entities/card/PlayingCard.tsx';
import { PlayerRow, YouRow, type SeatView } from '../../widgets/table/players.tsx';
import { ActionBar } from '../../widgets/table/ActionBar.tsx';
import { ChatPanel } from '../../widgets/table/ChatPanel.tsx';
import { MobileTable } from '../../widgets/table/MobileTable.tsx';
import { RoundTable } from '../../widgets/table/RoundTable.tsx';
import { FloatingCards } from '../../widgets/table/FloatingCards.tsx';
import { ChipStack } from '../../widgets/table/ChipStack.tsx';
import { BankControls } from '../../widgets/table/BankControls.tsx';
import { LastHandStrip } from '../../widgets/table/LastHandStrip.tsx';
import { ResultFlash } from '../../widgets/table/ResultFlash.tsx';
import { TableQuickControls } from '../../widgets/table/TableQuickControls.tsx';
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

interface FloatingReaction {
  id: number;
  emoji: string;
  left: number;
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
  status: string | null;
  amSpectator: boolean;
  players: SeatView[];
  canManagePlayers: boolean;
  standUp: (userId: number) => void;
  showResult: () => void;
  showLargeCards: () => void;
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
  const [chatOpen, setChatOpen] = useState(!renderTable);
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
  const [peekAmtStr, setPeekAmtStr] = useState('');
  const [peekSent, setPeekSent] = useState<Record<number, boolean>>({});
  const [shareOpen, setShareOpen] = useState(false);
  const [standingsOpen, setStandingsOpen] = useState(false);
  // the docked copy is collapsible and remembers itself, like the last-hand strip
  const [standingsDockOpen, setStandingsDockOpen] = useState(
    () => localStorage.getItem('4am-standings-dock') !== 'off',
  );
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
  const desktopChatCloseRef = useRef<HTMLButtonElement>(null);
  const desktopChatDrawerRef = useRef<HTMLElement>(null);
  const desktopChatTriggerRef = useRef<HTMLButtonElement>(null);
  const desktopMenuRef = useRef<HTMLDivElement>(null);
  const desktopMenuTriggerRef = useRef<HTMLButtonElement>(null);
  const now = useNow();
  // lightning on every showdown reveal; keyed so back-to-back hands re-flash
  const [thunderKey, setThunderKey] = useState(0);
  useEffect(() => {
    const boom = () => setThunderKey((k) => k + 1);
    window.addEventListener('4am-thunder', boom);
    return () => window.removeEventListener('4am-thunder', boom);
  }, []);
  const unreadChat = unreadChatCount(chat.length, chatSeenCount, chatOpen);

  useEffect(() => {
    if (!chatOpen) return;
    setChatSeenCount(chat.length);
  }, [chatOpen, chat.length]);

  useEffect(() => {
    if (!chatOpen || renderTable) return;
    const desktopMedia = window.matchMedia('(min-width: 768px)');
    const closeAtBreakpoint = () => setChatOpen(false);
    desktopMedia.addEventListener('change', closeAtBreakpoint);
    if (!desktopMedia.matches) {
      return () => desktopMedia.removeEventListener('change', closeAtBreakpoint);
    }
    desktopChatCloseRef.current?.focus();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setChatOpen(false);
      if (event.key !== 'Tab') return;
      const controls = desktopChatDrawerRef.current?.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled])',
      );
      if (!controls?.length) return;
      const first = controls[0]!;
      const last = controls[controls.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      desktopMedia.removeEventListener('change', closeAtBreakpoint);
      document.removeEventListener('keydown', closeOnEscape);
      document.body.style.overflow = previousOverflow;
      if (desktopMedia.matches) desktopChatTriggerRef.current?.focus();
    };
  }, [chatOpen]);

  useEffect(() => {
    if (!menuOpen || renderTable) return;
    const desktopMedia = window.matchMedia('(min-width: 768px)');
    const closeAtBreakpoint = () => setMenuOpen(false);
    desktopMedia.addEventListener('change', closeAtBreakpoint);
    if (!desktopMedia.matches) {
      return () => desktopMedia.removeEventListener('change', closeAtBreakpoint);
    }
    desktopMenuRef.current
      ?.querySelector<HTMLElement>('a[href], button:not([disabled]), select:not([disabled])')
      ?.focus();
    const closeMenu = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('keydown', closeMenu);
    return () => {
      desktopMedia.removeEventListener('change', closeAtBreakpoint);
      document.removeEventListener('keydown', closeMenu);
      if (desktopMedia.matches) desktopMenuTriggerRef.current?.focus();
    };
  }, [menuOpen]);


  useEffect(() => {
    let alive = true;
    setJoinError(null);
    bindGameClient();
    wsClient.joinRoom(roomId!);
    api.getRoom(roomId!).catch((e) => {
      if (alive) setJoinError(e instanceof Error ? e.message : 'Could not load room');
    });
    return () => {
      alive = false;
      voice.leave();
      wsClient.leaveRoom();
      useStore.getState().setRoom(null);
    };
  }, [roomId]);

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
  const isHost = room?.room.hostId === auth.userId;
  const isBankerHere =
    room?.room.bankerId === auth.userId || room?.room.coBankerId === auth.userId || isHost;
  // no membership row at all means this login came through a watch link
  const amSpectator = !!room && !room.players.some((p) => p.userId === auth.userId);
  const handLive = hand.handId !== null && !hand.result && !hand.abort;
  const myRoomStack = room?.players.find((p) => p.userId === auth.userId)?.stack ?? null;
  const amBroke = mySeat !== null && myRoomStack === 0 && !handLive;
  const remaining = hand.deadline ? hand.deadline - now : null;
  const urgent = handLive && remaining !== null && remaining <= 10_000;
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

  // Standings live in the side dock now, so they load whenever the dock or the
  // dialog is showing - and refresh at the end of every hand, which is the only
  // moment the numbers can change. Previously they were fetched once per dialog
  // open, which is why you had to keep reopening it to see where you stood.
  useEffect(() => {
    if (!standingsOpen && !(chatOpen && standingsDockOpen)) return;
    api
      .roomLeaderboard(roomId!)
      .then((r) => setStandings(r.rows))
      .catch(() => setStandings([]));
  }, [standingsOpen, chatOpen, standingsDockOpen, roomId, hand.result, hand.abort]);

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
        const won =
          !!hand.result && (hand.result.deltas.find((d) => d.seat === p.seat)?.delta ?? 0) > 0;
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
          lastAction: hand.lastActions[p.seat!],
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
  const secs = remaining !== null ? Math.max(0, Math.ceil(remaining / 1000)) : null;
  const notInHand = handLive && mySeat !== null && !hand.seats.some((s) => s.seat === mySeat);
  const meSittingOut = !!room.players.find((p) => p.userId === auth.userId)?.sittingOut;
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
  const mobilePeekPanel = hasPeekContent && (
    <div className="rounded-2xl bg-white/10 p-3.5 text-sm text-white">{peekBody(true)}</div>
  );

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

  // The recap panel is gone: a two-second flash of who took what, then the
  // table stays the table. The full story lives in the last-hand strip and
  // in hand history (出牌记录), where every hand now expands into its detail.
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
    const label = hand.showdown?.runTwice
      ? t('ran it twice')
      : top
        ? tScore(top.score)
        : t('everyone folded');
    const commission = hand.result?.commission ?? 0;
    return (
      <ResultFlash
        dark={dark}
        headline={
          winners.length
            ? winners.map((w) => `${seatName(w.seat)} +${fmt(w.delta)}`).join(' & ')
            : t('chips stayed put')
        }
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

  const mobileSeatPicker = (
    <div className="rounded-2xl bg-white/5 p-3.5">
      <div className="mb-2.5 text-sm text-white/70">
        {tNode('Pick a seat. Friends join with code {code}', {
          code: <span className="font-display font-bold text-white">{room.room.joinCode}</span>,
        })}
      </div>
      <div className="grid grid-cols-3 gap-2">
        {Array.from({ length: 9 }, (_, i) => (
          <button
            key={i}
            disabled={takenSeats.has(i) || handLive}
            onClick={() => sit(i)}
            className="rounded-full bg-white/10 py-2 text-sm font-semibold text-white active:scale-[0.98] disabled:opacity-30"
          >
            {t('Seat {n}', { n: i + 1 })}
          </button>
        ))}
      </div>
    </div>
  );

  const utilityGroupLabels: Record<TableUtilityGroupId, string> = {
    people: t('People'),
    records: t('Records'),
    table: t('Table'),
    preferences: t('Preferences'),
  };
  // The switches you touch every hand now live on the top bar itself
  // (TableQuickControls), so the 2D ⋮ menu keeps only the secondary items.
  // The 3D lounge chrome - which has no such row - still gets the full set.
  const inlineSurfaced: TableUtilityAction[] = ['auto-deal', 'sit-out', 'timer', 'preferences'];
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

  const runTwice = hand.ritOffer && (
    <div className="z-20 flex flex-col items-center gap-2 rounded-2xl bg-fuchsia-600/95 px-5 py-3 text-white shadow-[0_18px_50px_rgba(192,38,211,0.35)]">
      <span className="font-display text-lg font-bold">
        {t('🔁 Run it twice? · {n}s', {
          n: Math.max(0, Math.ceil((hand.ritOffer.deadlineTs - now) / 1000)),
        })}
      </span>
      {mySeat !== null && hand.ritOffer.voters.includes(mySeat) && !hand.ritOffer.voted ? (
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
  const sharedDialogs = (
    <>
      <AutoDealDialog open={autoDealOpen} onClose={() => setAutoDealOpen(false)} />
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

  return (
    <div className="table-app-bg min-h-screen">
      {/* MOBILE: full-screen Offsuit-style app view */}
      <div
        className="flex min-h-[100dvh] flex-col overflow-x-hidden bg-slate-950 text-white md:hidden"
        style={{ paddingTop: 'env(safe-area-inset-top)' }}
      >
        <div className="flex items-center gap-2 px-4 pt-3">
          <Link
            to="/lobby"
            aria-label={t('Leave table')}
            className="-ml-1.5 rounded-full p-1.5 text-white/70 active:bg-white/10"
          >
            <ArrowLeft size={20} weight="bold" />
          </Link>
          <div className="min-w-0">
            <div className="truncate font-display text-base font-bold leading-tight">
              {room.room.name}
            </div>
            <div className="font-display text-[0.65rem] tracking-widest text-white/60">
              {room.room.joinCode} · {room.room.sb}/{room.room.bb}
            </div>
          </div>
          <div className="ml-auto flex items-center gap-1.5">
            {handLive && secs !== null && (
              <span
                className={cn(
                  'rounded-full bg-white/10 px-2.5 py-1 font-display text-sm font-semibold',
                  urgent && 'animate-urgent bg-rose-500/20 text-rose-300',
                )}
              >
                0:{String(secs).padStart(2, '0')}
              </span>
            )}
            <button
              onClick={() => (voiceState.joined ? voice.toggleMute() : void voice.join())}
              aria-label={
                voiceState.joined
                  ? voiceState.muted
                    ? t('Unmute')
                    : t('Mute')
                  : t('Join voice chat')
              }
              className={cn(
                'flex h-9 w-9 items-center justify-center rounded-full bg-white/10 active:scale-95',
                voiceState.joined && !voiceState.muted && 'bg-emerald-500/25 text-emerald-300',
                voiceState.joined && voiceState.muted && 'bg-rose-500/25 text-rose-300',
              )}
            >
              {voiceState.joined && voiceState.muted ? (
                <MicrophoneSlash size={17} weight="bold" />
              ) : (
                <Microphone size={17} weight={voiceState.joined ? 'bold' : 'regular'} />
              )}
            </button>
            <button
              onClick={() => setChatOpen(true)}
              aria-label={t('Open chat')}
              className="flex h-9 w-9 items-center justify-center rounded-full bg-white/10 active:scale-95"
            >
              <ChatCircle size={17} />
            </button>
            <button
              onClick={() => setMenuOpen(true)}
              aria-label={t('Table menu')}
              className="flex h-9 w-9 items-center justify-center rounded-full bg-white/10 active:scale-95"
            >
              <DotsThreeVertical size={19} weight="bold" />
            </button>
          </div>
        </div>

        <MobileTable
          opponents={opponents}
          me={me}
          mySeat={mySeat}
          isHost={!!isHost}
          myCards={hand.myCards}
          board={hand.board}
          pot={pot}
          urgent={urgent}
          statusText={mobileStatus}
          dimBoard={notInHand}
        />

        {/* the result is a passing flash over the felt, never a second page */}
        {showResult && (
          <div className="pointer-events-none fixed inset-x-0 top-[4.5rem] z-40 flex justify-center px-4">
            {renderFlash(true)}
          </div>
        )}

        <div className="px-4 pb-2">
          <LastHandStrip roomId={roomId!} light />
        </div>

        {(!me || hasPeekContent) && (
          <div className="space-y-3 px-4 pb-6">
            {mobilePeekPanel}
            {!me && (amSpectator ? spectatorPanel : mobileSeatPicker)}
          </div>
        )}

        {menuOpen && (
          <div
            data-poker-hotkeys-blocked
            className="fixed inset-0 z-40 flex flex-col justify-end bg-black/60"
            onClick={() => setMenuOpen(false)}
          >
            <div
              className="space-y-4 rounded-t-3xl bg-slate-900 p-5 pb-8 text-white ring-1 ring-white/10"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="mx-auto h-1 w-10 rounded-full bg-white/20" />
              <div className="flex flex-wrap gap-2">
                <BankControls roomId={roomId!} />
              </div>
              <div className="flex gap-2">
                <Link to={`/room/${roomId}/ledger`} className="flex-1">
                  <Button variant="secondary" className="w-full">
                    {t('Ledger')}
                  </Button>
                </Link>
                <Link to={`/room/${roomId}/hands`} className="flex-1">
                  <Button variant="secondary" className="w-full">
                    {t('Hands')}
                  </Button>
                </Link>
              </div>
              <div className="flex gap-2">
                {mySeat !== null && (
                  <Button
                    variant="secondary"
                    className="flex-1"
                    onClick={() => setSitOut(!meSittingOut)}
                  >
                    {meSittingOut ? t('Deal me back in') : t('Sit out next hands')}
                  </Button>
                )}
                <Link
                  to="/settings"
                  target="_blank"
                  rel="noreferrer"
                  className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-background-secondary-default p-2 text-sm text-text-primary"
                >
                  <GearSix size={16} /> {t('Settings')}{' '}
                  <span className="sr-only">{t('(opens in a new tab)')}</span>
                </Link>
              </div>
              <div className="flex gap-2">
                <Button
                  variant="secondary"
                  className="flex-1"
                  onClick={() => {
                    setMenuOpen(false);
                    setStandingsOpen(true);
                  }}
                >
                  <Trophy size={16} /> {t('Standings')}
                </Button>
                <Button
                  variant="secondary"
                  className="flex-1"
                  onClick={() => {
                    setMenuOpen(false);
                    setInviteOpen(true);
                  }}
                >
                  {t('Invite friends')}
                </Button>
              </div>
              {room.room.meetLink && (
                <a href={room.room.meetLink} target="_blank" rel="noreferrer" className="block">
                  <Button variant="secondary" className="w-full">
                    <VideoCamera size={16} /> {t('Join the video call')}
                  </Button>
                </a>
              )}
              {isBankerHere && (
                <Button
                  variant="secondary"
                  className="w-full"
                  onClick={() => {
                    setMenuOpen(false);
                    setWatchOpen(true);
                  }}
                >
                  <Eye size={16} /> {t('Watch-only share link')}
                </Button>
              )}
              {!amSpectator && (
                <Button
                  variant="secondary"
                  className="w-full"
                  onClick={() => {
                    setMenuOpen(false);
                    setAutoDealOpen(true);
                  }}
                >
                  <Play size={16} /> {t('Auto-deal')} ·{' '}
                  {room.room.autoDeal === false ? t('Off') : t('On')}
                </Button>
              )}
              {isHost && (
                <label className="flex items-center justify-between text-sm text-white/70">
                  {t('Turn timer')}
                  {handLive ? t('(next hand)') : null}
                  <select
                    value={room.room.actionSecs ?? 45}
                    disabled={handLive}
                    onChange={(e) =>
                      void api.roomSettings(roomId!, +e.target.value).catch(reportError)
                    }
                    className="rounded-lg border border-white/20 bg-slate-800 px-2.5 py-1.5 text-white"
                  >
                    {[15, 30, 45, 60, 90, 120].map((seconds) => (
                      <option key={seconds} value={seconds}>
                        {t('{n}s', { n: seconds })}
                      </option>
                    ))}
                    <option value={0}>{t('No limit')}</option>
                  </select>
                </label>
              )}
            </div>
          </div>
        )}

        {chatOpen && (
          <div
            data-poker-hotkeys-blocked
            className="fixed inset-0 z-40 flex flex-col bg-slate-950 p-3"
          >
            <div className="mb-2 flex justify-end">
              <Button variant="secondary" onClick={() => setChatOpen(false)}>
                <X size={16} /> {t('Close')}
              </Button>
            </div>
            <div className="min-h-0 flex-1">
              <ChatPanel />
            </div>
          </div>
        )}
      </div>

      {/* DESKTOP */}
      <div className="mx-auto hidden min-h-screen w-full max-w-[96rem] flex-col gap-4 px-5 py-4 md:flex lg:px-7">
        <header className="flex flex-wrap items-center gap-3 rounded-2xl bg-white/80 p-2.5 shadow-[0_12px_36px_rgba(15,23,42,0.06)] ring-1 ring-slate-200/70 dark:bg-slate-950/70 dark:ring-slate-800">
          <Link
            to="/lobby"
            className={desktopIconClass}
            aria-label={t('Leave table')}
            title={t('Leave table')}
          >
            <ArrowLeft size={19} weight="bold" />
          </Link>
          <div className="min-w-0 pr-2">
            <h1 className="truncate font-display text-lg font-semibold tracking-[-0.02em]">
              {room.room.name}
            </h1>
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
          </div>

          {room.room.auditMode === 'strict-audit' && <Badge tone="amber">{t('strict audit')}</Badge>}
          {room.room.voided && (
            <span title={t('The banker voided this table: results do not count anywhere')}>
              <Badge tone="rose">{t('void table')}</Badge>
            </span>
          )}
          {handLive && secs !== null && (
            <span
              className={cn(
                'flex items-center gap-1.5 rounded-xl bg-slate-100 px-3 py-2 font-display text-sm font-semibold tabular-nums dark:bg-slate-900',
                urgent && 'animate-urgent bg-rose-50 text-rose-600 dark:bg-rose-950',
              )}
            >
              <Timer size={15} weight="bold" /> 0:{String(secs).padStart(2, '0')}
            </span>
          )}

          <div className="ml-auto flex flex-wrap items-center justify-end gap-1">
            <BankControls roomId={roomId!} mode="hub" />
            <TableQuickControls
              isHost={!!isHost}
              autoDeal={room.room.autoDeal !== false}
              autoDealPaused={!!room.autoDealPaused}
              hasSeat={mySeat !== null}
              sittingOut={meSittingOut}
              sitOutDisabled={!wsConnected}
              actionSecs={room.room.actionSecs ?? 45}
              timerDisabled={handLive}
              amSpectator={amSpectator}
              onChangeAutoDeal={(value) =>
                void api.setAutoDeal(roomId!, value).catch(reportError)
              }
              onOpenAutoDealDialog={() => setAutoDealOpen(true)}
              onToggleSitOut={() => {
                if (wsConnected) setSitOut(!meSittingOut);
              }}
              onChangeActionSecs={(seconds) =>
                void api.roomSettings(roomId!, seconds).catch(reportError)
              }
            />
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
            <DesktopIconButton
              label={
                unreadChat > 0
                  ? t('Toggle chat, {n} unread messages', { n: unreadChat })
                  : t('Toggle chat')
              }
              onClick={() => setChatOpen((open) => !open)}
              active={chatOpen}
              badge={unreadChat}
              buttonRef={desktopChatTriggerRef}
            >
              <ChatCircle size={20} weight={chatOpen ? 'fill' : 'regular'} />
            </DesktopIconButton>

            <Link
              to={`/room/${roomId}/3d`}
              className={desktopIconClass}
              aria-label={t('3D table')}
              title={t('3D table')}
            >
              <Cube size={19} />
            </Link>
            <DesktopIconButton
              label={isFullscreen ? t('Exit full screen') : t('Full screen')}
              onClick={() => {
                if (document.fullscreenElement) void document.exitFullscreen();
                else void document.documentElement.requestFullscreen().catch(() => {});
              }}
              active={isFullscreen}
            >
              {isFullscreen ? <CornersIn size={19} /> : <CornersOut size={19} />}
            </DesktopIconButton>

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
                    className="absolute right-0 top-12 z-30 w-72 rounded-2xl bg-white p-2 shadow-[0_20px_60px_rgba(15,23,42,0.18)] ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-700"
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
                  </div>
                </>
              )}
            </div>
          </div>
        </header>

        <div className="flex flex-1 items-start gap-4">
          <main className="flex min-w-0 flex-1 flex-col gap-4">
            <section
              aria-label={t('Poker board')}
              className={cn(
                'relative flex min-h-[clamp(32rem,64vh,54rem)] flex-col gap-3 overflow-hidden rounded-[2rem] bg-slate-200/50 px-2 pb-2 pt-4 ring-1 ring-slate-200 dark:bg-slate-900/60 dark:ring-slate-800 sm:px-4 lg:px-6',
                notInHand && 'opacity-60 saturate-50',
              )}
            >
              {thunderKey > 0 && (
                <div key={thunderKey} className="thunder-flash" aria-hidden="true" />
              )}
              {showResult && (
                <div
                  className="pointer-events-none absolute inset-x-0 top-3 z-20 flex justify-center px-4"
                  role="region"
                  aria-label={t('Hand result')}
                >
                  {renderFlash(false)}
                </div>
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
              <RoundTable
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
                onMyCardsClick={() => {
                  localStorage.setItem('4am-big-cards', 'on');
                  setBigCards(true);
                }}
                readyCheck={!handLive ? hand.readyCheck : null}
              >
                <div className="relative">
                  <motion.div
                    key={pot}
                    initial={pot > 0 ? { scale: 1.14 } : false}
                    animate={{ scale: 1 }}
                    transition={{ type: 'spring', stiffness: 320, damping: 18 }}
                    className="absolute inset-0 rounded-xl bg-indigo-600 shadow-[0_12px_30px_rgba(79,70,229,0.22)]"
                    aria-hidden="true"
                  />
                  <div className="relative px-5 py-2.5 font-display text-lg font-semibold text-white">
                    {t('POT')} <NumberFlow value={pot} />
                  </div>
                </div>
                {pot > 0 && (
                  <ChipStack amount={pot} bb={room.room.bb} size="lg" className="justify-center" />
                )}
                {/* the felt keeps its layout while a result flashes over it */}
                <>
                    {runTwice}
                    <div className="flex flex-col items-center gap-2">
                      <div className="flex items-center justify-center gap-2.5 lg:gap-3">
                        {hand.board2.length > 0 && (
                          <span className="rounded-full bg-fuchsia-500/15 px-2 py-0.5 text-[0.65rem] font-bold uppercase tracking-wide text-fuchsia-500">
                            {t('Run 1')}
                          </span>
                        )}
                        {[0, 1, 2, 3, 4].map((index) =>
                          hand.board[index] !== undefined ? (
                            <PlayingCard
                              key={`${index}-${hand.board[index]}`}
                              card={hand.board[index]}
                              size="table"
                              deal
                              // the three flop cards land together, so cascade them; the
                              // turn and river arrive alone and flip immediately
                              dealDelay={hand.board.length === 3 ? index * 0.16 : 0}
                            />
                          ) : (
                            <div
                              key={index}
                              className="h-36 w-24 rounded-2xl border-2 border-dashed border-slate-300/80 dark:border-slate-700"
                              role="img"
                              aria-label={t('Empty community card {n}', { n: index + 1 })}
                            />
                          ),
                        )}
                      </div>
                      {/* the second runout grows underneath as its twin cards land */}
                      {hand.board2.length > 0 && (
                        <div className="flex items-center justify-center gap-2">
                          <span className="rounded-full bg-fuchsia-500/15 px-2 py-0.5 text-[0.65rem] font-bold uppercase tracking-wide text-fuchsia-500">
                            {t('Run 2')}
                          </span>
                          {[0, 1, 2, 3, 4].map((index) =>
                            hand.board2[index] !== undefined ? (
                              <PlayingCard
                                key={`r2-${index}-${hand.board2[index]}`}
                                card={hand.board2[index]}
                                size="lg"
                                deal
                              />
                            ) : (
                              <div
                                key={`r2-${index}`}
                                className="h-20 w-14 rounded-lg border-2 border-dashed border-fuchsia-400/30 md:h-32 md:w-[5.6rem] md:rounded-2xl"
                                aria-label={t('Empty run 2 card {n}', { n: index + 1 })}
                              />
                            ),
                          )}
                        </div>
                      )}
                    </div>
                    {!handLive && !showResult && (
                      <div className="text-center">
                        <p className="text-sm text-slate-500">
                          {mySeat === null
                            ? t('Pick a seat.')
                            : opponents.length === 0
                              ? t('Invite a friend to deal.')
                              : t('Ready.')}
                        </p>
                        {mySeat !== null && isHost && opponents.length > 0 && (
                          <Button className="mt-5 h-11 rounded-xl px-5" onClick={startHand}>
                            <Play size={17} weight="fill" /> {t('Deal hand')}
                          </Button>
                        )}
                      </div>
                    )}
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
            </section>

            {/* the control strip sits under the table so the oval keeps its space */}
            {amSpectator && spectatorPanel}
            <fieldset disabled={!wsConnected} className="min-w-0">
              <ActionBar
                mySeat={mySeat}
                isHost={!!isHost}
                urgent={urgent}
                hideIdleStart={!showResult}
              />
            </fieldset>

            <LastHandStrip roomId={roomId!} />

            {peekPanel}

            {bigCards && handLive && hand.myCards.length > 0 && !notInHand && (
              <FloatingCards
                cards={hand.myCards}
                onClose={() => {
                  localStorage.setItem('4am-big-cards', 'off');
                  setBigCards(false);
                }}
              />
            )}
          </main>

          {/* chat rides beside the table as a real column, never an overlay */}
          {chatOpen && (
            <aside
              aria-label={t('Table chat')}
              className="sticky top-4 hidden max-h-[calc(100dvh-2rem)] min-h-[30rem] w-80 shrink-0 flex-col overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-slate-200/70 md:flex dark:bg-slate-900 dark:ring-slate-700/70"
            >
              {/* Standings ride above the chat in the same rail, so who is up and
                who is down is just there - it used to be a dialog you had to
                open again after every hand. Collapsible, because on a short
                screen the chat needs the room more. */}
              <div className="border-b border-slate-200 dark:border-slate-800">
                <button
                  type="button"
                  onClick={() => {
                    const next = !standingsDockOpen;
                    setStandingsDockOpen(next);
                    localStorage.setItem('4am-standings-dock', next ? 'on' : 'off');
                  }}
                  aria-expanded={standingsDockOpen}
                  className="flex w-full items-center justify-between px-4 py-2.5 text-left hover:bg-slate-50 dark:hover:bg-slate-800/60"
                >
                  <h2 className="font-display text-sm font-semibold">{t('Standings')}</h2>
                  <CaretDown
                    size={14}
                    weight="bold"
                    className={cn(
                      'text-slate-400 transition-transform',
                      !standingsDockOpen && '-rotate-90',
                    )}
                  />
                </button>
                {standingsDockOpen && (
                  <div className="max-h-[38vh] overflow-y-auto px-2.5 pb-2.5">
                    {standings === null ? (
                      <p className="px-1.5 py-2 text-xs text-slate-400">{t('Counting chips…')}</p>
                    ) : (
                      <LeaderboardTable rows={standings} minHands={room.room.minSettleHands} />
                    )}
                  </div>
                )}
              </div>
              <div className="flex items-center justify-between border-b border-slate-200 px-4 py-2.5 dark:border-slate-800">
                <h2 className="font-display text-sm font-semibold">{t('Table chat')}</h2>
                <button
                  type="button"
                  onClick={() => setChatOpen(false)}
                  aria-label={t('Close chat')}
                  className="rounded-md p-1 text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800"
                >
                  <X size={16} />
                </button>
              </div>
              <div className="min-h-0 flex-1 p-2.5">
                <ChatPanel chrome={false} />
              </div>
            </aside>
          )}
        </div>
      </div>

      {sharedDialogs}
    </div>
  );
}
