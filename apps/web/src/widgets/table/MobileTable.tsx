import { useEffect, useState, useRef, type RefObject } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { usePokerHotkeys } from '../../features/table/usePokerHotkeys.ts';
import { pokerActionLatch } from '../../features/table/pokerHotkeys.ts';
import { PokerShortcutButton } from '../../features/settings/PokerShortcutButton.tsx';
import NumberFlow from '@number-flow/react';
import {
  HAND_CATEGORY_NAMES,
  evaluate5,
  evaluate7,
  handCategory,
  legalActions,
  rankOf,
  type CardId,
} from '@4am/shared';
import { Crown } from '@phosphor-icons/react';
import { act, imReady, ritVote, showMyCards, startHand } from '../../shared/gameClient.ts';
import { useStore } from '../../shared/store.ts';
import { cn, fmt } from '../../shared/lib/cn.ts';
import { t } from '../../shared/i18n/index.ts';
import { tHandCategory } from '../../shared/i18n/pokerLabels.ts';
import { preActionOptions, togglePreAction } from '../../features/table/preActions.ts';
import { useSettling } from '../../features/table/useSettling.ts';
import { PlayingCard } from '../../entities/card/PlayingCard.tsx';
import { Avatar } from '../../entities/user/Avatar.tsx';
import type { SeatView } from './players.tsx';
import { ChipFlight, StackValue, WinBadge, useWinnerFx } from './WinnerFx.tsx';

/** Offsuit-style phone table: flat dark canvas, opponents in a top row,
 *  huge board cards, bare pot number, ghost-pill actions, giant hole cards. */

function strengthLabel(myCards: CardId[], board: CardId[]): string | null {
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
  return HAND_CATEGORY_NAMES[handCategory(best)] ?? null;
}

/** Badge verbs for the last action of an opponent column. */
const ACTION_VERB_KEYS: Record<'fold' | 'check' | 'call' | 'bet' | 'raise', string> = {
  fold: 'Fold',
  check: 'Check',
  call: 'Call',
  bet: 'Bet',
  raise: 'Raise',
};

function OpponentColumn({
  p,
  urgent,
  tileRef,
}: {
  p: SeatView;
  urgent: boolean;
  tileRef: (el: HTMLDivElement | null) => void;
}) {
  const engineCommitted = useStore(
    (s) => s.hand.betting?.seats.find((x) => x.seat === p.seat)?.committed ?? 0,
  );
  return (
    <div
      ref={tileRef}
      className={cn(
        'flex w-16 shrink-0 flex-col items-center gap-1 rounded-2xl px-1 pt-1.5',
        p.isToAct && 'turn-stripes-dark bg-indigo-500/10 ring-1 ring-indigo-400/50',
        p.isToAct && urgent && 'turn-stripes-dark-rose bg-rose-500/10 ring-rose-400/60',
      )}
    >
      <div className="relative">
        <Avatar
          userId={p.userId}
          name={p.displayName}
          version={p.avatarVersion}
          size="md"
          speaking={p.speaking}
          className={cn(
            p.isToAct && 'ring-2 ring-indigo-400',
            p.isToAct && urgent && 'ring-rose-500 animate-urgent',
            p.won && 'animate-winner',
            (p.folded || !p.connected || p.broke) && 'opacity-50 saturate-50',
          )}
        />
        {p.isButton && (
          <span className="absolute -bottom-0.5 -right-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-white text-[0.55rem] font-bold text-slate-900">
            D
          </span>
        )}
        {p.isLeader && (
          <span
            title={t('Chip leader')}
            className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-amber-400 text-white"
          >
            <Crown size={9} weight="fill" />
          </span>
        )}
        {/* the WIN tag takes the action pill's spot the moment the hand lands */}
        {p.won ? (
          <span className="absolute -top-2 left-1/2 z-20 -translate-x-1/2">
            <WinBadge amount={p.wonAmount ?? 0} />
          </span>
        ) : (
          p.lastAction && (
            <span className="absolute -top-1.5 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full bg-slate-950/90 px-2 py-0.5 text-[0.6rem] font-semibold capitalize text-white ring-1 ring-white/20">
              {t(ACTION_VERB_KEYS[p.lastAction.type])}
            </span>
          )
        )}
        {p.inHand && p.revealed && (
          <div className="absolute -right-3 -top-2 flex gap-0.5">
            {p.revealed.map((c) => (
              <PlayingCard key={c} card={c} size="xs" deal />
            ))}
          </div>
        )}
      </div>
      <div className="max-w-full truncate text-xs font-medium text-white/80">{p.displayName}</div>
      <div
        className={cn('font-display text-sm font-bold', p.broke ? 'text-rose-400' : 'text-white')}
      >
        <StackValue stack={p.stack} won={p.won} />
      </div>
      <div className="h-6">
        {p.sittingOut && !p.broke && (
          <span className="rounded-full bg-white/10 px-1.5 py-px text-[0.55rem] font-bold uppercase text-white/50">
            {t('away')}
          </span>
        )}
        {p.broke && (
          <span className="rounded-full bg-rose-500/20 px-1.5 py-px text-[0.55rem] font-bold uppercase text-rose-300">
            {t('out')}
          </span>
        )}
        {engineCommitted > 0 && (
          <span className="flex h-6 min-w-6 items-center justify-center rounded-full bg-white/10 px-1.5 font-display text-xs font-bold text-amber-300">
            {fmt(engineCommitted)}
          </span>
        )}
      </div>
    </div>
  );
}

function MobileActions({
  rootRef,
  mySeat,
  isHost,
  urgent,
  statusText,
}: {
  mySeat: number | null;
  isHost: boolean;
  urgent: boolean;
  statusText: string | null;
  rootRef: RefObject<HTMLDivElement>;
}) {
  const hand = useStore((s) => s.hand);
  const room = useStore((s) => s.room);
  const connected = useStore((s) => s.wsConnected);
  const amountRef = useRef<HTMLInputElement>(null);
  const actionLatch = useRef(pokerActionLatch);
  const [raiseOpen, setRaiseOpen] = useState(false);
  const [raiseTo, setRaiseTo] = useState(0);
  const [sentAtSeq, setSentAtSeq] = useState<number | null>(null);
  const [showSentFor, setShowSentFor] = useState<string | null>(null);

  const st = hand.betting;
  const la = st ? legalActions(st) : null;
  const handOver = hand.result !== null || hand.abort !== null;
  const myTurn = la !== null && la.seat === mySeat && !handOver;
  const handIdle = !hand.handId || handOver;
  const sb = room?.room.sb ?? 1;
  const pot = st ? st.seats.reduce((s, x) => s + x.total, 0) : 0;

  useEffect(() => {
    if (myTurn && la) setRaiseTo(la.minRaiseTo);
    if (!myTurn) setRaiseOpen(false);
  }, [myTurn, la?.minRaiseTo, hand.actionSeq, hand.handId]); // eslint-disable-line react-hooks/exhaustive-deps

  const pending = sentAtSeq !== null;
  useEffect(() => {
    if (sentAtSeq !== null && (hand.actionSeq !== sentAtSeq || !myTurn)) setSentAtSeq(null);
  }, [hand.actionSeq, myTurn, sentAtSeq]);
  useEffect(() => {
    if (sentAtSeq === null) return;
    const sentHand = hand.handId;
    const timer = setTimeout(() => {
      setSentAtSeq(null);
      if (sentHand) actionLatch.current.release(sentHand, sentAtSeq);
    }, 6000);
    return () => clearTimeout(timer);
  }, [sentAtSeq, hand.handId]);
  const send = (a: Parameters<typeof act>[0]) => {
    if (
      !hand.handId ||
      !myTurn ||
      !connected ||
      pending ||
      settling ||
      !actionLatch.current.claim(hand.handId, hand.actionSeq)
    )
      return;
    setSentAtSeq(hand.actionSeq);
    amountRef.current?.blur();
    try {
      act(a);
    } catch (error) {
      actionLatch.current.release(hand.handId, hand.actionSeq);
      setSentAtSeq(null);
      useStore
        .getState()
        .pushError(error instanceof Error ? error.message : t('Could not send your action.'));
    }
  };

  // misclick guard: buttons go dead for a beat when the options change,
  // so a tap aimed at the old state cannot fire the new button
  const settling = useSettling(
    `${hand.handId}:${hand.actionSeq}:${myTurn}:${la?.canCheck ?? '-'}:${la?.callAmount ?? '-'}:${st?.currentBet ?? '-'}`,
  );

  const amountValid =
    !!la && Number.isInteger(raiseTo) && raiseTo >= la.minRaiseTo && raiseTo <= la.maxRaiseTo;
  const submitRaise = () => {
    if (myTurn && la?.canRaise && st && amountValid)
      send({ type: st.currentBet === 0 ? 'bet' : 'raise', amount: raiseTo });
  };
  const { binding, amountInput } = usePokerHotkeys({
    mySeat,
    myTurn,
    pending,
    settling,
    raiseTo,
    onAmount: (amount) => {
      setRaiseTo(amount);
      setRaiseOpen(true);
    },
    send,
    onConfirm: submitRaise,
    rootRef,
    amountRef,
  });

  // pre-deal ready check
  const myUserId = useStore((s) => s.auth.userId);
  const rit = !handIdle ? hand.ritOffer : null;
  const rc = handIdle ? hand.readyCheck : null;
  const amEligible = rc !== null && myUserId !== null && rc.eligible.includes(myUserId);
  const amReady = rc !== null && myUserId !== null && rc.ready.includes(myUserId);

  const ghost =
    'flex-1 rounded-full border border-white/25 px-4 py-3 text-center text-sm font-semibold text-white active:scale-[0.98]';

  const myStack = room?.players.find((pl) => pl.seat === mySeat)?.stack ?? 0;

  // voluntary card show: available once you folded, or when the hand is over
  const iFolded = !!st?.seats.find((s) => s.seat === mySeat)?.folded;
  const dealtIn =
    mySeat !== null && hand.seats.some((s) => s.seat === mySeat) && hand.myCards.length > 0;
  const alreadyPublic =
    mySeat !== null &&
    (!!hand.shown[mySeat] || !!hand.showdown?.reveals.some((r) => r.seat === mySeat));
  const canShow = dealtIn && !alreadyPublic && (iFolded || handOver);
  const showBtn = canShow ? (
    <button
      disabled={showSentFor === hand.handId}
      onClick={() => {
        setShowSentFor(hand.handId);
        showMyCards();
      }}
      className="mx-auto block rounded-full border border-white/25 px-4 py-1.5 text-xs font-semibold text-white/80 active:scale-[0.98] disabled:opacity-50"
    >
      {t('Show cards')}
    </button>
  ) : null;

  // everyone is all-in: vote on dealing the rest of the board twice
  if (rit && mySeat !== null && rit.voters.includes(mySeat) && !rit.voted) {
    return (
      <div className="space-y-2">
        <p className="text-center text-sm font-semibold text-fuchsia-300">{t('🔁 Run it twice?')}</p>
        <div className="flex gap-2">
          <button
            onClick={() => ritVote(true)}
            className="flex-1 rounded-full bg-fuchsia-500 py-3 text-sm font-bold text-white active:scale-[0.98]"
          >
            {t('Twice 🔁')}
          </button>
          <button
            onClick={() => ritVote(false)}
            className="flex-1 rounded-full border border-white/25 py-3 text-sm font-semibold text-white active:scale-[0.98]"
          >
            {t('Once')}
          </button>
        </div>
      </div>
    );
  }

  if (handIdle) {
    return (
      <div className="space-y-2">
        {showBtn}
        {rc ? (
          amEligible && !amReady ? (
            <button
              onClick={imReady}
              className="w-full animate-pulse rounded-full bg-emerald-500 py-3 text-sm font-bold text-white active:scale-[0.98]"
            >
              {t("✋ I'm ready · {a}/{b}", { a: rc.ready.length, b: rc.eligible.length })}
            </button>
          ) : (
            <p className="py-2 text-center text-sm text-emerald-300">
              {t(amReady ? '✓ You are ready' : 'Ready check')} ·{' '}
              {t('{a}/{b} — dealing without the rest shortly', {
                a: rc.ready.length,
                b: rc.eligible.length,
              })}
            </p>
          )
        ) : mySeat !== null && myStack === 0 ? (
          <p className="py-2 text-center text-sm font-semibold text-rose-300">
            {t('You are out of chips. Buy points from the bank (menu, top right).')}
          </p>
        ) : hand.autoDealAt && hand.autoDealAt > Date.now() ? (
          <p className="py-2 text-center text-sm text-white/50">
            {t('Automatic ready check soon. Menu → sit out if you need a break.')}
          </p>
        ) : isHost ? (
          <button
            onClick={startHand}
            className="w-full rounded-full bg-white py-3 text-sm font-bold text-slate-900 active:scale-[0.98]"
          >
            {t('Start hand')}
          </button>
        ) : (
          <p className="py-2 text-center text-sm text-white/50">
            {room?.autoDealPaused
              ? t('Auto-deal paused. Table menu → Auto-deal.')
              : room?.room.autoDeal
                ? t('Waiting for two online players with chips.')
                : t('Waiting for the host to deal.')}
          </p>
        )}
      </div>
    );
  }

  if (!myTurn || !la || !st) {
    const canPreAct = !iFolded && dealtIn && !!st && mySeat !== null;
    return (
      <div className="space-y-2">
        {showBtn}
        {canPreAct && (
          <div className="flex gap-1.5">
            {preActionOptions(st!, mySeat!).map((pa) => (
              <button
                key={pa.key}
                disabled={settling}
                onClick={() => togglePreAction(pa.key, st!, mySeat!)}
                className={cn(
                  'flex-1 rounded-full border px-2 py-2 text-xs font-semibold',
                  hand.preAction === pa.key
                    ? 'border-white bg-white text-slate-900'
                    : 'border-white/25 text-white/70',
                )}
              >
                {pa.label}
              </button>
            ))}
          </div>
        )}
        <p className="py-2 text-center text-sm text-white/50">{statusText ?? t('Waiting…')}</p>
      </div>
    );
  }

  const potRaise = (frac: number) => {
    const target = st.currentBet + Math.round((pot + la.callAmount) * frac);
    return Math.min(Math.max(Math.round(target / sb) * sb, la.minRaiseTo), la.maxRaiseTo);
  };

  return (
    <div className="space-y-2.5">
      {raiseOpen && la.canRaise && (
        <div className="space-y-2.5 rounded-2xl bg-white/5 p-3">
          <div className="flex gap-1.5">
            {[
              { label: t('Min'), value: la.minRaiseTo },
              { label: t('½ pot'), value: potRaise(0.5) },
              { label: t('Pot'), value: potRaise(1) },
              { label: t('All-in'), value: la.maxRaiseTo },
            ].map((q) => (
              <button
                key={q.label}
                disabled={pending}
                onClick={() =>
                  send(
                    st.currentBet === 0
                      ? { type: 'bet', amount: q.value }
                      : { type: 'raise', amount: q.value },
                  )
                }
                className="flex-1 rounded-full bg-white/10 px-2 py-1.5 text-xs font-semibold text-white/80 active:bg-white active:text-slate-900 disabled:opacity-50"
              >
                {q.label} · {fmt(q.value)}
              </button>
            ))}
          </div>
          <label className="flex flex-wrap items-center gap-2 text-xs text-white">
            {t('Amount')}
            <input
              ref={amountRef}
              type="number"
              inputMode="numeric"
              min={la.minRaiseTo}
              max={la.maxRaiseTo}
              step={1}
              value={Number.isNaN(raiseTo) ? '' : raiseTo}
              disabled={pending || settling}
              aria-label={t('Bet or raise amount')}
              aria-keyshortcuts={binding('raise')}
              {...amountInput}
              onChange={(e) => setRaiseTo(e.target.value === '' ? NaN : +e.target.value)}
              className="min-h-10 w-28 rounded-lg border border-white/25 bg-white/10 px-2 text-sm"
            />
            <span>{t('Enter to confirm')}</span>
          </label>
          {!amountValid && (
            <p role="status" className="text-xs text-white/70">
              {t('Enter a whole-chip amount from {min} to {max}.', {
                min: fmt(la.minRaiseTo),
                max: fmt(la.maxRaiseTo),
              })}
            </p>
          )}
          <input
            type="range"
            min={la.minRaiseTo}
            max={la.maxRaiseTo}
            step={sb}
            value={raiseTo}
            onChange={(e) => setRaiseTo(+e.target.value)}
            className="w-full accent-white"
            aria-label={t('Raise amount')}
          />
          <button
            disabled={pending || settling || !amountValid}
            onClick={submitRaise}
            className="w-full rounded-full bg-white py-2.5 text-sm font-bold text-slate-900 active:scale-[0.98] disabled:opacity-50"
          >
            {st.currentBet === 0
              ? t('Bet {n}', { n: fmt(raiseTo) })
              : t('Raise to {n}', { n: fmt(raiseTo) })}
          </button>
        </div>
      )}
      {pending && (
        <p className="flex items-center justify-center gap-1.5 text-xs text-white/60">
          <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/25 border-t-white" />
          {t('Sending…')}
        </p>
      )}
      {/* your turn, unmistakably: the whole row breathes inside a hot ring and
          the button you most likely want is the bright one */}
      <div className="relative rounded-full p-1">
        <span
          aria-hidden
          className={cn(
            'pointer-events-none absolute inset-0 rounded-3xl ring-2 animate-pulse motion-reduce:animate-none',
            urgent ? 'bg-rose-500/10 ring-rose-400/90' : 'bg-indigo-500/10 ring-indigo-300/90',
          )}
        />
        <div
          className={cn(
            'relative flex gap-2',
            (pending || settling) && 'pointer-events-none opacity-50',
          )}
        >
          <button
            onClick={() => send({ type: 'fold' })}
            disabled={pending || settling}
            aria-keyshortcuts={binding('fold')}
            className={cn(ghost, 'border-rose-500/40 text-rose-300')}
          >
            {t('Fold')}
          </button>
          <button
            onClick={() => send(la.canCheck ? { type: 'check' } : { type: 'call' })}
            disabled={pending || settling}
            aria-keyshortcuts={binding(la.canCheck ? 'check' : 'call')}
            className={cn(
              ghost,
              'border-indigo-300/80 bg-indigo-500/35 font-bold shadow-[0_0_18px_rgba(99,102,241,0.35)]',
            )}
          >
            {la.canCheck ? t('Check') : t('Call {n}', { n: fmt(la.callAmount) })}
          </button>
          {la.canRaise && (
            <button
              onClick={() => setRaiseOpen((v) => !v)}
              className={cn(ghost, 'border-amber-300/70 text-amber-200', raiseOpen && 'border-white bg-white/10')}
            >
              {t('Raise')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export function MobileTable({
  opponents,
  me,
  mySeat,
  isHost,
  myCards,
  board,
  pot,
  urgent,
  statusText,
  dimBoard,
}: {
  opponents: SeatView[];
  me: SeatView | undefined;
  mySeat: number | null;
  isHost: boolean;
  myCards: CardId[];
  board: CardId[];
  pot: number;
  urgent: boolean;
  statusText: string | null;
  dimBoard: boolean;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const myCommitted = useStore(
    (s) => s.hand.betting?.seats.find((x) => x.seat === mySeat)?.committed ?? 0,
  );
  const roomMe = useStore((s) => s.room?.players.find((p) => p.seat === mySeat));
  const bought = roomMe?.totalBought ?? 0;
  const net = (roomMe?.stack ?? 0) - bought;
  const board2 = useStore((s) => s.hand.board2);
  const strength = me && me.inHand ? strengthLabel(myCards, board) : null;

  // ── (A) your turn, on a phone: the game client already pings the turn
  // sound, so the cue here is visual + haptic: a banner that holds until you
  // act (toAct moves = banner goes), a hot ring around the action row, and a
  // buzz pattern on devices that support vibration.
  const turnHandId = useStore((s) => s.hand.handId);
  const turnActionSeq = useStore((s) => s.hand.actionSeq);
  const myTurnNow = !!me?.isToAct;
  const [turnCue, setTurnCue] = useState(false);
  const buzzedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!myTurnNow) {
      setTurnCue(false);
      buzzedFor.current = null;
      return;
    }
    setTurnCue(true);
    const key = `${turnHandId}:${turnActionSeq}`;
    if (buzzedFor.current !== key) {
      buzzedFor.current = key;
      try {
        if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
          navigator.vibrate([90, 60, 90]);
        }
      } catch {
        /* haptics are best-effort; never break the table for them */
      }
    }
  }, [myTurnNow, turnHandId, turnActionSeq]);

  // ── (B) the win moment: WIN tags live on the cards (see OpponentColumn /
  // the identity tile); here we measure pot -> winner tiles for the chip fly.
  const winners = [me, ...opponents].filter((p): p is SeatView => !!p && p.won);
  const fxLit = useWinnerFx(winners.length > 0);
  const potRef = useRef<HTMLDivElement | null>(null);
  const seatEls = useRef<Record<number, HTMLDivElement | null>>({});

  return (
    <div ref={rootRef} className="flex min-h-0 flex-1 flex-col px-4 pb-4 pt-3 text-white">
      <AnimatePresence>
        {turnCue && (
          <motion.div
            key="turn-cue"
            role="status"
            aria-live="assertive"
            initial={{ y: -20, opacity: 0, scale: 0.92 }}
            animate={{ y: 0, opacity: 1, scale: 1 }}
            exit={{ y: -14, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 460, damping: 26 }}
            className="fixed inset-x-0 top-[3.3rem] z-50 mx-auto flex w-max items-center gap-2.5 rounded-2xl bg-gradient-to-b from-amber-300 to-amber-400 px-5 py-2.5 text-slate-950 shadow-[0_10px_34px_rgba(251,191,36,0.5)] ring-2 ring-amber-200/80"
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
      </AnimatePresence>

      {/* opponents */}
      <div className="flex justify-center gap-2 overflow-x-auto pb-1">
        {opponents.length === 0 ? (
          <p className="py-3 text-sm text-white/50">{t('Waiting for friends to sit down…')}</p>
        ) : (
          opponents.map((p) => (
            <OpponentColumn
              key={p.seat}
              p={p}
              urgent={urgent}
              tileRef={(el) => {
                seatEls.current[p.seat] = el;
              }}
            />
          ))
        )}
      </div>

      {/* board */}
      <div
        className={cn(
          'flex flex-1 flex-col items-center justify-center gap-3',
          dimBoard && 'opacity-40 saturate-50',
        )}
      >
        <div className="flex gap-1.5">
          {[0, 1, 2, 3, 4].map((i) =>
            board[i] !== undefined ? (
              <PlayingCard
                key={`${i}-${board[i]}`}
                card={board[i]}
                size="md"
                deal
                className="shadow-lg"
              />
            ) : (
              <div key={i} className="card-hatch h-24 w-[4.2rem] rounded-xl shadow-lg" />
            ),
          )}
        </div>
        {board2.length > 0 && (
          <div className="flex items-center gap-1.5">
            <span className="rounded-full bg-fuchsia-500/20 px-1.5 py-0.5 text-[0.6rem] font-bold uppercase text-fuchsia-300">
              {t('Run {n}', { n: 2 })}
            </span>
            {board2.map((c) => (
              <PlayingCard key={`r2-${c}`} card={c} size="sm" deal />
            ))}
          </div>
        )}
        <div ref={potRef} className="flex w-full items-baseline justify-end gap-2 pr-2">
          <span className="text-xs uppercase tracking-wide text-white/60">{t('pot')}</span>
          <span className="font-display text-3xl font-bold">
            <NumberFlow value={pot} />
          </span>
        </div>
      </div>

      {/* my bet chip */}
      <div className="h-8 pl-1">
        {myCommitted > 0 && (
          <span className="inline-flex h-7 min-w-7 items-center justify-center rounded-full bg-white/10 px-2 font-display text-sm font-bold text-amber-300">
            {fmt(myCommitted)}
          </span>
        )}
      </div>

      {/* actions */}
      <MobileActions
        mySeat={mySeat}
        isHost={isHost}
        urgent={urgent}
        statusText={statusText}
        rootRef={rootRef}
      />
      <div className="mt-2 flex justify-end">
        <PokerShortcutButton className="text-white/70! hover:bg-white/10!" />
      </div>

      {/* hole cards + identity tile */}
      <div className="mt-4 flex items-end justify-between gap-3">
        <div className={cn('flex', me?.folded && 'opacity-40')}>
          {me && me.inHand && (myCards.length > 0 || !me.folded) ? (
            myCards.length ? (
              myCards.map((c, i) => (
                <PlayingCard
                  key={c}
                  card={c}
                  size="xl"
                  deal
                  className={cn('shadow-2xl', i === 1 && '-ml-7')}
                />
              ))
            ) : (
              <>
                <PlayingCard faceDown size="xl" />
                <PlayingCard faceDown size="xl" className="-ml-7" />
              </>
            )
          ) : null}
        </div>
        {me && (
          <div
            ref={(el) => {
              seatEls.current[me.seat] = el;
            }}
            className={cn(
              'relative flex min-w-28 flex-col items-center gap-1 rounded-2xl border border-white/20 px-4 py-3',
              me.isToAct && 'turn-stripes-dark border-indigo-400 bg-indigo-500/10',
              me.isToAct &&
                urgent &&
                'turn-stripes-dark-rose border-rose-500 bg-rose-500/10 animate-urgent',
              me.isLeader && !me.isToAct && 'border-amber-400/80',
              me.won && 'animate-winner',
            )}
          >
            {me.won && (
              <span className="absolute -top-3 left-1/2 z-20 -translate-x-1/2">
                <WinBadge amount={me.wonAmount ?? 0} />
              </span>
            )}
            {strength && (
              <span className="text-xs font-semibold text-white/80">{tHandCategory(strength)}</span>
            )}
            <span className="relative">
              <Avatar
                userId={me.userId}
                name={me.displayName}
                version={me.avatarVersion}
                size="sm"
                speaking={me.speaking}
              />
              {me.isLeader && (
                <span className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-amber-400 text-white">
                  <Crown size={9} weight="fill" />
                </span>
              )}
            </span>
            <span className={cn('font-display text-lg font-bold', me.broke && 'text-rose-400')}>
              <StackValue stack={me.stack} won={me.won} />
            </span>
            {bought > 0 && (
              <span className="text-[0.6rem] text-white/50">
                {t('in {n}', { n: fmt(bought) })} ·{' '}
                <span className={net >= 0 ? 'text-emerald-300' : 'text-rose-300'}>
                  {net >= 0 ? `+${fmt(net)}` : `-${fmt(-net)}`}
                </span>
              </span>
            )}
          </div>
        )}
      </div>

      {/* the payoff: chips sweep from the pot into the winner's tile, and the
          stack number only bumps once they land (see StackValue) */}
      {fxLit &&
        winners.map((w) => (
          <ChipFlight
            key={`fly-${w.seat}`}
            run={fxLit}
            discs={winners.length === 1 ? 6 : 4}
            getFrom={() => potRef.current}
            getTo={() => seatEls.current[w.seat] ?? null}
          />
        ))}
    </div>
  );
}
