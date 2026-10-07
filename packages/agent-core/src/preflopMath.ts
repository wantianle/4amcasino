/**
 * Small numeric helper shared by the preflop range-construction and frequency
 * layers. Kept in a neutral module so neither imports the other.
 */
export function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return Math.min(1, Math.max(0, x));
}
