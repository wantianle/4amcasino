import { describe, expect, it, vi } from 'vitest';
import type { ServerMsg } from '@4am/shared';
import { identityFromSeed, verifyContent } from '@4am/mental-poker';
import { HeadlessClient } from '../src/client.js';

/**
 * A bot auto-answers the all-in multi-run negotiation:
 *   - `stage: 'choice'`   -> the behind (equity underdog) seat asks for 2 runs;
 *   - `stage: 'agreement'` -> the ahead seat agrees to the requested count.
 * It must answer only when it is the exact seat the server waits on, and only
 * while the hand is live. Every reply carries a content signature whose body
 * matches `signedBody()` (the same thing the server verifies).
 */

type TestSeams = {
  handle(msg: ServerMsg): void;
  onSocketOpened(): void;
  identity: { publicKey: string; secretKey: string };
};

const seams = (c: HeadlessClient) => c as unknown as TestSeams;

function roomState(handActive: boolean): ServerMsg {
  return {
    t: 'room_state',
    room: {
      id: 'r1',
      name: 'R',
      joinCode: 'ABCDEF',
      hostId: 1,
      bankerId: 1,
      sb: 10,
      bb: 20,
      auditMode: false,
      actionTimeoutMs: 30_000,
      actionSecs: null,
      coBankerId: null,
      minSettleHands: 0,
      autoApproveBuys: false,
      tvReplays: false,
      autoDeal: false,
      autoDealerId: null,
      commissionBps: 0,
      sevenDeuceBonus: 0,
      voided: false,
      meetLink: null,
    },
    players: [],
    handActive,
    autoDealAt: null,
    autoDealPaused: false,
    readyCheck: null,
  } as unknown as ServerMsg;
}

function handStart(handId: string): ServerMsg {
  return {
    t: 'hand_start',
    handId,
    seats: [
      { seat: 0, userId: 7, username: 'me' },
      { seat: 1, userId: 8, username: 'other' },
    ],
    sb: 10,
    bb: 20,
  } as unknown as ServerMsg;
}

function multiRunOffer(overrides: Record<string, unknown>): ServerMsg {
  return {
    t: 'multi_run_offer',
    handId: 'h1',
    decisionId: 'd1',
    stage: 'choice',
    aheadSeat: 1,
    behindSeat: 0,
    equities: [
      { seat: 0, bps: 4000 },
      { seat: 1, bps: 6000 },
    ],
    deadlineTs: Date.now() + 1000,
    ...overrides,
  } as unknown as ServerMsg;
}

const handEnd = (handId: string): ServerMsg =>
  ({ t: 'hand_end', handId, deltas: [] }) as unknown as ServerMsg;

/** A connected, resynced client (our seat 0) inside a live hand `h1`. */
function liveClient(): { c: HeadlessClient; s: TestSeams } {
  const c = new HeadlessClient('http://127.0.0.1:1', 'unit', 'pw');
  c.userId = 7;
  const s = seams(c);
  s.identity = identityFromSeed(new Uint8Array(32));
  s.onSocketOpened();
  s.handle(roomState(true));
  s.handle(handStart('h1'));
  return { c, s };
}

describe('HeadlessClient multi-run negotiation', () => {
  it('answers a choice-stage offer as the behind seat: run_count_choice count=2, signed', () => {
    const { c, s } = liveClient();
    const send = vi.spyOn(c, 'send');

    s.handle(multiRunOffer({ stage: 'choice', aheadSeat: 1, behindSeat: 0 }));

    expect(send).toHaveBeenCalledTimes(1);
    const msg = send.mock.calls[0]![0] as Record<string, unknown>;
    expect(msg).toMatchObject({
      t: 'run_count_choice',
      handId: 'h1',
      decisionId: 'd1',
      count: 2,
    });
    expect(typeof msg.sig).toBe('string');
    expect(msg.sig as string).toMatch(/^[0-9a-f]{128}$/i);
    // The signature binds exactly the body the server verifies.
    expect(
      verifyContent(s.identity.publicKey, 'h1', 'run_count_choice', { decisionId: 'd1', count: 2 }, msg.sig as string),
    ).toBe(true);
  });

  it('answers an agreement-stage offer as the ahead seat: run_count_agree true, signed', () => {
    const { c, s } = liveClient();
    const send = vi.spyOn(c, 'send');

    s.handle(
      multiRunOffer({ stage: 'agreement', aheadSeat: 0, behindSeat: 1, requestedRuns: 2 }),
    );

    expect(send).toHaveBeenCalledTimes(1);
    const msg = send.mock.calls[0]![0] as Record<string, unknown>;
    expect(msg).toMatchObject({
      t: 'run_count_agree',
      handId: 'h1',
      decisionId: 'd1',
      agree: true,
    });
    expect(msg.sig as string).toMatch(/^[0-9a-f]{128}$/i);
    expect(
      verifyContent(s.identity.publicKey, 'h1', 'run_count_agree', { decisionId: 'd1', agree: true }, msg.sig as string),
    ).toBe(true);
  });

  it('does not answer when it is not the seat the server is waiting on', () => {
    const { c, s } = liveClient();
    const send = vi.spyOn(c, 'send');

    // choice stage, but we are the ahead seat: behind must choose.
    s.handle(multiRunOffer({ stage: 'choice', aheadSeat: 0, behindSeat: 1 }));
    // agreement stage, but we are the behind seat: ahead must agree.
    s.handle(
      multiRunOffer({ stage: 'agreement', aheadSeat: 1, behindSeat: 0, requestedRuns: 2 }),
    );

    expect(send).not.toHaveBeenCalled();
  });

  it('does not answer a stale hand id', () => {
    const { c, s } = liveClient();
    const send = vi.spyOn(c, 'send');

    s.handle(multiRunOffer({ handId: 'h-other', behindSeat: 0 }));

    expect(send).not.toHaveBeenCalled();
  });

  it('does not answer once the hand has ended', () => {
    const { c, s } = liveClient();
    const send = vi.spyOn(c, 'send');

    s.handle(handEnd('h1'));
    s.handle(multiRunOffer({ stage: 'choice', behindSeat: 0 }));

    expect(send).not.toHaveBeenCalled();
  });

  it('never emits a frame lacking the signed-protocol fields', () => {
    const { c, s } = liveClient();
    const send = vi.spyOn(c, 'send');

    s.handle(multiRunOffer({ stage: 'choice', behindSeat: 0 }));
    for (const [raw] of send.mock.calls) {
      const msg = raw as Record<string, unknown>;
      expect(['run_count_choice', 'run_count_agree']).toContain(msg.t);
      expect(typeof msg.handId).toBe('string');
      expect(typeof msg.decisionId).toBe('string');
      expect(msg.sig as string).toMatch(/^[0-9a-f]{128}$/i);
    }
  });
});
