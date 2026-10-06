import { expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { runBenchmark, baselineAgents } from '../src/benchmark.js';
import { assertContinuousHistory, webhookHeaders } from '../src/webhook-relay.js';
it('requires an explicit resync when retained webhook history is lost', () => {
  expect(() => assertContinuousHistory(12, { oldestCursor: 50, resyncRecommended: true })).toThrow(
    /resynchroniz/i,
  );
  expect(() =>
    assertContinuousHistory(0, { oldestCursor: 50, resyncRecommended: false }),
  ).not.toThrow();
  expect(() =>
    assertContinuousHistory(50, { oldestCursor: 50, resyncRecommended: false }),
  ).not.toThrow();
});
it('reproduces benchmark results and preserves chips across 100 hands', async () => {
  const a = await runBenchmark(baselineAgents, 100, 'test-reproducibility');
  const b = await runBenchmark(baselineAgents, 100, 'test-reproducibility');
  expect(a).toEqual(b);
  expect(a.history).toHaveLength(100);
  expect(a.history.every((h) => h.net.reduce((sum, n) => sum + n, 0) === 0)).toBe(true);
});
it('signs the exact webhook body, event ID and timestamp', () => {
  const key = Buffer.alloc(32, 7);
  const body = '{"event":"hand"}';
  const headers = webhookHeaders('id-1', 123, body, `whsec_${key.toString('base64')}`);
  expect(headers['webhook-signature']).toBe(
    `v1,${createHmac('sha256', key).update(`id-1.123.${body}`).digest('base64')}`,
  );
  expect(webhookHeaders('id-2', 123, body, key.toString('base64'))['webhook-signature']).not.toBe(
    headers['webhook-signature'],
  );
});
