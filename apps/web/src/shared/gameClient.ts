import {
  cardLookup,
  handKeyCommit,
  invScalar,
  maskAndShuffle,
  mulPoint,
  pointFromHex,
  pointHex,
  proveUnmask,
  randScalar,
  randomPerm,
  recoverCard,
  signContent,
} from '@4am/mental-poker';
import { legalActions, type PlayerAction, type ServerMsg } from '@4am/shared';
import { t, tr } from './i18n/index.ts';
import { handReducer } from './handReducer.ts';
import { useStore } from './store.ts';
import { wsClient } from './ws.ts';
import { voice } from './voice.ts';
import { play } from './sounds.ts';

const lookup = cardLookup();

const KEY_PREFIX = '4am/handkey/';

// This is deliberately client-session state, not part of the authoritative
// hand snapshot.  A reconnect can replay frames, but it must not make cards
// fly again; a fixture/resetHand call also cannot manufacture a deal event.
const dealEpochByHand = new Map<string, number>();
const dealtMotionByCard = new Map<string, number>();
const dealEpochByCard = new Map<string, number>();
const boardDeckIndexByCard = new Map<string, number>();

export function dealMotionEpoch(handId: string | null, cardKey: string): number {
  return handId ? dealEpochByCard.get(`${handId}:${cardKey}`) ?? 0 : 0;
}

export function boardMotionKey(handId: string | null, runIndex: number, card: number): string {
  return `board:${runIndex}:${card}`;
}

type BoardOpenForMotion = { deckIndex: number; card: number; run?: number };

function orderKnownBoard(handId: string, runIndex: number, cards: number[]): number[] {
  const indexOf = (card: number) => boardDeckIndexByCard.get(`${handId}:${runIndex}:${card}`)
    ?? boardDeckIndexByCard.get(`${handId}:0:${card}`);
  // Snapshot cards without metadata keep their slots, not an artificial
  // Infinity index. Sort only the known slots with a transitive comparator.
  const known = cards.filter((card) => indexOf(card) !== undefined)
    .sort((a, b) => indexOf(a)! - indexOf(b)!);
  if (known.length === cards.length) return known;
  let cursor = 0;
  return cards.map((card) => indexOf(card) === undefined ? card : known[cursor++]!);
}

/** Handler-level board merge contract: duplicate frames add metadata but no motion. */
export function mergeBoardOpenForMotion(
  handId: string,
  boards: number[][],
  msg: BoardOpenForMotion,
): number[][] {
  const runIndex = (msg.run ?? 1) - 1;
  const next = boards.map((run) => [...run]);
  while (next.length <= runIndex) next.push([]);
  boardDeckIndexByCard.set(`${handId}:${runIndex}:${msg.card}`, msg.deckIndex);
  if (!next[runIndex]!.includes(msg.card)) next[runIndex]!.push(msg.card);
  next[runIndex] = orderKnownBoard(handId, runIndex, next[runIndex]!);
  return next;
}

export function mergeAuthoritativeBoardForMotion(
  handId: string,
  boards: number[][],
  board: number[],
): number[][] {
  const next = boards.map((run) => [...run]);
  // The snapshot is authoritative, including its ordering. It must be able to
  // correct local state even if previously recorded event metadata disagrees.
  next[0] = [...board];
  return next;
}

/** Claim the one animation belonging to a newly received card event. */
export function claimDealMotion(handId: string | null, cardKey: string, epoch: number): boolean {
  if (!handId || epoch === 0) return false;
  const key = `${handId}:${cardKey}`;
  if ((dealtMotionByCard.get(key) ?? 0) >= epoch) return false;
  dealtMotionByCard.set(key, epoch);
  return true;
}

function advanceDealEpoch(handId: string): number {
  const next = (dealEpochByHand.get(handId) ?? 0) + 1;
  dealEpochByHand.set(handId, next);
  return next;
}

/** Test/fixture bridge for an explicitly simulated deal event. Snapshots must
 * use resetHand/patchHand instead; only an event may call this. */
export function noteDealMotion(handId: string, cardKey: string): number {
  const epoch = advanceDealEpoch(handId);
  dealEpochByCard.set(`${handId}:${cardKey}`, epoch);
  return epoch;
}

/** Read the per-hand key, or null if this browser has never held it.
 *
 *  localStorage, not sessionStorage: sessionStorage is per-TAB, so opening the
 *  same room in a second tab gave that tab no key for the hand already running.
 *  It then minted a fresh random one, and every share it produced failed against
 *  the commitment the first tab had already published - which the server can
 *  only read as a bad proof or as silence. Either way the hand died. Every tab
 *  in the browser now reads the same key.
 *
 *  It deliberately does NOT mint. A key invented mid-hand is worse than no key:
 *  it produces confidently-signed garbage. Minting happens once, at key_commit. */
function handKeyFor(handId: string): bigint | null {
  try {
    const hex =
      localStorage.getItem(KEY_PREFIX + handId) ?? sessionStorage.getItem(KEY_PREFIX + handId);
    return hex ? BigInt('0x' + hex) : null;
  } catch {
    return null;
  }
}

/** Mint the key for a hand we are joining, and keep the store from growing
 *  without bound. Idempotent, so re-committing after a reconnect reuses it. */
function createHandKey(handId: string): bigint {
  const existing = handKeyFor(handId);
  if (existing !== null) return existing;
  const k = randScalar();
  try {
    // hands are short; keep a handful so a reconnect mid-hand still finds its
    // key, and drop the rest rather than accumulating forever
    const mine = Object.keys(localStorage).filter((key) => key.startsWith(KEY_PREFIX));
    for (const key of mine.slice(0, Math.max(0, mine.length - 20))) localStorage.removeItem(key);
    localStorage.setItem(KEY_PREFIX + handId, k.toString(16));
  } catch {
    /* storage disabled: the key lives for this page load only */
  }
  return k;
}

function mySeatIn(seats: { seat: number; userId: number }[]): number | null {
  const userId = useStore.getState().auth.userId;
  return seats.find((s) => s.userId === userId)?.seat ?? null;
}

/** Sign against the hand named in the server's message, not local state, so
 *  crypto responses still work right after a reconnect or page reload. */
function signed(handId: string, t: string, body: unknown): string {
  const { auth } = useStore.getState();
  return signContent(auth.identity!.secretKey, handId, t, body);
}

/** Hands this browser actually folded, and hands it has seen end.
 *
 *  The client holds secrets the server is never supposed to learn, and the
 *  server is the one narrating what happened - so "the server told me I folded"
 *  and "the server asked me for my key" are not, on their own, reasons to hand
 *  anything over. These two sets are the local record we check against instead. */
const foldedByMe = new Set<string>();
const endedHands = new Set<string>();

/** Hands the client has seen reach a TERMINAL state (`hand_end` / `hand_abort`
 *  / a durable `hand_recovery`). Unlike `endedHands` this is written only on a
 *  terminal frame, never on `showdown`: a settlement can still fail AFTER the
 *  reveal, so a `settlement_failed` that follows a `showdown` is legitimate and
 *  must not be rejected. This set is what stops a late/replayed
 *  `settlement_failed` for an already-finished hand from reviving its banner. */
const terminalHands = new Set<string>();

/** Test-only: clear the module-level hand-tracking sets so cases are isolated.
 *  Production never calls this - the sets are process-lifetime by design and
 *  resetting them mid-session would re-open already-finished hands. */
export function __resetHandTrackingForTest(): void {
  foldedByMe.clear();
  endedHands.clear();
  terminalHands.clear();
}

/** Send a betting action for the current hand (called from the UI). */
export function act(action: PlayerAction): void {
  const handId = useStore.getState().hand.handId;
  if (!handId) return;
  if (action.type === 'fold') foldedByMe.add(handId);
  wsClient.send({ t: 'action', handId, action, sig: signed(handId, 'action', { action }) });
}

/** Offer chips to privately see a player's cards from the hand that just ended. */
export function offerPeek(targetSeat: number, amount: number): void {
  const handId = useStore.getState().hand.handId;
  if (!handId) return;
  wsClient.send({ t: 'peek_offer', handId, targetSeat, amount });
}

/** Answer a paid-peek offer. Accepting proves the reveal with the hand key. */
export function answerPeek(offerId: string, accept: boolean): void {
  const { hand } = useStore.getState();
  if (!hand.handId) return;
  useStore
    .getState()
    .patchHand({ peekOffers: hand.peekOffers.filter((o) => o.offerId !== offerId) });
  if (!accept) {
    wsClient.send({ t: 'peek_decline', handId: hand.handId, offerId });
    return;
  }
  if (hand.myCardPoints.length === 0) return;
  const k = handKeyFor(hand.handId);
  if (k === null) return;
  const shares = hand.myCardPoints.map(({ deckIndex, point }) => {
    const { out, proof } = proveUnmask(k, pointFromHex(point));
    return { deckIndex, out: pointHex(out), proof };
  });
  wsClient.send({
    t: 'peek_accept',
    handId: hand.handId,
    offerId,
    shares,
    sig: signed(hand.handId, 'peek_accept', { offerId, shares }),
  });
}

/** Sit out upcoming hands (or come back in). Takes effect at the next deal. */
export function setSitOut(sittingOut: boolean): void {
  wsClient.send({ t: 'sit_out', sittingOut });
}

/** Voluntarily reveal your hole cards to the table (after folding, or once the hand is over). */
export function showMyCards(): void {
  const { hand } = useStore.getState();
  if (!hand.handId || hand.myCardPoints.length === 0) return;
  const k = handKeyFor(hand.handId);
  if (k === null) return;
  const shares = hand.myCardPoints.map(({ deckIndex, point }) => {
    const { out, proof } = proveUnmask(k, pointFromHex(point));
    return { deckIndex, out: pointHex(out), proof };
  });
  wsClient.send({
    t: 'show_cards',
    handId: hand.handId,
    shares,
    sig: signed(hand.handId, 'show_cards', { shares }),
  });
}

export function sit(seat: number): void {
  wsClient.send({ t: 'sit', seat });
}

export function leaveSeat(): void {
  wsClient.send({ t: 'leave_seat' });
}

export function startHand(): void {
  wsClient.send({ t: 'start_hand' });
}

export function imReady(): void {
  wsClient.send({ t: 'im_ready' });
}

/** Host-only recovery from a frozen settlement. The server keeps the computed
 *  (deterministic) result and re-runs the durable write; safe and idempotent.
 *  The request carries no payload and the reply is a later frame - either the
 *  terminal `hand_end` (success) or another `settlement_failed` (still failing) -
 *  so mark the local pending timestamp to avoid a dead-looking button. */
export function retrySettlement(): void {
  const state = useStore.getState();
  const failed = state.hand.settlementFailed;
  if (!failed || failed.orphaned) return;
  // Host-only, and only while the socket is live, checked BEFORE touching any
  // local state. The server enforces the same rule, but rejecting here means no
  // caller - not just the banner button - can flip the UI into 'retrying' or
  // emit the frame on behalf of a non-host.
  if (!state.room || state.room.room.hostId !== state.auth.userId) return;
  if (!state.wsConnected) return;
  useStore.getState().patchHand({
    settlementFailed: {
      ...failed,
      retryRequestedAt: Date.now(),
      manualRetry: true,
    },
  });
  wsClient.send({ t: 'retry_settlement' });
}

/** Vote on running the all-in board twice (requested by notpritam, docs/FEATURES.md). */
export function ritVote(yes: boolean): void {
  const h = useStore.getState().hand;
  if (!h.handId || !h.ritOffer) return;
  useStore.getState().patchHand({ ritOffer: { ...h.ritOffer, voted: true } });
  wsClient.send({
    t: 'rit_vote',
    handId: h.handId,
    yes,
    sig: signed(h.handId, 'rit_vote', { yes }),
  });
}

/** Multi-run, choice stage: the player ahead picks how many times to run the
 *  board (1-3). Signed like every other in-hand decision. */
export function chooseRunCount(count: 1 | 2 | 3): void {
  const h = useStore.getState().hand;
  const offer = h.multiRunOffer;
  if (!h.handId || !offer || offer.stage !== 'choice') return;
  // optimistic: show the pick immediately; multi_run_offer/result reconcile
  useStore.getState().patchHand({
    multiRunOffer: { ...offer, requestedRuns: count },
  });
  wsClient.send({
    t: 'run_count_choice',
    handId: h.handId,
    decisionId: offer.decisionId,
    count,
    sig: signed(h.handId, 'run_count_choice', { decisionId: offer.decisionId, count }),
  });
}

/** Multi-run, agreement stage: the player behind accepts or declines the
 *  ahead player's requested run count. Signed like every other decision. */
export function agreeRunCount(agree: boolean): void {
  const h = useStore.getState().hand;
  const offer = h.multiRunOffer;
  if (!h.handId || !offer || offer.stage !== 'agreement') return;
  wsClient.send({
    t: 'run_count_agree',
    handId: h.handId,
    decisionId: offer.decisionId,
    agree,
    sig: signed(h.handId, 'run_count_agree', { decisionId: offer.decisionId, agree }),
  });
}

export function sendChat(text: string, kind: 'text' | 'sticker' | 'phrase' = 'text'): void {
  wsClient.send({ t: 'chat', text, kind });
}

export function handle(msg: ServerMsg): void {
  const store = useStore.getState();
  switch (msg.t) {
    case 'room_state': {
      store.setRoom(msg);
      // Authoritative snapshot restores countdown/readiness after a reconnect.
      if (msg.autoDealAt !== undefined)
        store.patchHand({ autoDealAt: msg.autoDealAt, readyCheck: msg.readyCheck ?? null });
      // after a reconnect (deploy or network drop): if the server no longer has
      // our hand, stop showing it as live instead of freezing the table
      if (wsClient.consumeResync() && !msg.handActive) {
        const h = useStore.getState().hand;
        const failed = h.settlementFailed;
        if (h.handId && failed && failed.handId === h.handId) {
          // A pending durable-settlement failure is NOT resolved by the hand
          // disappearing from the server. After a restart the `hand_lifecycle`
          // row can still be unresolved, and a committed hand's `hand_end` may
          // simply have been missed - absence of `handActive` is not proof the
          // chips moved. Keep the recovery banner; a replayed `hand_end` (the
          // server retains the terminal frame) clears it. Until then mark it
          // orphaned: there is no live hand for the host to retry.
          store.patchHand({
            settlementFailed: {
              ...failed,
              orphaned: true,
              retrying: false,
              retryRequestedAt: null,
            },
            deadline: null,
          });
        } else if (h.handId && h.handRecovery === 'unresolved') {
          // The server's durable answer for this hand is `unresolved`: it never
          // reached a terminal transaction, so the missing live hand is NOT a
          // restart refund. Keep the recovery state and stop the dead action
          // timer; only an operator resolves it. Synthesising an abort here
          // would fabricate a refund the durable state never made (and the next
          // hand would still be refused).
          store.patchHand({ deadline: null, baseDeadline: null });
        } else if (h.handId && !h.result && !h.abort) {
          store.patchHand({
            abort: {
              t: 'hand_abort',
              handId: h.handId,
              reason:
                'The server restarted during this hand. Bets were returned; the host can deal again.',
              blamedSeat: null,
            },
            deadline: null,
            settlementFailed: null,
          });
          try {
            localStorage.removeItem(KEY_PREFIX + h.handId);
            sessionStorage.removeItem(KEY_PREFIX + h.handId);
          } catch {
            /* storage disabled */
          }
        }
      }
      voice.syncPeers(msg.players);
      return;
    }
    case 'chat':
      store.pushChat({
        from: msg.from,
        userId: msg.userId,
        text: msg.text,
        kind: msg.kind,
        ts: msg.ts,
      });
      return;
    case 'rtc':
      void voice.handleRtc(msg.from, msg.data);
      return;
    case 'voice_state': {
      const { voice: v } = useStore.getState();
      store.patchVoice({ mutedByUser: { ...v.mutedByUser, [msg.userId]: msg.muted } });
      return;
    }
    case 'error':
      // server prose crosses into the toast store here: translate at the
      // boundary, exact/template match only — unknown phrases pass through
      store.pushError(tr(msg.message));
      return;

    case 'hand_start': {
      const mySeat = mySeatIn(msg.seats);
      // re-sent on reconnect: never wipe state we already have for this hand
      const fresh = useStore.getState().hand.handId !== msg.handId;
      if (fresh) {
        // A refresh can receive this hand's `settlement_failed` BEFORE its
        // `hand_start`: the server re-asserts the frozen settlement first, and
        // a fresh client writes it against a null handId. An unconditional
        // reset would erase exactly the banner the host needs. Keep it only when
        // it names THIS hand - a previous hand's failure must never leak in.
        const carry = useStore.getState().hand.settlementFailed;
        store.resetHand({
          handId: msg.handId,
          seats: msg.seats,
          buttonSeat: msg.buttonSeat,
          settlementFailed: carry?.handId === msg.handId ? carry : null,
        });
        // previous hands' keys are no longer needed: the voluntary-show window
        // for the last hand closes when a new one is dealt
        for (let i = sessionStorage.length - 1; i >= 0; i--) {
          const key = sessionStorage.key(i);
          if (key?.startsWith('4am/handkey/') && key !== `4am/handkey/${msg.handId}`) {
            sessionStorage.removeItem(key);
          }
        }
      }
      if (fresh) play('shuffle');
      if (mySeat === null) return; // spectator
      const k = createHandKey(msg.handId);
      const commit = pointHex(handKeyCommit(k));
      wsClient.send({
        t: 'key_commit',
        handId: msg.handId,
        commit,
        sig: signContent(store.auth.identity!.secretKey, msg.handId, 'key_commit', { commit }),
      });
      return;
    }

    case 'shuffle_turn': {
      const { hand } = useStore.getState();
      if (msg.seat !== mySeatIn(hand.seats)) return;
      const k = handKeyFor(msg.handId);
      if (k === null) return;
      const deck = maskAndShuffle(msg.deck.map(pointFromHex), k, randomPerm(52)).map(pointHex);
      wsClient.send({
        t: 'shuffle_deck',
        handId: msg.handId,
        deck,
        sig: signed(msg.handId, 'shuffle_deck', { deck }),
      });
      return;
    }

    case 'need_share': {
      // Unmasking is a capability, not a favour: if the server can get us to
      // strip our own mask off a point it chose, it can feed us our own
      // encrypted hole card and read back the plaintext.
      //
      // But a showdown legitimately needs exactly that. The card is masked by
      // EVERY player's key including its owner's, so at showdown the owner must
      // contribute their share too or nobody can see the hand. Refusing that
      // stalled every showdown into an unmask timeout, blaming the player who
      // was following the protocol correctly.
      //
      // So: refuse only the shapes that are never legitimate - being asked,
      // during the deal or a board opening, to unmask a card that is ours.
      const h0 = useStore.getState().hand;
      const mine = mySeatIn(h0.seats);
      const isMyCard = h0.myCardPoints.some((c) => c.deckIndex === msg.deckIndex);
      if (msg.purpose !== 'showdown' && (isMyCard || (mine !== null && msg.forSeat === mine))) {
        store.pushError(t('Refused an unmask request for a card dealt to me.'));
        return;
      }
      const k = handKeyFor(msg.handId);
      if (k === null) return;
      const { out, proof } = proveUnmask(k, pointFromHex(msg.point));
      const body = { deckIndex: msg.deckIndex, out: pointHex(out), proof };
      wsClient.send({
        t: 'unmask_share',
        handId: msg.handId,
        ...body,
        sig: signed(msg.handId, 'unmask_share', body),
      });
      return;
    }

    case 'your_card': {
      const h = useStore.getState().hand;
      if (h.handId !== msg.handId) return;
      if (h.myCardPoints.some((c) => c.deckIndex === msg.deckIndex)) return; // re-delivered on reconnect
      const k = handKeyFor(msg.handId);
      if (k === null) return;
      const plain = mulPoint(pointFromHex(msg.point), invScalar(k));
      const card = recoverCard(plain, lookup);
      if (card === null) {
        store.pushError(t('Could not decode a dealt card. The hand will abort.'));
        return;
      }
      if (h.myCards.length === 0) play('deal');
      noteDealMotion(msg.handId, `hole:hero:${h.myCards.length}`);
      // Opponent cards are intentionally face-down, so the client cannot
      // identify their individual your_card frame. They join the same deal
      // beat only after an actual your_card event, never at hand_start.
      for (const seat of h.seats) {
        if (seat.seat === mySeatIn(h.seats)) continue;
        noteDealMotion(msg.handId, `hole:seat:${seat.seat}:${h.myCards.length}`);
      }
      store.patchHand({
        myCards: [...h.myCards, card],
        myCardPoints: [...h.myCardPoints, { deckIndex: msg.deckIndex, point: msg.point }],
      });
      return;
    }

    case 'board_open': {
      const { hand } = useStore.getState();
      if (hand.handId !== msg.handId) return;
      const runIndex = (msg.run ?? 1) - 1;
      const boards = hand.boards.map((run) => run);
      while (boards.length <= runIndex) boards.push([]);
      const board = boards[runIndex]!;
      const existing = board.includes(msg.card);
      // Metadata is authoritative even when the card came from an earlier
      // snapshot. Only a genuinely new card advances the visual epoch.
      const nextBoards = mergeBoardOpenForMotion(msg.handId, boards, msg);
      if (!existing) {
        if (board.length === 0 || board.length >= 3) play('flip');
        const epoch = advanceDealEpoch(msg.handId);
        dealEpochByCard.set(`${msg.handId}:${boardMotionKey(msg.handId, runIndex, msg.card)}`, epoch);
      }
      if (JSON.stringify(nextBoards) !== JSON.stringify(hand.boards)) store.patchHand({ boards: nextBoards });
      return;
    }

    case 'betting_state': {
      const prev = useStore.getState().hand;
      const streetChanged = prev.betting?.street !== msg.state.street;
      const myUserId = useStore.getState().auth.userId;
      const mySeat = prev.seats.find((s) => s.userId === myUserId)?.seat;
      if (mySeat !== undefined && msg.state.toAct === mySeat && prev.betting?.toAct !== mySeat) {
        play('turn');
      }
      const boards = prev.boards.map((run) => run);
      const reconciled = mergeAuthoritativeBoardForMotion(prev.handId!, boards, msg.board);
      // baseDeadline/timeBanks are optional while the server rolls out: keep the
      // last known values rather than clearing them when a frame omits them.
      const timeBanks: Record<number, number> = { ...prev.timeBanks };
      if (msg.timeBanks !== undefined) {
        for (const tb of msg.timeBanks) timeBanks[tb.seat] = tb.remainingMs;
      }
      store.patchHand({
        betting: msg.state,
        actionSeq: msg.actionSeq,
        deadline: msg.deadline,
        baseDeadline: msg.baseDeadline !== undefined ? msg.baseDeadline : prev.baseDeadline,
        timeBanks,
        boards: reconciled,
        ...(streetChanged ? { lastActions: {}, preAction: null, preActionCallAt: null } : {}),
      });
      // the street closed with chips out front: they sweep into the pot
      if (streetChanged && prev.betting?.seats.some((s) => s.committed > 0)) play('pot-collect');
      let pre = streetChanged ? null : prev.preAction;
      // the table moved: disarm any selection the new price invalidates, so a
      // raise can never turn 'Check' or a price-armed 'Call' into a surprise
      if (pre && mySeat !== undefined) {
        const meNow = msg.state.seats.find((s) => s.seat === mySeat);
        const toCall = meNow ? Math.max(0, msg.state.currentBet - meNow.committed) : 0;
        const invalid =
          (pre === 'check' && toCall > 0) ||
          (pre === 'call' && toCall > (prev.preActionCallAt ?? 0));
        if (invalid) {
          pre = null;
          useStore.getState().patchHand({ preAction: null, preActionCallAt: null });
        }
      }
      // fire a pre-selected action the moment the turn arrives
      if (pre && mySeat !== undefined && msg.state.toAct === mySeat) {
        const la = legalActions(msg.state);
        if (la && la.seat === mySeat) {
          useStore.getState().patchHand({ preAction: null, preActionCallAt: null });
          if (pre === 'check-fold') act(la.canCheck ? { type: 'check' } : { type: 'fold' });
          else if (pre === 'call-any' || pre === 'call')
            act(la.canCheck ? { type: 'check' } : { type: 'call' });
          else if (pre === 'check' && la.canCheck) act({ type: 'check' });
        }
      }
      return;
    }

    case 'action_applied': {
      const { hand } = useStore.getState();
      const soundFor = {
        fold: 'muck',
        check: 'knock',
        call: 'chip',
        bet: 'chips-slide',
        raise: 'chips-slide',
      } as const;
      play(soundFor[msg.action.type]);
      // my fold escrows my hand key with the server, so the hand can carry on
      // without me if I disappear (requested by notpritam, docs/FEATURES.md)
      // ...but only for a fold this browser actually made. Taking the server's
      // word for it would let a forged action_applied pull the hand key out of a
      // player who is still contesting the pot.
      if (
        msg.action.type === 'fold' &&
        hand.handId === msg.handId &&
        msg.seat === mySeatIn(hand.seats) &&
        foldedByMe.has(msg.handId) &&
        // The last fold settles synchronously on the server. There is no
        // remaining hand to escrow for; replying would arrive after hand_end.
        (hand.betting?.seats.filter((seat) => !seat.folded && seat.seat !== msg.seat).length ?? 0) >
          1
      ) {
        const key = handKeyFor(msg.handId)?.toString(16);
        if (key === undefined) return;
        wsClient.send({
          t: 'fold_key',
          handId: msg.handId,
          key,
          sig: signed(msg.handId, 'fold_key', { key }),
        });
      }
      store.patchHand({
        lastActions: { ...hand.lastActions, [msg.seat]: { ...msg.action, auto: msg.auto } },
      });
      return;
    }

    case 'seven_deuce': {
      const h = useStore.getState().hand;
      const roomState = useStore.getState().room;
      const seatInfo = h.seats.find((s) => s.seat === msg.seat);
      const name =
        roomState?.players.find((p) => p.userId === seatInfo?.userId)?.displayName ??
        seatInfo?.username ??
        `Seat ${msg.seat + 1}`;
      play('win');
      store.pushChat({
        from: t('House rule'),
        userId: 0,
        text: t('7-2 offsuit! {name} collects {amount} in bounties.', { name, amount: msg.amount }),
        kind: 'phrase',
        ts: Date.now(),
      });
      return;
    }

    // Pure hand-state alignment: the reducer owns the state change, this switch
    // only writes it back to the store. No side effects live in these frames.
    // `Date.now` is passed as a thunk, not called here: only `auto_deal` consults
    // it (inside the reducer), so the other four frames read no clock - matching
    // the pre-extraction switch, which called `Date.now()` only on `auto_deal`.
    case 'ready_end':
    case 'feature_started':
    case 'time_bank_update':
    case 'peek_offers_snapshot':
    case 'auto_deal': {
      const patch = handReducer(useStore.getState().hand, msg, Date.now);
      if (patch) store.patchHand(patch);
      return;
    }

    case 'ready_check': {
      const prev = useStore.getState().hand.readyCheck;
      if (!prev) play('turn'); // ping once when the check opens, not on every update
      store.patchHand({
        autoDealAt: null,
        readyCheck: { deadlineTs: msg.deadlineTs, eligible: msg.eligible, ready: msg.ready },
      });
      return;
    }

    case 'rit_offer': {
      play('turn');
      store.patchHand({
        ritOffer: { deadlineTs: msg.deadlineTs, voters: msg.voters, voted: false },
      });
      return;
    }

    case 'rit_result': {
      if (msg.runTwice) play('chip');
      // run 1 is the shared board; run 2 starts as a copy of everything already
      // open and grows as run-2 cards land
      const shared = [...msg.sharedBoard];
      store.patchHand({ ritOffer: null, boards: [shared, msg.runTwice ? [...shared] : []] });
      return;
    }

    case 'multi_run_offer': {
      // authoritative snapshot of the negotiation, including its stage. Sent
      // again after a reconnect, so overwrite rather than merge: a stale stage
      // would leave the wrong player's buttons armed.
      play('turn');
      store.patchHand({
        multiRunOffer: {
          t: 'multi_run_offer',
          handId: msg.handId,
          decisionId: msg.decisionId,
          stage: msg.stage,
          aheadSeat: msg.aheadSeat,
          behindSeat: msg.behindSeat,
          equities: msg.equities,
          ...(msg.requestedRuns !== undefined ? { requestedRuns: msg.requestedRuns } : {}),
          deadlineTs: msg.deadlineTs,
        },
      });
      return;
    }

    case 'multi_run_result': {
      if (msg.reason === 'agreed') play('chip');
      store.patchHand({ multiRunOffer: null, multiRunResult: msg });
      // A 2-3 run result can land just before or just after hand_end. If the
      // recap for this hand already exists, refresh it so it carries every run
      // (multi_run_result itself only names the shared board). Purely additive:
      // a later hand_end overwrites with the showdown-authoritative boards.
      const state = useStore.getState();
      const last = state.lastHand;
      if (last && last.handId === msg.handId) {
        const h = state.hand;
        const showdownMultiRun = h.showdown?.multiRun ?? null;
        const showdownTwice = h.showdown?.runTwice ?? null;
        const boards = showdownMultiRun?.boards ?? showdownTwice?.boards ?? last.boards ?? h.boards;
        const awards = showdownMultiRun?.awards ?? showdownTwice?.awards ?? last.multiRun?.awards;
        state.setLastHand({
          ...last,
          boards,
          multiRun: boards.length > 1 ? { boards, ...(awards ? { awards } : {}) } : last.multiRun,
        });
      }
      return;
    }

    case 'squid_result': {
      play('chip');
      store.patchHand({ squidResult: msg });
      return;
    }

    case 'peek_offer': {
      const h = useStore.getState().hand;
      if (h.handId !== msg.handId || h.peekOffers.some((o) => o.offerId === msg.offerId)) return;
      play('chip');
      store.patchHand({
        peekOffers: [
          ...h.peekOffers,
          {
            offerId: msg.offerId,
            fromUserId: msg.fromUserId,
            fromName: msg.fromName,
            amount: msg.amount,
          },
        ],
      });
      return;
    }

    case 'peek_offer_closed': {
      const h = useStore.getState().hand;
      if (h.handId !== msg.handId) return;
      // This is the target-side receipt. It only closes an incoming banner;
      // peek_offers_snapshot likewise describes incoming offers only and must
      // never be used to reconcile the user's own outgoing request UI.
      if (!h.peekOffers.some((o) => o.offerId === msg.offerId)) return;
      if (msg.status === 'accepted') {
        play('flip');
        window.dispatchEvent(new CustomEvent('4am-peek-accepted'));
      }
      store.patchHand({ peekOffers: h.peekOffers.filter((o) => o.offerId !== msg.offerId) });
      return;
    }

    case 'peek_result': {
      const h = useStore.getState().hand;
      if (h.handId !== msg.handId) return;
      // peek_result is buyer-only. Keep the client defensive as well: a
      // spectator has no current room seat and must never retain/render cards.
      // Do not consult h.seats here: it is the previous hand's participants,
      // while the server also allows a currently seated non-participant to buy.
      const room = useStore.getState().room;
      const currentUserId = useStore.getState().auth.userId;
      if (
        currentUserId === null ||
        !room?.players.some((player) => player.userId === currentUserId && player.seat !== null)
      ) return;
      if (msg.status === 'accepted' && msg.cards) {
        // The hand snapshot, never the current seat occupant, owns these cards.
        const target = h.seats.find((seat) => seat.seat === msg.targetSeat);
        if (!target) return;
        play('flip');
        store.patchHand({ peekResults: { ...h.peekResults, [msg.targetSeat]: {
          targetSeat: msg.targetSeat,
          targetUserId: target.userId,
          targetName: room?.players.find((player) => player.userId === target.userId)?.displayName ?? target.username,
          cards: msg.cards,
        } } });
      } else {
        const message = msg.status === 'expired'
          ? t('Your peek offer expired.')
          : msg.status === 'failed'
            ? t('Your peek offer failed.')
            : t('Your peek offer was declined.');
        store.pushError(message);
      }
      return;
    }

    case 'cards_shown': {
      const state = useStore.getState();
      // a voluntary show can land after the next deal: keep the recap fresh
      const last = state.lastHand;
      if (last && last.handId === msg.handId) {
        state.setLastHand({ ...last, shown: { ...last.shown, [msg.seat]: msg.cards } });
      }
      const h = state.hand;
      if (h.handId !== msg.handId) return;
      play('flip');
      store.patchHand({ shown: { ...h.shown, [msg.seat]: msg.cards } });
      return;
    }

    case 'showdown': {
      const current = useStore.getState().hand;
      if (current.handId !== msg.handId || current.showdown) return;
      for (const reveal of msg.reveals) {
        reveal.cards.forEach((_, i) => noteDealMotion(msg.handId, `reveal:${reveal.seat}:${i}`));
      }
      // the big reveal: thunder + a lightning flash across the table
      // (requested by notpritam, docs/FEATURES.md)
      play('thunder');
      window.dispatchEvent(new CustomEvent('4am-thunder'));
      endedHands.add(msg.handId);
      store.patchHand({ showdown: msg, deadline: null, baseDeadline: null });
      return;
    }

    case 'settlement_failed': {
      const h = useStore.getState().hand;
      // A hand that already reached a terminal state must never be re-opened: a
      // late or replayed frame from a replaced connection would otherwise
      // resurrect the banner that `hand_end`/`hand_abort` just cleared.
      if (terminalHands.has(msg.handId)) return;
      // A frame naming an already-superseded hand must not resurrect the banner.
      if (h.handId && h.handId !== msg.handId) return;
      const prev = h.settlementFailed;
      store.patchHand({
        settlementFailed: {
          handId: msg.handId,
          reason: msg.reason,
          attempt: msg.attempt,
          retrying: msg.retrying,
          // any frame answers the in-flight manual retry
          retryRequestedAt: null,
          manualRetry: prev?.handId === msg.handId ? prev.manualRetry : false,
          // a live frame proves the server still has the hand: not orphaned
          since: Date.now(),
          orphaned: false,
        },
      });
      // Never silent: the durable write failed, so the chips are not yet moved.
      store.pushError(
        msg.retrying
          ? t('Settlement failed - retrying automatically (attempt {n}).', { n: msg.attempt })
          : t('Settlement failed - the host must retry.'),
      );
      return;
    }

    case 'hand_end': {
      // Record the terminal frame for its own hand BEFORE any guard: a retained
      // replay of an older hand still has to stop a later `settlement_failed`
      // for that same hand from reviving its banner.
      endedHands.add(msg.handId);
      terminalHands.add(msg.handId);
      const cur = useStore.getState().hand.handId;
      if (cur && cur !== msg.handId) {
        // A terminal frame for a hand the client already moved past (a late
        // frame from a replaced connection, or the server's retained replay of
        // an older hand) must not touch the CURRENT hand's live state. But it
        // still carries ITS OWN hand's terminal outcome, so clear a settlement
        // failure naming that hand - that is what unsticks a stale banner.
        if (useStore.getState().hand.settlementFailed?.handId === msg.handId) {
          store.patchHand({ settlementFailed: null });
        }
        return;
      }
      const state = useStore.getState();
      const mySeat = mySeatIn(state.hand.seats);
      const myDelta = msg.deltas.find((d) => d.seat === mySeat)?.delta ?? 0;
      play(myDelta > 0 ? 'win' : 'end');
      // freeze the recap before the next deal wipes it: the "last hand" strip
      // shows the winner and everyone's cards on demand
      // (requested by notpritam, docs/FEATURES.md)
      const h = state.hand;
      const nameOf = (seat: number) =>
        state.room?.players.find((p) => p.seat === seat)?.displayName ?? `Seat ${seat + 1}`;
      // Freeze every run's board, not just the first two: a 3-run hand only
      // reaches the recap through `boards`. showdown.multiRun (2-3 runs) is
      // authoritative, then the legacy runTwice pair, then the live boards.
      const showdownMultiRun = h.showdown?.multiRun ?? null;
      const showdownTwice = h.showdown?.runTwice ?? null;
      const boards = showdownMultiRun?.boards ?? showdownTwice?.boards ?? h.boards;
      const multiRun = showdownMultiRun
        ? { boards: showdownMultiRun.boards, awards: showdownMultiRun.awards }
        : showdownTwice
          ? { boards: showdownTwice.boards, awards: showdownTwice.awards }
          : null;
      store.setLastHand({
        handId: msg.handId,
        ts: Date.now(),
        board: boards[0] ?? h.board,
        board2: boards[1] ?? h.board2,
        boards,
        multiRun,
        reveals: h.showdown?.reveals ?? [],
        shown: h.shown,
        deltas: msg.deltas,
        commissionDeltas: msg.commissionDeltas,
        runTwice: showdownTwice,
        names: Object.fromEntries(h.seats.map((s) => [s.seat, nameOf(s.seat)])),
      });
      store.patchHand({
        result: msg,
        deadline: null,
        baseDeadline: null,
        multiRunOffer: null,
        // the terminal frame can only be broadcast after the write committed
        settlementFailed: null,
        // A reconnect may have synthesised a refund abort before the server's
        // retained terminal frame was replayed; a real hand_end supersedes it.
        abort: null,
        // A real terminal frame proves the hand committed: the durable
        // `unresolved` answer (if any) no longer applies.
        handRecovery: null,
      });
      // the hand key stays until the next deal so "Show cards" can still prove reveals
      return;
    }

    case 'hand_abort': {
      // Same stale-frame discipline as hand_end: an old connection's abort must
      // not wipe the current hand's recovery state, but a matching failure for
      // its OWN hand is exactly what the abort resolves.
      endedHands.add(msg.handId);
      terminalHands.add(msg.handId);
      const cur = useStore.getState().hand.handId;
      if (cur && cur !== msg.handId) {
        if (useStore.getState().hand.settlementFailed?.handId === msg.handId) {
          store.patchHand({ settlementFailed: null });
        }
        return;
      }
      store.patchHand({
        abort: msg,
        deadline: null,
        baseDeadline: null,
        multiRunOffer: null,
        settlementFailed: null,
        // A real abort is a terminal answer: any durable `unresolved` no longer
        // applies.
        handRecovery: null,
      });
      return;
    }

    case 'hand_recovery': {
      // Durable answer for the hand we told the server we still hold, used when
      // no live hand or retained frame can answer. It is the authoritative exit
      // from an `orphaned` banner: once an operator resolves the lifecycle, the
      // next reconnect reports `committed`/`aborted` here and the client moves
      // on instead of insisting an administrator is still needed.
      const h = useStore.getState().hand;
      const failed = h.settlementFailed;
      if (msg.status === 'committed') {
        terminalHands.add(msg.handId);
        if (h.handId === msg.handId && !h.result) {
          // No full terminal survived the restart. Close the hand as finished
          // (chips moved) so the room_state resync neither synthesises a refund
          // abort nor leaves a phantom live table. The recap is a recovered
          // marker: per-seat detail is genuinely unavailable in this path.
          store.patchHand({
            result: {
              t: 'hand_end',
              handId: msg.handId,
              head: '',
              stacks: [],
              deltas: [],
              recovered: true,
            },
            abort: null,
            deadline: null,
            baseDeadline: null,
            multiRunOffer: null,
            settlementFailed: null,
            // The hand is terminal now: clear the admin-only recovery state.
            handRecovery: null,
          });
        } else if (failed?.handId === msg.handId) {
          store.patchHand({ settlementFailed: null, handRecovery: null });
        }
        return;
      }
      if (msg.status === 'aborted') {
        terminalHands.add(msg.handId);
        if (h.handId === msg.handId || failed?.handId === msg.handId) {
          store.patchHand({
            abort: {
              t: 'hand_abort',
              handId: msg.handId,
              reason: 'The hand was aborted by the server; bets were returned.',
              blamedSeat: null,
            },
            result: null,
            deadline: null,
            baseDeadline: null,
            multiRunOffer: null,
            settlementFailed: null,
            // Bets were returned: this is the terminal abort, so the durable
            // `unresolved` state is resolved.
            handRecovery: null,
          });
        }
        return;
      }
      // unresolved: the hand never reached a terminal transaction. This is
      // recorded even when NO `settlement_failed` frame was ever seen - the
      // client still holds the hand, and its disappearance from a later
      // `room_state` must not be read as a refund. Only an operator can resolve
      // it, so surface admin-only status and never offer a retry that cannot
      // succeed.
      if (h.handId === msg.handId || failed?.handId === msg.handId) {
        if (failed && failed.handId === msg.handId) {
          store.patchHand({
            handRecovery: 'unresolved',
            settlementFailed: {
              ...failed,
              orphaned: true,
              retrying: false,
              retryRequestedAt: null,
            },
            deadline: null,
            baseDeadline: null,
          });
        } else {
          store.patchHand({ handRecovery: 'unresolved', deadline: null, baseDeadline: null });
        }
      }
      return;
    }

    case 'transcript_entry': {
      // The settlement entry is the hand's terminal record, and it is broadcast
      // BEFORE the server asks for audit keys - whereas hand_end comes after,
      // and a hand won by everyone folding never produces a showdown at all. So
      // this, not hand_end, is the signal that answering need_keys is safe.
      if (msg.type === 'settlement' || msg.type === 'hand_abort') endedHands.add(msg.handId);
      return;
    }

    case 'need_keys': {
      // The audit key opens the whole deck, so it goes out only once the hand is
      // genuinely over. Answering this mid-hand - which the server can ask for at
      // any moment - would hand it every hole card at the table at once.
      if (!endedHands.has(msg.handId)) return;
      const k = handKeyFor(msg.handId);
      if (k === null) return;
      const key = k.toString(16);
      wsClient.send({
        t: 'reveal_key',
        handId: msg.handId,
        key,
        sig: signed(msg.handId, 'reveal_key', { key }),
      });
      return;
    }

    default:
      return;
  }
}

let bound = false;
export function bindGameClient(): void {
  if (bound) return;
  bound = true;
  wsClient.on(handle);
}
