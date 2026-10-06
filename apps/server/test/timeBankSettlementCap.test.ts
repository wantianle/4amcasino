import { afterEach, expect, it } from 'vitest';
import { MAX_TIME_BANK_MS } from '@4am/shared';
import { createApp } from '../src/app.js';
import {
  PreparedInputError,
  applyHandSettlement,
  applyPreparedHandSettlement,
  persistPreparedInput,
} from '../src/settlementWriter.js';
import { SEED_TIME_BANK_EPOCH, makeWrite, seed } from './helpers/settlementFixture.js';

/**
 * Blocker A regression: the settlement write layer had no final cap on
 * `time_bank_ms`. The read path clamps, but a frozen/legacy/tampered input could
 * still write a row above the 5 x 30s invariant. These tests pin BOTH halves of
 * the fix:
 *   - the writer clamps on the SQL write (direct in-process path), and
 *   - `validateWriteShape` rejects an out-of-range frozen input (recovery path,
 *     fail closed -> quarantine), leaving the stored row untouched.
 */

const apps: ReturnType<typeof createApp>[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.app.close();
});
function freshApp(): ReturnType<typeof createApp> {
  const app = createApp(':memory:');
  apps.push(app);
  return app;
}

const msOf = (db: ReturnType<typeof createApp>['db'], userId: number): number =>
  (
    db
      .prepare('SELECT time_bank_ms AS ms FROM room_players WHERE room_id = ? AND user_id = ?')
      .get('r1', userId) as { ms: number }
  ).ms;

it('the writer clamps an over-cap time-bank balance to MAX_TIME_BANK_MS', () => {
  const { db } = freshApp();
  seed(db);
  const overCap = MAX_TIME_BANK_MS + 9_000;
  const w = makeWrite({
    timeBankEpoch: SEED_TIME_BANK_EPOCH,
    timeBanks: [{ userId: 1, ms: overCap, hands: 3 }],
  });
  // Direct writer path (bypasses `validateWriteShape`): the SQL itself must cap.
  applyHandSettlement(db, w);
  expect(msOf(db, 1)).toBe(MAX_TIME_BANK_MS);
  expect(msOf(db, 1)).toBeLessThanOrEqual(MAX_TIME_BANK_MS);
});

it('the writer clamps a negative time-bank balance to 0', () => {
  const { db } = freshApp();
  seed(db);
  const w = makeWrite({
    timeBankEpoch: SEED_TIME_BANK_EPOCH,
    timeBanks: [{ userId: 1, ms: -50_000, hands: 0 }],
  });
  applyHandSettlement(db, w);
  expect(msOf(db, 1)).toBe(0);
});

it('an out-of-range frozen input is rejected (quarantined), never written', () => {
  const { db } = freshApp();
  seed(db);
  const before = msOf(db, 1);
  const w = makeWrite({
    timeBankEpoch: SEED_TIME_BANK_EPOCH,
    timeBanks: [{ userId: 1, ms: MAX_TIME_BANK_MS + 1, hands: 0 }],
  });
  // The hash is computed over these exact bytes; only the shape check rejects.
  persistPreparedInput(db, w);
  let thrown: unknown;
  try {
    applyPreparedHandSettlement(db, 'h1');
  } catch (e) {
    thrown = e;
  }
  expect(thrown).toBeInstanceOf(PreparedInputError);
  expect((thrown as Error).message).toMatch(/time-bank balance/);
  expect(
    (
      db.prepare('SELECT status FROM hand_lifecycle WHERE hand_id = ?').get('h1') as {
        status: string;
      }
    ).status,
  ).toBe('quarantined');
  // Fail closed: the stored row is exactly what it was before the rejection.
  expect(msOf(db, 1)).toBe(before);
});
