import type { ServerMsg } from '@4am/shared';
import type { HandView, LastHandSnap } from './store.ts';
import type { SoundName } from './sounds.ts';
import { t } from './i18n/index.ts';

/**
 * Step 3 (B class) of the `gameClient.handle()` decomposition: the terminal /
 * recovery / reconnect lifecycle.
 *
 * The A-class reducers (`handReducer`, `handEffectsReducer`) translate a frame
 * into "one pure patch (+ maybe a fixed sound)". Class B is different in three
 * ways, and the shape of this module follows from them rather than from a
 * frame-by-frame translation:
 *
 *  1. **Cross-store.** `hand_end` writes `hand` AND freezes `lastHand`;
 *     `settlement_failed` writes `hand` AND pushes an `errors` toast;
 *     `room_state` writes `room`, `hand` and calls `voice.syncPeers`. So the
 *     result is an ORDERED list of operations, not a single patch.
 *
 *  2. **Explicit ordering.** The switch interleaves store writes and effects in
 *     ways that are observable: `hand_end` plays its win/end cue BEFORE it
 *     freezes the recap, and `action_applied` plays before it may (on a missing
 *     key) early-return without patching. Separate `patch`/`effects` arrays
 *     cannot express that, so there is ONE ordered `ops` array and the runner
 *     executes it start to finish.
 *
 *  3. **Shared module-level registries.** `terminalHands`, `endedHands` and
 *     `foldedByMe` are read by guards (`settlement_failed`, `hand_recovery`,
 *     `need_keys`, `action_applied`) and written by terminals
 *     (`hand_end`, `hand_abort`, `hand_recovery`, `transcript_entry`). They are
 *     INJECTED as read-only snapshots so the reducer stays a pure function of
 *     data, and the writes come back as `claims` that the runner applies once
 *     before running `ops`. `terminalHands` (terminal registry) and
 *     `endedHands` (audit-key authorisation) are deliberately different sets and
 *     are never inferred from one another here.
 *
 * The reducer reads no store, socket, storage, DOM or clock directly. The clock
 * is the injected `now` thunk and the per-hand key is the injected `handKey`
 * thunk, exactly like `handReducer`'s clock: they are called only on the frames
 * that need them, so the number and timing of the underlying reads is the same
 * as the pre-extraction switch.
 */

type RoomStateMsg = Extract<ServerMsg, { t: 'room_state' }>;
type HandStartMsg = Extract<ServerMsg, { t: 'hand_start' }>;
type HandEndMsg = Extract<ServerMsg, { t: 'hand_end' }>;
type HandAbortMsg = Extract<ServerMsg, { t: 'hand_abort' }>;
type HandRecoveryMsg = Extract<ServerMsg, { t: 'hand_recovery' }>;

/** The frames class B owns. Each is routed here by `handle()`; the rest of the
 *  switch (deal/crypto/betting frames, `showdown`, ...) stays in gameClient. */
export type LifecycleMsg = Extract<
  ServerMsg,
  {
    t:
      | 'room_state'
      | 'hand_start'
      | 'settlement_failed'
      | 'hand_end'
      | 'hand_abort'
      | 'hand_recovery'
      | 'transcript_entry'
      | 'need_keys'
      | 'action_applied';
  }
>;

/** Read-only view of the module-level registries, captured by the runner. */
export interface LifecycleRegistries {
  /** Hands seen reach a terminal state. Guards a replayed `settlement_failed`
   *  and a late `hand_recovery`. NOT an authorisation to reveal keys. */
  terminalHands: ReadonlySet<string>;
  /** Hands whose audit key may be revealed. Written by `hand_end`/`hand_abort`
   *  and by a terminal `transcript_entry`; read only by `need_keys`. */
  endedHands: ReadonlySet<string>;
  /** Hands THIS browser actually folded; read only by the `fold_key` escrow. */
  foldedByMe: ReadonlySet<string>;
}

/** Everything the lifecycle reducer is allowed to observe. */
export interface LifecycleCtx {
  hand: HandView;
  lastHand: LastHandSnap | null;
  room: RoomStateMsg | null;
  registries: LifecycleRegistries;
  /** `auth.userId`; `mySeatIn` folds the server's seats against it. */
  userId: number | null;
  /** `room_state` only: `wsClient.consumeResync()` already drained by the
   *  runner (the call is a consuming side effect, so it cannot live here). */
  resync: boolean;
  /** Injected clock. Only `settlement_failed` (`since`) and `hand_end` (`ts`). */
  now: () => number;
  /** `handKeyFor(handId)?.toString(16) ?? null`. Called only by the `fold_key`
   *  gate, matching the original conditional read. */
  handKey: (handId: string) => string | null;
}

/** Ordered operations. Store writes and effects share the array so their
 *  interleaving is preserved; the runner discriminates on `store` vs `effect`. */
export type LifecycleOp =
  // -- store writes ---------------------------------------------------------
  | { store: 'room'; set: RoomStateMsg }
  | { store: 'hand'; patch: Partial<HandView> }
  /** Full reset, not a merge: `hand_start` / `room_state` replace the snapshot. */
  | { store: 'hand'; reset: Partial<HandView> }
  | { store: 'lastHand'; set: LastHandSnap }
  | { store: 'errors'; push: string }
  // -- effects (data descriptions; the runner performs them) ----------------
  | { effect: 'sound'; name: SoundName }
  | { effect: 'voice-sync'; players: RoomStateMsg['players'] }
  /** Lost the current hand: forget its key in both storages. */
  | { effect: 'drop-hand-key'; handId: string }
  /** New deal: drop every other hand's session key. */
  | { effect: 'prune-hand-keys'; keepHandId: string }
  | { effect: 'key-commit'; handId: string }
  | { effect: 'fold-key'; handId: string; key: string }
  | { effect: 'reveal-key'; handId: string };

/** Registry writes returned as data; the runner applies them before `ops`. */
export interface LifecycleClaims {
  terminalHands?: string;
  endedHands?: string;
}

export interface LifecycleResult {
  claims: LifecycleClaims;
  ops: LifecycleOp[];
}

const EMPTY: LifecycleResult = { claims: {}, ops: [] };

function mySeatIn(
  seats: readonly { seat: number; userId: number }[],
  userId: number | null,
): number | null {
  return seats.find((s) => s.userId === userId)?.seat ?? null;
}

/** The lifecycle transition function: `(snapshot, msg) -> claims + ordered ops`.
 *
 *  A pure function of its arguments. It never touches a store, socket, storage,
 *  DOM or clock; `now()` and `handKey()` are injected capabilities called only
 *  where the original switch called `Date.now()` / `handKeyFor()`. */
export function handLifecycleReducer(ctx: LifecycleCtx, msg: LifecycleMsg): LifecycleResult {
  switch (msg.t) {
    case 'room_state': {
      const ops: LifecycleOp[] = [{ store: 'room', set: msg }];
      // Authoritative snapshot restores countdown/readiness after a reconnect.
      if (msg.autoDealAt !== undefined) {
        ops.push({
          store: 'hand',
          patch: { autoDealAt: msg.autoDealAt, readyCheck: msg.readyCheck ?? null },
        });
      }
      // after a reconnect (deploy or network drop): if the server no longer has
      // our hand, stop showing it as live instead of freezing the table
      if (ctx.resync && !msg.handActive) {
        const h = ctx.hand;
        const failed = h.settlementFailed;
        if (h.handId && failed && failed.handId === h.handId) {
          // A pending durable-settlement failure is NOT resolved by the hand
          // disappearing from the server. Absence of `handActive` is not proof
          // the chips moved, so keep the banner and mark it orphaned (no live
          // hand for the host to retry) until a retained terminal clears it.
          ops.push({
            store: 'hand',
            patch: {
              settlementFailed: {
                ...failed,
                orphaned: true,
                retrying: false,
                retryRequestedAt: null,
              },
              deadline: null,
            },
          });
        } else if (h.handId && h.handRecovery === 'unresolved') {
          // The durable answer is `unresolved`: the missing live hand is NOT a
          // restart refund. Keep the recovery state, stop the dead timer. Only
          // an operator resolves it; synthesising an abort would fabricate a
          // refund the durable state never made.
          ops.push({ store: 'hand', patch: { deadline: null, baseDeadline: null } });
        } else if (h.handId && !h.result && !h.abort) {
          ops.push({
            store: 'hand',
            patch: {
              abort: {
                t: 'hand_abort',
                handId: h.handId,
                reason:
                  'The server restarted during this hand. Bets were returned; the host can deal again.',
                blamedSeat: null,
              },
              deadline: null,
              settlementFailed: null,
            },
          });
          ops.push({ effect: 'drop-hand-key', handId: h.handId });
        }
      }
      ops.push({ effect: 'voice-sync', players: msg.players });
      return { claims: {}, ops };
    }

    case 'hand_start': {
      const mySeat = mySeatIn(msg.seats, ctx.userId);
      // re-sent on reconnect: never wipe state we already have for this hand
      const fresh = ctx.hand.handId !== msg.handId;
      const ops: LifecycleOp[] = [];
      if (fresh) {
        // A refresh can receive this hand's `settlement_failed` BEFORE its
        // `hand_start`: the server re-asserts the frozen settlement first, and
        // a fresh client writes it against a null handId. Keep it only when it
        // names THIS hand - a previous hand's failure must never leak in.
        const carry = ctx.hand.settlementFailed;
        ops.push({
          store: 'hand',
          reset: {
            handId: msg.handId,
            seats: msg.seats,
            buttonSeat: msg.buttonSeat,
            settlementFailed: carry?.handId === msg.handId ? carry : null,
          },
        });
        // previous hands' keys are no longer needed: the voluntary-show window
        // for the last hand closes when a new one is dealt
        ops.push({ effect: 'prune-hand-keys', keepHandId: msg.handId });
        ops.push({ effect: 'sound', name: 'shuffle' });
      }
      if (mySeat === null) return { claims: {}, ops }; // spectator
      ops.push({ effect: 'key-commit', handId: msg.handId });
      return { claims: {}, ops };
    }

    case 'settlement_failed': {
      const h = ctx.hand;
      // A hand that already reached a terminal state must never be re-opened: a
      // late or replayed frame from a replaced connection would otherwise
      // resurrect the banner that `hand_end`/`hand_abort` just cleared.
      if (ctx.registries.terminalHands.has(msg.handId)) return EMPTY;
      // A frame naming an already-superseded hand must not resurrect the banner.
      if (h.handId && h.handId !== msg.handId) return EMPTY;
      const prev = h.settlementFailed;
      return {
        claims: {},
        ops: [
          {
            store: 'hand',
            patch: {
              settlementFailed: {
                handId: msg.handId,
                reason: msg.reason,
                attempt: msg.attempt,
                retrying: msg.retrying,
                // any frame answers the in-flight manual retry
                retryRequestedAt: null,
                manualRetry: prev?.handId === msg.handId ? prev.manualRetry : false,
                // a live frame proves the server still has the hand: not orphaned
                since: ctx.now(),
                orphaned: false,
              },
            },
          },
          // Never silent: the durable write failed, so the chips are not moved.
          {
            store: 'errors',
            push: msg.retrying
              ? t('Settlement failed - retrying automatically (attempt {n}).', {
                  n: msg.attempt,
                })
              : t('Settlement failed - the host must retry.'),
          },
        ],
      };
    }

    case 'hand_end':
      return handEndResult(ctx, msg);

    case 'hand_abort': {
      // Same stale-frame discipline as hand_end: an old connection's abort must
      // not wipe the current hand's recovery state, but a matching failure for
      // its OWN hand is exactly what the abort resolves.
      const claims: LifecycleClaims = { endedHands: msg.handId, terminalHands: msg.handId };
      const cur = ctx.hand.handId;
      if (cur && cur !== msg.handId) {
        if (ctx.hand.settlementFailed?.handId === msg.handId) {
          return { claims, ops: [{ store: 'hand', patch: { settlementFailed: null } }] };
        }
        return { claims, ops: [] };
      }
      return {
        claims,
        ops: [
          {
            store: 'hand',
            patch: {
              abort: msg,
              deadline: null,
              baseDeadline: null,
              multiRunOffer: null,
              equityBubble: null,
              settlementFailed: null,
              // A real abort is a terminal answer: any durable `unresolved` no
              // longer applies.
              handRecovery: null,
            },
          },
        ],
      };
    }

    case 'hand_recovery':
      return handRecoveryResult(ctx, msg);

    case 'transcript_entry':
      // The settlement entry is the hand's terminal record, and it is broadcast
      // BEFORE the server asks for audit keys - whereas hand_end comes after,
      // and a hand won by everyone folding never produces a showdown at all. So
      // this, not hand_end, is the signal that answering need_keys is safe.
      return msg.type === 'settlement' || msg.type === 'hand_abort'
        ? { claims: { endedHands: msg.handId }, ops: [] }
        : EMPTY;

    case 'need_keys':
      // The audit key opens the whole deck, so it goes out only once the hand is
      // genuinely over. `endedHands`, never `terminalHands`: a status-only
      // `committed` recovery marks a hand terminal but does not authorise
      // handing over the key. The key lookup itself stays in the runner.
      if (!ctx.registries.endedHands.has(msg.handId)) return EMPTY;
      return { claims: {}, ops: [{ effect: 'reveal-key', handId: msg.handId }] };

    case 'action_applied': {
      const h = ctx.hand;
      const soundFor = {
        fold: 'muck',
        check: 'knock',
        call: 'chip',
        bet: 'chips-slide',
        raise: 'chips-slide',
      } as const;
      // Played before the fold gate: a fold this browser did NOT make still
      // cues, and a missing key must not swallow the cue (the original plays
      // before its early return too).
      const ops: LifecycleOp[] = [{ effect: 'sound', name: soundFor[msg.action.type] }];
      // my fold escrows my hand key with the server, so the hand can carry on
      // without me if I disappear - but only for a fold this browser actually
      // made. Taking the server's word for it would let a forged
      // action_applied pull the hand key out of a player still contesting.
      const foldGate =
        msg.action.type === 'fold' &&
        h.handId === msg.handId &&
        msg.seat === mySeatIn(h.seats, ctx.userId) &&
        ctx.registries.foldedByMe.has(msg.handId) &&
        // The last fold settles synchronously on the server. There is no
        // remaining hand to escrow for; replying would arrive after hand_end.
        (h.betting?.seats.filter((seat) => !seat.folded && seat.seat !== msg.seat).length ?? 0) >
          1;
      if (foldGate) {
        const key = ctx.handKey(msg.handId);
        // Missing key: the original returns here, before the lastActions patch.
        if (key === null) return { claims: {}, ops };
        ops.push({ effect: 'fold-key', handId: msg.handId, key });
      }
      ops.push({
        store: 'hand',
        patch: {
          lastActions: { ...h.lastActions, [msg.seat]: { ...msg.action, auto: msg.auto } },
        },
      });
      return { claims: {}, ops };
    }
  }
}

function handEndResult(ctx: LifecycleCtx, msg: HandEndMsg): LifecycleResult {
  // Record the terminal frame for its own hand BEFORE any guard: a retained
  // replay of an older hand still has to stop a later `settlement_failed` for
  // that same hand from reviving its banner.
  const claims: LifecycleClaims = { endedHands: msg.handId, terminalHands: msg.handId };
  const cur = ctx.hand.handId;
  if (cur && cur !== msg.handId) {
    // A terminal frame for a hand the client already moved past must not touch
    // the CURRENT hand's live state. But it still carries ITS OWN hand's
    // terminal outcome, so clear a settlement failure naming that hand - that
    // is what unsticks a stale banner.
    if (ctx.hand.settlementFailed?.handId === msg.handId) {
      return { claims, ops: [{ store: 'hand', patch: { settlementFailed: null } }] };
    }
    return { claims, ops: [] };
  }
  const h = ctx.hand;
  const mySeat = mySeatIn(h.seats, ctx.userId);
  const myDelta = msg.deltas.find((d) => d.seat === mySeat)?.delta ?? 0;
  // Freeze every run's board, not just the first two: a 3-run hand only reaches
  // the recap through `boards`. showdown.multiRun is authoritative, then the
  // legacy runTwice pair, then the live boards.
  const showdownMultiRun = h.showdown?.multiRun ?? null;
  const showdownTwice = h.showdown?.runTwice ?? null;
  const boards = showdownMultiRun?.boards ?? showdownTwice?.boards ?? h.boards;
  const multiRun = showdownMultiRun
    ? { boards: showdownMultiRun.boards, awards: showdownMultiRun.awards }
    : showdownTwice
      ? { boards: showdownTwice.boards, awards: showdownTwice.awards }
      : null;
  const nameOf = (seat: number) =>
    ctx.room?.players.find((p) => p.seat === seat)?.displayName ?? `Seat ${seat + 1}`;
  return {
    claims,
    ops: [
      // the cue is decided from the pre-write snapshot and, as in the original
      // switch, is played BEFORE the recap and the hand are written
      { effect: 'sound', name: myDelta > 0 ? 'win' : 'end' },
      {
        store: 'lastHand',
        set: {
          handId: msg.handId,
          ts: ctx.now(),
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
        },
      },
      {
        store: 'hand',
        patch: {
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
        },
      },
    ],
  };
}

function handRecoveryResult(ctx: LifecycleCtx, msg: HandRecoveryMsg): LifecycleResult {
  const h = ctx.hand;
  const failed = h.settlementFailed;
  // A hand that already reached a terminal outcome must not be rewritten by a
  // late/replayed durable answer. Evaluated BEFORE the claim below is applied -
  // reading it after would always see the just-added id. The registry outlives
  // any single hand lifecycle, so a later hand reusing the id is still rejected
  // (the correct, idempotent behaviour).
  const alreadyTerminal = ctx.registries.terminalHands.has(msg.handId);

  if (msg.status === 'committed') {
    const claims: LifecycleClaims = { terminalHands: msg.handId };
    if (alreadyTerminal) return { claims, ops: [] };
    if (h.handId === msg.handId && !h.result) {
      // No full terminal survived the restart. Close the hand as finished
      // (chips moved) so the room_state resync neither synthesises a refund
      // abort nor leaves a phantom live table. The recap is a recovered marker:
      // per-seat detail is genuinely unavailable in this path.
      return {
        claims,
        ops: [
          {
            store: 'hand',
            patch: {
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
              handRecovery: null,
            },
          },
        ],
      };
    }
    if (failed?.handId === msg.handId) {
      return {
        claims,
        ops: [{ store: 'hand', patch: { settlementFailed: null, handRecovery: null } }],
      };
    }
    return { claims, ops: [] };
  }

  if (msg.status === 'aborted') {
    const claims: LifecycleClaims = { terminalHands: msg.handId };
    if (alreadyTerminal) return { claims, ops: [] };
    if (h.handId === msg.handId || failed?.handId === msg.handId) {
      return {
        claims,
        ops: [
          {
            store: 'hand',
            patch: {
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
            },
          },
        ],
      };
    }
    return { claims, ops: [] };
  }

  // unresolved: the hand never reached a terminal transaction. Recorded even
  // when NO `settlement_failed` frame was ever seen - the client still holds
  // the hand, and its disappearance from a later `room_state` must not be read
  // as a refund. Only an operator can resolve it. Declining here without
  // claiming terminal keeps `unresolved` distinct from a terminal state.
  if (alreadyTerminal) return EMPTY;
  if (h.handId === msg.handId || failed?.handId === msg.handId) {
    if (failed && failed.handId === msg.handId) {
      return {
        claims: {},
        ops: [
          {
            store: 'hand',
            patch: {
              handRecovery: 'unresolved',
              settlementFailed: {
                ...failed,
                orphaned: true,
                retrying: false,
                retryRequestedAt: null,
              },
              deadline: null,
              baseDeadline: null,
            },
          },
        ],
      };
    }
    return {
      claims: {},
      ops: [
        {
          store: 'hand',
          patch: { handRecovery: 'unresolved', deadline: null, baseDeadline: null },
        },
      ],
    };
  }
  return EMPTY;
}
