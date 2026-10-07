import { describe, expect, it } from 'vitest';
import type { CardId } from '@4am/shared';
import { runMultiwayEquityJob } from '../src/equityWorker.js';
import { TestClient, type Strategy } from './helpers/testClient.js';
import { setupRoom as createRoom, awaitHandEnd } from './helpers/testRoom.js';
import { useIntegrationServer } from './helpers/integrationServer.js';

// The bubble worker boots with tsx in tests and, under a full-suite load, can
// take a while; give the per-job compute budget room (the production default is
// 2s). The compute timer is measured after the worker's ready handshake, so the
// budget covers enumeration, not thread start-up.
process.env.EQUITY_TIMEOUT_MS = '15000';

const srv = useIntegrationServer();

const setupRoom = (names: string[], strategies: Strategy[] = []) =>
  createRoom(srv.baseUrl, names, strategies, srv.clients);

/** The wire contract of every bubble snapshot: one entry per live seat, summing
 *  to exactly 10000 bps, all integers in range. */
function expectSaneEquities(e: { equities: { seat: number; bps: number }[] }, size: number): void {
  expect(e.equities).toHaveLength(size);
  for (const q of e.equities) {
    expect(Number.isInteger(q.bps)).toBe(true);
    expect(q.bps).toBeGreaterThanOrEqual(0);
    expect(q.bps).toBeLessThanOrEqual(10000);
  }
  expect(e.equities.reduce((s, q) => s + q.bps, 0)).toBe(10000);
  expect(new Set(e.equities.map((q) => q.seat)).size).toBe(size);
}

describe('live all-in equity bubbles (per-street push)', () => {
  async function enable(host: TestClient, roomId: string, features: unknown): Promise<void> {
    const res = await host.api(`/api/rooms/${roomId}/settings`, { features }, 'PUT');
    expect(res.ok).toBe(true);
  }

  it('heads-up: reveals before any bubble, then a preflop + per-street snapshot per run', async () => {
    const { players, room, host } = await setupRoom(['eqa', 'eqb'], ['allin-first', 'allin-first']);
    await enable(host, room.id, { multiRun: { enabled: true } });
    for (const p of players) {
      p.runCountAnswer = 2;
      p.runAgreeAnswer = true;
    }
    host.send({ t: 'start_hand' });
    await awaitHandEnd(players, 20000);
    // The per-street workers are chained; the last frames may land a beat after
    // hand_end (the client ignores anything past the result).
    const c = players[0]!;
    await c.waitFor(
      () => c.equityUpdates.filter((e) => e.run === 2 && e.board.length === 5).length >= 1,
      8000,
    );

    expect(c.handAbort).toBeNull();
    expect(c.multiRunResult).toMatchObject({ runs: 2, reason: 'agreed' });

    // ── P0: reveal first, then the run result, then equity ──
    const iReveal = c.frameLog.indexOf('runout_reveal');
    const iResult = c.frameLog.indexOf('multi_run_result');
    const iEquity = c.frameLog.indexOf('equity_update');
    expect(iReveal).toBeGreaterThanOrEqual(0);
    expect(iReveal).toBeLessThan(iResult);
    expect(iResult).toBeLessThan(iEquity);
    // The first bubble is published before the runout deals, so the client sees
    // the reveal + a win rate before the first board card.
    const iBoard = c.frameLog.indexOf('board_open');
    expect(iEquity).toBeLessThan(iBoard);
    // The reveal names both live seats, two public cards each.
    expect(c.runoutReveals[0]).toHaveLength(2);
    for (const r of c.runoutReveals[0]!) expect(r.cards).toHaveLength(2);

    const eqs = c.equityUpdates;
    // eslint-disable-next-line no-console
    console.log('EQUITY FRAMES', JSON.stringify(eqs, null, 0));
    const run1 = eqs.filter((e) => e.run === 1);
    const run2 = eqs.filter((e) => e.run === 2);
    // The preflop snapshot is real now (run-1 board length 0), then flop/turn/
    // river for run 1 and flop/turn/river for run 2.
    expect(run1.some((e) => e.board.length === 0)).toBe(true);
    expect(run1.length).toBeGreaterThanOrEqual(4);
    expect(run2.length).toBeGreaterThanOrEqual(3);
    const lens1 = run1.map((e) => e.board.length);
    for (const n of [0, 3, 4, 5]) expect(lens1).toContain(n);
    const lens2 = run2.map((e) => e.board.length);
    for (const n of [3, 4, 5]) expect(lens2).toContain(n);

    for (const e of eqs) expectSaneEquities(e, 2);

    const run1Flop = run1.find((e) => e.board.length === 3)!;
    const run1River = run1.find((e) => e.board.length === 5)!;
    expect(run1Flop.equities.map((e) => e.bps)).not.toEqual(run1River.equities.map((e) => e.bps));
  }, 30000);

  it('three-way: every live seat gets its own bubble equity and the frame sums to 100%', async () => {
    const { players, room, host } = await setupRoom(
      ['eq3a', 'eq3b', 'eq3c'],
      ['allin-first', 'allin-first', 'allin-first'],
    );
    await enable(host, room.id, { multiRun: { enabled: true } });
    host.send({ t: 'start_hand' });
    await awaitHandEnd(players, 20000);

    expect(players[0]!.handAbort).toBeNull();
    // 3-way all-in is forced to a single run, but the bubble still streams.
    const c = players[0]!;
    await c.waitFor(() => c.equityUpdates.some((e) => e.board.length === 3), 8000);
    const eqs = c.equityUpdates;
    // eslint-disable-next-line no-console
    console.log('3-WAY EQUITY FRAMES', JSON.stringify(eqs, null, 0));
    expect(eqs.length).toBeGreaterThan(0);
    const flop = eqs.find((e) => e.board.length === 3);
    expect(flop).toBeDefined();
    expectSaneEquities(flop!, 3);
  }, 30000);

  it('audit: run 2 flop equity equals an independent recompute with run 1 board as dead', async () => {
    const { players, room, host } = await setupRoom(
      ['auda', 'audb'],
      ['allin-first', 'allin-first'],
    );
    await enable(host, room.id, { multiRun: { enabled: true } });
    for (const p of players) {
      p.runCountAnswer = 2;
      p.runAgreeAnswer = true;
    }
    host.send({ t: 'start_hand' });
    await awaitHandEnd(players, 20000);

    const c = players[0]!;
    await c.waitFor(() => c.equityUpdates.some((e) => e.run === 2 && e.board.length === 3), 8000);

    const showdown = c.lastShowdown!;
    expect(showdown.multiRun).toBeDefined();
    const run1Board = showdown.multiRun!.boards[0]!;
    expect(run1Board).toHaveLength(5);

    const run2FlopFrame = c.equityUpdates.find((e) => e.run === 2 && e.board.length === 3)!;
    // Per-seat holes, in seat order, straight from the public reveal.
    const bySeat = [...showdown.reveals].sort((a, b) => a.seat - b.seat);
    const holes = bySeat.map((r) => r.cards as [CardId, CardId]);
    const seats = bySeat.map((r) => r.seat);

    // Board length 3 enumerates exactly, so the seed is irrelevant: the value
    // is fully determined by holes + run-2 flop + run-1's dead cards. A
    // reviewer can redo this from the persisted hole cards and boards alone.
    const recomputed = runMultiwayEquityJob({
      holes,
      board: run2FlopFrame.board,
      seed: 'audit-any',
      dead: run1Board,
    });
    for (const q of run2FlopFrame.equities) {
      expect(recomputed.equitiesBps[seats.indexOf(q.seat)]).toBe(q.bps);
    }
    expectSaneEquities(run2FlopFrame, 2);
  }, 30000);
});
