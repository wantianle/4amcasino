/** Typings for `deterministicShuffle.mjs`, which is consumed both by `.mjs`
 *  harnesses (via node) and by the TypeScript test suite (via vitest).
 *  `tsc` needs the `.d.mts` companion for a NodeNext `.mjs` import. */
export interface DeterministicShuffleHandle {
  proto: { handle: (msg: unknown) => void };
  original: (msg: unknown) => void;
  seed: number;
  salt: string;
}

export function hashSeed(seed: number, text: string): number;
export function deterministicPerm(seed: number, label?: string): number[];
export function installDeterministicShuffle(
  seed: number | string,
  options?: { salt?: string },
): DeterministicShuffleHandle;
export function uninstallDeterministicShuffle(): void;
export function isDeterministicShuffleInstalled(): boolean;
