import { useEffect, useMemo, useRef, useState } from 'react';
import NumberFlow from '@number-flow/react';
import { legalActions, type PokerHotkeyAction, type PlayerAction } from '@4am/shared';
import { act, imReady, showMyCards, startHand } from '../../shared/gameClient.ts';
import { useStore } from '../../shared/store.ts';
import { ALL_IN_RATIO } from '../../shared/store.ts';
import { cn, fmt } from '../../shared/lib/cn.ts';
import { HourglassMedium } from '@phosphor-icons/react';
import { Button } from '../../shared/ui/index.tsx';
import { myToCall, togglePreAction } from '../../features/table/preActions.ts';
import { usePokerHotkeys } from '../../features/table/usePokerHotkeys.ts';
import { pokerActionLatch } from '../../features/table/pokerHotkeys.ts';
import { useSettling } from '../../features/table/useSettling.ts';
import { t } from '../../shared/i18n/index.ts';

/** A8 (docs/table-redesign-spec.md), the user's GGPoker reference: the betting
 *  area is a COMPACT widget anchored bottom-right of the table area -
 *  percentage quick-size pills, slider + numeric amount (chips AND BB), the
 *  big 弃牌 / 跟注 N / 加注至 N buttons, and a circular action-timer ring.
 *  This is layout only: the act()/latch/settling/hotkey flow mirrors
 *  ActionBar.tsx (which the 3D lounge still owns) rule for rule. */

const bbOf = (amount: number, bb: number): number =>
  Math.max(0, Math.round(amount / Math.max(1, bb)));

/** The action-clock ring next to the amount. When the time-bank feature (P2 B2)
 *  lands server-side, this is the dial that grows the bank track: `totalMs`
 *  becomes remaining+bank instead of the plain turn window. */
function CountdownRing({ deadline, actionSecs }: { deadline: number | null; actionSecs: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!deadline) return;
    const iv = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(iv);
  }, [deadline]);
  if (!deadline || actionSecs <= 0) return null;
  const totalMs = actionSecs * 1000;
  const remainMs = Math.max(0, deadline - now);
  const frac = Math.min(1, remainMs / totalMs);
  const secs = Math.max(0, Math.ceil(remainMs / 1000));
  const hot = secs <= 10;
  const CIRC = 2 * Math.PI * 15;
  return (
    <span
      className="relative inline-flex h-10 w-10 shrink-0 items-center justify-center"
      role="timer"
      aria-label={t('time remaining to act')}
      title={t('time remaining to act')}
    >
      <svg viewBox="0 0 36 36" className="h-10 w-10 -rotate-90" aria-hidden="true">
        <circle cx="18" cy="18" r="15" fill="none" strokeWidth="3.5" className="stroke-white/15" />
        <circle
          cx="18"
          cy="18"
          r="15"
          fill="none"
          strokeWidth="3.5"
          strokeLinecap="round"
          strokeDasharray={`${frac * CIRC} ${CIRC}`}
          className={cn('transition-[stroke] duration-300', hot ? 'stroke-rose-400' : 'stroke-indigo-300')}
        />
      </svg>
      <span
        className={cn(
          'absolute font-display text-[0.7rem] font-bold tabular-nums',
          hot ? 'text-rose-300' : 'text-white/90',
        )}
      >
        {secs}
      </span>
    </span>
  );
}

export function BettingPanel({
  mySeat,
  isHost,
  urgent,
  hideIdleStart = false,
}: {
  mySeat: number | null;
  isHost: boolean;
  urgent: boolean;
  hideIdleStart?: boolean;
}) {
  const hand = useStore((s) => s.hand);
  const room = useStore((s) => s.room);
  const myUserId = useStore((s) => s.auth.userId);
  // A10: quick sizes come from the account's pot-ratio slots, like ActionBar.
  const betRatios = useStore((s) => s.prefs.betRatios);
  const connected = useStore((s) => s.wsConnected);
  const rootRef = useRef<HTMLDivElement>(null);
  const amountRef = useRef<HTMLInputElement>(null);
  const actionLatch = useRef(pokerActionLatch);
  const [raiseTo, setRaiseTo] = useState(0);

  const st = hand.betting;
  const la = useMemo(() => (st ? legalActions(st) : null), [st]);
  const handOver = hand.result !== null || hand.abort !== null;
  const myTurn = la !== null && la.seat === mySeat && !handOver;
  const me = st?.seats.find((s) => s.seat === mySeat);
  const roomMe = room?.players.find((p) => p.seat === mySeat);
  const balance = me && !handOver ? me.stack : (roomMe?.stack ?? 0);
  const pot = st ? st.seats.reduce((s, x) => s + x.total, 0) : 0;
  const bb = room?.room.bb ?? 1;
  const handIdle = !hand.handId || handOver;
  const sb = room?.room.sb ?? 1;

  useEffect(() => {
    if (myTurn && la) setRaiseTo(la.minRaiseTo);
  }, [myTurn, la?.minRaiseTo, hand.actionSeq, hand.handId]); // eslint-disable-line react-hooks/exhaustive-deps

  // voluntary card show: available once you folded, or when the hand is over
  const iFolded = !!st?.seats.find((s) => s.seat === mySeat)?.folded;
  const dealtIn =
    mySeat !== null && hand.seats.some((s) => s.seat === mySeat) && hand.myCards.length > 0;
  const alreadyPublic =
    mySeat !== null &&
    (!!hand.shown[mySeat] || !!hand.showdown?.reveals.some((r) => r.seat === mySeat));
  const canShow = dealtIn && !alreadyPublic && (iFolded || handOver);
  const [showSentFor, setShowSentFor] = useState<string | null>(null);

  // pre-select an action before your turn; the game client fires it when you are to act
  const canPreAct = !handIdle && !iFolded && dealtIn && !myTurn && !!st;

  // players still in the hand whose connection dropped: the hand holds for them
  const disconnected =
    !handIdle && room
      ? hand.seats
          .filter((s) => !hand.betting?.seats.find((b) => b.seat === s.seat)?.folded)
          .filter((s) => room.players.some((p) => p.userId === s.userId && !p.connected))
          .map((s) => room.players.find((p) => p.userId === s.userId)?.displayName ?? s.username)
      : [];

  // pending: an action left this device but the table has not updated yet
  const [sentAtSeq, setSentAtSeq] = useState<number | null>(null);
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
  }, [sentAtSeq, hand.handId]); // eslint-disable-line react-hooks/exhaustive-deps
  const send = (a: PlayerAction) => {
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

  // misclick guard: the moment my options change the buttons go dead for a beat
  const settling = useSettling(
    `${hand.handId}:${hand.actionSeq}:${myTurn}:${la?.canCheck ?? '-'}:${la?.callAmount ?? '-'}:${st?.currentBet ?? '-'}`,
  );

  const amountValid =
    !!la && Number.isInteger(raiseTo) && raiseTo >= la.minRaiseTo && raiseTo <= la.maxRaiseTo;
  const submitRaise = () => {
    if (!myTurn || !la?.canRaise || !st || !amountValid) return;
    send({ type: st.currentBet === 0 ? 'bet' : 'raise', amount: raiseTo });
  };
  const { binding, amountInput } = usePokerHotkeys({
    mySeat,
    myTurn,
    pending,
    settling,
    raiseTo,
    onAmount: setRaiseTo,
    send,
    onConfirm: submitRaise,
    rootRef,
    amountRef,
  });
  const hint = (action: PokerHotkeyAction) =>
    binding(action) ? (
      <kbd
        aria-hidden="true"
        className="ml-1 rounded border border-current/30 px-1 font-sans text-[10px] opacity-80"
      >
        {binding(action)}
      </kbd>
    ) : null;

  // pre-deal ready check
  const rc = handIdle ? hand.readyCheck : null;
  const amEligible = rc !== null && myUserId !== null && rc.eligible.includes(myUserId);
  const amReady = rc !== null && myUserId !== null && rc.ready.includes(myUserId);
  const [nowTick, setNowTick] = useState(() => Date.now());
  useEffect(() => {
    if (!rc) return;
    const timer = setInterval(() => setNowTick(Date.now()), 500);
    return () => clearInterval(timer);
  }, [rc !== null]); // eslint-disable-line react-hooks/exhaustive-deps
  const readySecs = rc ? Math.max(0, Math.ceil((rc.deadlineTs - nowTick) / 1000)) : 0;

  /** Sensible raise-to for a fraction of the pot (pot counted after our call). */
  const potRaise = (frac: number): number => {
    if (!la || !st) return 0;
    const target = st.currentBet + Math.round((pot + la.callAmount) * frac);
    const snapped = Math.round(target / sb) * sb;
    return Math.min(Math.max(snapped, la.minRaiseTo), la.maxRaiseTo);
  };

  // GGPoker-style pills: the ADDED bet as % of the post-call pot. All-in keeps
  // its word label; clamped duplicates collapse like on the action bar.
  const quicks = (() => {
    if (!la || !st) return [];
    const base = Math.max(1, pot + la.callAmount);
    const seen = new Set<number>();
    const out: { label: string; value: number }[] = [];
    for (const frac of betRatios) {
      const value = frac === ALL_IN_RATIO ? la.maxRaiseTo : potRaise(frac);
      if (seen.has(value)) continue;
      seen.add(value);
      out.push({
        label:
          frac === ALL_IN_RATIO
            ? t('All-in')
            : `${Math.max(1, Math.round(((value - la.callAmount) / base) * 100))}%`,
        value,
      });
    }
    return out;
  })();

  const waitingOn = st
    ? (room?.players.find((p) => p.seat === st.toAct)?.displayName ??
      t('Seat {n}', { n: st.toAct !== null ? st.toAct + 1 : '-' }))
    : null;

  const statusMsg = myTurn
    ? t('Your turn.')
    : handIdle
      ? balance === 0
        ? t('Out of chips. Chips menu → Buy points.')
        : hand.autoDealAt && hand.autoDealAt > Date.now()
          ? t('Automatic ready check soon…')
          : room?.autoDealPaused
            ? t('Auto-deal paused. Table menu → Auto-deal.')
            : isHost
              ? t('Deal when ready.')
              : room?.room.autoDeal
                ? t('Waiting for two online players with chips…')
                : t('Host deals soon…')
      : disconnected.length > 0
        ? t('Holding ~40s for {names}…', { names: disconnected.join(', ') })
        : st
          ? t('{name}…', { name: waitingOn ?? '' })
          : t('Shuffling…');

  return (
    <div
      ref={rootRef}
      role="group"
      aria-label={t('Betting controls')}
      className={cn(
        'poker-action-bar poker-betting-panel w-[min(18.5rem,calc(100vw-6.5rem))] rounded-2xl bg-slate-900/90 p-2.5 text-white shadow-[0_16px_44px_rgba(2,6,23,0.5)] ring-1 ring-white/10 backdrop-blur-sm',
        myTurn && 'ring-indigo-300/50',
        myTurn && urgent && 'animate-urgent',
      )}
    >
      {pending && (
        <p className="mb-1.5 flex items-center justify-center gap-1.5 text-[0.68rem] text-indigo-200">
          <span className="h-3 w-3 animate-spin rounded-full border-2 border-white/30 border-t-white" />
          {t('Sending…')}
        </p>
      )}

      {rc ? (
        <div className="flex flex-col gap-1.5">
          {amEligible && !amReady ? (
            <Button variant="success" className="w-full animate-pulse" onClick={imReady}>
              {t("I'm ready · {n}s", { n: readySecs })}
            </Button>
          ) : (
            <p className="text-xs font-semibold text-emerald-300">
              {amReady ? t('✓ You are ready') : t('Ready check')}
            </p>
          )}
          <p className="text-[0.68rem] leading-snug text-white/60">
            {t('{a}/{b} ready · deals in {n}s, without the rest', {
              a: rc.ready.length,
              b: rc.eligible.length,
              n: readySecs,
            })}
          </p>
        </div>
      ) : myTurn && la && st ? (
        <div className="flex flex-col gap-2">
          {/* amount (chips + BB) with the action-clock ring */}
          <div className="flex items-end justify-between gap-2">
            <label className="min-w-0 text-[0.62rem] uppercase tracking-wide text-white/55">
              {st.currentBet === 0 ? t('Bet amount') : t('Raise to')}
              <span className="mt-0.5 flex items-baseline gap-1.5 normal-case tracking-normal">
                <input
                  ref={amountRef}
                  type="number"
                  inputMode="numeric"
                  min={la.minRaiseTo}
                  max={la.maxRaiseTo}
                  step={1}
                  value={Number.isNaN(raiseTo) ? '' : raiseTo}
                  aria-label={t('Bet or raise amount')}
                  aria-keyshortcuts={binding('raise')}
                  disabled={pending || settling}
                  {...amountInput}
                  onChange={(e) => setRaiseTo(e.target.value === '' ? NaN : +e.target.value)}
                  className="min-h-8 w-24 min-w-0 rounded-lg border border-white/25 bg-white/10 px-2 py-1 font-display text-sm font-bold outline-none focus:ring-2 focus:ring-white/60"
                />
                <span className="font-display text-[0.7rem] font-semibold text-white/60">
                  {bbOf(raiseTo, bb)} BB
                </span>
              </span>
            </label>
            <CountdownRing deadline={hand.deadline} actionSecs={room?.room.actionSecs ?? 45} />
          </div>
          {/* slider, min/max marked in BB (GGPoker-style) */}
          <div className="flex items-center gap-2">
            <span className="font-display text-[0.62rem] text-white/50">
              {bbOf(la.minRaiseTo, bb)}
            </span>
            <input
              type="range"
              min={la.minRaiseTo}
              max={la.maxRaiseTo}
              step={sb}
              value={raiseTo}
              onChange={(e) => setRaiseTo(+e.target.value)}
              className="h-1.5 min-w-0 flex-1 cursor-pointer appearance-none rounded-full bg-indigo-400/60 accent-white"
              aria-label={t('Raise amount')}
            />
            <span className="font-display text-[0.62rem] text-white/50">
              {bbOf(la.maxRaiseTo, bb)}
            </span>
          </div>
          {/* percentage quick pills (A10-configurable slots, % of pot) */}
          <div className="flex flex-wrap gap-1.5">
            {quicks.map((q) => (
              <button
                key={q.label}
                disabled={pending || settling}
                onClick={() =>
                  send(
                    st.currentBet === 0
                      ? { type: 'bet', amount: q.value }
                      : { type: 'raise', amount: q.value },
                  )
                }
                className="rounded-full bg-white/12 px-2.5 py-1 font-display text-[0.72rem] font-bold text-white/90 transition-colors hover:bg-white hover:text-indigo-700 disabled:opacity-50"
              >
                {q.label}
              </button>
            ))}
          </div>
          {!amountValid && (
            <p role="status" className="text-[0.68rem] leading-snug text-rose-300">
              {t('Enter a whole-chip amount from {min} to {max}.', {
                min: fmt(la.minRaiseTo),
                max: fmt(la.maxRaiseTo),
              })}
            </p>
          )}
          {/* the big three */}
          <div className="grid grid-cols-3 gap-1.5">
            <Button
              variant="secondary"
              disabled={settling}
              className="h-11! min-h-11! border-0 bg-white/12! text-white! text-sm! hover:bg-white/20!"
              aria-keyshortcuts={binding('fold')}
              title={binding('fold') ? t('Fold ({key})', { key: binding('fold')! }) : t('Fold')}
              onClick={() => send({ type: 'fold' })}
            >
              <span className="flex flex-col items-center leading-tight">
                <span>
                  {t('Fold')}
                  {hint('fold')}
                </span>
              </span>
            </Button>
            <Button
              variant="success"
              disabled={settling}
              className="h-11! min-h-11! text-sm!"
              aria-keyshortcuts={binding(la.canCheck ? 'check' : 'call')}
              title={
                binding(la.canCheck ? 'check' : 'call')
                  ? t('Shortcut: {key}', { key: binding(la.canCheck ? 'check' : 'call')! })
                  : undefined
              }
              onClick={() =>
                send(la.canCheck ? { type: 'check' } : { type: 'call' })
              }
            >
              <span className="flex flex-col items-center leading-tight">
                <span>
                  {la.canCheck ? t('Check') : t('Call {n}', { n: fmt(la.callAmount) })}
                  {hint(la.canCheck ? 'check' : 'call')}
                </span>
                {!la.canCheck && (
                  <span className="text-[0.6rem] font-semibold opacity-80">
                    {bbOf(la.callAmount, bb)} BB
                  </span>
                )}
              </span>
            </Button>
            <Button
              variant="secondary"
              disabled={settling || !la.canRaise || !amountValid}
              className="h-11! min-h-11! border-0 bg-amber-400! text-[0.8rem]! text-slate-900! hover:bg-amber-300!"
              title={la.canRaise ? undefined : t('Raising unlocks on your turn')}
              onClick={submitRaise}
            >
              <span className="flex flex-col items-center leading-tight">
                <span>
                  {st.currentBet === 0
                    ? t('Bet {n}', { n: fmt(raiseTo) })
                    : t('Raise to {n}', { n: fmt(raiseTo) })}
                </span>
                <span className="text-[0.6rem] font-semibold opacity-80">
                  {bbOf(raiseTo, bb)} BB
                </span>
              </span>
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <p className="min-w-0 break-words text-xs font-medium text-white/75">{statusMsg}</p>
          {canPreAct && st && mySeat !== null && (
            <div className="flex flex-wrap items-center gap-1.5">
              <HourglassMedium size={14} className="text-white/40" aria-label={t('Ahead of turn')} />
              <button
                onClick={() => !settling && togglePreAction('call-any', st, mySeat)}
                disabled={settling}
                className={cn(
                  'rounded-full px-2.5 py-1 text-[0.68rem] font-semibold transition-colors',
                  hand.preAction === 'call-any'
                    ? 'bg-indigo-500 text-white'
                    : 'bg-white/10 text-white/70 hover:bg-white/20',
                )}
                title={t('Arms now, acts on your turn')}
              >
                {t('Call any')}
              </button>
              <button
                onClick={() => !settling && togglePreAction('check-fold', st, mySeat)}
                disabled={settling}
                className={cn(
                  'rounded-full px-2.5 py-1 text-[0.68rem] font-semibold transition-colors',
                  hand.preAction === 'check-fold'
                    ? 'bg-indigo-500 text-white ring-2 ring-indigo-300'
                    : 'bg-white/10 text-white/70 hover:bg-white/20',
                )}
                title={t('Arms now, acts on your turn')}
              >
                {myToCall(st, mySeat) === 0 ? t('Check / Fold') : t('Fold')}
              </button>
              <button
                onClick={() =>
                  !settling && togglePreAction(myToCall(st, mySeat) > 0 ? 'call' : 'check', st, mySeat)
                }
                disabled={settling}
                className={cn(
                  'rounded-full px-2.5 py-1 text-[0.68rem] font-semibold transition-colors',
                  hand.preAction === 'call' || hand.preAction === 'check'
                    ? 'bg-emerald-500 text-white ring-2 ring-emerald-300'
                    : 'bg-white/10 text-white/70 hover:bg-white/20',
                )}
                title={t('Arms now, acts on your turn')}
              >
                {myToCall(st, mySeat) > 0
                  ? t('Call {n}', { n: fmt(myToCall(st, mySeat)) })
                  : t('Check')}
              </button>
            </div>
          )}
          {canShow && (
            <Button
              variant="secondary"
              className="w-full border-0 bg-white/12! text-white! hover:bg-white/20!"
              disabled={showSentFor === hand.handId}
              onClick={() => {
                setShowSentFor(hand.handId);
                showMyCards();
              }}
            >
              {t('Show cards')}
            </Button>
          )}
          {handIdle && isHost && !hideIdleStart && (
            <Button
              variant="secondary"
              className="poker-start-button w-full border-0 bg-white! text-indigo-700! hover:bg-indigo-50!"
              onClick={startHand}
            >
              {t('Start hand')}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
