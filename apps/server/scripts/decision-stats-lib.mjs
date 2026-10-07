// @ts-nocheck
/**
 * Pure core of `decision-stats.mjs`: no DB, no I/O, no CLI. Kept separate so a
 * unit test can pin the numerator/denominator contract (in particular that
 * fold-to-bet is never "all folds" and that RFI excludes limped pots).
 *
 * --- all-in / non-voluntary-action encoding (evidence, not assumption) -------
 * The projection that writes `hand_actions` is authoritative here:
 *
 *  - EVERY strategic player action is just `fold|check|call|bet|raise`:
 *    `packages/shared/src/betting.ts:27-30` (`PlayerAction`), mapped 1:1 by
 *    `ACTION_TYPE_MAP` in `apps/server/src/handProjection.ts:739-745`, and
 *    written with `isForced: 0, isAuto: 0` at `handProjection.ts:1124-1125`.
 *    There is NO `all_in` action type.
 *  - An all-in by a player is therefore a `bet`/`raise` (amount = remaining
 *    stack; the engine's short all-in raise is still a `raise`, see
 *    `packages/shared/src/betting.ts:207-209`) or a short `call`. Those ARE
 *    voluntary strategic choices and are counted as such (raise/call).
 *  - The only AUTO strategic action is a timeout fold: emitted by the server as
 *    `timeout_fold` (`apps/server/src/game.ts:2175`), projected with
 *    `isAuto: 1` (`handProjection.ts:1131-1155`). There is no auto-all-in; a
 *    timeout folds.
 *  - The only FORCED all-in is a short blind/ante post: encoded as
 *    `post_sb`/`post_bb`/`post_ante` with `isForced: 1, isAuto: 1`
 *    (`handProjection.ts:1026-1027, 1080-1081`; raw_json carries `allIn:true`).
 *    These are excluded from every node and from VPIP/PFR by `isForced`.
 *
 * Consequence: a voluntarily all-in player is credited with the underlying
 * bet/raise/call, and no non-voluntary all-in can create a strategic node.
 *
 * Documented limitation: `activeOpponents` (the HU/multiway split) counts every
 * unfolded seat, INCLUDING an all-in opponent, because they are still contesting
 * the pot. The projection does NOT expose a per-player-action all-in flag
 * (player-action `raw_json` has no `allIn`/`stackAfter`), so we cannot separate
 * "can still act" from "in the hand" without extending the projection. This is
 * the intended choice (split = "how many opponents still in"), recorded here.
 */

/** Actions that are never a strategic choice. */
export const FORCED_TYPES = new Set(['post_sb', 'post_bb', 'post_ante']);
export const RAISE_TYPES = new Set(['bet', 'raise']);
export const CALL_TYPE = 'call';
export const FOLD_TYPES = new Set(['fold', 'timeout_fold']);

export const DEFINITIONS = {
  hands:
    'denominator: every (hand, player) the player was dealt into, after the scope filters. VPIP/PFR use this dealt-hand denominator.',
  vpip: 'numerator: dealt hands in which the player voluntarily put chips in preflop (call/bet/raise; forced posts and auto acts excluded). denominator: dealt hands.',
  pfr: 'numerator: dealt hands in which the player voluntarily raised preflop (bet/raise). denominator: dealt hands.',
  rfi: 'numerator: unopened first-in nodes where the player raised. denominator: unopened nodes = the player acted preflop with 0 prior voluntary raises AND 0 prior voluntary calls (folded to them; a limp in front makes it `limped`, not `unopened`).',
  limped:
    'numerator: limped-pot nodes where the player raised (isolation). denominator: nodes with 0 prior raises but >= 1 prior call.',
  facingOpenFold:
    'numerator: the player folded facing exactly one open. denominator: nodes facing exactly one prior voluntary raise (the player is never the opener here).',
  facingOpenCall:
    'numerator: the player flat-called facing one open. denominator: same facing-open nodes.',
  threeBet:
    'numerator: the player raised facing exactly one open (a 3-bet). denominator: same facing-open nodes.',
  facing3BetFold:
    'numerator: folds facing exactly two prior raises. denominator: nodes facing exactly two prior raises, whether the player opened (3-bet defence) or was cold.',
  facing3BetCall:
    'numerator: calls facing exactly two prior raises. denominator: same facing-3-bet nodes.',
  fourBet:
    'numerator: raises facing exactly two prior raises. denominator: same facing-3-bet nodes. (facing3BetCold splits the same nodes to those where the player had not raised before.)',
  facing4BetPlus:
    'numerator/denominator: nodes facing >= 3 prior raises; reported as fold/call/raise out of those nodes.',
  foldToBet:
    'numerator: postflop folds where the player faced an outstanding bet (their street commitment was below the current street bet). denominator: postflop facing-bet nodes. Every voluntary facing-bet action is one node; a re-raise that reopens and forces a second decision creates a second node.',
  callVsBet:
    'numerator: postflop calls at a facing-bet node. denominator: postflop facing-bet nodes.',
  raiseVsBet:
    'numerator: postflop bet/raise at a facing-bet node. denominator: postflop facing-bet nodes.',
  betWhenCheckedTo:
    'numerator: postflop bet/raise where no bet was outstanding (the action was checked to the player). denominator: postflop no-outstanding-bet nodes (checks and bets/bets after check-through).',
  checkedTo:
    'numerator: postflop checks where no bet was outstanding. denominator: same no-outstanding-bet nodes. (fold-to-bet is deliberately NOT computed over all folds; a checked-to fold is impossible, and a fold is only ever counted at a facing-bet node.)',
};

/**
 * Rebuild every decision node for one hand. Pure: `hand`/`players`/`actions`
 * are plain projection rows. Returns one dealt-hand record per (hand, player)
 * for VPIP/PFR, and one record per strategic decision node.
 */
export function replayHand(hand, players, actions, meta) {
  const positionBySeat = new Map(players.map((p) => [p.seat, p.position ?? 'UNKNOWN']));
  const playerCount = players.length;
  const dealtPlayers = players.map((p) => ({
    playerId: p.userId,
    position: p.position ?? 'UNKNOWN',
    playerCount,
    policyKind: meta.policyKindByUser.get(p.userId) ?? 'human-other',
    gameKind: hand.gameKind,
    bb: hand.bb,
    vpip: 0,
    pfr: 0,
  }));
  const dealtById = new Map(dealtPlayers.map((r) => [r.playerId, r]));

  const nodes = [];
  const folded = new Set();
  let street = null;
  let committed = new Map(); // seat -> chips committed this street
  let currentBet = 0;
  let preRaises = 0;
  let preCallers = 0;
  const preRaisedSeats = new Set();
  let degraded = false;

  const activeOpponents = (heroSeat) => {
    let n = 0;
    for (const p of players) {
      if (p.seat === heroSeat) continue;
      if (!folded.has(p.seat)) n++;
    }
    return n;
  };

  const pushNode = (kind, a, extra) => {
    nodes.push({
      kind,
      playerId: a.userId,
      position: positionBySeat.get(a.seat) ?? 'UNKNOWN',
      playerCount,
      policyKind: meta.policyKindByUser.get(a.userId) ?? 'human-other',
      gameKind: hand.gameKind,
      street: a.street,
      action: a.actionType,
      activeOpponents: activeOpponents(a.seat),
      ...extra,
    });
  };

  for (const a of actions) {
    if (a.street !== street) {
      street = a.street;
      committed = new Map();
      currentBet = 0;
    }
    const added = Math.max(0, (a.potAfter ?? 0) - (a.potBefore ?? 0));
    const isForced = a.isForced === 1 || FORCED_TYPES.has(a.actionType);
    const isAuto = a.isAuto === 1;

    if (isAuto && !isForced) {
      // Timeout / disconnect is not a strategy choice, but a timeout fold does
      // remove the seat from the active set.
      if (FOLD_TYPES.has(a.actionType)) folded.add(a.seat);
      continue;
    }
    if (isForced) {
      const c = committed.get(a.seat) ?? 0;
      committed.set(a.seat, c + added);
      currentBet = Math.max(currentBet, c + added);
      continue;
    }

    // A voluntary call/bet/raise with no pot context is an unenriched legacy
    // row: the action is known but the committed state is not. Skip it.
    const unenriched =
      a.potAfter === 0 && a.potBefore === 0 && (a.actionType === CALL_TYPE || RAISE_TYPES.has(a.actionType));
    if (unenriched) {
      degraded = true;
      continue;
    }

    const myCommit = committed.get(a.seat) ?? 0;

    if (a.street === 'preflop') {
      const isRaise = RAISE_TYPES.has(a.actionType);
      const isCall = a.actionType === CALL_TYPE;
      if (isCall || isRaise) {
        const dealt = dealtById.get(a.userId);
        if (dealt) dealt.vpip = 1;
        if (isRaise && dealt) dealt.pfr = 1;
      }
      if (preRaises === 0 && preCallers === 0) {
        pushNode('rfi', a, { isRaise });
      } else if (preRaises === 0 && preCallers >= 1) {
        pushNode('limped', a, { isRaise });
      } else if (preRaises === 1) {
        pushNode('facingOpen', a, { fold: FOLD_TYPES.has(a.actionType), call: isCall, raise: isRaise });
      } else if (preRaises === 2) {
        pushNode('facing3Bet', a, {
          cold: !preRaisedSeats.has(a.seat),
          fold: FOLD_TYPES.has(a.actionType),
          call: isCall,
          raise: isRaise,
        });
      } else {
        pushNode('facing4BetPlus', a, {
          fold: FOLD_TYPES.has(a.actionType),
          call: isCall,
          raise: isRaise,
        });
      }
      if (isRaise) {
        preRaises += 1;
        preRaisedSeats.add(a.seat);
      } else if (isCall) {
        preCallers += 1;
      }
      // A preflop fold must leave the active set too, or every postflop node
      // would look multiway (the active count drives the HU/multiway split).
      if (FOLD_TYPES.has(a.actionType)) folded.add(a.seat);
      committed.set(a.seat, myCommit + added);
      currentBet = Math.max(currentBet, myCommit + added);
    } else {
      const facingBet = myCommit < currentBet;
      if (facingBet) {
        pushNode('facingBet', a, {
          fold: FOLD_TYPES.has(a.actionType),
          call: a.actionType === CALL_TYPE,
          raise: RAISE_TYPES.has(a.actionType),
        });
      } else {
        pushNode('checkedTo', a, { bet: RAISE_TYPES.has(a.actionType) });
      }
      if (FOLD_TYPES.has(a.actionType)) folded.add(a.seat);
      committed.set(a.seat, myCommit + added);
      if (RAISE_TYPES.has(a.actionType)) currentBet = Math.max(currentBet, myCommit + added);
    }
  }

  return { dealtPlayers, nodes, degraded };
}

export function metric(hits, opportunities) {
  return {
    hits,
    opportunities,
    pct: opportunities > 0 ? Math.round((hits / opportunities) * 10000) / 100 : null,
  };
}

/** Turn the (dealt, nodes) streams into the full metric bundle. */
export function metricsFrom(dealt, nodes) {
  const n = (kind, pred) => nodes.filter((x) => x.kind === kind && (!pred || pred(x)));
  const dealtCount = dealt.length;
  const vpipHits = dealt.filter((d) => d.vpip === 1).length;
  const pfrHits = dealt.filter((d) => d.pfr === 1).length;

  const rfi = n('rfi');
  const limped = n('limped');
  const fOpen = n('facingOpen');
  const f3 = n('facing3Bet');
  const f3Cold = f3.filter((x) => x.cold);
  const f4 = n('facing4BetPlus');
  const fBet = n('facingBet');
  const checked = n('checkedTo');

  return {
    hands: metric(dealtCount, dealtCount),
    vpip: metric(vpipHits, dealtCount),
    pfr: metric(pfrHits, dealtCount),
    rfi: metric(rfi.filter((x) => x.isRaise).length, rfi.length),
    limped: metric(limped.filter((x) => x.isRaise).length, limped.length),
    facingOpenFold: metric(fOpen.filter((x) => x.fold).length, fOpen.length),
    facingOpenCall: metric(fOpen.filter((x) => x.call).length, fOpen.length),
    threeBet: metric(fOpen.filter((x) => x.raise).length, fOpen.length),
    facing3BetFold: metric(f3.filter((x) => x.fold).length, f3.length),
    facing3BetCall: metric(f3.filter((x) => x.call).length, f3.length),
    fourBet: metric(f3.filter((x) => x.raise).length, f3.length),
    facing3BetCold: metric(f3Cold.filter((x) => x.raise).length, f3Cold.length),
    facing4BetPlusFold: metric(f4.filter((x) => x.fold).length, f4.length),
    facing4BetPlusCall: metric(f4.filter((x) => x.call).length, f4.length),
    facing4BetPlusRaise: metric(f4.filter((x) => x.raise).length, f4.length),
    foldToBet: metric(fBet.filter((x) => x.fold).length, fBet.length),
    callVsBet: metric(fBet.filter((x) => x.call).length, fBet.length),
    raiseVsBet: metric(fBet.filter((x) => x.raise).length, fBet.length),
    betWhenCheckedTo: metric(checked.filter((x) => x.bet).length, checked.length),
    checkedTo: metric(checked.filter((x) => !x.bet).length, checked.length),
  };
}

export function groupBy(items, keyOf) {
  const out = new Map();
  for (const it of items) {
    const k = keyOf(it);
    if (k === null || k === undefined) continue;
    const arr = out.get(k);
    if (arr) arr.push(it);
    else out.set(k, [it]);
  }
  return out;
}
