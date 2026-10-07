import type { ServerMsg } from '@4am/shared';
import type { HandView } from './store.ts';
import type { SoundName } from './sounds.ts';

/** A frame whose state change is a pure `HandView` patch AND whose only side
 *  effect is a fixed sound that does not need to read any intermediate store
 *  state. For each of these, "patch first, then play" produces the same result
 *  as the pre-extraction "play first, then patch", which is exactly why they
 *  can move off the switch together.
 *
 *  Frames are deliberately kept out of this set when their sound depends on the
 *  store (e.g. `ready_check` plays `turn` only when a check just opened) or when
 *  a later side effect reads state written by the patch (e.g. `multi_run_result`).
 *  Those stay on the switch in `handle()`. */
export type HandEffectsMsg = Extract<
  ServerMsg,
  { t: 'rit_offer' | 'rit_result' | 'multi_run_offer' | 'squid_result' }
>;

/** A *description* of a side effect, never the effect itself.
 *
 *  The reducer below builds these values and must not call `play`, touch the
 *  DOM, audio, storage, the socket or the clock. The runner in `gameClient.ts`
 *  is the only place that turns a descriptor into an actual call, after it has
 *  applied the returned `patch`. That separation is the point of this lane: it
 *  keeps the decision of *what* to play pure and testable while leaving the
 *  impure execution in one obvious runner. */
export type HandEffect = { kind: 'sound'; name: SoundName };

/** What a `HandEffectsMsg` frame produces: the `HandView` patch to write and
 *  the descriptors to execute after that write, or `null` when the frame is a
 *  no-op (so the runner skips both the write and the effects, matching the
 *  original early return). */
export type HandEffectsResult = {
  patch: Partial<HandView>;
  effects: HandEffect[];
} | null;

/** Pure reducer for the "unconditional sound + pure patch" frames.
 *
 *  A pure function of `(state, msg)`: every remaining frame is decided from the
 *  message payload alone (the previous `peek_offer` append was the only branch
 *  that read `state`), and it never reads the clock. The returned effects are
 *  data, not calls. */
export function handEffectsReducer(_state: HandView, msg: HandEffectsMsg): HandEffectsResult {
  switch (msg.t) {
    case 'rit_offer':
      return {
        patch: { ritOffer: { deadlineTs: msg.deadlineTs, voters: msg.voters, voted: false } },
        effects: [{ kind: 'sound', name: 'turn' }],
      };

    case 'rit_result': {
      // run 1 is the shared board; run 2 starts as a copy of everything already
      // open and grows as run-2 cards land
      const shared = [...msg.sharedBoard];
      return {
        patch: { ritOffer: null, boards: [shared, msg.runTwice ? [...shared] : []] },
        // the chip cue is tied to the frame payload, never to store state
        effects: msg.runTwice ? [{ kind: 'sound', name: 'chip' }] : [],
      };
    }

    case 'multi_run_offer':
      // authoritative snapshot of the negotiation, including its stage. Sent
      // again after a reconnect, so overwrite rather than merge: a stale stage
      // would leave the wrong player's buttons armed.
      return {
        patch: {
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
        },
        effects: [{ kind: 'sound', name: 'turn' }],
      };

    case 'squid_result':
      return { patch: { squidResult: msg }, effects: [{ kind: 'sound', name: 'chip' }] };
  }
}
