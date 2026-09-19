/**
 * Deterministic pseudo-random number generator.
 *
 * Uses the mulberry32 algorithm: tiny, dependency-free and fast enough for a
 * game loop. Seeding a game with a fixed value makes runs reproducible, which
 * is what the tests rely on.
 *
 * @module core/rng
 */

/**
 * Create a seeded random function.
 *
 * @param {number} [seed=1] Any finite number; truncated to a 32-bit integer.
 * @returns {() => number} Function returning a float in `[0, 1)`.
 */
export function createRng(seed = 1) {
  let state = (Number.isFinite(seed) ? Math.trunc(seed) : 1) >>> 0;
  return function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Pick an integer in `[min, max]` (inclusive) from a `[0, 1)` random function.
 *
 * @param {() => number} rng
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
export function randomInt(rng, min, max) {
  return min + Math.floor(rng() * (max - min + 1));
}

/**
 * Pick a random element from a non-empty array.
 *
 * @template T
 * @param {() => number} rng
 * @param {ReadonlyArray<T>} items
 * @returns {T}
 */
export function randomPick(rng, items) {
  if (!items || items.length === 0) {
    throw new Error('randomPick requires a non-empty array');
  }
  return items[Math.floor(rng() * items.length)];
}
