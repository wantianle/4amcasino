import type { ServerMsg } from '@4am/shared';
import type { HandView } from './store.ts';

/** The frames whose entire effect is a pure `HandView` state alignment.
 *
 *  This is the seed of the `handle()` decomposition: each type listed here has
 *  no outbound frame, crypto, audio, DOM or storage side effect, so its state
 *  change can be expressed as a pure function of `(state, msg)`. Everything
 *  else in `handle()` is deliberately left on the switch for later lanes
 *  (lifecycle reducer / effect vocabulary). */
export type HandStateMsg = Extract<
  ServerMsg,
  { t: 'ready_end' | 'feature_started' | 'time_bank_update' | 'peek_offers_snapshot' | 'auto_deal' }
>;

/** Pure hand-state reducer.
 *
 *  Returns the `HandView` patch to apply, or `null` when the frame leaves the
 *  hand unchanged (so the caller can skip the store write, exactly as the
 *  original early-return did). It touches no store, socket, DOM, storage or
 *  clock: `now` is passed in explicitly by the caller, which is what keeps the
 *  `auto_deal` deadline computation pure. */
export function handReducer(
  state: HandView,
  msg: HandStateMsg,
  now: number,
): Partial<HandView> | null {
  switch (msg.t) {
    case 'ready_end':
      return { readyCheck: null };

    case 'feature_started':
      // announces which new-gameplay features are live for this hand; re-sent
      // on reconnect, so it simply overwrites the previous announcement
      if (msg.handId && msg.handId !== state.handId) return null;
      return { featureStarted: { squid: msg.squid, bombPot: msg.bombPot } };

    case 'time_bank_update':
      return { timeBanks: { ...state.timeBanks, [msg.seat]: msg.remainingMs } };

    case 'peek_offers_snapshot': {
      // The server snapshot is the authoritative set of still-open INCOMING
      // offers after reconnect. It says nothing about our outgoing offers.
      const live = new Set(msg.incomingOfferIds);
      return { peekOffers: state.peekOffers.filter((o) => live.has(o.offerId)) };
    }

    case 'auto_deal':
      return { autoDealAt: msg.inMs > 0 ? now + msg.inMs : null };
  }
}
