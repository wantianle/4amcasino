import type { DecisionView } from './decisionView.js';

/**
 * Rules-v1's single deterministic seed derivation, shared by the preflop and
 * postflop engines:
 *
 *   hash(baseSeed, 'rules-v1', handId, actionSeq, mySeat, street, myCards)
 *
 * Same view + same base seed ⇒ same roll; advancing `actionSeq` changes it, so
 * mixed frequencies actually mix across actions of one hand. `myCards` is
 * sorted for order-independence. No `Math.random` anywhere.
 */
export function deriveRulesSeed(baseSeed: number, view: DecisionView): number {
  const cards = [...(view.hand?.myCards ?? [])].sort((a, b) => a - b);
  const parts = [
    'rules-v1',
    view.hand?.handId ?? '',
    String(view.actionSeq ?? -1),
    String(view.hand?.mySeat ?? view.me?.seat ?? -1),
    view.hand?.street ?? '',
    cards.join(','),
  ].join('|');
  let h = baseSeed >>> 0;
  for (let i = 0; i < parts.length; i++) {
    h = Math.imul(h ^ parts.charCodeAt(i), 0x01000193) >>> 0;
  }
  return h >>> 0;
}
