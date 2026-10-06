import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HeadlessClient, buildDecisionView } from '@4am/agent-core';
import { createApp } from '../src/app.js';
import { attachHub } from '../src/hub.js';
import { BotSupervisor } from '../src/botSupervisor.js';
import type { RunnerActionEvent } from '../src/botRunner.js';
import { activeHands } from '../src/liveHands.js';
import { joinActionAttribution } from './helpers/actionAttribution.js';
import { sleep, waitFor } from './helpers/waitFor.js';
import {
  installDeterministicShuffle,
  uninstallDeterministicShuffle,
} from './helpers/deterministicShuffle.mjs';

/**
 * Phase 1b end to end: a real server on a loopback port, a real human
 * `HeadlessClient` (same protocol/crypto/signatures as any client) and a bot
 * driven by the `BotSupervisor`, playing at least one complete hand.
 *
 * It deliberately does NOT stub the runner or the WS: the bot's grant, its
 * mental-poker messages, its action and the settlement all flow through the
 * ordinary server paths. This is the strongest practical proof that a bot is
 * just another player.
 */

const KEY = 'ab'.repeat(32);
const ORIGINAL_KEY = process.env.BOT_IDENTITY_KEY;
const ORIGINAL_SHUFFLE_SEED = process.env.BOT_TEST_SHUFFLE_SEED;

let ctx: ReturnType<typeof createApp>;
let baseUrl: string;
let supervisor: BotSupervisor;
let human: HeadlessClient;
let hub: ReturnType<typeof attachHub>;
/** Routed decisions of every bot runner, captured via `onActionEvent`. */
let routedActions: RunnerActionEvent[] = [];

/**
 * Seed for the deterministic mental-poker deal used by the end-to-end hand.
 * With `BOT_TEST_SHUFFLE_SEED` set the server also mints a reproducible handId
 * (`testHandId` in `game.ts`), so the seeded client permutation - and therefore
 * the whole hand - is identical run to run. Safe here because every test boots
 * a fresh `:memory:` database, so the `transcripts.hand_id` PRIMARY KEY the flag
 * warns about cannot collide.
 */
const SHUFFLE_SEED = 'bot-e2e-complete-hand-rake';

function botStatus(botId: string): string | null {
  const row = ctx.db.prepare('SELECT status FROM bot_accounts WHERE id = ?').get(botId) as
    | { status: string }
    | undefined;
  return row?.status ?? null;
}

async function createTable() {
  const room = (await human.api('/api/rooms', { name: 'Bot Table', sb: 10, bb: 20 }, 'POST')) as {
    id: string;
    joinCode: string;
  };
  await human.connect(room.id);
  human.send({ t: 'sit', seat: 0 });
  // auto-approval is on by default, so the buy funds the sitter immediately
  await human.api(`/api/rooms/${room.id}/buy`, { amount: 1000 });
  const bot = (await human.api(`/api/rooms/${room.id}/bots`, {
    seat: 1,
    initialBuyIn: 1000,
    policyKind: 'scripted',
    name: 'Robo',
  })) as { bot: { id: string; userId: number; seat: number } };
  return { room, bot };
}

async function startBot(botId: string, roomId: string, botUserId: number) {
  await human.api(`/api/rooms/${roomId}/bots/${botId}/start`, {});
  await waitFor(() => {
    if (botStatus(botId) !== 'running') return false;
    const p = human.room?.players.find((x) => x.userId === botUserId);
    return !!p && p.connected && p.stack > 0;
  }, 15000);
}

/** Call/check forever with the human until the hand settles. */
function driveHuman(maxMs: number): Promise<void> {
  return (async () => {
    const deadline = Date.now() + maxMs;
    while (Date.now() < deadline && !human.result && !human.abort) {
      await human.waitForTurn(100);
      if (human.result || human.abort) break;
      // A stale cached turn is not actionable until this epoch's resync lands:
      // mirror the runner's `isResynced` gate instead of acting on old betting.
      if (!human.isResynced) continue;
      if (!human.myTurn()) continue;
      const view = buildDecisionView(human);
      if (!view.legalActions) continue;
      try {
        human.act({ type: view.legalActions.canCheck ? 'check' : 'call' });
      } catch {
        // the table advanced between the check and the send
      }
    }
  })();
}

beforeEach(async () => {
  process.env.BOT_IDENTITY_KEY = KEY;
  ctx = createApp(':memory:');
  hub = attachHub(ctx.app, ctx.db, {
    cryptoTimeoutMs: 2500,
    actionTimeoutMs: 3000,
    autoDealMs: 60_000,
    readyCheckMs: 2000,
  });
  const address = await ctx.app.listen({ host: '127.0.0.1', port: 0 });
  baseUrl = address;
  routedActions = [];
  supervisor = new BotSupervisor(ctx.db, {
    baseUrl,
    maxConcurrent: 2,
    runner: { graceMs: 10_000, pollMs: 25, onActionEvent: (e) => routedActions.push(e) },
    log: () => {},
  });
  ctx.botControl.hooks = supervisor;
  human = new HeadlessClient(
    baseUrl,
    `h${Date.now().toString(36)}${randomBytes(2).toString('hex')}`,
    'hunter2',
  );
  await human.login();
});

afterEach(async () => {
  uninstallDeterministicShuffle();
  if (ORIGINAL_SHUFFLE_SEED === undefined) delete process.env.BOT_TEST_SHUFFLE_SEED;
  else process.env.BOT_TEST_SHUFFLE_SEED = ORIGINAL_SHUFFLE_SEED;
  await supervisor.stopAll().catch(() => {});
  human.close();
  await ctx.app.close();
  if (ORIGINAL_KEY === undefined) delete process.env.BOT_IDENTITY_KEY;
  else process.env.BOT_IDENTITY_KEY = ORIGINAL_KEY;
});

describe('bot vs human end to end', () => {
  it('plays a complete hand with real crypto, signature and ledger', async () => {
    const { room, bot } = await createTable();
    await startBot(bot.bot.id, room.id, bot.bot.userId);

    // The bot is a real member shown to the human, seated and funded.
    const seen = human.room?.players.find((p) => p.userId === bot.bot.userId);
    expect(seen).toBeTruthy();
    expect(seen?.seat).toBe(1);

    // Freeze the deal: patch the client-side mental-poker permutation and make
    // the server mint a reproducible handId. Without this the CSPRNG deals a
    // different hand every run, so the pot - and whether it crosses the rake
    // floor - varied run to run.
    process.env.BOT_TEST_SHUFFLE_SEED = SHUFFLE_SEED;
    installDeterministicShuffle(SHUFFLE_SEED);

    human.send({ t: 'start_hand' });
    const driver = driveHuman(25_000);
    await waitFor(() => human.result !== null || human.abort !== null, 25_000);
    await driver;

    expect(human.abort).toBeNull();
    const result = human.result!;
    // Chips leave the hand's seats only via the room commission: `hand_end.deltas`
    // are the combined poker+squid+bounty game legs and the documented aggregate
    // is `sum(deltas) === -commission` ALWAYS (wsProtocol.ts), so a raked pot
    // legitimately nets to -rake here; the commission itself lands on the
    // recipient's `commission` ledger row. (The old assertion expected 0 and
    // was only correct while the randomly dealt pot stayed under the rake floor.)
    const handNet = result.deltas.reduce((s, d) => s + d.delta, 0);
    expect(handNet + (result.commission ?? 0)).toBe(0);

    // The bot took real actions, all legal and observed by the human.
    const botActions = human.actionHistory.filter((a) => a.seat === bot.bot.seat);
    expect(botActions.length).toBeGreaterThan(0);
    for (const a of botActions)
      expect(['fold', 'check', 'call', 'bet', 'raise']).toContain(a.action.type);

    // The hand produced an auditable transcript and a verifiable ledger.
    const transcript = ctx.db
      .prepare('SELECT 1 FROM transcripts WHERE hand_id = ?')
      .get(result.handId);
    expect(transcript).toBeTruthy();
    const ledger = (await human.api(`/api/rooms/${room.id}/ledger`)) as {
      verified: { ok: boolean };
    };
    expect(ledger.verified.ok).toBe(true);

    // Strong conservation, not just "the chain verifies": every seated player's
    // persisted stack equals the sum of their ledger deltas (the ledger is the
    // source of truth), and the whole room's ledger nets to exactly the chips
    // bought in - settlement and rake are zero-sum.
    const roster = ctx.db
      .prepare('SELECT user_id, stack FROM room_players WHERE room_id = ?')
      .all(room.id) as { user_id: number; stack: number }[];
    for (const p of roster) {
      const sum = (
        ctx.db
          .prepare(
            'SELECT COALESCE(SUM(delta), 0) AS s FROM ledger WHERE room_id = ? AND user_id = ?',
          )
          .get(room.id, p.user_id) as { s: number }
      ).s;
      expect(p.stack).toBe(sum);
    }
    const ledgerTotal = (
      ctx.db
        .prepare('SELECT COALESCE(SUM(delta), 0) AS s FROM ledger WHERE room_id = ?')
        .get(room.id) as { s: number }
    ).s;
    const purchased = (
      ctx.db
        .prepare(
          "SELECT COALESCE(SUM(delta), 0) AS s FROM ledger WHERE room_id = ? AND kind = 'purchase'",
        )
        .get(room.id) as { s: number }
    ).s;
    expect(ledgerTotal).toBe(purchased);
  }, 40_000);

  it('stops a running bot gracefully without aborting the hand in progress', async () => {
    const { room, bot } = await createTable();
    await startBot(bot.bot.id, room.id, bot.bot.userId);

    human.send({ t: 'start_hand' });
    // Stop while the hand is live (during the deal/crypto phase).
    await waitFor(() => human.handLive(), 10_000);

    const stop = (await human.api(`/api/rooms/${room.id}/bots/${bot.bot.id}/stop`, {})) as {
      bot: { status: string };
    };
    expect(stop.bot.status).toBe('stopping');

    const driver = driveHuman(25_000);
    await waitFor(() => human.result !== null || human.abort !== null, 25_000);
    await driver;
    await waitFor(() => botStatus(bot.bot.id) === 'stopped', 15_000);

    expect(human.abort).toBeNull();
    expect(botStatus(bot.bot.id)).toBe('stopped');
  }, 40_000);

  it('attributes a runner action to the signed transcript across a mid-hand observer reconnect', async () => {
    const { room, bot } = await createTable();
    await startBot(bot.bot.id, room.id, bot.bot.userId);

    human.send({ t: 'start_hand' });
    await waitFor(() => human.handLive(), 10_000);
    // The observer drops and reconnects mid-hand while the bot keeps playing;
    // the runner's own client is untouched. Attribution is server-authoritative,
    // so the observer's missed frames must not change it.
    human.close();
    await sleep(250);
    await human.connect(room.id);

    const driver = driveHuman(25_000);
    await waitFor(() => human.result !== null || human.abort !== null, 25_000);
    await driver;
    expect(human.abort).toBeNull();

    const handId = human.result!.handId;
    const row = ctx.db.prepare('SELECT entries FROM transcripts WHERE hand_id = ?').get(handId) as {
      entries: string;
    };
    const entries = JSON.parse(row.entries) as {
      type: string;
      payload: { actionSeq?: number; seat: number };
    }[];
    // Restrict the join to the bot's seat: the human driver's sends are not
    // routed events (its decisions are not what this test attributes).
    const accepted = entries
      .filter((e) => e.type === 'action' && e.payload.seat === bot.bot.seat)
      .map((e) => ({ handId, actionSeq: e.payload.actionSeq!, seat: e.payload.seat }));
    // Every accepted signed action carries the server's authoritative index.
    expect(accepted.length).toBeGreaterThan(0);
    for (const a of accepted) expect(Number.isInteger(a.actionSeq)).toBe(true);

    // The real runner's routed sends join the transcript one-to-one: no
    // unmatched, unaccepted, duplicate or seat-mismatched decisions.
    const sends = routedActions.filter((e) => e.kind === 'sent' && e.seat === bot.bot.seat);
    const join = joinActionAttribution(sends, accepted);
    expect(join.duplicateRoute).toBe(0);
    expect(join.acceptedWithoutRoute).toBe(0);
    expect(join.routeWithoutAccepted).toBe(0);
    expect(join.seatMismatch).toBe(0);
    expect(join.acceptedMissingActionSeq).toBe(0);
    // The scripted bot's actions are local (no model source), so they land in
    // `otherAccepted`; that bucket must be non-empty.
    expect(join.otherAccepted).toBeGreaterThan(0);
  }, 40_000);

  it('resyncs after a non-betting (crypto-phase) reconnect and still plays the hand out', async () => {
    const { room, bot } = await createTable();
    await startBot(bot.bot.id, room.id, bot.bot.userId);

    human.send({ t: 'start_hand' });
    // `handLive()` turns true at `hand_start`, while the crypto deal is still
    // running and no `betting_state` has been sent yet.
    await waitFor(() => human.handLive(), 10_000);
    // Immediate handoff with no drain window: the stale-socket guards must keep
    // the old socket's late close/message frames from touching the new one.
    human.close();
    await human.connect(room.id);
    // The replayed `hand_start`/crypto context frame must open the gate even
    // though there is no `betting_state` yet: a non-betting reconnect must not
    // permanently freeze the runner.
    await waitFor(() => human.isResynced, 5_000);

    const driver = driveHuman(25_000);
    await waitFor(() => human.result !== null || human.abort !== null, 25_000);
    await driver;
    expect(human.abort).toBeNull();
    expect(human.result).not.toBeNull();
  }, 40_000);

  it('clears a stale hand snapshot when a reconnect finds no live hand (missed hand_end)', async () => {
    const { room, bot } = await createTable();
    await startBot(bot.bot.id, room.id, bot.bot.userId);

    human.send({ t: 'start_hand' });
    await waitFor(() => human.handLive(), 10_000);
    // Drop mid-hand and never observe `hand_end`: the server settles the hand
    // (auto-fold / abort) while we are away.
    human.close();
    await waitFor(() => !activeHands.has(room.id), 20_000);
    // The stale snapshot is still cached (no terminal frame was received).
    expect(human.handId).not.toBeNull();

    await human.connect(room.id);
    await waitFor(() => human.isResynced, 10_000);
    // `room_state` reported no live hand, so the barrier opened and the stale
    // hand was cleared instead of being reused.
    expect(human.handId).toBeNull();
    expect(human.betting).toBeNull();
    expect(human.myTurn()).toBe(false);
  }, 40_000);

  it('never treats a stale cached turn as actionable across a live-hand reconnect', async () => {
    const { room, bot } = await createTable();
    const second = (await human.api(`/api/rooms/${room.id}/bots`, {
      seat: 2,
      initialBuyIn: 1000,
      policyKind: 'scripted',
      name: 'Robo2',
    })) as { bot: { id: string; userId: number; seat: number } };
    await startBot(bot.bot.id, room.id, bot.bot.userId);
    await startBot(second.bot.id, room.id, second.bot.userId);

    human.send({ t: 'start_hand' });
    await waitFor(() => human.myTurn(), 15_000);
    // The cached snapshot says it is our turn...
    expect(human.myTurn()).toBe(true);

    // ...but we drop without acting. The action clock auto-folds us; the two
    // bots keep the hand alive so the server is now waiting on someone else.
    human.close();
    await sleep(3_300);
    await human.connect(room.id);
    // Immediately after the socket opens, this epoch is not resynced, so the
    // stale cached turn is not actionable yet.
    expect(human.isResynced).toBe(false);

    // Sample the whole reconnect window: a snapshot that still reads "our turn"
    // must never also be considered resynced.
    const probes: { resynced: boolean; myTurn: boolean }[] = [];
    for (let i = 0; i < 4_000 && !human.isResynced; i++) {
      probes.push({ resynced: human.isResynced, myTurn: human.myTurn() });
      await sleep(1);
    }
    expect(human.isResynced).toBe(true);
    // By the time the barrier lifts, the authoritative state has moved on.
    expect(human.myTurn()).toBe(false);
    expect(probes.some((p) => p.resynced && p.myTurn)).toBe(false);
  }, 40_000);

  it('a bot auto-accepts a human peek and the fixed 1bb moves through the ledger', async () => {
    const { room, bot } = await createTable();
    await startBot(bot.bot.id, room.id, bot.bot.userId);

    human.send({ t: 'start_hand' });
    // Heads-up: the human is the button/SB and acts first. Fold so the hand
    // ends without a showdown (the bot's cards stay private and peekable).
    const foldDriver = (async () => {
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline && !human.result && !human.abort) {
        await human.waitForTurn(100);
        if (human.result || human.abort) break;
        if (!human.isResynced || !human.myTurn()) continue;
        try {
          human.act({ type: 'fold' });
        } catch {
          /* the table advanced between the check and the send */
        }
      }
    })();
    await waitFor(() => human.result !== null || human.abort !== null, 25_000);
    await foldDriver;
    expect(human.abort).toBeNull();

    const botSeat = bot.bot.seat;
    const stackOf = (seat: number) =>
      (
        ctx.db
          .prepare('SELECT stack FROM room_players WHERE room_id = ? AND seat = ?')
          .get(room.id, seat) as { stack: number }
      ).stack;
    const humanBefore = stackOf(0);
    const botBefore = stackOf(botSeat);

    // Tap the bot's server-side socket to observe the target-side terminal
    // receipt (`peek_offer_closed`) it is sent on its real WS. The bot client
    // ignores it (it auto-accepts and has nothing to dismiss), so only a frame
    // tap can prove the server emitted it on the bot path.
    const botFrames: string[] = [];
    const gameRoom = hub.rooms.get(room.id) as unknown as {
      sockets: Map<number, { send: (data: string) => void }>;
    };
    const botSocket = gameRoom.sockets.get(bot.bot.userId)!;
    const origSend = botSocket.send.bind(botSocket);
    botSocket.send = (data: string): void => {
      botFrames.push(data);
      origSend(data);
    };

    // The human asks to see the bot's mucked cards, passing a bogus 100: the
    // server must charge the fixed 1bb anyway.
    human.send({ t: 'peek_offer', handId: human.handId, targetSeat: botSeat, amount: 100 });
    // The bot answers on its own; the human receives the private reveal.
    await waitFor(() => human.events.some((e) => e.includes('peek accepted')), 10_000);
    expect(human.events.some((e) => e.includes(`peek accepted: seat ${botSeat + 1}`))).toBe(true);

    // The bot target is told the offer resolved, with no buyer-only payload.
    await waitFor(
      () => botFrames.some((f) => f.includes('peek_offer_closed')),
      10_000,
    );
    const closed = JSON.parse(
      botFrames.find((f) => f.includes('peek_offer_closed'))!,
    ) as { t: string; status: string; cards?: unknown; amount?: unknown };
    expect(closed.t).toBe('peek_offer_closed');
    expect(closed.status).toBe('accepted');
    expect(closed.cards).toBeUndefined();
    expect(closed.amount).toBeUndefined();

    const bb = (ctx.db.prepare('SELECT bb FROM rooms WHERE id = ?').get(room.id) as { bb: number })
      .bb;
    expect(bb).toBe(20);
    expect(stackOf(0)).toBe(humanBefore - bb);
    expect(stackOf(botSeat)).toBe(botBefore + bb);

    const peekRows = ctx.db
      .prepare("SELECT delta FROM ledger WHERE room_id = ? AND kind = 'peek'")
      .all(room.id) as { delta: number }[];
    expect(peekRows).toHaveLength(2);
    expect(peekRows.reduce((s, r) => s + r.delta, 0)).toBe(0);
  }, 40_000);
});
