import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { AutoDealDialog } from '../../features/table/AutoDealDialog.tsx';
import { HandRecoveryBanner, SettlementFailureBanner } from '../../features/table/settlementFailure.tsx';
import { pokerOverlayOpen } from '../../features/table/pokerHotkeys.ts';
import { motion } from 'motion/react';
import {
  ArrowLeft,
  Bomb,
  CornersIn,
  CornersOut,
  UsersThree,
  CardsThree,
  DotsThreeVertical,
  Eye,
  Microphone,
  MicrophoneSlash,
  GearSix,
  PauseCircle,
  Play,
  Receipt,
  Robot,
  Skull,
  Sliders,
  Timer,
  Trophy,
  UserPlus,
  X,
} from '@phosphor-icons/react';
import NumberFlow from '@number-flow/react';
import {
  bestFive,
  describeScore,
  evaluate7,
  type RoomGameplaySettings,
} from '@4am/shared';
import {
  answerPeek,
  bindGameClient,
  imReady,
  offerPeek,
  resetHandSession,
  setSitOut,
  sit,
  startHand,
  dealMotionEpoch,
  boardMotionKey,
} from '../../shared/gameClient.ts';
import { wsClient } from '../../shared/ws.ts';
import { useStore } from '../../shared/store.ts';
import { api, type FeatureTriggerKind } from '../../shared/api.ts';
import { GameplaySettingsDialog } from '../../features/table/GameplaySettingsDialog.tsx';
import { BotsDialog } from '../../features/bots/BotsDialog.tsx';
import { botsPollMs, useRoomBots } from '../../features/bots/useRoomBots.ts';
import { voice } from '../../shared/voice.ts';
import { play } from '../../shared/sounds.ts';
import { cn, fmt } from '../../shared/lib/cn.ts';
import { ACTION_TIMEOUT_SECS } from '../../shared/lib/tableTimers.ts';
import { t, tr } from '../../shared/i18n/index.ts';
import { tNode } from '../../shared/i18n/trans.tsx';
import { tScore } from '../../shared/i18n/pokerLabels.ts';
import { Badge, Button, Dialog, Panel, Spinner } from '../../shared/ui/index.tsx';
import { PlayingCard } from '../../entities/card/PlayingCard.tsx';
import type { SeatView } from '../../widgets/table/RoundTable.tsx';
import { BettingPanel } from '../../widgets/table/BettingPanel.tsx';
import { ChatPanel } from '../../widgets/table/ChatPanel.tsx';
import { RoundTable } from '../../widgets/table/RoundTable.tsx';
import { DealCard } from '../../widgets/table/DealCard.tsx';
import { BombPotIntro } from '../../widgets/table/BombPotIntro.tsx';
import { ribbonFitsRail } from '../../widgets/table/geometry.ts';
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
  filterDesktopMenuGroups,
  tableUtilityGroups,
  unreadChatCount,
  type TableUtilityAction,
  type TableUtilityGroupId,
} from './tableUi.ts';
import { holeStrengthLabel } from './holeStrengthLabel.ts';
import { useUrgentAt } from './hooks/useUrgentAt.ts';
import { useViewportSize } from './hooks/useViewportSize.ts';
import { CountdownChip } from './ui/CountdownChip.tsx';
import { RunTwicePrompt } from './ui/RunTwicePrompt.tsx';
import { MultiRunPrompt } from './ui/MultiRunPrompt.tsx';
import { DesktopIconButton, desktopIconClass } from './ui/DesktopIconButton.tsx';

interface FloatingReaction {
  id: number;
  emoji: string;
  left: number;
}

export function TablePage() {
  const { id: roomId } = useParams<{ id: string }>();
  const storedRoom = useStore((s) => s.room);
  const room = storedRoom?.room.id === roomId ? storedRoom : null;
  const hand = useStore((s) => s.hand);
  const handLive = hand.handId !== null && !hand.result && !hand.abort;
  // The server's last room_state snapshot also knows whether a hand is running.
  // It covers the window where the host closes before this browser has received
  // hand_start. Once a hand is held locally its terminal frame wins: hand_end /
  // hand_abort means it is over even if a stale snapshot still said handActive.
  const serverHandActive = !!room?.handActive;
  const handInFlight = handLive || (serverHandActive && hand.handId === null);
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
  useEffect(() => {
    const sync = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', sync);
    return () => document.removeEventListener('fullscreenchange', sync);
  }, []);
  const [chatSeenCount, setChatSeenCount] = useState(0);
  const [menuOpen, setMenuOpen] = useState(false);
  const [closeRoomBusy, setCloseRoomBusy] = useState(false);
  // In-app confirmation for closing (archiving) the table. Native confirm() is
  // deliberately not used: the copy has to be explicit that nothing is deleted.
  const [closeDialogOpen, setCloseDialogOpen] = useState(false);
  // Shown to everyone else when the host closes/archives the room (and to a
  // member who opens an already-closed room), with a way back to the lobby.
  const [archiveNotice, setArchiveNotice] = useState(false);
  // Close flow owned by this tab: 'idle' = not closing from here, 'pending' =
  // the close request is in flight, 'settling' = the server archived the room
  // and we are waiting out the live hand so it settles instead of being
  // aborted by our own departure.
  const [closeFlow, setCloseFlow] = useState<'idle' | 'pending' | 'settling'>('idle');
  // A member left the table while a hand was running: stay mounted (keep the
  // hand's controls and crypto connection) and navigate once it finishes.
  const [leavePending, setLeavePending] = useState(false);
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
  const [peekSent, setPeekSent] = useState<Record<number, boolean>>({});
  const [shareOpen, setShareOpen] = useState(false);
  const [standingsOpen, setStandingsOpen] = useState(false);
  const closeDockPopovers = useCallback(() => {
    setChatOpen(false);
  }, []);
  // review fix #7: stable identities so the dock's popover effects never see
  // callback churn - the focus behavior depends on open/close, not on render.
  const toggleChat = useCallback(() => {
    setChatOpen((open) => !open);
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
  // L6: narrowCanvas = the PHONE oval (548×410 + phone ring/anchors/pods).
  // Portrait phones drive it off isPhone; a short landscape phone (height
  // under the 480 the desktop canvas cannot survive) joins it too.
  const { w: viewportW, h: viewportH } = useViewportSize();
  const isPhone = viewportW < 768;
  const narrowCanvas = isPhone || (viewportH < 480 && viewportW < 1100);
  // L6: the console strip is a PORTRAIT reflow — the dock + action cluster
  // leave the felt and ride a bottom row (zero felt coverage by controls).
  // A landscape phone (short but wide) keeps absolute corner overlays: the
  // side gutters next to the smaller oval host them, and a console strip
  // would squeeze the canvas into a scrollbox.
  const consoleFlow = isPhone && viewportH >= viewportW;
  const compactBar = viewportW < 1280;
  const unreadChat = unreadChatCount(chat.length, chatSeenCount, chatOpen);

  useEffect(() => {
    if (!chatOpen) return;
    setChatSeenCount(chat.length);
  }, [chatOpen, chat.length]);

  // A11: one full-height viewport, no page scroll - the table area owns the
  // room; popovers close on Escape themselves.
  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, []);

  // ⋮ menu: focus the first item on open, close on Escape.
  useEffect(() => {
    if (!menuOpen) return;
    desktopMenuRef.current
      ?.querySelector<HTMLElement>('a[href], button:not([disabled]), select:not([disabled])')
      ?.focus();
    const closeMenu = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('keydown', closeMenu);
    return () => document.removeEventListener('keydown', closeMenu);
  }, [menuOpen]);

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
      // Room switch / unmount is a session boundary: leaveRoom() drops the held
      // hand as well (handId, handRecovery, settlementFailed, result/abort), so
      // the previous room's hand is never announced as `resumeHandId` to the
      // next room and its recovery banner cannot leak across.
      wsClient.leaveRoom();
      // ...but a leave is NOT a full session end. The same live hand can be
      // resumed after rejoining (a room switch is often just a page move), so
      // the module-level fold/terminal evidence must survive:
      // `resetHandSession('leave-room')` is a deliberate no-op that states the
      // boundary here rather than silently omitting it. A full wipe is owned by
      // gameClient's auth-identity subscription (logout / account switch), and
      // room archiving funnels through this same cleanup once its hand is
      // terminal, so it rightfully keeps the registries too.
      resetHandSession('leave-room');
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
          error instanceof Error
            ? tr(error.message)
            : t('That change did not go through. Try again.'),
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

  // Archiving means the room is gone from the live app: everyone still looking
  // at it gets an explicit notice and a way back to the lobby. While a hand is
  // still running we deliberately do NOT raise the modal: the hand has to keep
  // its controls and its crypto connection until it reaches a terminal frame,
  // and an unavoidable exit dialog would abort it. Once the hand is done the
  // notice (or, for the tab that closed it, the redirect below) takes over.
  // A tab that did not drive the close still gets the notice even if the close
  // HTTP response was lost: resetting `closeFlow` to idle re-runs this effect.
  useEffect(() => {
    if (!room?.room.archived) return;
    // The archive notice owns the modal slot: drop any open close confirmation
    // first so the two dialogs can never stack.
    setCloseDialogOpen(false);
    if (closeFlow !== 'idle') return;
    if (handInFlight) return;
    setArchiveNotice(true);
  }, [room?.room.archived, closeFlow, handInFlight]);

  // Any exit - the host's close or a member leaving - waits for the live hand
  // to reach its terminal frame. Settlement is durable by then and no next hand
  // can start, so this navigation can no longer abort the hand.
  useEffect(() => {
    if (handInFlight) return;
    if (closeFlow === 'settling' || leavePending) window.location.assign('/lobby');
  }, [closeFlow, leavePending, handInFlight]);

  // The single exit used by every table exit point (the header back button and
  // the early-return fallbacks). With a hand in flight we keep the page mounted
  // and record the intent instead of unmounting: an unmount disconnects the
  // socket and would abort the deal.
  const requestLeave = () => {
    if (handInFlight) {
      setLeavePending(true);
      return;
    }
    window.location.assign('/lobby');
  };

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
      // Dismiss only the recap, without also closing docked chat.
      event.stopPropagation();
      setResultDismissed(true);
    };
    document.addEventListener('keydown', dismissOnEscape, true);
    return () => document.removeEventListener('keydown', dismissOnEscape, true);
  }, [showResult, room?.room.id]);

  // L5 (spec §4): the winner confetti burst was removed with the motion
  // pass - the celebration is the gold ring highlight + WIN badge + the
  // pot-collection chip flight (WinnerFx), no particles / canvas overlays.

  useEffect(() => {
    if (errors.length === 0) return;
    const timer = setTimeout(dismissError, 4000);
    return () => clearTimeout(timer);
  }, [errors, dismissError]);

  // The in-flight hand snapshots its own seats. Closing clears every
  // room_players seat (that is what "stand everyone up" means for the next
  // deal), but a hand already dealt must stay playable for those still in it -
  // so while a hand is live we trust the hand's seat snapshot over the room row.
  const handSeat = hand.seats.find((s) => s.userId === auth.userId)?.seat ?? null;
  const roomSeat = room?.players.find((p) => p.userId === auth.userId)?.seat ?? null;
  const mySeat = handLive && handSeat !== null ? handSeat : roomSeat;
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
  const myRoomStack = room?.players.find((p) => p.userId === auth.userId)?.stack ?? null;
  const meRoomPlayer = room?.players.find((p) => p.userId === auth.userId);
  // A fresh seat can legitimately have zero points before its first buy-in.
  // Only show the recovery dialog after this player has bought/played here.
  const hasPlayedOrBought = !!meRoomPlayer && (meRoomPlayer.totalBought > 0 || hand.seats.some((s) => s.seat === mySeat));
  // `brokeNow` deliberately ignores the hand lifecycle: a player who is out of
  // chips needs to buy whether or not a hand is running. The PROMPT is still
  // only raised between hands (`!handLive` below) so it never pops over a live
  // deal - but once it is on screen, the next deal must not yank it out from
  // under a purchase the player is filling in. `buyPromptShown` latches the
  // offer open until the player dismisses it or is no longer broke.
  const brokeNow = mySeat !== null && myRoomStack === 0 && hasPlayedOrBought;
  const [buyPromptShown, setBuyPromptShown] = useState(false);
  useEffect(() => {
    if (brokeNow && !handLive) setBuyPromptShown(true);
  }, [brokeNow, handLive]);
  // review fix #8: one scheduled flip per deadline, no page-wide 500ms ticker
  const urgent = useUrgentAt(hand.deadline, handLive);
  const utilityGroups = tableUtilityGroups({
    amSpectator,
    isBankerHere: !!isBankerHere,
    isHost: !!isHost,
    hasSeat: mySeat !== null,
  });

  // ── table bots (Phase 1 UI) ───────────────────────────────────────────────
  // ONE shared read instance feeds both the seat badges and the host dialog:
  // a create/stop in the dialog reloads this state, so the felt repaints in
  // the same frame and the two views can never disagree. A watch-link
  // spectator is not a room member (the route 403s) - `quiet` folds exactly
  // that into "no badges"; real faults (503, network) still surface as errors.
  const [botsOpen, setBotsOpen] = useState(false);
  const botsVisible = !!room && !amSpectator;
  const [botsPoll, setBotsPoll] = useState(0);
  const botsState = useRoomBots(roomId, botsVisible, botsPoll, true);
  const { bots } = botsState;
  useEffect(() => {
    setBotsPoll(botsPollMs(bots, botsOpen));
  }, [bots, botsOpen]);
  const botByUserId = useMemo(
    () => new Map(bots.map((b) => [b.userId, { status: b.status, policyKind: b.policyKind }])),
    [bots],
  );

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
    if (!standingsOpen) return;
    api
      .roomLeaderboard(roomId!)
      .then((r) => setStandings(r.rows))
      .catch(() => setStandings([]));
  }, [standingsOpen, roomId, hand.result, hand.abort]);

  // resolve / re-arm the prompt: leaving the broke state closes the latch and
  // clears the dismissal, so the next broke episode offers a fresh prompt.
  useEffect(() => {
    if (!brokeNow) {
      setBuyPromptShown(false);
      setBrokeDismissed(false);
    }
  }, [brokeNow]);

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
          displayName: p.displayName,
          avatarVersion: p.avatarVersion,
          stack: stackShown,
          pendingBuy: p.pendingBuy ?? 0,
          broke: stackShown === 0 && !(handLive && inHand),
          isButton: inHand && hand.buttonSeat === p.seat,
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
          // Table bot: undefined for humans, so the pod keeps the plain look.
          bot: botByUserId.get(p.userId),
        };
      });
  }, [room, hand, handLive, voiceState, botByUserId]);

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
              <Button onClick={requestLeave}>{t('Back to lobby')}</Button>
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
                  <Button variant="ghost" onClick={requestLeave}>
                    {t('Back to lobby')}
                  </Button>
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
  const seatName = (seat: number) =>
    seatViews.find((s) => s.seat === seat)?.displayName ?? t('Seat {n}', { n: seat + 1 });

  const peekAmt = room.room.bb;
  // Every seated player may request a look. The target is any participant in
  // the just-ended hand whose cards are still private; the server is the final
  // authority for the hand's terminal eligibility and fixed 1bb settlement.
  const amSeated = room.players.some((p) => p.userId === auth.userId && p.seat !== null);
  const peekEligible =
    hand.result && !hand.abort && !handLive && amSeated
        ? seatViews.filter(
          (v) => hand.seats.some((s) => s.seat === v.seat && s.userId === v.userId) && v.seat !== mySeat && !v.revealed && !hand.peekResults[v.seat],
        )
      : [];
  const peekReveals = Object.entries(hand.peekResults);
  // The eye is deliberately part of the opponent pod, not the dock. The
  // result drawer below is only a secondary history affordance for cards the
  // requester already received; spectators never get either object.
  const peekTargets = Object.fromEntries(
    peekEligible.map((v) => [v.seat, {
      sent: !!peekSent[v.seat] || (myRoomStack ?? 0) < peekAmt,
      onPeek: () => {
        if (peekSent[v.seat] || (myRoomStack ?? 0) < peekAmt) return;
        setPeekSent((m) => ({ ...m, [v.seat]: true }));
        offerPeek(v.seat, peekAmt);
      },
    }]),
  );
  const peekBody = (dark: boolean) => (
    <div className="space-y-2.5">
      {peekReveals.map(([seat, result]) => (
        <div key={seat} className="flex flex-wrap items-center gap-2 text-sm">
          <span>{tNode('{name} had', { name: <b>{result.targetName}</b> })}</span>
          {result.cards.map((c) => (
            <PlayingCard key={c} card={c} size="xs" />
          ))}
          <span className={dark ? 'text-white/50' : 'text-slate-400'}>
            {t('only you can see this')}
          </span>
        </div>
      ))}
    </div>
  );

  const peekPanel = peekReveals.length > 0 && <details className="table-peek" key={hand.handId} open>
    <summary className="table-dock-chip" aria-label={t('Peek results')}>
      <Eye size={15} weight="bold" />
      <span className="sr-only">{t('Peek results')}</span>
    </summary>
    <div className="table-peek-body" data-poker-hotkeys-blocked>{peekBody(true)}</div>
  </details>;

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
        headline: t('{name} takes the pot. Everyone else folded, so no cards had to be shown.', {
          name: nameOf(winner.seat),
        }),
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
  // (see WinnerFx / RoundTable). This pill remains for voided hands. The
  // full story lives in the last-hand strip and in hand history (出牌记录).
  const resultWinners = (hand.result?.deltas ?? []).filter((d) => d.delta > 0);
  const showdownCollectors = hand.showdown
    ? (hand.showdown.multiRun?.awards.flat() ?? hand.showdown.runTwice?.awards.flat() ?? hand.showdown.awards)
        .filter((a) => a.amount > 0)
        .map((a) => a.seat)
        .filter((seat, i, all) => all.indexOf(seat) === i)
    : [];
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
    if (hand.result?.recovered) {
      // A committed hand rebuilt from durable data after a restart: it is over
      // (chips moved) but the per-seat detail did not survive. Say so instead of
      // showing an empty winner list as though nobody won.
      return (
        <ResultFlash
          dark={dark}
          headline={t('Hand finished')}
          detail={t('The result was recovered after a server restart; per-hand details are unavailable.')}
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
        {t("You can see everything public, but not anyone's cards, the join code, or the chips.")}
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
  // Invite and watch are explicit top-bar entries on both desktop and phone;
  // keep them out of ⋮ so the same action is never offered twice. The menu
  // remains the home for secondary utilities and phone-only actions.
  const inlineSurfaced: TableUtilityAction[] = [
    'invite',
    'watch',
    ...(isPhone
      ? (['auto-deal', 'sit-out', 'bots'] as const)
       : (['auto-deal', 'sit-out', 'timer', 'preferences', 'hands', 'ledger'] as const)),
  ];
  const desktopMenuGroups = filterDesktopMenuGroups(utilityGroups, inlineSurfaced);
  // An already-archived table has nothing to close, and not offering the
  // action also means the confirmation can never sit over an archive notice.
  const canCloseRoom = (!!isHost || !!auth.isPlatform) && !room?.room.archived;
  const utilityItemClass =
    'flex w-full items-center gap-2.5 rounded-xl px-3 py-2.5 text-left text-sm font-medium text-slate-700 transition-colors hover:bg-slate-100 hover:text-slate-950 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-indigo-500 dark:text-slate-200 dark:hover:bg-slate-800 dark:hover:text-white';

  const reportError = (error: unknown) =>
    useStore
      .getState()
      .pushError(
        error instanceof Error ? error.message : t('That change did not go through. Try again.'),
      );
  const closeUtilityMenu = () => setMenuOpen(false);
  // Confirmed from the in-app dialog (see sharedDialogs), never a native
  // confirm(): closing archives the table and stands everyone up. Nothing is
  // deleted, so the copy has to say so unambiguously.
  const closeRoomNow = async () => {
    if (!canCloseRoom || closeRoomBusy) return;
    // Never stack the confirm over an archived notice.
    setCloseDialogOpen(false);
    setCloseRoomBusy(true);
    setCloseFlow('pending');
    try {
      const res = (await api.closeRoom(roomId!)) as { handActive?: boolean } | undefined;
      // The response carries the authoritative "was a hand running" flag, so the
      // window where the server already dealt but this browser has not yet seen
      // hand_start cannot navigate us into an abort. handInFlight is the local
      // belt-and-braces fallback.
      if (res?.handActive || handInFlight) {
        // A hand is in flight: stay put and keep playing. The effect above
        // navigates once it reaches its terminal frame, so the hand settles
        // instead of being aborted by our departure.
        setCloseFlow('settling');
      } else {
        window.location.assign('/lobby');
      }
    } catch (error) {
      // If the server archived and broadcast but the response was lost, reset
      // to idle so the archived-notice effect re-runs and offers a way out; a
      // genuine failure (403/409/network) surfaces here too.
      setCloseFlow('idle');
      reportError(error);
    } finally {
      setCloseRoomBusy(false);
    }
  };
  // Phone view controls (A11 + review fix #1): the ⋮ menu carries fullscreen
  // where the top bar has no room for the icon buttons.
  const fullscreenSupported =
    typeof document !== 'undefined' && 'requestFullscreen' in document.documentElement;
  const showMoreControls = desktopMenuGroups.length > 0 || (isPhone && fullscreenSupported) || canCloseRoom;
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
            {meSittingOut ? t('Deal me in next hand') : t('Sit out next deal')}
          </button>
        );
      case 'timer':
        return (
          <label className="flex items-center gap-2.5 rounded-xl px-3 py-2.5 text-sm font-medium text-slate-700 dark:text-slate-200">
            <Timer size={18} />
            <span className="flex-1">{t('Turn timer')}</span>
            <select
              aria-label={t('Turn timer')}
              value={room.room.actionSecs ?? ACTION_TIMEOUT_SECS}
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
      case 'bots':
        // phone entry for the host-only bot dialog (desktop rides the top bar)
        return (
          <button
            type="button"
            role="menuitem"
            className={utilityItemClass}
            onClick={() => {
              closeUtilityMenu();
              setBotsOpen(true);
            }}
          >
            <Robot size={18} /> {t('Bot opponents')}
            {bots.length > 0 && (
              <span className="ml-auto text-xs text-slate-500 dark:text-slate-400">
                {t('{n} seated', { n: bots.length })}
              </span>
            )}
          </button>
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
  // L3 (rev-3): the feature banners ride a RIBBON — on the top rail for 1/3/5
  // players, else as the center column's first child (adaptive; see
  // geometry.ts ribbonFitsRail). On the column they used to collide with the
  // top seats' bet chips and ate the H2 budget. Borderless colored text: bomb =
  // room gold, squid = its identity violet. All of it still derives from
  // server announcements — nothing here invents boards, antes or settlements.
  const feat = hand.featureStarted;
  const bombActive = !!feat?.bombPot?.enabled;
  const bombBeforeFlop =
    bombActive && handLive && (!hand.betting || hand.betting.street === 'preflop');
  const featureRibbon =
    ((feat?.squid?.enabled || bombActive) && hand.handId !== null) || bombBeforeFlop ? (
       <div className="table-ribbon" role="status">
         <BombPotIntro />
        {(feat?.squid?.enabled || bombActive) && hand.handId !== null && (
          <div className="table-ribbon-row">
            {bombActive && feat.bombPot && (
              <span className="rb-bomb">
                <Bomb size={12} weight="fill" />
                {t('Bomb pot · {n}× BB', { n: feat.bombPot.anteBb })}
              </span>
            )}
            {feat?.squid?.enabled && (
              <span className="rb-squid">
                <Skull size={12} weight="fill" />
                {t('Squid Game · {n}× BB · {p} players', {
                  n: feat.squid.penaltyBb,
                  p: hand.seats.length,
                })}
              </span>
            )}
          </div>
        )}
        {bombBeforeFlop && (
          <span className="rb-note">
            <Bomb size={11} weight="fill" /> {t('Bomb pot ante posted - straight to the flop.')}
          </span>
        )}
      </div>
    ) : null;
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
      <p className="table-outcome z-10">
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
        className="table-squid-summary z-10"
      >
        <p className="table-squid-title">
          <Skull size={13} weight="fill" /> {t('Squid Game settlement')}
          <span className="table-squid-sub">
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
                'table-squid-chip',
                n.net > 0
                  ? 'table-squid-chip--pos'
                  : n.net < 0
                    ? 'table-squid-chip--neg'
                    : 'table-squid-chip--zero',
              )}
            >
              {seatName(n.seat)} {n.net >= 0 ? `+${fmt(n.net)}` : `−${fmt(-n.net)}`}
            </span>
          ))}
        </div>
      </div>
    ) : null;

  // ── center-column size budget (H2) ────────────────────────────────────────
  // The felt column (pot → [ribbon] → prompts → board → summaries) is one
  // stack; a 3-run board or a banner/summary pile grows it down toward the
  // bottom-seat pods (baseline: run 3 covering the hero's plate). When that
  // risk is live we switch the column to its COMPACT tier - smaller board
  // cards, collapsed gaps - and RoundTable additionally scales the measured
  // column down to the geometry budget (centerBudget) as a backstop: it is a
  // mitigation, not a guarantee - the clamp bottoms out at minScale 0.72, so
  // an extreme pile (3 runs + banners + summary) can still overrun.
  // L3: the feature ribbon rides the top rail band for 1/3/5 seated players
  // (geometry.ts ribbonFitsRail) - there it is outside this stack and is NOT
  // counted below; every other seat count flows it at the column head, where
  // it is.
  const boardRuns = hand.boards.length > 0 ? hand.boards : [hand.board];
  // EFFECTIVE multi-run, decided by the server's INTENT, not by card arrival:
  // - primary: multi_run_result with runs > 1 - broadcast the moment the
  //   negotiation resolves, BEFORE run 2's first board_open lands (boards
  //   only grows lazily per flip, gameClient board_open). Without this the
  //   felt would visibly jump single→multi tier mid-hand at the first flip;
  // - fallback: a non-empty extra run already on the boards array (covers
  //   any window where cards arrived without the result frame in view);
  // - stays FALSE for the legacy declined rit, whose rit_result leaves a
  //   `[shared, []]` placeholder behind with no multiRunResult - that hand
  //   must render exactly like a single run: no raised anchor, no xs tier,
  //   no run labels.
  const multiRunBoard =
    (hand.multiRunResult?.runs ?? 0) > 1 || boardRuns.slice(1).some((r) => r.length > 0);
  // L3: the ribbon rides the top rail band (geometry.ts ribbonFitsRail, the
  // SAME predicate RoundTable uses to place it) for 1/3/5 seated players -
  // there it is not part of the column, so the ResizeObserver never measures
  // it and it must NOT count toward the budget. Every other seat count flows
  // it at the column head, where it does. multiRunBoard's own semantics are
  // untouched.
  const ribbonOnRail = !!featureRibbon && ribbonFitsRail(Math.max(seatViews.length, 1));
  const feltStackCount = [
    !ribbonOnRail && featureRibbon,
    runTwice,
    multiRunOutcome,
    squidSummary,
  ].filter(Boolean).length;
  const centerCompact = multiRunBoard || feltStackCount >= 2;

  // ── host-only dock controls (B1/B3 arming + Lane D dialog) ────────────────
  const dockChip = 'pointer-events-auto table-dock-chip';
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
            className={cn(dockChip, armedTriggers.squid && 'table-dock-chip--squid')}
            data-testid="gameplay-squid"
          >
            {armedTriggers.squid ? <X size={15} /> : <Skull size={15} />}
            <span className={isPhone ? 'sr-only' : undefined}>{t('Squid Game')}</span>
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
            className={cn(dockChip, armedTriggers.bomb && 'table-dock-chip--active')}
            data-testid="gameplay-bomb"
          >
            {armedTriggers.bomb ? <X size={15} /> : <Bomb size={15} />}
            <span className={isPhone ? 'sr-only' : undefined}>{t('Bomb pot')}</span>
          </button>
        )}
        {/* phones have no quick-controls strip - the 玩法规则 gear lives here */}
        {isPhone && (
          <button
            type="button"
            onClick={openGameplay}
            title={t('Gameplay rules')}
            className={cn(dockChip, 'table-dock-chip--active')}
          >
            <Sliders size={15} />
            <span className="sr-only">{t('Gameplay rules')}</span>
          </button>
        )}
      </div>
    ) : null;
  // ── corner controls ───────────────────────────────────────────────────────
  // The betting area is a compact widget - % pills, slider + amount (chips and
  // BB), big action buttons, action-clock ring. On portrait phones the cluster
  // AND the dock leave the felt and ride a console strip below the canvas (they
  // can no longer share its box); desktop and short landscape phones keep the
  // bottom-corner overlays, the smaller phone oval leaving the side columns free.
  const bettingCluster = (
    <fieldset
      disabled={!wsConnected}
      className={cn(
        'm-0 min-w-0 border-0 p-0',
        consoleFlow
          ? 'shrink-0'
          : 'table-cluster-host absolute bottom-2 right-2 z-30 md:bottom-3 md:right-3',
      )}
    >
      <div data-testid="betting-panel">
        <BettingPanel mySeat={mySeat} isHost={!!isHost} narrow={narrowCanvas} />
      </div>
    </fieldset>
  );
  const dockNode = (
    <TableDock
      peek={peekPanel}
      flow={consoleFlow}
      phone={narrowCanvas}
      compact={isPhone || compactBar}
      hasSeat={mySeat !== null}
      sittingOut={meSittingOut}
      sitOutDisabled={!wsConnected}
      onToggleSitOut={() => {
        if (wsConnected) setSitOut(!meSittingOut);
      }}
      onClosePopovers={closeDockPopovers}
      chatOpen={chatOpen}
      onToggleChat={toggleChat}
      unread={unreadChat}
      chatBody={
        <fieldset disabled={!wsConnected} className="h-full min-h-0">
          <ChatPanel chrome={false} />
        </fieldset>
      }
    />
  );
  const sharedDialogs = (
    <>
      {/* A frozen durable settlement is the one state a toast may not own: the
          table cannot continue, so the recovery banner persists until it clears. */}
      <SettlementFailureBanner isHost={!!isHost} />
      {/* An `unresolved` durable hand with no local failure frame: admin-only,
          no retry, no fabricated refund. */}
      <HandRecoveryBanner />
      {/* The room is archived but a hand is still running. This is a banner,
          not a dialog: the current hand keeps its controls and its crypto
          connection until it reaches a terminal frame. */}
      {(leavePending || !!room?.room.archived) && handInFlight && (
        <div
          role="status"
          data-testid="table-archive-pending"
          className="pointer-events-none fixed inset-x-0 top-0 z-50 bg-amber-400 px-4 py-2 text-center text-sm font-semibold text-amber-950 shadow-md"
        >
          {room?.room.archived
            ? isHost
              ? t('This hand finishes first, then the room archives. Keep playing - nothing is deleted.')
              : t('The host closed this table. This hand finishes first, then you can leave - nothing is deleted.')
            : t('This hand finishes first, then you can leave. Keep playing - nothing is deleted.')}
        </div>
      )}
      <AutoDealDialog open={autoDealOpen} onClose={() => setAutoDealOpen(false)} />
      {/* Host close confirmation. The label and the body both say "archive,
          nothing deleted" so it can never be mistaken for a data wipe. */}
      <Dialog
        open={closeDialogOpen}
        onClose={() => setCloseDialogOpen(false)}
        title={t('Close and archive this room?')}
      >
        <p className="text-sm text-slate-600 dark:text-slate-300">
          {t(
            'Closing archives this table and stands everyone up. It disappears from the lobby, the sidebar and the public list, and no further hands are dealt - but nothing is deleted. The ledger and every hand stay readable, and anything still owed is still owed.',
          )}
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <Button
            variant="ghost"
            onClick={() => setCloseDialogOpen(false)}
            disabled={closeRoomBusy}
          >
            {t('Cancel')}
          </Button>
          <Button
            variant="danger"
            data-testid="table-close-confirm"
            onClick={() => void closeRoomNow()}
            disabled={closeRoomBusy}
          >
            {closeRoomBusy ? (
              <Spinner label={t('Closing and archiving…')} />
            ) : (
              t('Close and archive (nothing is deleted)')
            )}
          </Button>
        </div>
      </Dialog>
      {/* Shown to everyone else once the host has archived the table, and to a
          member who opens a closed room directly. */}
      <Dialog
        open={archiveNotice}
        onClose={() => window.location.assign('/lobby')}
        title={t('This room was closed and archived')}
      >
        <p className="text-sm text-slate-600 dark:text-slate-300">
          {t(
            'The host closed and archived this table. Nothing was deleted - you can still read its hands and ledger from History.',
          )}
        </p>
        <div className="mt-4 flex justify-end">
          <Button data-testid="table-archive-back" onClick={() => window.location.assign('/lobby')}>
            {t('Back to lobby')}
          </Button>
        </div>
      </Dialog>
      {features && (
        <GameplaySettingsDialog
          roomId={roomId!}
          features={features}
          open={gameplayOpen}
          onOpenChange={setGameplayOpen}
          onSaved={setFeatures}
        />
      )}
      {/* host-only bot seat: manage the felt's machine players. The dialog
          reads the page's shared bot state - no second fetch of its own. */}
      {isHost && (
        <BotsDialog
          roomId={roomId!}
          open={botsOpen}
          onClose={() => setBotsOpen(false)}
          takenSeats={[...takenSeats]}
          bb={room?.room.bb ?? 20}
          bots={bots}
          loading={botsState.loading}
          error={botsState.error}
          reload={botsState.reload}
        />
      )}
      <BrokeBuyInDialog
        roomId={roomId!}
        open={brokeNow && buyPromptShown && !brokeDismissed}
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
          <p className="text-sm text-slate-500">
            {t('No completed hands yet. Deal one and check back.')}
          </p>
        ) : (
          <LeaderboardTable rows={standings} minHands={room.room.minSettleHands} />
        )}
      </Dialog>

      {/* connection state */}
      {!wsConnected && (
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

  // ONE consolidated 牌桌区 for desktop and phone alike. The old right column
  // (standings dock + chat) and the old bottom bar are gone: rankings/chat are
  // dock buttons with popovers, status/balance/shortcuts ride inside the table
  // area, sit-out anchors bottom-left, and the oval is a fixed-aspect canvas
  // that scales instead of stretching.
  // The desktop floor (min 30rem) is a DESKTOP contract - on the phone oval's
  // short viewports (landscape 844×390) it would force the page past the
  // viewport and push the bottom-corner controls out of the clipped strip, so
  // the phone canvas runs un-floored.
  return (
    <div
      className={cn(
        'table-app-bg flex h-[calc(100dvh-60px)] flex-col gap-2 overflow-hidden p-2 md:h-[calc(100dvh-65px)] md:gap-2.5 md:p-3',
        !narrowCanvas && 'min-h-[30rem]',
      )}
      data-table-skin={prefs.tableSkin}
      style={{ paddingTop: 'calc(env(safe-area-inset-top) + 0.5rem)' }}
    >
      {/* ── compact top bar (A11) ─────────────────────────────────────────── */}
      <header
        className={cn(
          'relative shrink-0 rounded-xl bg-white/80 px-2 shadow-[0_10px_30px_rgba(15,23,42,0.06)] ring-1 ring-slate-200/70 dark:bg-slate-950/70 dark:ring-slate-800',
          isPhone
            ? 'grid grid-cols-[auto_minmax(0,1fr)_auto] grid-rows-[2.75rem_2.75rem] gap-x-1'
            : 'flex h-12 items-center gap-2',
        )}
        data-testid="table-header"
      >
        <button
          type="button"
          onClick={requestLeave}
          className={cn(desktopIconClass, isPhone && 'row-span-2 h-11 w-11')}
          aria-label={t('Leave table')}
          title={t('Leave table')}
        >
          <ArrowLeft size={19} weight="bold" />
        </button>
        <div className={cn('min-w-0 md:flex-none md:pr-2', isPhone ? 'self-center' : 'flex-1')}>
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

        {isPhone && (room.room.auditMode === 'strict-audit' || room.room.voided) && (
          <div className="col-start-2 row-start-1 flex min-w-0 items-center gap-1 self-end truncate text-[0.62rem]">
            {room.room.auditMode === 'strict-audit' && (
              <Badge tone="amber">{t('strict audit')}</Badge>
            )}
            {room.room.voided && <Badge tone="rose">{t('void table')}</Badge>}
          </div>
        )}
        {!isPhone && room.room.auditMode === 'strict-audit' && (
          <Badge tone="amber">{t('strict audit')}</Badge>
        )}
        {!isPhone && room.room.voided && (
          <span title={t('The banker voided this table: results do not count anywhere')}>
            <Badge tone="rose">{t('void table')}</Badge>
          </span>
        )}
        {!isPhone && handLive && hand.deadline !== null && (
          <CountdownChip deadline={hand.deadline} urgent={urgent} />
        )}

        {isPhone && (
          <div className="col-start-3 row-start-1 self-center justify-self-end">
            <BankControls roomId={roomId!} compact />
          </div>
        )}
        <div
          className={cn(
            'flex items-center justify-end gap-1',
            isPhone
              ? 'col-start-2 row-start-2 min-w-0 justify-start overflow-visible pl-1 pr-12'
              : 'ml-auto flex-nowrap',
          )}
        >
          {!isPhone && <BankControls roomId={roomId!} compact={compactBar} />}
          {isPhone && (
            <Link
              to={`/room/${roomId}/hands`}
              className={cn(desktopIconClass, 'h-11 w-11')}
              data-testid="mobile-history"
              title={t('Hand history')}
              aria-label={t('Hand history')}
            >
              <CardsThree size={19} />
            </Link>
          )}
          {isPhone && !amSpectator && (
            <DesktopIconButton
              label={isHost ? t('Auto-deal') : t('Only the host can change this room setting.')}
              onClick={() =>
                isHost
                  ? void api.setAutoDeal(roomId!, room.room.autoDeal === false).catch(reportError)
                  : setAutoDealOpen(true)
              }
              className="h-11 w-11"
              data-testid="mobile-auto-deal"
            >
              <Play size={18} weight={room.room.autoDeal === false ? 'regular' : 'fill'} />
            </DesktopIconButton>
          )}
          {isPhone && isHost && (
            <DesktopIconButton
              label={t('Bot opponents')}
              onClick={() => setBotsOpen(true)}
              className="h-11 w-11"
              data-testid="mobile-bots"
            >
              <Robot size={18} />
            </DesktopIconButton>
          )}
          {isPhone && !amSpectator && (
            <DesktopIconButton
              label={t('Invite friends')}
              onClick={() => setInviteOpen(true)}
              className="h-11 w-11"
              data-testid="mobile-invite"
            >
              <UserPlus size={18} />
            </DesktopIconButton>
          )}
          {isPhone && isBankerHere && (
            <DesktopIconButton
              label={t('Watch-only link')}
              onClick={() => setWatchOpen(true)}
              className="h-11 w-11"
              data-testid="mobile-watch"
            >
              <Eye size={18} />
            </DesktopIconButton>
          )}
          {/* phones trade the switch strip for the ⋮ menu so the bar never
              wraps (A1); desktop keeps the chips, icon-only when tight */}
          {!isPhone && (
            <TableQuickControls
              roomId={roomId!}
              isHost={!!isHost}
              autoDeal={room.room.autoDeal !== false}
              autoDealPaused={!!room.autoDealPaused}
              actionSecs={room.room.actionSecs ?? ACTION_TIMEOUT_SECS}
              timerDisabled={handLive}
              amSpectator={amSpectator}
              compact={compactBar}
              onChangeAutoDeal={(value) => void api.setAutoDeal(roomId!, value).catch(reportError)}
              onOpenAutoDealDialog={() => setAutoDealOpen(true)}
              onChangeActionSecs={(seconds) =>
                void api.roomSettings(roomId!, seconds).catch(reportError)
              }
              onOpenGameplay={isHost && features ? openGameplay : undefined}
              onOpenBots={isHost ? () => setBotsOpen(true) : undefined}
              botCount={bots.length}
            />
          )}
          {!isPhone && (
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
          )}
          {!isPhone && !amSpectator && (
            <DesktopIconButton label={t('Invite friends')} onClick={() => setInviteOpen(true)}>
              <UserPlus size={18} />
            </DesktopIconButton>
          )}
          {!isPhone && isBankerHere && (
            <DesktopIconButton label={t('Watch-only link')} onClick={() => setWatchOpen(true)}>
              <Eye size={18} />
            </DesktopIconButton>
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

          {showMoreControls && <div className="relative">
            <DesktopIconButton
              label={t('More table controls')}
              onClick={() => setMenuOpen((open) => !open)}
              active={menuOpen}
              hasPopup
              expanded={menuOpen}
              buttonRef={desktopMenuTriggerRef}
              className={isPhone ? 'h-11 w-11' : undefined}
               data-testid={isPhone ? 'mobile-table-utilities' : 'table-more'}
            >
              <DotsThreeVertical size={20} weight="bold" />
            </DesktopIconButton>
             {menuOpen && (desktopMenuGroups.length > 0 || (isPhone && fullscreenSupported) || canCloseRoom) && (
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
                  className={cn(
                    'pointer-events-auto z-50 max-w-[calc(100vw-1rem)] overflow-y-auto rounded-2xl bg-white p-2 shadow-[0_20px_60px_rgba(15,23,42,0.18)] ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-700',
                    isPhone
                      ? 'fixed right-2 top-[9rem] max-h-[calc(100dvh-10rem)] w-[min(18rem,calc(100vw-1rem))]'
                      : 'absolute right-0 top-12 max-h-[70vh] w-72',
                  )}
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
                        <div key={action} role="none" data-testid={isPhone ? `mobile-utility-${action}` : undefined}>
                          {utilityAction(action)}
                        </div>
                      ))}
                    </div>
                  ))}
                  {/* review fix #1: phones keep fullscreen reachable via ⋮ */}
                  {isPhone && (
                    <div
                      role="group"
                      aria-label={t('View')}
                      className="mt-1 border-t border-slate-100 pt-1 dark:border-slate-800"
                    >
                      <div className="px-3 pb-1 pt-2 text-[0.64rem] font-semibold uppercase tracking-[0.14em] text-slate-400 dark:text-slate-500">
                        {t('View')}
                      </div>
                       <button
                         type="button"
                         role="menuitem"
                         data-testid="mobile-utility-fullscreen"
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
                       <button
                         type="button"
                         role="menuitem"
                         data-testid="mobile-utility-voice"
                         className={utilityItemClass}
                        onClick={() => {
                          if (voiceState.joined) voice.toggleMute();
                          else void voice.join();
                          closeUtilityMenu();
                        }}
                      >
                        {voiceState.joined && voiceState.muted ? (
                          <MicrophoneSlash size={18} />
                        ) : (
                          <Microphone size={18} />
                        )}{' '}
                        {voiceState.joined
                          ? voiceState.muted
                            ? t('Unmute voice')
                            : t('Mute voice')
                          : t('Join voice')}
                      </button>
                    </div>
                  )}
                  {canCloseRoom && (
                    <button
                      type="button"
                      role="menuitem"
                      disabled={closeRoomBusy}
                      data-testid="table-close-room"
                      className="mt-1 flex w-full items-center gap-2.5 rounded-xl px-3 py-2.5 text-left text-sm font-semibold text-rose-700 hover:bg-rose-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-rose-500 disabled:opacity-50 dark:text-rose-300 dark:hover:bg-rose-950/40"
                      onClick={() => {
                        setMenuOpen(false);
                        setCloseDialogOpen(true);
                      }}
                    >
                      <X size={18} weight="bold" />
                      {closeRoomBusy ? t('Closing and archiving…') : t('Close and archive')}
                    </button>
                  )}
                </div>
              </>
            )}
          </div>}
        </div>
      </header>

      <div
        className="flex shrink-0 items-center justify-between gap-2 px-1"
        data-testid="table-corner-controls"
      >
        <div className={cn('min-w-0', isPhone && 'table-dock--phone')}>{hostGameplay}</div>
        <div className="flex shrink-0 items-center gap-1.5">
          <PokerShortcutButton className="!text-(--table-muted) hover:!text-(--table-ink)" />
          <button
            type="button"
            onClick={() => setStandingsOpen(true)}
            className={dockChip}
            aria-haspopup="dialog"
          >
            <Trophy size={15} /> {t('Standings')}
          </button>
        </div>
      </div>

      {/* ── the one table area (A7: no separate bottom bar) ───────────────── */}
      <section
        aria-label={t('Poker board')}
        className="relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-[1.5rem] md:rounded-[2rem]"
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
            L6: on portrait phones the oval only owns the flex region ABOVE
            the console strip - the dock + action cluster leave the felt and
            ride as a bottom row, so they can never share the canvas box.
            Landscape phones keep the corner overlays (the smaller oval
            leaves the side columns free). */}
        <div className={cn('relative min-h-[8rem] flex-1', consoleFlow && 'flex flex-col')}>
          <div
            className={cn(
              // pb-6: the hero's pill row rides BELOW its ring point and
              // spills past the canvas box (≈50 design px at the worst
              // showdown state); the strip absorbs it without shrinking the
              // canvas area below the floor scale's 225px height on 320×700.
              consoleFlow ? 'min-h-0 flex-1 pb-6' : 'h-full min-h-0',
              notInHand && 'opacity-60 saturate-50',
            )}
          >
            <RoundTable
              hudRoomId={!amSpectator ? roomId! : undefined}
              narrow={narrowCanvas}
              centerCompact={centerCompact}
              centerRaised={multiRunBoard}
              centerBudget
              ribbon={featureRibbon}
              seats={seatViews}
              mySeat={mySeat}
              myUserId={auth.userId}
              myCards={hand.myCards}
              committedBySeat={Object.fromEntries(
                (hand.betting?.seats ?? []).map((s) => [s.seat, s.committed]),
              )}
              handId={hand.handId}
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
               collectSeats={showdownCollectors}
               peekTargets={peekTargets}
               peekResults={!amSpectator ? hand.peekResults : undefined}
             >
              {/* A5/L3: the pot is ONE GG "Total Pot" gold pill centered above
                the board row. (rev-3 dropped the pot chip pile + the 0-state
                Coins icon — the number carries the value; the pulse motion
                stays as-is, the motion pass is L5.) */}
              {pot > 0 && (
                <div className="table-pot-pill" title={t('POT')}>
                  <span className="sr-only">{t('POT')}</span>
                  <span className="table-pot-label">{t('POT')}</span>
                  <motion.span
                    key={pot}
                    initial={{ scale: 1.12 }}
                    animate={{ scale: 1 }}
                    transition={{ type: 'spring', stiffness: 320, damping: 18 }}
                    className="table-pot-val"
                  >
                    {/* the pot follows the same shared unit preference as the
                        seat stacks and the action bar: BB when the table is in
                        BB, points otherwise - never a second, chip-only total. */}
                    <NumberFlow
                      value={prefs.stackUnit === 'bb' ? Math.round(pot / Math.max(1, room?.room.bb ?? 1)) : pot}
                    />
                  </motion.span>
                  {prefs.stackUnit === 'bb' && <span className="table-pot-label">BB</span>}
                </div>
              )}
              {/* the felt keeps its layout while a result flashes over it */}
              <>
                {runTwice}
                <div className="flex flex-col items-center gap-2">
                  {(() => {
                    // P2 B4: render hand.boards - run 1 owns the felt's geometry
                    // as before; run 2 / run 3 grow underneath.
                    // EFFECTIVE MULTI-RUN (multiRunBoard: server-declared
                    // runs > 1, or a non-empty extra run already dealt - a
                    // trailing [] from a declined legacy rit is NOT one):
                    // every row shares ONE card
                    // size (xs) and ONE 5-slot structure (label + 5 cells, dealt
                    // cards or matching empty placeholders) - GGPoker-style equal
                    // rows, no 96px-vs-40px mismatch, no ragged widths.
                    // Sizing math (design px, canvas 1180x660): the bare stack
                    // pot ≈28 + column gap 8 + 3x40 + 2x8 = 172, centered on the
                    // RAISED anchor (48% -> y ≈317), spans ≈231-403 - below the
                    // far pods (bottom edge ≈197-207) and above the bet ellipse
                    // (y ≈455). The hero pod's top edge is state-dependent
                    // (≈412-440 at showdown), so the bottom gap is real but thin
                    // in the worst case. This is sizing, NOT a guarantee:
                    // banners/summaries stacked on 3 runs still exceed the
                    // 204px budget and fall to the RoundTable clamp, which
                    // scales the whole column uniformly (floor minScale 0.72) -
                    // past that floor the column may still touch a pod.
                    // Non-effective hands (single run, or a single run with a
                    // legacy empty extra, banners included) keep the yPct anchor
                    // and the untouched full/md tier.
                    const [first, ...rest] = boardRuns;
                    const boardSmall = narrowCanvas || centerCompact;
                    // L3 tiers (mockup board = 84×120 'board'; desktop compact
                    // falls to 'sm' 40×56; multi-run 'xs'). L6 measured the
                    // phone 'md' idea and REVERTED it: five md cards span 359
                    // of the 548 oval and the ±130° hole-card fans ate the end
                    // cards — 'sm' (232 wide) is the widest tier the 9-seat
                    // phone ring leaves free, and at k≈0.55-0.68 the corner
                    // index still renders ~11px, above the legibility line.
                    // Phone multi-run rows upgrade xs→sm (28 design px of card
                    // is unreadable at the floor scale); desktop tiers are
                    // untouched. The RoundTable clamp (centerBudget, now active
                    // on the phone canvas too) keeps the stack inside the
                    // seat-ring budget.
                    const runSize = multiRunBoard
                      ? narrowCanvas
                        ? 'sm'
                        : 'xs'
                      : boardSmall
                        ? 'sm'
                        : 'board';
                    const runGap = multiRunBoard ? 'gap-1' : boardSmall ? 'gap-1.5' : 'gap-3';
                    const emptySlotClass =
                      multiRunBoard && !narrowCanvas
                        ? 'h-10 w-7 rounded-md'
                        : boardSmall || multiRunBoard
                          ? 'h-14 w-10 rounded-lg'
                          : 'h-30 w-21 rounded-[13px]';
                    const runLabel = (n: number) => (
                      <span className="table-run-chip">{t('Run {n}', { n })}</span>
                    );
                    const emptySlot = (key: string, index: number) => (
                      <div
                        key={key}
                        className={cn('table-slot', emptySlotClass)}
                        role="img"
                        aria-label={t('Empty community card {n}', { n: index + 1 })}
                      />
                    );
                    return (
                      <>
                        <div className={cn('flex items-center justify-center', runGap)}>
                          {multiRunBoard && runLabel(1)}
                          {[0, 1, 2, 3, 4].map((index) =>
                            first![index] !== undefined ? (
                               <DealCard key={boardMotionKey(hand.handId, 0, first![index]!)} handId={hand.handId} epoch={dealMotionEpoch(hand.handId, boardMotionKey(hand.handId, 0, first![index]!))} motionKey={boardMotionKey(hand.handId, 0, first![index]!)} delay={index < 3 ? index * 90 : 0}><PlayingCard
                                card={first![index]}
                                size={runSize}
                                // the three flop cards land together, so cascade them; the
                                // turn and river arrive alone and flip immediately
                                dealDelay={first!.length === 3 ? index * 0.16 : 0}
                              /></DealCard>
                            ) : (
                              emptySlot(`r0-slot-${index}`, index)
                            ),
                          )}
                        </div>
                        {/* a run that has not opened a single card renders NO row
                          (legacy rit_result leaves a `[]` placeholder behind when
                          the ahead player declined - never show it as a ghost
                          row); a partly-dealt run pads to the same 5 slots as
                          run 1 so the visible rows stay equal width */}
                        {rest.map((run, runIdx) =>
                          run.length === 0 ? null : (
                            <div
                              key={`run-${runIdx}`}
                              className={cn('flex items-center justify-center', runGap)}
                            >
                              {runLabel(runIdx + 2)}
                              {[0, 1, 2, 3, 4].map((index) =>
                                run[index] !== undefined ? (
                                   <DealCard key={boardMotionKey(hand.handId, runIdx + 1, run[index]!)} handId={hand.handId} epoch={dealMotionEpoch(hand.handId, boardMotionKey(hand.handId, runIdx + 1, run[index]!))} motionKey={boardMotionKey(hand.handId, runIdx + 1, run[index]!)} delay={index < 3 ? index * 90 : 0}><PlayingCard
                                    card={run[index]}
                                    size={runSize}
                                  /></DealCard>
                                ) : (
                                  emptySlot(`r${runIdx}-slot-${index}`, index)
                                ),
                              )}
                            </div>
                          ),
                        )}
                      </>
                    );
                  })()}
                </div>
                {multiRunOutcome}
                {squidSummary}
                {notInHand && <p className="table-notinhand">{t("You're in the next hand.")}</p>}
                {!handLive && opponents.length === 0 && !amSpectator && (
                  <button
                    type="button"
                    onClick={() => setInviteOpen(true)}
                    className="table-invite"
                  >
                    <UserPlus size={15} /> {t('Invite friends')} · {t('code')}{' '}
                    <span className="table-invite-code">{room.room.joinCode}</span>
                  </button>
                )}
              </>
            </RoundTable>
          </div>

          {/* L4 (rev2 decision): the host's deal post + auto-deal clock + the
              ready check are merged into the bottom-right action cluster
              (BettingPanel) - one card serves between-hand and in-hand, so
              the old top-right command post is gone. */}

          {/* feedback #3: the last-hand recap floats over the top-left of the
              felt now - the standalone bottom panel is gone. It stops short of
              the deal corner so the two never share a row on phones. */}
          <div className="pointer-events-none absolute inset-x-2 top-1 z-20 flex justify-start [&_a]:pointer-events-auto [&_button]:pointer-events-auto">
            <div className="w-[min(23rem,calc(100%-9.5rem))]">
              <LastHandStrip roomId={roomId!} />
            </div>
          </div>

          {/* Incoming peek offers are a one-line overlay, not a layout slot: a
              slot above the felt would shrink the explicit table stage and can
              move every pod on desktop and phone. The top inset is reserved
              chrome, so this compact banner does not intersect table elements. */}
          {hand.peekOffers.length > 0 && (
            <div
              className="pointer-events-none absolute inset-x-0 top-1 z-30 flex justify-center px-2"
              data-testid="peek-incoming-banner"
            >
              <details className="peek-incoming-banner pointer-events-auto w-[min(27rem,calc(100%-1rem))] rounded-xl px-2.5 py-1 text-[0.7rem] shadow-lg">
                <summary className="cursor-pointer list-none truncate text-center font-semibold [&::-webkit-details-marker]:hidden">
                  {t('{n} people want to peek at your cards', { n: hand.peekOffers.length })}
                </summary>
                <div className="peek-incoming-list">
                  {hand.peekOffers.map((offer) => (
                    <div key={offer.offerId} className="flex min-w-0 items-center gap-2 border-t border-white/10 py-1.5">
                      <span className="min-w-0 flex-1 truncate">
                        {tNode('{name} offers {amount} to privately see the cards you just had.', {
                          name: <b>{offer.fromName}</b>,
                          amount: <b className="font-display">{fmt(offer.amount)}</b>,
                        })}
                      </span>
                      <Button
                        variant="success"
                        className="shrink-0 !px-2 !py-0.5 !text-[0.68rem]"
                        disabled={hand.myCardPoints.length === 0}
                        onClick={() => answerPeek(offer.offerId, true)}
                      >
                        {t('Accept {amount}', { amount: fmt(offer.amount) })}
                      </Button>
                      <Button
                        variant="secondary"
                        className="shrink-0 !px-2 !py-0.5 !text-[0.68rem]"
                        onClick={() => answerPeek(offer.offerId, false)}
                      >
                        {t('Decline')}
                      </Button>
                    </div>
                  ))}
               </div>
              </details>
            </div>
          )}

          {/* seat picker / spectator notice / buy-peek, as floating cards */}
          {!me && (
            <div className="pointer-events-none absolute inset-x-0 top-1 z-20 flex flex-col items-center gap-2 px-2">
              {!me && (
                <div className="pointer-events-auto w-[min(26rem,96%)]">
                  {amSpectator ? spectatorPanel : seatPicker}
                </div>
              )}
            </div>
          )}

          {/* popover click-away: over the felt only - the action bar stays
              usable while a dock popover is open */}
          {chatOpen && (
            <button
              className="absolute inset-0 z-20 cursor-default"
              aria-label={t('Close table controls')}
              onClick={closeDockPopovers}
            />
          )}

          {/* A8 + A6/A9: the corner controls. Portrait phones re-dock them
              into the console strip (rendered below, outside the felt box). */}
          {consoleFlow ? null : (
            <>
              {bettingCluster}
              {dockNode}
            </>
          )}
        </div>
        {consoleFlow && (
          <div className="table-console relative z-30 flex shrink-0 items-end justify-between gap-1.5 px-0.5 pb-1">
            {dockNode}
            {bettingCluster}
          </div>
        )}
      </section>

      {sharedDialogs}
    </div>
  );
}
