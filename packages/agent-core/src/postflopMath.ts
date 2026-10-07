/**
 * Small numeric helpers shared by the postflop feature layer and the policy
 * orchestrator. Kept in a neutral module (mirrors `preflopMath.ts`) so a feature
 * module and the decision module can both use them without importing each
 * other. Moved verbatim out of `postflopPolicy.ts`.
 */
export const clamp = (x: number, lo: number, hi: number): number =>
  Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : lo;
export const clamp01 = (x: number): number => clamp(x, 0, 1);
