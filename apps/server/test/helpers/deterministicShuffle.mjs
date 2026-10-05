/**
 * Deterministic-shuffle test seam (harness-only, no product code change).
 *
 * WHY THIS LIVES HERE (and not in the server):
 *   The server never shuffles. It only *coordinates* a mental-poker shuffle:
 *   `Hand.requestShuffle()` forwards `shuffle_turn` to one seat at a time and
 *   `Hand.onShuffle()` accepts that seat's `shuffle_deck` message. The actual
 *   permutation is chosen client-side, in
 *   `@4am/agent-core`'s `HeadlessClient.handle()`:
 *
 *       const deck = maskAndShuffle(
 *         msg.deck.map(pointFromHex),
 *         this.keyFor(msg.handId),
 *         randomPerm(52),          // <-- crypto-random, per client
 *       ).map(pointHex);
 *
 *   `randomPerm()` uses `randomBytes()` (OS CSPRNG), so every run deals a
 *   different deck. There is no server-side shuffle to seed, and the harness
 *   may not edit `packages/agent-core` (another lane owns it). The only
 *   injection point the harness fully controls is the *client instance*, so we
 *   patch `HeadlessClient.prototype.handle` for the `shuffle_turn` branch only
 *   and keep the exact same math (`maskAndShuffle`) with a seeded Fisher-Yates
 *   permutation. Every other frame falls through to the untouched original
 *   handler, so nothing but the permutation changes.
 *
 *   The permutation position sequence - not the masked point values - is what
 *   determines the dealt cards, so seeding the permutation is sufficient to
 *   make the whole deal reproducible across processes.
 *
 * CROSS-PROCESS REPRODUCIBILITY & DUPLICATE MATCHES:
 *   Every client derives its permutation from `(seed, handId)`. The server mints
 *   a reproducible handId in test mode (`BOT_TEST_SHUFFLE_SEED`), and it is the
 *   same for all seats of a hand. Consequently:
 *     - two runs with the same seed deal the same hand ids, and
 *     - when the same cards are replayed with the two strategies swapped
 *       (duplicate), every seat still receives exactly the cards it received in
 *       the first run - the per-hand strategy delta is luck-free.
 *   Different seed => different hand ids => different decks.
 *
 * DEFAULT OFF: `installDeterministicShuffle` is only called when
 * `BOT_TEST_SHUFFLE_SEED` is set, so the production/default path is byte-for-byte
 * the original `handle`.
 *
 * ISOLATION WARNING: `BOT_TEST_SHUFFLE_SEED` is ONLY safe with a throwaway /
 * temp database. The server mints test hand ids from `(seed, per-room ordinal)`
 * (see `testHandId` in `game.ts`), and `transcripts.hand_id` is a PRIMARY KEY.
 * Reusing the same seed across rooms or across a restart onto a non-empty DB
 * therefore regenerates the same ids and collides on insert. The eval/playtest
 * harnesses always boot a fresh `tmpdir()` DB, which is why they are safe.
 */
import { HeadlessClient, mulberry32 } from '@4am/agent-core';
import { maskAndShuffle, pointFromHex, pointHex } from '@4am/mental-poker';

const DECK_SIZE = 52;

/** FNV-1a over a string, mixed with a 32-bit seed. Stable across processes. */
export function hashSeed(seed, text) {
  let h = seed >>> 0;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0;
  return h >>> 0;
}

/**
 * A seeded deterministic Fisher-Yates permutation of [0..51].
 *
 * Note: this is plain Fisher-Yates with `Math.floor(rand() * (i + 1))`, not a
 * rejection-sampled uniformly-unbiased shuffle; the tiny modulo bias of a
 * 32-bit PRNG is irrelevant for a reproducible test deal.
 *
 * `label` scopes the PRNG (normally the hand id), while staying a pure function
 * of `(seed, label)` for reproducibility.
 */
export function deterministicPerm(seed, label = '') {
  const rand = mulberry32(hashSeed(seed, label));
  const p = Array.from({ length: DECK_SIZE }, (_, i) => i);
  for (let i = DECK_SIZE - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = p[i];
    p[i] = p[j];
    p[j] = tmp;
  }
  return p;
}

let installed = null;

/**
 * Patch every `HeadlessClient` (the human host and every bot runner client) so
 * that `shuffle_turn` uses `deterministicPerm(seed, handId)` instead of
 * `randomPerm(52)`. Idempotent; returns the original method for tests.
 *
 * The patch is a process-global singleton, so it cannot represent two different
 * seeds at once. Calling again with the same seed (and `salt`) is a no-op;
 * a different one throws instead of silently reusing the first seed.
 *
 * `salt` is an optional harness-only label prefix used to prove the card-level
 * replay assertion is real: two runs with the same hand ids but different salts
 * deal different cards.
 */
export function installDeterministicShuffle(seed, { salt = '' } = {}) {
  const normalized = Number(seed) >>> 0;
  const normalizedSalt = String(salt ?? '');
  if (installed) {
    if (installed.seed !== normalized || installed.salt !== normalizedSalt)
      throw new Error(
        `deterministic shuffle already installed for seed=${installed.seed}` +
          `${installed.salt ? ` salt=${installed.salt}` : ''}; ` +
          `refusing to reuse it for seed=${normalized}${normalizedSalt ? ` salt=${normalizedSalt}` : ''}`,
      );
    return installed;
  }
  const proto = HeadlessClient.prototype;
  const original = proto.handle;
  proto.handle = function deterministicHandle(msg) {
    if (!msg || msg.t !== 'shuffle_turn') return original.call(this, msg);
    // Mirrors the original `shuffle_turn` branch exactly, except the perm.
    if (!this.isCurrentHandFrame(msg.handId)) return;
    this.markHandContextSynced(msg.handId);
    if (!this.identity || this.handId !== msg.handId || this.mySeat() !== msg.seat) return;
    // Keyed by handId only (not seat): all seats of one hand share a perm, so a
    // duplicate run with swapped seats replays the exact same cards per seat.
    const label = normalizedSalt ? `${normalizedSalt}:${msg.handId}` : msg.handId;
    const perm = deterministicPerm(normalized, label);
    const deck = maskAndShuffle(
      msg.deck.map(pointFromHex),
      this.keyFor(msg.handId),
      perm,
    ).map(pointHex);
    this.send({
      t: 'shuffle_deck',
      handId: msg.handId,
      deck,
      sig: this.signed(msg.handId, 'shuffle_deck', { deck }),
    });
  };
  installed = { proto, original, seed: normalized, salt: normalizedSalt };
  return installed;
}

/** Restore the original `handle`. Safe to call when not installed. */
export function uninstallDeterministicShuffle() {
  if (!installed) return;
  installed.proto.handle = installed.original;
  installed = null;
}

/** True when the deterministic seam is currently patched in. */
export function isDeterministicShuffleInstalled() {
  return installed !== null;
}
