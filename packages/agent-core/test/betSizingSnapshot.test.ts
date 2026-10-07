import { describe, expect, it } from 'vitest';
import { PostflopPolicy, heroInPosition } from '../src/postflopPolicy.js';
import { RULE_PRESETS } from '../src/ruleStyles.js';
import {
  SNAPSHOT_CONFIG,
  STREETS,
  buildBetSizingCorpus,
  type CorpusEntry,
} from './tools/betSizingSnapshot.js';

/** hole intersects board = an impossible deal (malformed input). */
const hasOverlap = (e: CorpusEntry): boolean =>
  e.view.hand!.myCards.some((card) => e.view.hand!.board.includes(card));

describe('bet-sizing snapshot generator corpus', () => {
  const corpus = buildBetSizingCorpus();

  it('keeps malformed hole/board collisions strictly out of the legal set', () => {
    expect(corpus.legal.length).toBeGreaterThan(0);
    expect(corpus.malformed.length).toBeGreaterThan(0);
    for (const entry of corpus.legal) expect(hasOverlap(entry)).toBe(false);
    for (const entry of corpus.malformed) expect(hasOverlap(entry)).toBe(true);
  });

  it('covers both heads-up hero seats on every street', () => {
    for (const street of STREETS) {
      for (const heroSeat of [0, 1]) {
        expect(
          corpus.legal.some(
            (e) => e.street === street && e.view.hand!.mySeat === heroSeat,
          ),
        ).toBe(true);
      }
    }
  });

  it('ships turn/river overbet probes that really reach the street-top size', () => {
    const probes = corpus.legal.filter((e) => e.tag === 'overbet-probe');
    expect(probes.map((p) => p.street).sort()).toEqual(['river', 'turn']);
    const policy = new PostflopPolicy({
      params: RULE_PRESETS[SNAPSHOT_CONFIG.preset],
      seed: SNAPSHOT_CONFIG.seed,
    });
    for (const probe of probes) {
      const pot = probe.view.potOdds!.pot;
      expect(probe.view.hand!.street).toBe(probe.street);
      expect(heroInPosition(probe.view)).toBe(true);
      expect(policy.decide(probe.view).action).toEqual({
        type: 'bet',
        amount: Math.round(pot * 1.5),
      });
    }
  });
});
