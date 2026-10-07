import { describe, expect, it } from 'vitest';
import {
  RANDOM_BOT_PRESETS,
  pickBotPolicyKind,
  resolveCreatePolicyKind,
} from '../src/botPresetPick.js';
import type { PolicyKind } from '@4am/agent-core';

const TI: PolicyKind = 'tight-aggressive';
const LA: PolicyKind = 'loose-aggressive';
const CS: PolicyKind = 'calling-station';
const CR: PolicyKind = 'constrained-random';

/** A scripted rng that yields the given rolls in order, then 0. */
function seq(...rolls: number[]): () => number {
  let i = 0;
  return () => rolls[i++] ?? 0;
}

describe('RANDOM_BOT_PRESETS', () => {
  it('is exactly the four local rules-v1 presets, no llm', () => {
    expect([...RANDOM_BOT_PRESETS]).toEqual([TI, LA, CS, CR]);
    expect(RANDOM_BOT_PRESETS).not.toContain('llm');
  });
});

describe('pickBotPolicyKind', () => {
  it('uniformly covers every candidate on an empty room', () => {
    // With no existing bots the pool is all four presets in order; a roll in
    // each quartile selects the matching one.
    expect(pickBotPolicyKind(() => 0, [])).toBe(TI);
    expect(pickBotPolicyKind(() => 0.25, [])).toBe(LA);
    expect(pickBotPolicyKind(() => 0.5, [])).toBe(CS);
    expect(pickBotPolicyKind(() => 0.999999, [])).toBe(CR);
  });

  it('is deterministic for a given rng + room state', () => {
    expect(pickBotPolicyKind(seq(0.7, 0.7), [TI])).toBe(pickBotPolicyKind(seq(0.7, 0.7), [TI]));
  });

  it('is balanced: picks only the least-represented presets', () => {
    // Three distinct kinds already present -> only the missing one is a candidate.
    expect(pickBotPolicyKind(() => 0, [TI, LA, CS])).toBe(CR);
    expect(pickBotPolicyKind(() => 0.99, [TI, LA, CS])).toBe(CR);
    // Two loose-aggressive -> the other three share the minimum (0).
    const pool = [TI, CS, CR];
    expect(pool).toContain(pickBotPolicyKind(() => 0, [LA, LA]));
    expect(pool).toContain(pickBotPolicyKind(() => 0.34, [LA, LA]));
    expect(pool).toContain(pickBotPolicyKind(() => 0.99, [LA, LA]));
    // The over-represented preset is never selected while a deficit exists.
    expect(pickBotPolicyKind(() => 0, [LA, LA])).not.toBe(LA);
    expect(pickBotPolicyKind(() => 0.5, [LA, LA])).not.toBe(LA);
  });

  it('counts aliases towards their canonical preset', () => {
    // `scripted`/`lag`/`station`/`random` normalise to the four canonical kinds,
    // so every preset is at 1 and the pool is all four.
    const existing = ['scripted', 'lag', 'station', 'random'];
    expect(pickBotPolicyKind(() => 0, existing)).toBe(TI);
    expect(pickBotPolicyKind(() => 0.25, existing)).toBe(LA);
    expect(pickBotPolicyKind(() => 0.5, existing)).toBe(CS);
    expect(pickBotPolicyKind(() => 0.75, existing)).toBe(CR);
  });

  it('ignores llm and unknown kinds for balance', () => {
    // Neither can be chosen, so they must not unbalance the pool: an empty
    // effective room still offers all four uniformly.
    expect(pickBotPolicyKind(() => 0, ['llm', 'mystery-style'])).toBe(TI);
    expect(pickBotPolicyKind(() => 0.75, ['llm', 'mystery-style'])).toBe(CR);
  });

  it('clamps a malformed/out-of-range rng instead of going out of bounds', () => {
    expect(pickBotPolicyKind(() => Number.NaN, [])).toBe(TI);
    expect(pickBotPolicyKind(() => -1, [])).toBe(TI);
    expect(pickBotPolicyKind(() => 1, [])).toBe(CR);
    // A non-finite roll falls back to the first candidate rather than crashing.
    expect(pickBotPolicyKind(() => Number.POSITIVE_INFINITY, [])).toBe(TI);
    expect(pickBotPolicyKind(() => Number.NEGATIVE_INFINITY, [])).toBe(TI);
  });

  it('destructively: five sequential creates are a guaranteed mix, never all-equal', () => {
    // Simulate the real create path — each pick is fed back as room state.
    // A flat draw could produce five identical kinds; the balanced draw cannot.
    const rng = seq(0.1, 0.9, 0.2, 0.8, 0.5);
    const room: string[] = [];
    for (let i = 0; i < 5; i++) room.push(pickBotPolicyKind(rng, room));

    // First four are a permutation of all four presets.
    expect(new Set(room.slice(0, 4)).size).toBe(4);
    expect([...room.slice(0, 4)].sort()).toEqual([...RANDOM_BOT_PRESETS].sort());
    // The fifth is a valid preset that duplicates one already present.
    expect(RANDOM_BOT_PRESETS).toContain(room[4]!);
    expect(room.slice(0, 4)).toContain(room[4]!);
    // And it is emphatically not the "everything the same" failure mode.
    expect(new Set(room).size).toBeGreaterThan(1);
  });
});

describe('resolveCreatePolicyKind', () => {
  it('honours an explicit local preset, canonicalising aliases', () => {
    // The rng is rigged to the far end of the pool so an accidental draw would
    // pick something else; the explicit value must win anyway.
    expect(resolveCreatePolicyKind('scripted', () => 0.99, [])).toBe(TI);
    expect(resolveCreatePolicyKind('lag', () => 0.99, [])).toBe(LA);
    expect(resolveCreatePolicyKind('calling-station', () => 0.99, [])).toBe(CS);
    expect(resolveCreatePolicyKind('constrained-random', () => 0.99, [])).toBe(CR);
  });

  it('honours llm verbatim regardless of room state', () => {
    expect(resolveCreatePolicyKind('llm', () => 0.99, [TI])).toBe('llm');
    expect(resolveCreatePolicyKind('LLM', () => 0.99, [])).toBe('llm');
    expect(resolveCreatePolicyKind(' llm ', () => 0.99, [])).toBe('llm');
  });

  it('falls back to the balanced draw when unset/empty/unknown', () => {
    // Omission, null, blank and unknown strings are all "auto". A literal `auto`
    // sentinel is accepted too and falls through the same way.
    expect(resolveCreatePolicyKind(undefined, () => 0, [])).toBe(TI);
    expect(resolveCreatePolicyKind(null, () => 0, [])).toBe(TI);
    expect(resolveCreatePolicyKind('', () => 0, [])).toBe(TI);
    expect(resolveCreatePolicyKind('   ', () => 0, [])).toBe(TI);
    expect(resolveCreatePolicyKind('auto', () => 0, [])).toBe(TI);
    expect(resolveCreatePolicyKind('mystery-style', () => 0.75, [])).toBe(CR);
  });

  it('destructively: explicit picks repeat, auto spreads in the same room', () => {
    // Explicit scripted cannot be overridden: two in a row both persist
    // tight-aggressive even though the room would normally forbid a repeat.
    const room: string[] = [];
    room.push(resolveCreatePolicyKind('scripted', () => 0.9, room));
    room.push(resolveCreatePolicyKind('scripted', () => 0.9, room));
    expect(room).toEqual([TI, TI]);
    // Auto then fills the deficits and never repeats tight-aggressive while it is
    // over-represented.
    room.push(resolveCreatePolicyKind(undefined, () => 0, room));
    room.push(resolveCreatePolicyKind(undefined, () => 0, room));
    expect(room.filter((k) => k === TI)).toHaveLength(2);
    expect(new Set(room.slice(0, 4)).size).toBe(3);
  });
});
