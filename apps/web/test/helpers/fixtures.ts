import type { ServerMsg } from '@4am/shared';

/**
 * Shared pure-data fixtures for the gameClient suites.
 *
 * `roomState` and `handStart` were inlined byte-for-byte in
 * `settlementFailure.test.ts`, `gameClient.test.ts` and
 * `handRecoveryReconnect.test.ts` (identical fields and defaults; only the host
 * id was ever parameterised), so they live here.
 *
 * Deliberately data-only: the `vi.mock`/`vi.hoisted` socket doubles stay in each
 * test file. Vitest hoists `vi.mock` above the imports by file-local transform,
 * and a helper-module factory cannot reproduce that (nor the per-file relative
 * module specifier) safely, so those stay where they are.
 */

/** A `room_state` for host `hostId` (default 1) with a live hand by default. */
export function roomState(
  hostId = 1,
  handActive = true,
): Extract<ServerMsg, { t: 'room_state' }> {
  return {
    t: 'room_state',
    room: {
      id: 'r',
      name: 'r',
      joinCode: 'ABC',
      hostId,
      bankerId: hostId,
      sb: 10,
      bb: 20,
      auditMode: 'private',
      actionTimeoutMs: 30_000,
      actionSecs: null,
      coBankerId: null,
      minSettleHands: 0,
      sevenDeuceBonus: 0,
      voided: false,
      autoApproveBuys: false,
      tvReplays: false,
      commissionBps: 0,
    },
    players: [],
    handActive,
  };
}

/** A `hand_start` for the host (user `hostId`, default 1), as re-sent on reconnect. */
export function handStart(
  handId: string,
  hostId = 1,
): Extract<ServerMsg, { t: 'hand_start' }> {
  return {
    t: 'hand_start',
    handId,
    seats: [{ seat: 0, userId: hostId, username: 'me', publicKey: '', stack: 1000 }],
    buttonSeat: 0,
    sb: 10,
    bb: 20,
    auditMode: 'private',
  };
}
