/**
 * One isolated heads-up-vs-anchor match for the bot evaluation rig.
 *
 * Boots the real server in-process (temp DB, dynamic port, real WS), seats one
 * scripted anchor at seat 0 and one bot per entry of `seatPolicies` on the
 * following seats, plays `hands` hands, and returns the per-hand per-seat deltas.
 *
 * Everything is driven by `BOT_TEST_SHUFFLE_SEED`'s deterministic deal, so two
 * matches with the same seed (and the same seat layout) replay the exact same
 * cards. `botEval.mjs` uses that to build duplicate matches (swap the two
 * strategies between seats, replay the same cards) and to bootstrap a CI on the
 * per-hand strategy delta.
 *
 * This is a harness module: it never changes product behaviour, it only injects
 * policies through `BotSupervisor.runnerFactory` and drives the human via the
 * shipped `HeadlessClient`.
 */
import { randomBytes } from 'node:crypto';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../src/app';
import { attachHub } from '../../src/hub';
import { BotSupervisor } from '../../src/botSupervisor';
import { BotRunner } from '../../src/botRunner';
import { HeadlessClient, buildDecisionView } from '@4am/agent-core';
import {
  createPolicyStats,
  fallbackDecision,
  isLegalDecision,
  resolveEvalStrategy,
} from './evalStrategies.mjs';
import { installDeterministicShuffle, uninstallDeterministicShuffle } from './deterministicShuffle.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Env keys `runEvalMatch` mutates; saved before and restored in `finally`. */
const MANAGED_ENV = ['BOT_TEST_SHUFFLE_SEED', 'BOT_IDENTITY_KEY', 'BOT_THINK_ENABLED'];

function snapshotEnv(keys) {
  const snap = {};
  for (const key of keys) snap[key] = process.env[key];
  return snap;
}

function restoreEnv(snap) {
  for (const [key, value] of Object.entries(snap)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

async function waitFor(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return;
    await sleep(10);
  }
  throw new Error(`waitFor timed out: ${label ?? ''}`);
}

/**
 * Server-authoritative card-level fingerprint of one hand, read back from the
 * persisted transcript after settlement:
 *   - each participant's two hole cards (`hole_cards`, written during the audit
 *     probe - see `tvReplays` below), ordered by seat number. These are ALWAYS
 *     present (live players reveal their key, folders reveal via escrowed key),
 *     so they are the load-bearing part of the replay proof;
 *   - the board in deal order (`settlement.board`). The board is only opened as
 *     far as the ACTION reached, so its length legitimately differs between two
 *     seatings of the same deal (a fold-out vs a showdown); comparison therefore
 *     checks the common prefix rather than the length.
 * The hole fingerprint is stable across runs for the same physical deal and
 * differs when the permutation (not the hand id) changes.
 */
function extractCardFingerprint(tRow, participantSeats) {
  const entries = tRow ? JSON.parse(tRow.entries) : [];
  const holes = new Map();
  let board = null;
  for (const e of entries) {
    const p = e?.payload;
    if (!p) continue;
    if (e.type === 'hole_cards' && typeof p.seat === 'number' && Array.isArray(p.cards)) {
      holes.set(p.seat, p.cards.slice());
    } else if (e.type === 'settlement') {
      if (Array.isArray(p.board)) board = p.board.slice();
      if (Array.isArray(p.reveals))
        for (const r of p.reveals)
          if (!holes.has(r.seat) && Array.isArray(r.cards)) holes.set(r.seat, r.cards.slice());
    }
  }
  const seats = [...participantSeats].sort((a, b) => a - b);
  const missing = seats.filter((s) => !holes.has(s));
  const holeFingerprint = seats
    .map((s) => `s${s}:${(holes.get(s) ?? ['?', '?']).join('+')}`)
    .join('|');
  const boardCards = board ?? [];
  return {
    fingerprint: `${holeFingerprint}|board:${boardCards.join('+')}`,
    holeFingerprint,
    board: boardCards,
    complete: missing.length === 0 && board !== null,
    missing,
  };
}

/**
 * Resolve a policy name through the harness registry. `resolveEvalStrategy`
 * covers baselines AND arms (`rules-v1` / `p2:*` / `adaptive-preflop`) and
 * throws on an unknown name.
 */
function resolveStrategy(name, stats) {
  return resolveEvalStrategy(name, stats);
}

const ACTION_TYPES = ['fold', 'call', 'check', 'bet', 'raise'];

/** Fresh zeroed action-count record for one seat. */
function emptyActionCounts() {
  const counts = { total: 0 };
  for (const t of ACTION_TYPES) counts[t] = 0;
  return counts;
}

/**
 * @param {object} opts
 * @param {number|null} [opts.seed]   deterministic-shuffle seed; `null`/omitted
 *                                    keeps the production crypto shuffle (the
 *                                    default path, used by the env-restore smoke)
 * @param {string} [opts.shuffleSalt] harness-only perm label prefix (negative
 *                                    test: same hand ids, different cards)
 * @param {number} opts.hands
 * @param {Record<number,string>} opts.seatPolicies  seat -> policy name (seats >= 1)
 * @param {string} [opts.anchor]      seat-0 policy name
 * @param {number} [opts.sb] @param {number} [opts.bb] @param {number} [opts.buyIn]
 * @param {boolean} [opts.memory]     inject cross-hand `sessionMemory` into the
 *   bot decision views (default `false` = legacy empty-memory behaviour). Arm
 *   mode turns this on so opponent-model switches (`shrinkage`) actually see
 *   opponent history instead of a permanently empty snapshot.
 */
export async function runEvalMatch({
  seed,
  shuffleSalt = '',
  hands,
  seatPolicies,
  anchor = 'always-call',
  sb = 10,
  bb = 20,
  buyIn = 4000,
  actionMs = 1_000,
  cryptoMs = 2_000,
  readyMs = 300,
  handMs = 30_000,
  maxHandActions = 600,
  memory = false,
} = {}) {
  const deterministic = seed !== undefined && seed !== null;
  const envBefore = snapshotEnv(MANAGED_ENV);
  if (deterministic) process.env.BOT_TEST_SHUFFLE_SEED = String(seed);
  process.env.BOT_IDENTITY_KEY = process.env.BOT_IDENTITY_KEY ?? 'ab'.repeat(32);
  if (!process.env.BOT_THINK_ENABLED) process.env.BOT_THINK_ENABLED = '0';
  try {
    if (deterministic) installDeterministicShuffle(Number(seed) >>> 0, { salt: shuffleSalt });
  } catch (err) {
    // A concurrent different-seed install is a harness programming error; still
    // put the env back so the throw cannot pollute the rest of the worker.
    restoreEnv(envBefore);
    throw err;
  }

  // Per-seat fallback/illegal sinks, so a policy bug is attributable to the arm
  // that produced it (the run-level totals are their sum). Seat 0 is the human
  // anchor; every bot seat is a policy under test.
  const statsBySeat = new Map();
  const statsForSeat = (seat) => {
    if (!statsBySeat.has(seat)) statsBySeat.set(seat, createPolicyStats());
    return statsBySeat.get(seat);
  };
  // How often each seat's policy actually saw a non-empty opponent snapshot.
  // With `memory: false` this stays 0 for every seat; with it on it proves the
  // `shrinkage` path got real opponent statistics rather than `{}`.
  const memoryBySeat = new Map();
  const memoryForSeat = (seat) => {
    if (!memoryBySeat.has(seat))
      memoryBySeat.set(seat, {
        decisions: 0,
        nonEmptyOpponents: 0,
        withOpponentStats: 0,
        maxHandsObserved: 0,
      });
    return memoryBySeat.get(seat);
  };
  const observeMemory = (seat, policy) => ({
    name: policy.name,
    decide(view) {
      const rec = memoryForSeat(seat);
      rec.decisions++;
      const opps = view?.sessionMemory?.opponents ?? [];
      if (opps.length > 0) rec.nonEmptyOpponents++;
      // `snapshot` lists every current opponent even before any sample, so this
      // is the stronger signal: at least one opponent has settled-hand history.
      if (opps.some((o) => (o.sampleHands ?? 0) > 0)) rec.withOpponentStats++;
      // Highest settled-hand count this seat ever saw. A barrier-correct run
      // lifts this to `hands - 1`; an inter-hand race that drops a record keeps
      // it lower, which is what makes "no missed memory record" testable.
      const observed = view?.sessionMemory?.handsObserved ?? 0;
      if (observed > rec.maxHandsObserved) rec.maxHandsObserved = observed;
      return policy.decide(view);
    },
  });
  const botSeats = Object.keys(seatPolicies).map(Number).sort((a, b) => a - b);
  const policyForSeat = (seat) =>
    observeMemory(seat, resolveStrategy(seatPolicies[seat], statsForSeat(seat)));
  const dbPath = join(tmpdir(), `4am-eval-${randomBytes(5).toString('hex')}.db`);
  const ctx = createApp(dbPath);
  const hub = attachHub(ctx.app, ctx.db, {
    cryptoTimeoutMs: cryptoMs,
    actionTimeoutMs: actionMs,
    autoDealMs: 3_600_000,
    readyCheckMs: readyMs,
    // Eval matches drive every hand explicitly and measure poker strength, not
    // animation: skip the web-facing holds so throughput is unchanged.
    showdownHoldMs: 0,
    settleHoldMs: 0,
  });
  const baseUrl = await ctx.app.listen({ host: '127.0.0.1', port: 0 });

  const supervisor = new BotSupervisor(ctx.db, {
    baseUrl,
    maxConcurrent: botSeats.length,
    runner: {
      graceMs: 8_000,
      pollMs: 15,
      settleMs: 100,
    },
    log: () => {},
    runnerFactory: (db, claim, opts) =>
      new BotRunner(db, claim, {
        ...opts,
        // Arm mode passes `memory: true`; the legacy default stays `false`, so
        // the pre-existing round-robin numbers are unchanged.
        memory,
        policy: policyForSeat(claim.bot.seat),
        // Only the memory-on path wraps clients: it lets the harness confirm
        // the runner recorded each settled hand before the next deal.
        ...(memory ? { clientFactory: barrierClientFactory } : {}),
      }),
  });
  ctx.botControl.hooks = supervisor;

  const human = new HeadlessClient(baseUrl, `host_${randomBytes(3).toString('hex')}`, 'eval');
  const humanPolicy = observeMemory(0, resolveStrategy(anchor, statsForSeat(0)));

  const out = {
    seed,
    shuffleSalt: deterministic ? shuffleSalt : null,
    deterministic,
    hands: 0,
    requestedHands: hands,
    aborts: 0,
    rejected: 0,
    botActions: 0,
    ledgerOk: true,
    handIds: [],
    perHand: [],
    cardFingerprints: [],
    cardsFingerprintComplete: true,
    /** Legality-guard substitutions summed over seats (see `seatPolicyStats`). */
    policyLegalityFallbacks: 0,
    policyLegalityIllegalDecisions: 0,
    /** seat -> { fold, call, check, bet, raise, total } accepted actions. */
    seatActions: {},
    /**
     * seat -> { legalityFallbacks, legalityIllegalDecisions }. These count only
     * the OUTER legality guard (`ensureLegal`): a decision that was absent or
     * illegal and had to be substituted. A `RulePolicy` internal `safeFallback`
     * that already returns a legal action is NOT visible here. Use `seatMemory`
     * to see whether the injected memory reached the policy.
     */
    seatPolicyStats: {},
    /** seat -> { decisions, nonEmptyOpponents } memory-visibility probe. */
    seatMemory: {},
    memory,
    seatPolicies: { ...seatPolicies },
    anchor,
  };

  // --- memory settlement barrier (memory-on only) ---------------------------
  // The runner polls `client.result` and only then records the settled hand into
  // its session memory. The next server `hand_start` clears the previous result
  // (client.ts), so if the harness deals the next hand before every bot has
  // recorded, a hand is silently dropped from memory. We wrap each bot client's
  // `result` accessor: the runner reads it immediately before its synchronous
  // `recordHandEnd`, so a microtask queued from the accessor always runs AFTER
  // the record completed. The loop awaits every bot having observed the settled
  // handId before dealing the next. Built only when `memory` is on; the legacy
  // path never wraps a client and never waits.
  const barrierClients = new Set();
  const observedByHand = new Map();
  const barrierWaiters = new Map();
  const maybeReleaseBarrier = (handId) => {
    const waiters = barrierWaiters.get(handId);
    if (!waiters) return;
    const seen = observedByHand.get(handId);
    if (!seen || seen.size < barrierClients.size) return;
    for (const w of waiters) {
      clearTimeout(w.timer);
      w.resolve();
    }
    barrierWaiters.delete(handId);
  };
  const noteSettlementObserved = (client, handId) => {
    queueMicrotask(() => {
      let seen = observedByHand.get(handId);
      if (!seen) {
        seen = new Set();
        observedByHand.set(handId, seen);
      }
      seen.add(client);
      maybeReleaseBarrier(handId);
    });
  };
  const awaitSettlementRecorded = (handId, timeoutMs) =>
    new Promise((resolve, reject) => {
      let waiters = barrierWaiters.get(handId);
      if (!waiters) {
        waiters = new Set();
        barrierWaiters.set(handId, waiters);
      }
      const waiter = {
        resolve,
        timer: setTimeout(() => {
          waiters.delete(waiter);
          reject(
            new Error(
              `memory barrier: hand ${handId} not recorded by every bot ` +
                `(${observedByHand.get(handId)?.size ?? 0}/${barrierClients.size})`,
            ),
          );
        }, timeoutMs),
      };
      waiters.add(waiter);
      maybeReleaseBarrier(handId);
    });
  const barrierClientFactory = (clientBaseUrl, username, password) => {
    const client = new HeadlessClient(clientBaseUrl, username, password);
    barrierClients.add(client);
    let current = client.result;
    Object.defineProperty(client, 'result', {
      configurable: true,
      get() {
        // Only the runner's `recordHandEnd()` read proves the hand is about to
        // be recorded. Other readers (`myTurn`, `waitForTurn`) also touch
        // `result`, and counting reads cannot tell them apart - but the stack
        // can: the record read is synchronous with `observeHand`, so a
        // microtask queued here always runs after the record completed. If this
        // ever fails to match, the barrier times out loudly instead of racing.
        if (
          current &&
          current.handId &&
          (new Error().stack ?? '').includes('recordHandEnd')
        ) {
          noteSettlementObserved(client, current.handId);
        }
        return current;
      },
      set(next) {
        current = next;
      },
    });
    return client;
  };

  const botStatus = (id) =>
    ctx.db.prepare('SELECT status FROM bot_accounts WHERE id = ?').get(id)?.status ?? null;

  try {
    await human.login();
    const room = await human.api('/api/rooms', { name: 'Eval', sb, bb }, 'POST');
    await human.connect(room.id);
    human.send({ t: 'sit', seat: 0 });
    const buy = await human.api(`/api/rooms/${room.id}/buy`, { amount: buyIn });
    await human.api(`/api/rooms/${room.id}/approve`, { requestId: buy.id, approve: true });
    // CARD-VISIBILITY PROBE (harness-only): enable TV replays so the post-hand
    // audit reveals EVERY participant's hole cards into the transcript (folded
    // players via escrowed keys, live players via reveal_key). This changes only
    // the post-settlement key collection - never the deal, betting or deltas -
    // and gives the duplicate comparison a real card-level fingerprint instead
    // of the bare hand-id. `startHand` reads the room fresh, so the UPDATE
    // applies from the first hand on.
    ctx.db.prepare('UPDATE rooms SET tv_replays = 1 WHERE id = ?').run(room.id);

    const bots = [];
    for (const seat of botSeats) {
      const created = await human.api(`/api/rooms/${room.id}/bots`, {
        seat,
        initialBuyIn: buyIn,
        policyKind: 'scripted',
        name: `Eval${seat}`,
      });
      bots.push({ id: created.bot.id, userId: created.bot.userId, seat: created.bot.seat });
    }
    for (const b of bots) await human.api(`/api/rooms/${room.id}/bots/${b.id}/start`, {});
    await waitFor(
      () =>
        bots.every(
          (b) =>
            botStatus(b.id) === 'running' &&
            !!human.room?.players.find((p) => p.userId === b.userId && p.connected),
        ),
      20_000,
      'eval bots running',
    );

    const stackOf = (userId) =>
      ctx.db
        .prepare('SELECT stack FROM room_players WHERE room_id = ? AND user_id = ?')
        .get(room.id, userId)?.stack ?? 0;
    let topUpSeq = 1;
    const nextTopUp = () => buyIn + topUpSeq++;
    const ensureFunded = async () => {
      if (stackOf(human.userId) <= 0) {
        const req = await human.api(`/api/rooms/${room.id}/buy`, { amount: nextTopUp() });
        await human.api(`/api/rooms/${room.id}/approve`, { requestId: req.id, approve: true });
      }
      for (const b of bots) {
        if (stackOf(b.userId) <= 0)
          await human.api(`/api/rooms/${room.id}/bots/${b.id}/buy`, { amount: nextTopUp() });
      }
    };

    const driveHuman = async (handId, deadline) => {
      while (Date.now() < deadline) {
        if (human.handId !== handId || human.abort) break;
        if (human.result && human.result.handId === handId) break;
        await human.waitForTurn(50);
        if (human.handId !== handId || human.abort) break;
        if (human.result && human.result.handId === handId) break;
        if (!human.myTurn()) continue;
        const view = buildDecisionView(human);
        if (!view.legalActions) continue;
        if (view.hand?.deadline && view.hand.deadline - Date.now() < 100) continue;
        let decision;
        try {
          decision = await humanPolicy.decide(view);
        } catch {
          decision = null;
        }
        const legal = !!decision && isLegalDecision(decision.action, view.legalActions);
        if (!legal) {
          // The human anchor is a baseline policy too: an illegal decision that
          // reached here is a policy bug, not something to hide behind the
          // harness fallback. `guardPolicy` already counts any decision it had
          // to repair into seat 0's sink; this catches the residual case.
          const anchorStats = statsForSeat(0);
          anchorStats.fallbacks++;
          if (decision && decision.action) anchorStats.illegalDecisions++;
        }
        const action = legal ? decision.action : fallbackDecision(view.legalActions).action;
        try {
          human.act(action);
        } catch {
          // table advanced between check and send
        }
      }
    };

    for (let h = 0; h < hands; h++) {
      await ensureFunded();
      const prevHandId = human.handId;
      const handStart = Date.now();
      human.send({ t: 'start_hand' });
      await waitFor(
        () => !!human.abort || (human.handId && human.handId !== prevHandId),
        15_000,
        `eval hand ${h + 1} dealt`,
      );
      if (human.abort) {
        out.aborts++;
        break;
      }
      const handId = human.handId;
      const driver = driveHuman(handId, Date.now() + handMs);
      const settleDeadline = Date.now() + handMs;
      for (;;) {
        const settled =
          (human.result && human.result.handId === handId) ||
          (human.abort && human.abort.handId === handId);
        if (settled) break;
        const actionSeq = hub.rooms.get(room.id)?.hand?.actionSeq ?? 0;
        if (actionSeq > maxHandActions)
          throw new Error(`pathological hand ${handId}: actionSeq=${actionSeq}`);
        if (Date.now() > settleDeadline) throw new Error(`eval hand ${h + 1} did not settle`);
        await sleep(15);
      }
      await driver;
      if (human.abort || !human.result || human.result.handId !== handId) {
        out.aborts++;
        break;
      }

      const result = human.result;
      const deltas = result.deltas.map((d) => ({ seat: d.seat, delta: d.delta }));
      const tRow = ctx.db
        .prepare('SELECT entries FROM transcripts WHERE hand_id = ?')
        .get(handId);
      let handRejected = 0;
      if (tRow) {
        for (const e of JSON.parse(tRow.entries))
          if (e.type === 'action_rejected') handRejected++;
      }
      out.rejected += handRejected;
      // Per-seat action distribution from the accepted action stream. Only bot
      // seats are counted (the seat-0 anchor is never itself compared).
      for (const a of human.actionHistory ?? []) {
        if (!bots.some((b) => b.seat === a.seat)) continue;
        const seat = a.seat;
        if (!out.seatActions[seat]) out.seatActions[seat] = emptyActionCounts();
        const rec = out.seatActions[seat];
        const type = a.action?.type;
        if (ACTION_TYPES.includes(type)) rec[type]++;
        rec.total++;
        out.botActions++;
      }

      // Real card-level fingerprint (see extractCardFingerprint): every dealt
      // seat must have its two hole cards and the settlement board present, or
      // the duplicate comparison below cannot prove the physical deal replayed.
      const cardFingerprint = extractCardFingerprint(
        tRow,
        result.deltas.map((d) => d.seat),
      );
      if (!cardFingerprint.complete) out.cardsFingerprintComplete = false;

      out.hands++;
      out.handIds.push(handId);
      out.cardFingerprints.push(cardFingerprint);
      out.perHand.push({
        handId,
        deltas,
        rejected: handRejected,
        durationMs: Date.now() - handStart,
      });
      // Memory-on: do not deal the next hand until every bot has recorded this
      // one. The accessor hook fires just before the runner's synchronous
      // record, and the microtask it queues runs after that record completes.
      if (memory) await awaitSettlementRecorded(handId, handMs + 5_000);
    }

    // Ledger conservation + no bot error.
    const roster = ctx.db
      .prepare('SELECT user_id, stack FROM room_players WHERE room_id = ?')
      .all(room.id);
    for (const p of roster) {
      const sum = ctx.db
        .prepare('SELECT COALESCE(SUM(delta),0) AS s FROM ledger WHERE room_id=? AND user_id=?')
        .get(room.id, p.user_id).s;
      if (p.stack !== sum || p.stack < 0) out.ledgerOk = false;
    }
    out.botErrors = ctx.db
      .prepare("SELECT COUNT(*) AS n FROM bot_accounts WHERE room_id=? AND status='error'")
      .get(room.id).n;
    // Per-seat stats + run-level totals (the sum). Every seat we actually seated
    // a policy for is reported, including the anchor at seat 0.
    let legalityFallbacks = 0;
    let legalityIllegalDecisions = 0;
    for (const [seat, s] of statsBySeat) {
      out.seatPolicyStats[seat] = {
        legalityFallbacks: s.fallbacks,
        legalityIllegalDecisions: s.illegalDecisions,
      };
      legalityFallbacks += s.fallbacks;
      legalityIllegalDecisions += s.illegalDecisions;
    }
    out.policyLegalityFallbacks = legalityFallbacks;
    out.policyLegalityIllegalDecisions = legalityIllegalDecisions;
    // Memory-visibility probe copied from the per-decision observer.
    for (const [seat, m] of memoryBySeat) out.seatMemory[seat] = m;
    // A seat that never acted still gets a zeroed record, so consumers do not
    // have to guess between "no actions" and "seat absent".
    for (const seat of [0, ...botSeats]) {
      if (!out.seatActions[seat]) out.seatActions[seat] = emptyActionCounts();
      if (!out.seatMemory[seat])
        out.seatMemory[seat] = {
          decisions: 0,
          nonEmptyOpponents: 0,
          withOpponentStats: 0,
          maxHandsObserved: 0,
        };
    }
    return out;
  } finally {
    await supervisor.stopAll().catch(() => {});
    human.close();
    await ctx.app.close().catch(() => {});
    uninstallDeterministicShuffle();
    // Restore the env the harness mutated, so a later server test in the same
    // worker is not silently forced onto the deterministic-shuffle path.
    restoreEnv(envBefore);
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${dbPath}${suffix}`, { force: true });
  }
}

/** Map a per-hand delta list to a seat->delta lookup. */
export function deltasBySeat(perHand) {
  const map = new Map();
  for (const d of perHand.deltas) map.set(d.seat, d.delta);
  return map;
}
