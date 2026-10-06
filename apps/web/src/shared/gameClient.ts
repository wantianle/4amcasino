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
import { handEffectsReducer } from './handEffectsReducer.ts';
import {
  handLifecycleReducer,
  type LifecycleMsg,
  type LifecycleResult,
} from './handLifecycleReducer.ts';
import { useStore } from './store.ts';
import { wsClient } from './ws.ts';
import { voice } from './voice.ts';
import { play } from './sounds.ts';

const lookup = cardLookup();

const KEY_PREFIX = '4am/handkey/';

// This is deliberately client-session state, not part of the authoritative
// hand snapshot.  A reconnect can replay frames, but it must not make cards
// fly again; a fixture/resetHand call also cannot manufacture a deal event.
//
// Motion metadata is per-hand and only ever read for the hand currently on
// screen (plus a brief recap window), but the maps used to keep every handId
// forever - one entry per card of every hand ever dealt in a long-lived tab.
// They are bounded below by a handId LRU: a write moves that hand to the MRU
// end and the least-recently written hand that is NOT pinned is dropped whole
// (all of its keys at once).
const MOTION_HAND_CAP = 64;
const dealEpochByHand = new Map<string, number>();
const dealtMotionByCard = new Map<string, number>();
const dealEpochByCard = new Map<string, number>();
const boardDeckIndexByCard = new Map<string, number>();
/** LRU order of handIds that have motion metadata; oldest (eviction candidate) first. */
const motionHandOrder: string[] = [];

/** HandIds whose motion metadata must survive eviction:
 *  - the live hand (its cards are on screen right now);
 *  - the last-hand recap (may still be rendered);
 *  - a hand THIS browser folded but has not yet seen reach a terminal state
 *    (the fold escrow may still need to observe its `action_applied`).
 *  A folded-but-unsettled hand is a safety pin, not a cache entry: many of them
 *  may legitimately outnumber the cap, and then the bound is pins + 0. */
function pinnedMotionHands(): Set<string> {
  const { hand, lastHand } = useStore.getState();
  const pins = new Set<string>();
  if (hand.handId) pins.add(hand.handId);
  if (lastHand?.handId) pins.add(lastHand.handId);
  for (const folded of foldedByMe) if (!terminalHands.has(folded)) pins.add(folded);
  return pins;
}

/** Drop every map entry owned by one hand. Card maps key on `handId:...`;
 *  `dealEpochByHand` keys on the bare handId. */
function evictMotionHand(handId: string): void {
  dealEpochByHand.delete(handId);
  const prefix = `${handId}:`;
  for (const key of dealtMotionByCard.keys()) if (key.startsWith(prefix)) dealtMotionByCard.delete(key);
  for (const key of dealEpochByCard.keys()) if (key.startsWith(prefix)) dealEpochByCard.delete(key);
  for (const key of boardDeckIndexByCard.keys()) if (key.startsWith(prefix)) boardDeckIndexByCard.delete(key);
}

/** Mark a hand MRU and evict the oldest unpinned hands until back within cap. */
function touchMotionHand(handId: string): void {
  const at = motionHandOrder.indexOf(handId);
  if (at >= 0) motionHandOrder.splice(at, 1);
  motionHandOrder.push(handId);
  if (motionHandOrder.length <= MOTION_HAND_CAP) return;
  const pins = pinnedMotionHands();
  for (let i = 0; i < motionHandOrder.length && motionHandOrder.length > MOTION_HAND_CAP; ) {
    const candidate = motionHandOrder[i]!;
    if (pins.has(candidate)) {
      i++;
      continue;
    }
    motionHandOrder.splice(i, 1);
    evictMotionHand(candidate);
  }
}

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
  touchMotionHand(handId);
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
  touchMotionHand(handId);
  return true;
}

function advanceDealEpoch(handId: string): number {
  const next = (dealEpochByHand.get(handId) ?? 0) + 1;
  dealEpochByHand.set(handId, next);
  touchMotionHand(handId);
  return next;
}

/** Test/fixture bridge for an explicitly simulated deal event. Snapshots must
 * use resetHand/patchHand instead; only an event may call this. */
export function noteDealMotion(handId: string, cardKey: string): number {
  const epoch = advanceDealEpoch(handId);
  dealEpochByCard.set(`${handId}:${cardKey}`, epoch);
  touchMotionHand(handId);
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

/** Which kind of session boundary is being crossed. `leave-room` is the one
 *  boundary that must NOT wipe the registries (see `resetHandSession`). */
export type HandSessionResetReason = 'logout' | 'leave-room' | 'session-end';

/** Reset the module-level hand state at a session boundary.
 *
 *  The three boundaries are deliberately not interchangeable:
 *  - `logout` (log out / switch account): full wipe. Nothing the old identity
 *    saw may authorise a key reveal or suppress a terminal for the new one.
 *  - `leave-room`: NO wipe. The same live hand can be resumed after re-joining,
 *    and the local evidence that this browser folded it is what makes the
 *    replayed `action_applied` send `fold_key`. `endedHands`/`terminalHands`
 *    persistence is likewise intentional: a reconnect must not revive a
 *    finished hand or double-escrow its key.
 *  - `session-end` (explicit end): full wipe, same as logout. */
export function resetHandSession(reason: HandSessionResetReason): void {
  if (reason === 'leave-room') return;
  foldedByMe.clear();
  endedHands.clear();
  terminalHands.clear();
  dealEpochByHand.clear();
  dealtMotionByCard.clear();
  dealEpochByCard.clear();
  boardDeckIndexByCard.clear();
  motionHandOrder.length = 0;
}

/** The production trigger for the full wipe: the auth IDENTITY going away or
 *  becoming a different one. Both `logout()` call sites (the nav/Settings/admin
 *  buttons) and `api.ts`'s 401 "session expired" path funnel through the store's
 *  `logout` action, and `?switch=1` re-login replaces the identity through
 *  `setAuth` WITHOUT ever calling `logout()` - so watching the identity is the
 *  one place that covers every account boundary, including the one no explicit
 *  call site owns.
 *
 *  It lives here, not in `store.logout()`, because the registries are this
 *  module's state and the store importing this module would close an import
 *  cycle (store <- gameClient <- ws/voice <- store). A fresh sign-in
 *  (null -> identity) is deliberately NOT a wipe: there is no previous
 *  identity's evidence to drop, and a hard reload starts with empty registries
 *  anyway.
 *
 *  `leave-room` is the room boundary (see `wsClient.leaveRoom` / TablePage's
 *  room-effect cleanup) and must preserve the registries; there is no separate
 *  production `session-end` today - a 401 expiry lands here as a logout. */
useStore.subscribe((state, prev) => {
  if (prev.auth.userId !== null && state.auth.userId !== prev.auth.userId) {
    resetHandSession('logout');
  }
});

/** Test-only: clear the module-level hand-tracking sets so cases are isolated.
 *  Production never calls this - the sets are process-lifetime by design and
 *  resetting them mid-session would re-open already-finished hands. */
export function __resetHandTrackingForTest(): void {
  resetHandSession('session-end');
}

/** Test-only: current occupancy of the bounded motion state, so a case can
 *  assert the maps do not grow forever. `order` is the LRU order, oldest first. */
export function __motionStateForTest(): {
  order: string[];
  epochByHand: number;
  dealtByCard: number;
  epochByCard: number;
  boardIndexByCard: number;
} {
  return {
    order: [...motionHandOrder],
    epochByHand: dealEpochByHand.size,
    dealtByCard: dealtMotionByCard.size,
    epochByCard: dealEpochByCard.size,
    boardIndexByCard: boardDeckIndexByCard.size,
  };
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

/** Route one class-B frame through the pure lifecycle reducer and execute the
 *  ordered operations it returns. The impure capabilities the reducer is not
 *  allowed to hold (the resync flag, the clock, the per-hand key, `localStorage`)
 *  are resolved here and injected as data/thunks. */
function runLifecycle(msg: LifecycleMsg): void {
  const state = useStore.getState();
  // `consumeResync()` is a consuming side effect: drain it here, once, exactly
  // where the old `room_state` branch did, and hand the boolean to the reducer.
  const resync = msg.t === 'room_state' ? wsClient.consumeResync() : false;
  const result = handLifecycleReducer(
    {
      hand: state.hand,
      lastHand: state.lastHand,
      room: state.room,
      registries: { terminalHands, endedHands, foldedByMe },
      userId: state.auth.userId,
      resync,
      now: Date.now,
      handKey: (handId) => handKeyFor(handId)?.toString(16) ?? null,
    },
    msg,
  );
  applyLifecycle(result);
}

/** Execute a `LifecycleResult`. Registry claims are applied first, then the
 *  ordered ops are run start to finish so the interleaving of store writes and
 *  effects is exactly the one the reducer chose. */
function applyLifecycle(result: LifecycleResult): void {
  const { terminalHands: terminalClaim, endedHands: endedClaim } = result.claims;
  if (terminalClaim !== undefined) {
    terminalHands.add(terminalClaim);
    // A terminal frame closes the fold-escrow window: the hand can no longer
    // produce a fresh `action_applied`, so "I folded X" is no longer needed and
    // must not keep the hand pinned in the motion LRU or leak forever.
    foldedByMe.delete(terminalClaim);
  }
  if (endedClaim !== undefined) endedHands.add(endedClaim);
  for (const op of result.ops) {
    if ('store' in op) {
      const store = useStore.getState();
      switch (op.store) {
        case 'room':
          store.setRoom(op.set);
          break;
        case 'hand':
          if ('reset' in op) store.resetHand(op.reset);
          else store.patchHand(op.patch);
          break;
        case 'lastHand':
          store.setLastHand(op.set);
          break;
        case 'errors':
          store.pushError(op.push);
          break;
      }
      continue;
    }
    switch (op.effect) {
      case 'sound':
        play(op.name);
        break;
      case 'voice-sync':
        voice.syncPeers(op.players);
        break;
      case 'drop-hand-key':
        try {
          localStorage.removeItem(KEY_PREFIX + op.handId);
          sessionStorage.removeItem(KEY_PREFIX + op.handId);
        } catch {
          /* storage disabled */
        }
        break;
      case 'prune-hand-keys': {
        // previous hands' keys are no longer needed: the voluntary-show window
        // for the last hand closes when a new one is dealt
        const keep = KEY_PREFIX + op.keepHandId;
        for (let i = sessionStorage.length - 1; i >= 0; i--) {
          const key = sessionStorage.key(i);
          if (key?.startsWith(KEY_PREFIX) && key !== keep) sessionStorage.removeItem(key);
        }
        break;
      }
      case 'key-commit': {
        const k = createHandKey(op.handId);
        const commit = pointHex(handKeyCommit(k));
        wsClient.send({
          t: 'key_commit',
          handId: op.handId,
          commit,
          sig: signContent(
            useStore.getState().auth.identity!.secretKey,
            op.handId,
            'key_commit',
            { commit },
          ),
        });
        break;
      }
      case 'fold-key':
        wsClient.send({
          t: 'fold_key',
          handId: op.handId,
          key: op.key,
          sig: signed(op.handId, 'fold_key', { key: op.key }),
        });
        break;
      case 'reveal-key': {
        const k = handKeyFor(op.handId);
        if (k === null) break;
        const key = k.toString(16);
        wsClient.send({
          t: 'reveal_key',
          handId: op.handId,
          key,
          sig: signed(op.handId, 'reveal_key', { key }),
        });
        break;
      }
    }
  }
}

export function handle(msg: ServerMsg): void {
  const store = useStore.getState();
  switch (msg.t) {
    case 'room_state': {
      runLifecycle(msg);
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
      runLifecycle(msg);
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
      runLifecycle(msg);
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

    // Effect-describing frames: the reducer decides the pure patch and the
    // sound descriptors; this switch only applies the patch and then runs the
    // effects. `play` is called here, never inside the reducer. Patch-first is
    // safe because none of these sounds reads the patched state (see
    // handEffectsReducer for the exact criterion).
    case 'rit_offer':
    case 'rit_result':
    case 'multi_run_offer': {
      const result = handEffectsReducer(useStore.getState().hand, msg);
      if (!result) return;
      store.patchHand(result.patch);
      for (const effect of result.effects) if (effect.kind === 'sound') play(effect.name);
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

    case 'squid_result':
    case 'peek_offer': {
      const result = handEffectsReducer(useStore.getState().hand, msg);
      if (!result) return;
      store.patchHand(result.patch);
      for (const effect of result.effects) if (effect.kind === 'sound') play(effect.name);
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
      runLifecycle(msg);
      return;
    }

    case 'hand_end': {
      runLifecycle(msg);
      return;
    }

    case 'hand_abort': {
      runLifecycle(msg);
      return;
    }

    case 'hand_recovery': {
      runLifecycle(msg);
      return;
    }

    case 'transcript_entry': {
      runLifecycle(msg);
      return;
    }

    case 'need_keys': {
      runLifecycle(msg);
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
