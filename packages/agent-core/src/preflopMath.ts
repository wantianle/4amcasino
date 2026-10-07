/**
 * Shared numeric helper for the preflop range-construction and frequency layers.
 * Kept as a neutral module so neither imports the other; the single `clamp01`
 * definition lives in `postflopMath.ts` (beside the `clamp` it is derived from)
 * and is re-exported here so the preflop import path stays stable.
 */
export { clamp01 } from './postflopMath.js';
