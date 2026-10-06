import type { AddressInfo } from 'node:net';
import { createApp } from '../../src/app.js';
import { attachHub } from '../../src/hub.js';
import type { GameClock, GameOpts } from '../../src/game.js';

/**
 * Shared boot scaffolding for the split WebSocket integration suites.
 *
 * The original monolithic `integration.test.ts` kept one module-level
 * `beforeEach` (a `ManualClock`, a mutable fault bag, and an in-memory
 * app+hub) plus the `ManualClock` class. Splitting that file by behaviour
 * cluster would otherwise duplicate ~90 lines of boot/crypto-free setup in
 * every new file, so this module holds exactly that scaffolding, lifted
 * verbatim from `integration.test.ts`:
 *
 *   - `ManualClock`           -> `integration.test.ts:678-722`
 *   - the `beforeEach` body   -> `integration.test.ts:742-789`
 *   - the `fault` bag shape   -> `integration.test.ts:729-740`
 *
 * Nothing here changes what a server does; each suite still boots an identical
 * app and drives it through `TestClient`/`setupRoom` from the other helpers.
 * (The existing `startServer` helper cannot be reused here because the restart
 * and shutdown suites need the live `hub` handle, which `startServer` does not
 * return, plus the mutable fault bag wired into the hub's injection hooks.)
 */

/** App context returned by `createApp` (in-memory or file-backed). */
export type IntegrationCtx = ReturnType<typeof createApp>;
/** Hub handle returned by `attachHub`. */
export type IntegrationHub = ReturnType<typeof attachHub>;

/**
 * The clock that drives the showdown settle hold. In `auto` mode it delegates
 * to real timers, so every ordinary WS test behaves exactly as before. A test
 * calls `freeze()` to take manual control: the hold timer is captured instead
 * of scheduled, and `advance(ms)` fires it. That makes the ordering contract
 * (durable write → reveal → hold → hand_end) deterministic instead of racing
 * wall-clock sleeps under load.
 */
export class ManualClock implements GameClock {
  private manual = false;
  private base = 1_000_000;
  private offset = 0;
  private seq = 1;
  private timers = new Map<number, { at: number; fn: () => void }>();

  now(): number {
    return this.manual ? this.base + this.offset : Date.now();
  }
  setTimer(fn: () => void, ms: number): ReturnType<typeof setTimeout> {
    if (!this.manual) return setTimeout(fn, ms);
    const handle = this.seq++;
    this.timers.set(handle, { at: this.now() + ms, fn });
    return handle as unknown as ReturnType<typeof setTimeout>;
  }
  clearTimer(handle: ReturnType<typeof setTimeout>): void {
    if (!this.manual) {
      clearTimeout(handle);
      return;
    }
    this.timers.delete(handle as unknown as number);
  }
  freeze(): void {
    this.manual = true;
    this.offset = 0;
  }
  advance(ms: number): void {
    if (!this.manual) throw new Error('ManualClock.advance requires freeze()');
    this.offset += ms;
    const due = [...this.timers.entries()].filter(([, t]) => t.at <= this.now());
    for (const [handle, t] of due) {
      this.timers.delete(handle);
      t.fn();
    }
  }
}

/** Mutable fault switches consulted by the hub's test-only fault injection. */
export interface FaultBag {
  persistFailThrough: number;
  broadcastThrowT: string | null;
  sevenDeuceFailOnce: boolean;
  /** A coded error thrown by the 7-2 bounty hook, to exercise the transient-vs-
   *  programming classification with real SQLite result codes. */
  sevenDeuceError: Error | null;
  /** Injected INSIDE the 7-2 bounty transaction; not special-cased, so it
   *  exercises the internal-error (unhealthy) classification. */
  sevenDeuceInternal: (() => void) | null;
}

/** A fresh fault bag, matching `integration.test.ts:744-750`. */
export function createFaultBag(): FaultBag {
  return {
    persistFailThrough: 0,
    broadcastThrowT: null,
    sevenDeuceFailOnce: false,
    sevenDeuceError: null,
    sevenDeuceInternal: null,
  };
}

/**
 * The hub options the original `beforeEach` passed (`integration.test.ts:752-784`),
 * with the mutable fault bag wired into the test-only injection hooks.
 */
export function integrationHubOpts(clock: GameClock, fault: FaultBag): Partial<GameOpts> {
  return {
    cryptoTimeoutMs: 1500,
    actionTimeoutMs: 1500,
    autoDealMs: 800,
    readyCheckMs: 1500,
    // short holds so the reveal/settle ordering is observable in real time
    showdownHoldMs: 400,
    settleHoldMs: 1500,
    ritVoteMs: 1500,
    clock,
    faultInjection: {
      persist: (attempt) => {
        if (fault.persistFailThrough >= attempt) throw new Error('injected persist failure');
      },
      broadcast: (msg) => {
        if (fault.broadcastThrowT === msg.t) throw new Error('injected broadcast failure');
      },
      sevenDeuce: () => {
        if (fault.sevenDeuceError) {
          const err = fault.sevenDeuceError;
          fault.sevenDeuceError = null;
          throw err;
        }
        if (fault.sevenDeuceFailOnce) {
          fault.sevenDeuceFailOnce = false;
          throw new Error('injected seven-deuce failure');
        }
      },
      sevenDeuceInternal: () => {
        fault.sevenDeuceInternal?.();
      },
    },
  };
}

/**
 * Boot an in-memory Fastify app with the game hub attached on an ephemeral
 * port, exactly like the original `beforeEach` did. Returns the live `ctx`,
 * `baseUrl` and `hub` so restart/shutdown suites can drive room internals.
 */
export async function bootIntegrationServer(
  clock: GameClock,
  fault: FaultBag,
): Promise<{ ctx: IntegrationCtx; baseUrl: string; hub: IntegrationHub }> {
  const ctx = createApp(':memory:');
  const hub = attachHub(ctx.app, ctx.db, integrationHubOpts(clock, fault));
  await ctx.app.listen({ port: 0 });
  const addr = ctx.app.server.address() as AddressInfo;
  return { ctx, baseUrl: `http://127.0.0.1:${addr.port}`, hub };
}
