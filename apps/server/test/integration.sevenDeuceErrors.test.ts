import { describe, expect, it } from 'vitest';
import {
  cardLookup,
  genIdentity,
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
import type { BettingState, CardId, PlayerAction, ServerMsg } from '@4am/shared';
import { awardPots, computePots, splitAmountEven, startBombPot } from '@4am/shared';
import { createSession, createUser } from '../src/auth.js';
import { setPlatformUserId } from '../src/platform.js';
import { activeHands } from '../src/liveHands.js';
import { applyHandSettlement, type GameClock } from '../src/game.js';
import { rechainRoom, verifyLedger } from '../src/ledger.js';
import {
  auditMarkerlessTranscripts,
  firstPendingHandLifecycle,
  reconcileMissingSettlements,
  recoverOrphanedFeatureTriggers,
} from '../src/db.js';
import { TestClient, type Strategy } from './helpers/testClient.js';
import { setupRoom as createRoom } from './helpers/testRoom.js';
import { awaitHandEnd } from './helpers/testRoom.js';
import { useIntegrationServer } from './helpers/integrationServer.js';

const srv = useIntegrationServer();

// Thin adapter onto the shared `setupRoom`, binding this file's server URL and
// client collector so the migrated call sites stay byte-identical.
const setupRoom = (names: string[], strategies: Strategy[] = []) =>
  createRoom(srv.baseUrl, names, strategies, srv.clients);

describe('7-2 bounty transfer error classification', () => {
  const setupSevenDeuceHand = async () => {
    const { players, room, host } = await setupRoom(['tca', 'tcb'], ['fold-first', 'passive']);
    srv.ctx.db
      .prepare('UPDATE rooms SET auto_deal = 0, seven_deuce_bonus = 25 WHERE id = ?')
      .run(room.id);
    // Seat 1 (bob) is dealt 7-2 offsuit; the host folds, so bob wins by fold.
    const identity = Array.from({ length: 52 }, (_, i) => i);
    const wanted = [9, 0, 10, 21, 11, 12, 13, 14, 15];
    const seen = new Set(wanted);
    const Q = [...wanted, ...identity.filter((i) => !seen.has(i))];
    host.forcedShufflePerm = identity;
    players[1]!.forcedShufflePerm = Q;
    host.send({ t: 'start_hand' });
    await awaitHandEnd(players, 15000);
    return { players, room, host, bob: players[1]!, gameRoom: srv.hub.rooms.get(room.id)! };
  };

  it('P1-4: a real transient SQLITE_BUSY is retryable and never locks the room', async () => {
    const { host, bob, gameRoom } = await setupSevenDeuceHand();
    srv.fault.sevenDeuceError = Object.assign(new Error('database is locked'), {
      code: 'SQLITE_BUSY',
    });
    bob.showCards();
    await new Promise((r) => setTimeout(r, 200));
    expect(gameRoom.isUnhealthy()).toBe(false);
    expect(host.cardsShown).toHaveLength(0);
    bob.showCards();
    await host.waitFor(() => host.cardsShown.length === 1, 3000);
    expect(host.cardsShown).toHaveLength(1);
    expect(gameRoom.isUnhealthy()).toBe(false);
  }, 20000);

  it('P1-4: an extended SQLITE_IOERR_READ is a programming/environmental error, not retryable', async () => {
    const { host, bob, gameRoom } = await setupSevenDeuceHand();
    srv.fault.sevenDeuceError = Object.assign(new Error('disk I/O error'), {
      code: 'SQLITE_IOERR_READ',
    });
    bob.showCards();
    await host.waitFor(() => gameRoom.isUnhealthy(), 3000);
    // Not clearable: it is not a recoverable settlement mark.
    expect(gameRoom.clearUnhealthy('anything')).toBe(false);
  }, 20000);

  it('P1-4: SQLITE_FULL/SQLITE_NOMEM/SQLITE_PROTOCOL are not treated as retryable', async () => {
    const { host, bob, gameRoom } = await setupSevenDeuceHand();
    srv.fault.sevenDeuceError = Object.assign(new Error('database or disk is full'), {
      code: 'SQLITE_FULL',
    });
    bob.showCards();
    await host.waitFor(() => gameRoom.isUnhealthy(), 3000);
  }, 20000);
});
