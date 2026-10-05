import { describe, expect, it } from 'vitest';
import {
  humanLlmTookEffect,
  joinActionAttribution,
  type AcceptedAction,
  type HumanLlmMetrics,
  type RoutedSend,
} from './helpers/actionAttribution.js';

/**
 * The attribution join is keyed on the server-authoritative (handId, actionSeq)
 * + seat. These tests pin its behaviour under the shapes a mid-hand reconnect /
 * missed frame produces (a gap in actionSeq) and under every failure mode the
 * playtest harness asserts to be zero.
 */

const send = (actionSeq: number, seat: number, source?: 'model' | 'fallback'): RoutedSend => ({
  handId: 'h1',
  actionSeq,
  seat,
  source,
});

const accepted = (actionSeq: number, seat: number): AcceptedAction => ({
  handId: 'h1',
  actionSeq,
  seat,
});

describe('joinActionAttribution', () => {
  it('joins model/fallback sends to accepted actions across a missed-frame seq gap', () => {
    // The client reconnected mid-hand and missed seq 2/3; its later sends carry
    // the server's authoritative seq (5,6), not a local ordinal (2,3).
    const sends = [send(0, 0, 'model'), send(1, 1, 'fallback'), send(5, 0, 'model')];
    const acc = [accepted(0, 0), accepted(1, 1), accepted(5, 0)];
    const j = joinActionAttribution(sends, acc);
    expect(j.modelAccepted).toBe(2);
    expect(j.fallbackAccepted).toBe(1);
    expect(j.otherAccepted).toBe(0);
    expect(j.acceptedWithoutRoute).toBe(0);
    expect(j.routeWithoutAccepted).toBe(0);
    expect(j.duplicateRoute).toBe(0);
    expect(j.seatMismatch).toBe(0);
    expect(j.modelAcceptedBySeat.get(0)).toBe(2);
  });

  it('counts an accepted action with no routed decision', () => {
    const j = joinActionAttribution([send(0, 0, 'model')], [accepted(0, 0), accepted(9, 1)]);
    expect(j.modelAccepted).toBe(1);
    expect(j.acceptedWithoutRoute).toBe(1);
    expect(j.samples.acceptedWithoutRoute).toEqual(['h1:9#seat1']);
    expect(j.routeWithoutAccepted).toBe(0);
  });

  it('counts a routed send the server never accepted', () => {
    const j = joinActionAttribution([send(0, 0, 'model'), send(3, 1, 'model')], [accepted(0, 0)]);
    expect(j.acceptedWithoutRoute).toBe(0);
    expect(j.routeWithoutAccepted).toBe(1);
    expect(j.samples.routeWithoutAccepted).toEqual(['h1:3#seat1']);
  });

  it('counts duplicate routed decisions for one (handId, actionSeq)', () => {
    // The first record is used for attribution; the extra one is an integrity
    // failure ("accepted and routed are one-to-one").
    const j = joinActionAttribution(
      [send(0, 0, 'model'), send(0, 0, 'fallback')],
      [accepted(0, 0)],
    );
    expect(j.duplicateRoute).toBe(1);
    expect(j.modelAccepted).toBe(1);
    expect(j.fallbackAccepted).toBe(0);
    expect(j.routeWithoutAccepted).toBe(0);
  });

  it('counts a seat mismatch and refuses to attribute it', () => {
    const j = joinActionAttribution([send(0, 1, 'model')], [accepted(0, 2)]);
    expect(j.seatMismatch).toBe(1);
    expect(j.modelAccepted).toBe(0);
    expect(j.acceptedWithoutRoute).toBe(0);
    expect(j.routeWithoutAccepted).toBe(0);
    expect(j.samples.seatMismatch).toEqual(['h1:0: route seat 1 vs transcript seat 2']);
  });

  it('passes through the accepted-without-actionSeq count', () => {
    const j = joinActionAttribution([send(0, 0, 'model')], [accepted(0, 0)], 2);
    expect(j.acceptedMissingActionSeq).toBe(2);
    expect(j.modelAccepted).toBe(1);
  });
});

/**
 * The consumer side of the attribution map: the playtest's human-LLM gate. The
 * producer (`joinActionAttribution`) was already covered above; these pin the
 * historical bug where the gate looked the map up with a string label
 * (`human:<style>#0`) instead of the numeric seat, so a real
 * `HUMAN_STYLE=llm, LLM_EXPECT=model` run was always misjudged as failed.
 */
describe('humanLlmTookEffect', () => {
  const metrics = (over: Partial<HumanLlmMetrics> = {}): HumanLlmMetrics => ({
    calls: 1,
    decisions: 1,
    harnessFallbacks: 0,
    ...over,
  });

  it('passes a model run when numeric seat 0 has an accepted model action', () => {
    const r = humanLlmTookEffect(new Map([[0, 3]]), 0, metrics(), true);
    expect(r.accepted).toBe(3);
    expect(r.ok).toBe(true);
  });

  it('fails a model run when seat 0 only has fallback/shadow actions', () => {
    // Shadow routes every decision to the fallback, so seat 0 never appears.
    const shadow = humanLlmTookEffect(new Map(), 0, metrics(), true);
    expect(shadow.accepted).toBe(0);
    expect(shadow.ok).toBe(false);

    // A fallback-sourced run must not satisfy the model gate either.
    expect(humanLlmTookEffect(new Map([[0, 0]]), 0, metrics(), true).ok).toBe(false);
  });

  it('does not require an accepted model action when not expecting the model', () => {
    expect(humanLlmTookEffect(new Map(), 0, metrics(), false).ok).toBe(true);
  });

  it('rejects non-model evidence (no calls, no decisions, harness fallback)', () => {
    expect(humanLlmTookEffect(new Map([[0, 1]]), 0, metrics({ calls: 0 }), true).ok).toBe(false);
    expect(humanLlmTookEffect(new Map([[0, 1]]), 0, metrics({ decisions: 0 }), true).ok).toBe(false);
    expect(
      humanLlmTookEffect(new Map([[0, 1]]), 0, metrics({ harnessFallbacks: 1 }), true).ok,
    ).toBe(false);
    expect(humanLlmTookEffect(new Map(), 0, null, false).ok).toBe(false);
  });

  it('regression: a string label never matches the numeric-seat map', () => {
    const bySeat = new Map<number, number>([[0, 2]]);
    // The historical lookup used `human:${style}#0`; it must always miss.
    expect((bySeat as Map<unknown, number>).get('human:llm#0')).toBeUndefined();
    // The numeric lookup is what makes the gate pass.
    expect(humanLlmTookEffect(bySeat, 0, metrics(), true).ok).toBe(true);
  });
});
