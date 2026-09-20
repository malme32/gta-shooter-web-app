/**
 * Best-run persistence.
 *
 * The game remembers the best score and the biggest cash pile across reloads in
 * `localStorage`. `localStorage` is a browser API, which is why this module
 * lives in `src/ui/` rather than the pure core; every function still takes an
 * injectable storage object so it can be unit tested under Node with an
 * in-memory stand-in.
 *
 * Robustness is the whole point: a missing `localStorage` (Node, private mode,
 * disabled storage) falls back to an in-memory store, and malformed or
 * unavailable values degrade to an empty record instead of throwing.
 *
 * @module ui/storage
 */

/** `localStorage` key holding the best record. */
export const BEST_RECORD_KEY = 'gta-shooter:best';

/**
 * @typedef {object} BestRecord
 * @property {number} score Best run score.
 * @property {number} cash Best run cash.
 */

/**
 * Is this object usable as a Web Storage instance?
 *
 * @param {object} [store]
 * @returns {boolean}
 */
function isStorageLike(store) {
  return Boolean(store) && typeof store.getItem === 'function' && typeof store.setItem === 'function';
}

/**
 * Create a tiny in-memory Web Storage stand-in. Used when `localStorage` is
 * absent or throws, so the game keeps working without persistence.
 *
 * @returns {{ getItem: (key: string) => string|null, setItem: (key: string, value: string) => void,
 *   removeItem: (key: string) => void, clear: () => void }}
 */
export function createMemoryStorage() {
  const values = new Map();
  return {
    getItem(key) {
      return values.has(String(key)) ? values.get(String(key)) : null;
    },
    setItem(key, value) {
      values.set(String(key), String(value));
    },
    removeItem(key) {
      values.delete(String(key));
    },
    clear() {
      values.clear();
    },
  };
}

/** Shared fallback so writes survive for the session when storage is missing. */
const memoryFallback = createMemoryStorage();

/**
 * Pick a usable storage: the explicit one, else `localStorage`, else the shared
 * in-memory fallback.
 *
 * @param {object} [storage] Explicit storage (tests inject one).
 * @returns {object}
 */
export function resolveStorage(storage) {
  if (isStorageLike(storage)) return storage;
  try {
    const local = globalThis.localStorage;
    if (isStorageLike(local)) return local;
  } catch {
    // Accessing localStorage can throw (e.g. disabled cookies); fall through.
  }
  return memoryFallback;
}

/**
 * A zeroed-out record.
 *
 * @returns {BestRecord}
 */
export function emptyRecord() {
  return { score: 0, cash: 0 };
}

/**
 * Coerce arbitrary input into a valid, non-negative integer record.
 *
 * @param {object} [value]
 * @returns {BestRecord}
 */
export function normaliseRecord(value) {
  const score = Number.isFinite(value?.score) ? Math.max(0, Math.trunc(value.score)) : 0;
  const cash = Number.isFinite(value?.cash) ? Math.max(0, Math.trunc(value.cash)) : 0;
  return { score, cash };
}

/**
 * Read the stored best record. Missing or corrupt data yields an empty record.
 *
 * @param {object} [storage] Explicit storage; defaults to the resolved one.
 * @returns {BestRecord}
 */
export function readBest(storage) {
  const store = resolveStorage(storage);
  try {
    const raw = store.getItem(BEST_RECORD_KEY);
    if (!raw) return emptyRecord();
    return normaliseRecord(JSON.parse(raw));
  } catch {
    return emptyRecord();
  }
}

/**
 * Write a best record. Returns `false` (without throwing) when storage refuses
 * the write, so callers can ignore persistence failures.
 *
 * @param {object} [storage]
 * @param {BestRecord} record
 * @returns {boolean}
 */
export function writeBest(storage, record) {
  const store = resolveStorage(storage);
  try {
    store.setItem(BEST_RECORD_KEY, JSON.stringify(normaliseRecord(record)));
    return true;
  } catch {
    return false;
  }
}

/**
 * Merge a finished run into the stored best, writing only when a value
 * improves. Score and cash are tracked independently.
 *
 * @param {object} [storage]
 * @param {BestRecord} run The finished run's `{ score, cash }`.
 * @returns {{ best: BestRecord, improved: boolean }}
 */
export function recordBest(storage, run) {
  const best = readBest(storage);
  const next = normaliseRecord(run);
  const merged = {
    score: Math.max(best.score, next.score),
    cash: Math.max(best.cash, next.cash),
  };
  const improved = merged.score > best.score || merged.cash > best.cash;
  if (improved) writeBest(storage, merged);
  return { best: merged, improved };
}
