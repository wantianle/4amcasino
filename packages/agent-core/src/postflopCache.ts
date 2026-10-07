/**
 * Board-keyed LRU cache helpers shared by the postflop feature layer (flush
 * distribution) and the policy orchestrator (combo distributions, villain
 * tiers). Moved verbatim out of `postflopPolicy.ts` so the feature modules and
 * the decision module can share one bounded cache implementation without a
 * circular import.
 */

/** Bound for the board-keyed caches (dist + villain tiers). */
const BOARD_CACHE_LIMIT = 256;

/** LRU read: return and refresh recency on a hit. */
export function lruGet<K, V>(cache: Map<K, V>, key: K): V | undefined {
  if (!cache.has(key)) return undefined;
  const value = cache.get(key) as V;
  cache.delete(key); // re-insert at the MRU end
  cache.set(key, value);
  return value;
}

/** LRU write: insert as MRU and evict the single oldest entry on overflow. */
export function lruSet<K, V>(cache: Map<K, V>, key: K, value: V): void {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > BOARD_CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}
