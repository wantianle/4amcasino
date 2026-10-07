import { useEffect, useMemo, useRef, useState } from 'react';
import NumberFlow from '@number-flow/react';
import { legalActions, type PokerHotkeyAction, type PlayerAction } from '@4am/shared';
import { act, imReady, showMyCards, startHand } from '../../shared/gameClient.ts';
import { useStore } from '../../shared/store.ts';
import { presetLabel, presetRaiseTo, snapRaiseTo as snapRaise } from '../../features/table/betPresets.ts';
import { cn, fmt } from '../../shared/lib/cn.ts';
import { bbValue } from '../../shared/lib/bb.ts';
import { ACTION_TIMEOUT_MS } from '../../shared/lib/tableTimers.ts';
import { HourglassMedium, Bomb, Timer, Play } from '@phosphor-icons/react';
import { Button } from '../../shared/ui/index.tsx';
import { myToCall, togglePreAction } from '../../features/table/preActions.ts';
import { usePokerHotkeys } from '../../features/table/usePokerHotkeys.ts';
import { pokerActionLatch } from '../../features/table/pokerHotkeys.ts';
import { useSettling } from '../../features/table/useSettling.ts';
import { t } from '../../shared/i18n/index.ts';

/** The betting area: a COMPACT widget anchored bottom-right of the table -
 *  percentage quick-size pills, slider + numeric amount (chips AND BB), the
 *  big 弃牌 / 跟注 N / 加注至 N buttons, and a circular action-timer ring.
 *  Layout only: the act()/latch/settling/hotkey flow is the single table
 *  betting implementation. */

export function clampRaiseAmount(value: number, min: number, max: number, fallback = min): number {
  const safeFallback = Number.isFinite(fallback) ? fallback : min;
  const safeValue = Number.isFinite(value) ? value : safeFallback;
  return Math.max(min, Math.min(max, Math.round(safeValue)));
}

export function isRaiseAmountValid(value: number, min: number, max: number): boolean {
  return Number.isFinite(value) && Number.isInteger(value) && value >= min && value <= max;
}

/** Explicit keyboard/wheel movement; the native range step stays at one so
 * every legal integer (including an off-grid All-in max) remains representable. */
export function adjustRaiseByStep(value: number, delta: number, sb: number, min: number, max: number): number {
  return clampRaiseAmount(value + delta * sb, min, max, min);
}

/** The action-clock ring next to the amount: the window is the room's base
 *  action clock (`actionMs`, MILLISECONDS) PLUS the acting seat's bank, the
 *  base clock drains first, and once `baseDeadline` passes the remaining arc
 *  turns amber - you are visibly spending banked thinking time. The bank
 *  balance itself rides as a small chip under the ring so it is readable even
 *  while the base clock runs. */
function CountdownRing({
  deadline,
  baseDeadline,
  bankMs,
  actionMs,
}: {
  deadline: number | null;
  baseDeadline: number | null;
  bankMs: number;
  actionMs: number;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!deadline) return;
    const iv = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(iv);
  }, [deadline]);
  const arcRef = useRef<SVGCircleElement | null>(null);
  // shared by the rAF drain and the static arc: the ring circumference and the
  // full turn budget. The bank this turn is spending = however far the final
  // deadline reaches past the base clock (zero for rooms without a time bank).
  const CIRC = 2 * Math.PI * 15;
  const baseMs = actionMs;
  const bankWindow = baseDeadline !== null && deadline !== null ? Math.max(0, deadline - baseDeadline) : 0;
  const totalMs = baseMs + bankWindow;
  // L5 (spec row 7): the arc itself drains on requestAnimationFrame -
  // stroke-dashoffset only, linear, endAt = the server deadline. The 250ms
  // interval above still drives the readout digits; the ring never waits on
  // React. Reduced motion keeps this drain (it is required information).
  useEffect(() => {
    if (!deadline || actionMs <= 0) return;
    let raf = 0;
    const tick = () => {
      const f = Math.max(0, Math.min(1, (deadline - Date.now()) / totalMs));
      if (arcRef.current) arcRef.current.style.strokeDashoffset = String(CIRC * (1 - f));
      if (Date.now() < deadline) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [deadline, baseDeadline, actionMs, totalMs]);
  if (!deadline || actionMs <= 0) return null;
  const baseLeft = Math.max(0, Math.min((baseDeadline ?? deadline) - now, baseMs));
  const bankLeft = baseDeadline ? Math.max(0, deadline - Math.max(now, baseDeadline)) : 0;
  const remainMs = Math.max(0, deadline - now);
  const frac = Math.min(1, remainMs / totalMs);
  const secs = Math.max(0, Math.ceil(remainMs / 1000));
  const hot = secs <= 10;
  const spending = baseLeft === 0 && bankWindow > 0;
  const bankSecs = Math.ceil((spending ? bankLeft : bankMs) / 1000);
  return (
    <span className="relative inline-flex h-10 w-10 shrink-0 flex-col items-center justify-center">
      <span
        className="relative inline-flex h-10 w-10 items-center justify-center"
        role="timer"
        aria-label={
          bankWindow > 0 ? t('{secs}s, then {bank}s of time bank', { secs, bank: bankSecs }) : t('time remaining to act')
        }
        title={
          bankWindow > 0
            ? spending
              ? t('Spending your time bank')
              : t('Bank {n}s', { n: bankSecs })
            : t('time remaining to act')
        }
      >
        <svg viewBox="0 0 36 36" className="h-10 w-10 -rotate-90" aria-hidden="true">
          <circle
            cx="18"
            cy="18"
            r="15"
            fill="none"
            strokeWidth="3.5"
            className="table-ring-track"
          />
          <circle
            ref={arcRef}
            cx="18"
            cy="18"
            r="15"
            fill="none"
            strokeWidth="3.5"
            strokeLinecap="round"
            strokeDasharray={`${CIRC} ${CIRC}`}
            style={{ strokeDashoffset: CIRC * (1 - frac) }}
            className={cn('table-ring-arc', hot && 'table-ring-arc--hot', spending && !hot && 'table-ring-arc--spending')}
          />
        </svg>
        <span
          className={cn(
            'table-ring-num absolute text-[0.7rem] font-bold',
            hot && 'table-ring-num--hot',
            spending && !hot && 'table-ring-num--spending',
          )}
        >
          {secs}
        </span>
      </span>
      {bankSecs > 0 && (
        <span
          className={cn(
            'table-bank absolute -bottom-2.5 px-1.5 text-[0.58rem] font-bold leading-[1.15]',
            spending && 'table-bank--loud',
          )}
        >
          {bankSecs}s
        </span>
      )}
    </span>
  );
}

/** v3 feedback #7a: with auto-deal on, the server dwells between hands before
 *  the next ready check. This clock makes that wait legible - L4 moved it into
 *  the cluster alongside the host's deal post. */
function AutoDealClock({ autoDealAt }: { autoDealAt: number | null }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!autoDealAt) return;
    const iv = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(iv);
  }, [autoDealAt]);
  if (!autoDealAt) return null;
  const secs = Math.max(0, Math.ceil((autoDealAt - now) / 1000));
  return (
    <p className="table-deal-clock">{t('Next hand in {n}s', { n: secs })}</p>
  );
}

export function BettingPanel({
  mySeat,
  isHost,
  narrow = false,
}: {
  mySeat: number | null;
  isHost: boolean;
  /** L6: the phone instance of the cluster. Narrower (it shares the console
   *  strip with the dock on portrait phones) and touch-first: table-controls.
   *  css grows the amount input / slider / % pills to full finger hit areas. */
  narrow?: boolean;
}) {
  const hand = useStore((s) => s.hand);
  const room = useStore((s) => s.room);
  const myUserId = useStore((s) => s.auth.userId);
  // A10: quick sizes come from the account's pot-ratio slots.
  const betRatios = useStore((s) => s.prefs.betRatios);
  // The table's money display unit (shared store, toggled from any seat stack):
  // every amount below renders in this ONE unit, never chips AND BB at once.
  const stackUnit = useStore((s) => s.prefs.stackUnit);
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
  // Chips are the settlement currency, so the legal window and the slider stay
  // chip-denominated; `showBB` only changes how every amount is DISPLAYED. The
  // editable amount converts in and out so the panel shows exactly one unit.
  //
  // BB → chips keeps the FULL product: an early `Math.round` would drop the
  // fraction before the small-blind ceil can recover it (review round 2: a typed
  // 6.01 BB at bb 20 is 120.2, which must ceil to 130, not collapse to 120).
  // The unified snapRaiseTo downstream owns rounding, and the final submitted
  // amount is always a whole chip, so no pre-round is needed for the ledger.
  const showBB = stackUnit === 'bb';
  const toUnit = (chips: number) => (showBB ? bbValue(chips, bb) : chips);
  const fromUnit = (value: number) => (showBB ? value * Math.max(1, bb) : value);
  const unitText = (chips: number) => (showBB ? `${toUnit(chips)} BB` : fmt(chips));
  // L4: the merged deal post shows 「Invite a friend to deal.」 vs 「Deal
  // when ready.」 on the opponent count - same rule the old top-right box used.
  const opponentsHere = room
    ? room.players.filter((p) => p.seat !== null && p.userId !== myUserId).length
    : 0;

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

  // Bet-input rule (user 2026-10-07): every editable amount — typed number,
  // slider drag, wheel/arrow step — rounds UP to the next small blind, then
  // clamps into the legal window. Clamping to maxRaiseTo AFTER the ceil is what
  // keeps an all-in exact: a 123-chip shove ceils to 130, which the max clamp
  // brings straight back to 123. An empty/NaN edit falls back to the minimum.
  const snapRaiseTo = (value: number) =>
    la ? snapRaise(value, sb, la.minRaiseTo, la.maxRaiseTo) : value;
  // The amount every control agrees on: the snapped+clamped value, not the raw
  // edit. The BB input labels the legal max as 6.5 BB; typing 6.5 converts to
  // 130 chips, and this snapping resolves it back to the exact 123-chip all-in
  // instead of rejecting it. So the typed max, the All-in pill, Enter and the
  // submit click all send the SAME number.
  const legalRaiseTo = la && Number.isFinite(raiseTo) ? snapRaiseTo(raiseTo) : (la?.minRaiseTo ?? 0);
  const amountValid =
    !!la && Number.isFinite(raiseTo) && isRaiseAmountValid(legalRaiseTo, la.minRaiseTo, la.maxRaiseTo);
  // Keep keyboard and wheel adjustments on the same small-blind increment. The
  // range is anchored at the legal minimum; the All-in pill remains the exact
  // escape hatch for a max value that is not an even step from that minimum.
  const raiseRangeStep = 1;
  const raiseRangeCollapsed = !!la && la.maxRaiseTo - la.minRaiseTo < raiseRangeStep;
  const submitRaise = () => {
    if (!myTurn || !la?.canRaise || !st) return;
    const amount = legalRaiseTo;
    setRaiseTo(amount);
    // An invalid edit is repaired on the first click, but is deliberately not
    // submitted until the user confirms the now-legal whole-chip value.
    if (!Number.isFinite(raiseTo) || !amountValid) return;
    send({ type: st.currentBet === 0 ? 'bet' : 'raise', amount });
  };
  const setRaiseClamped = (value: number) => {
    if (!la) return;
    setRaiseTo(snapRaiseTo(value));
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

  // GGPoker-style pills: each label shows the CONFIGURED pot ratio (All-in
  // keeps its word label), while the amount is snapped to the blind and
  // clamped into the legal window. Slots a clamp collapses onto the same
  // amount share one button, like on the action bar.
  const quicks = (() => {
    if (!la || !st) return [];
    const seen = new Set<number>();
    const out: { label: string; value: number }[] = [];
    for (const frac of betRatios) {
      const value = presetRaiseTo({
        frac,
        pot,
        callAmount: la.callAmount,
        currentBet: st.currentBet,
        sb,
        minRaiseTo: la.minRaiseTo,
        maxRaiseTo: la.maxRaiseTo,
      });
      if (seen.has(value)) continue;
      seen.add(value);
      out.push({ label: presetLabel(frac) ?? t('All-in'), value });
    }
    return out;
  })();

  const waitingOn = st
    ? (room?.players.find((p) => p.seat === st.toAct)?.displayName ??
      t('Seat {n}', { n: st.toAct !== null ? st.toAct + 1 : '-' }))
    : null;

  // P2 B3 (docs/p2-gameplay-design.md): a bomb-pot hand posts antes and opens
  // the flop directly - the engine never asks for preflop action, so the panel
  // shows what happened instead of controls that could never fire.
  const bombHand = !!hand.featureStarted?.bombPot?.enabled;
  const bombNoPreflop = bombHand && !handIdle && (!st || st.street === 'preflop');

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
        'poker-action-bar poker-betting-panel table-cluster p-2.5 text-white',
        // L6: portrait phones size the cluster through `.table-cluster--phone`
        // in table-controls.css (shared row with the dock); landscape/desktop
        // keep the corner width formula.
        narrow ? 'table-cluster--phone' : 'w-[min(18.5rem,calc(100vw-6.5rem))]',
        myTurn && 'table-cluster--mine',
      )}
    >
      {pending && (
        <p className="mb-1.5 flex items-center justify-center gap-1.5 text-[0.68rem] text-[var(--table-muted)]">
          <span className="h-3 w-3 animate-spin rounded-full border-2 border-white/30 border-t-white" />
          {t('Sending…')}
        </p>
      )}

      {rc ? (
        <div className="flex flex-col gap-1.5">
          {/* L4 (rev2 decision): the host's deal post + auto-deal clock share
              this card with the ready check - one corner, one card, both
              between-hand states. */}
          {isHost && mySeat !== null && (
            <div className="flex flex-col gap-1.5">
              <p className="table-deal-title">
                {opponentsHere === 0 ? t('Invite a friend to deal.') : t('Deal when ready.')}
              </p>
              {opponentsHere > 0 && (
                <button type="button" className="table-deal-btn" disabled={!connected} onClick={() => startHand()}>
                  <Play size={15} weight="fill" aria-hidden="true" /> {t('Deal hand')}
                </button>
              )}
              <AutoDealClock autoDealAt={hand.autoDealAt} />
            </div>
          )}
          {amEligible && !amReady ? (
            <Button variant="success" className="w-full animate-pulse" onClick={imReady}>
              {t("I'm ready · {n}s", { n: readySecs })}
            </Button>
          ) : (
            <p className="table-ready-done text-center text-xs font-semibold">
              {amReady ? t('✓ You are ready') : t('Ready check')}
            </p>
          )}
          <p className="table-sub text-center">
            {t('{a}/{b} ready · deals in {n}s, without the rest', {
              a: rc.ready.length,
              b: rc.eligible.length,
              n: readySecs,
            })}
          </p>
        </div>
      ) : bombNoPreflop ? (
        <div className="flex flex-col gap-1.5">
          <p className="flex items-center justify-center gap-1.5 text-xs font-semibold text-[var(--table-commit)]">
            <Bomb size={14} weight="fill" aria-hidden="true" />
            {t('Bomb pot ante posted - straight to the flop.')}
          </p>
        </div>
      ) : myTurn && la && st ? (
        <div className="flex flex-col gap-2">
          {/* L4 header: YOUR TURN + the action-clock ring (mockup .bp-head) */}
          <div className="flex items-center justify-between gap-2">
            <p className="table-turn">{t('Your turn.')}</p>
            <CountdownRing
              deadline={hand.deadline}
              baseDeadline={hand.baseDeadline}
              bankMs={mySeat !== null ? (hand.timeBanks[mySeat] ?? 0) : 0}
              actionMs={room?.room.actionTimeoutMs ?? ACTION_TIMEOUT_MS}
            />
          </div>
          <p className="table-sub">
            {la.callAmount > 0 && (
              <>
                {t('To call {n}', { n: unitText(la.callAmount) })} ·{' '}
              </>
            )}
            {t('Pot {n}', { n: unitText(pot) })}
          </p>
          {/* amount in the table's ONE display unit (never chips AND BB) */}
          <div className="flex items-end justify-between gap-1.5">
            <label className="min-w-0 text-[0.62rem] uppercase tracking-wide text-[var(--table-faint)]">
              {st.currentBet === 0 ? t('Bet amount') : t('Raise to')}
              <span className="mt-0 flex items-baseline gap-1 normal-case tracking-normal">
                <input
                  ref={amountRef}
                  type="number"
                  inputMode="numeric"
                  min={toUnit(la.minRaiseTo)}
                  max={toUnit(la.maxRaiseTo)}
                  step={showBB ? 'any' : 1}
                  value={Number.isFinite(raiseTo) ? toUnit(raiseTo) : ''}
                  aria-label={t('Bet or raise amount')}
                  aria-keyshortcuts={binding('raise')}
                  disabled={pending || settling}
                  {...amountInput}
                  onChange={(e) => setRaiseTo(e.target.value === '' ? NaN : fromUnit(+e.target.value))}
                  onBlur={() => setRaiseClamped(raiseTo)}
                  className="table-amt min-h-8 w-24 min-w-0 px-2 py-1 text-sm text-right font-bold outline-none"
                />
                <span className="table-bb text-[0.7rem]">{showBB ? 'BB' : t('pts')}</span>
              </span>
            </label>
          </div>
          {/* slider, min/max marked in BB (GGPoker-style) */}
          {raiseRangeCollapsed ? (
            <div className="flex items-center justify-between gap-2" role="status">
              <span className="table-bb table-bb--quiet font-display text-[0.62rem]">{t('All-in')}</span>
              <span className="table-bb table-bb--quiet text-[0.62rem]">
                {unitText(la.maxRaiseTo)}
              </span>
            </div>
          ) : (
            <div className="flex min-h-9 items-center gap-1.5">
              <span className="table-bb table-bb--quiet font-display text-[0.62rem]">
                {toUnit(la.minRaiseTo)}
              </span>
              <input
                type="range"
                min={la.minRaiseTo}
                max={la.maxRaiseTo}
                step={raiseRangeStep}
                value={clampRaiseAmount(legalRaiseTo, la.minRaiseTo, la.maxRaiseTo)}
                onChange={(e) => setRaiseClamped(+e.target.value)}
                onKeyDown={(e) => {
                  if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
                  e.preventDefault();
                  setRaiseClamped(
                    adjustRaiseByStep(
                      legalRaiseTo,
                      e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -1 : 1,
                      sb,
                      la.minRaiseTo,
                      la.maxRaiseTo,
                    ),
                  );
                }}
                onWheel={(e) => {
                  e.preventDefault();
                  setRaiseClamped(
                    adjustRaiseByStep(legalRaiseTo, e.deltaY < 0 ? 1 : -1, sb, la.minRaiseTo, la.maxRaiseTo),
                  );
                }}
                className="table-slider h-2 min-w-0 flex-1 cursor-pointer appearance-none rounded-full"
                aria-label={t('Raise amount')}
              />
              <span className="table-bb table-bb--quiet font-display text-[0.62rem]">
                {toUnit(la.maxRaiseTo)}
              </span>
            </div>
          )}
          {/* percentage quick pills (A10-configurable slots, % of pot) */}
          <div className="flex flex-wrap items-center gap-1.5">
            {quicks.map((q) => (
              <button
                key={q.label}
                type="button"
                disabled={pending || settling}
                onClick={() => setRaiseTo(q.value)}
                aria-pressed={raiseTo === q.value}
                className={cn(
                  'table-quick',
                  q.label === t('All-in') && 'table-quick--allin',
                  raiseTo === q.value &&
                    'border-[var(--table-commit)]! bg-[var(--table-commit)]! text-black! shadow-[0_0_0_2px_color-mix(in_srgb,var(--table-commit)_35%,transparent)]',
                )}
              >
                {q.label}
              </button>
            ))}
          </div>
          {/* Fires only for an empty / unparseable edit (`raiseTo` NaN): every
              finite input is auto-normalized (ceil to the small blind, then
              clamp into the legal window), so the panel no longer rejects an
              out-of-range number. The copy therefore no longer promises a
              range check it does not perform. */}
          {!amountValid && (
            <p role="status" className="text-[0.68rem] leading-snug text-[var(--table-allin)]">
              {t('Enter an amount.')}
            </p>
          )}
          {/* the big three (mockup .abtn): Fold dark, Call dark + gold amount,
              Raise the single bright gold CTA */}
          <div className="grid grid-cols-3 gap-1.5">
            <Button
              variant="secondary"
              disabled={settling}
              className="table-btn table-btn--fold h-11! min-h-11! border-0! text-sm!"
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
              variant="secondary"
              disabled={settling}
              className="table-btn table-btn--call h-11! min-h-11! border-0! text-sm!"
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
                  {la.canCheck ? (
                    t('Check')
                  ) : (
                    <>
                      {t('Call')}{' '}
                      <span className="table-btn-amt">{unitText(la.callAmount)}</span>
                    </>
                  )}
                  {hint(la.canCheck ? 'check' : 'call')}
                </span>
              </span>
            </Button>
            <Button
              variant="secondary"
              disabled={settling || !la.canRaise || !amountValid}
              className="table-btn table-btn--raise h-11! min-h-11! border-0! text-[0.8rem]!"
              title={la.canRaise ? undefined : t('Raising unlocks on your turn')}
              onClick={submitRaise}
            >
              <span className="flex flex-col items-center leading-tight">
                <span>
                  {st.currentBet === 0
                    ? t('Bet {n}', { n: unitText(legalRaiseTo) })
                    : t('Raise to {n}', { n: unitText(legalRaiseTo) })}
                </span>
              </span>
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-2">
            <p className="table-sub min-w-0 break-words text-xs font-medium">{statusMsg}</p>
            {/* v3 feedback #5: your time-bank balance stays on screen even while
                you are not the one facing action - the ring only runs on your
                turn, this chip is always honest about what you have banked. */}
            {!handIdle && mySeat !== null && hand.timeBanks[mySeat] !== undefined && (
              <span
                title={t('Bank {n}s', { n: Math.ceil(hand.timeBanks[mySeat]! / 1000) })}
                className={cn(
                  'table-bank flex shrink-0 items-center gap-1 px-1.5 py-0.5 text-[0.62rem]',
                  hand.timeBanks[mySeat] === 0 && 'table-bank--quiet',
                )}
              >
                <Timer size={9} weight="fill" aria-hidden="true" />
                {Math.ceil(hand.timeBanks[mySeat]! / 1000)}s
              </span>
            )}
          </div>
          {/* L4 (rev2 decision): idle + host → the deal post lives right here,
              same card as everything else (the old top-right box is gone). */}
          {handIdle && isHost && mySeat !== null && (
            <div className="flex flex-col gap-1.5">
              {opponentsHere === 0 && (
                <p className="table-deal-title">{t('Invite a friend to deal.')}</p>
              )}
              {opponentsHere > 0 && (
                <button
                  type="button"
                  className="table-deal-btn"
                  disabled={!connected}
                  onClick={() => startHand()}
                >
                  <Play size={15} weight="fill" aria-hidden="true" /> {t('Deal hand')}
                </button>
              )}
              <AutoDealClock autoDealAt={hand.autoDealAt} />
            </div>
          )}
          {canPreAct && st && mySeat !== null && (
            <div className="flex flex-wrap items-center gap-1.5">
              <HourglassMedium size={14} className="text-[var(--table-faint)]" aria-label={t('Ahead of turn')} />
              <button
                onClick={() => !settling && togglePreAction('call-any', st, mySeat)}
                disabled={settling}
                className={cn('table-pre', hand.preAction === 'call-any' && 'table-pre--armed')}
                title={t('Arms now, acts on your turn')}
              >
                {t('Call any')}
              </button>
              <button
                onClick={() => !settling && togglePreAction('check-fold', st, mySeat)}
                disabled={settling}
                className={cn('table-pre', hand.preAction === 'check-fold' && 'table-pre--armed')}
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
                  'table-pre',
                  (hand.preAction === 'call' || hand.preAction === 'check') && 'table-pre--armed',
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
              className="table-btn table-ghost w-full border-0! text-sm!"
              disabled={showSentFor === hand.handId}
              onClick={() => {
                setShowSentFor(hand.handId);
                showMyCards();
              }}
            >
              {t('Show cards')}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
