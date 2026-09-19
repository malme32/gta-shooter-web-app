/**
 * Wanted system: crime points, the 0-5 star ladder, crime-free decay and the
 * police spawn director.
 *
 * This module is pure: it never touches the DOM, `window` or `document`, so it
 * runs unchanged under Node and in the browser. It owns the *rules* of the
 * wanted system; `core/game.js` stores the live numbers on the game state and
 * calls these helpers once per tick.
 *
 * ## Points and stars
 *
 * Wanted **points** accumulate as the player commits crimes (see
 * {@link WANTED_CRIMES}) and map onto a 0-5 star level through the shared
 * {@link WANTED_THRESHOLDS} table in `core/constants.js`:
 *
 * ```text
 * points:   0   10   40   90   160   260
 * stars:    0    1    2    3     4     5
 * ```
 *
 * {@link BUSTED_LEVEL} (5 stars) is the terminal "busted" state.
 *
 * ## Decay
 *
 * Points hold for {@link WANTED_DECAY_COOLDOWN_TICKS} ticks after the last
 * crime, then bleed away at `WANTED_HEAT_DECAY_PER_TICK` per tick. Any fresh
 * crime resets the cooldown. At level 0 the police director despawns every
 * responder.
 *
 * ## Police escalation
 *
 * {@link POLICE_COMPOSITION} lists the roster for each star level, weakest
 * first: higher levels mean **more** responders and **tougher** archetypes.
 * {@link policeSpawnStep} hands back the next variant to spawn (or `null`) and
 * the carried-over timer, and {@link policeDespawnCount} says how many must be
 * removed when the level falls. {@link policeSpawnPoint} picks a walkable spot
 * on a ring around the player using a caller-supplied rng.
 *
 * @module core/wanted
 */

import {
  TILE_SIZE,
  WANTED_THRESHOLDS,
  WANTED_MAX_HEAT,
  WANTED_MAX_STARS,
  WANTED_HEAT_DECAY_PER_TICK,
} from './constants.js';
import { clamp } from './geometry.js';
import { canStandAt } from './map.js';
import { ENEMY_TYPES } from './enemy.js';

export { WANTED_THRESHOLDS, WANTED_MAX_STARS };

/**
 * Points awarded per crime. Values are documented here and unit tested; a
 * single shooting or a joyride is a light offence, a murder is severe.
 *
 * @type {Readonly<Record<string, number>>}
 */
export const WANTED_CRIMES = Object.freeze({
  gunfire: 5,
  assault: 12,
  vehicle_theft: 15,
  hit_and_run: 20,
  vehicle_destroyed: 25,
  police_assault: 30,
  murder: 45,
});

/** The star level that triggers the terminal "busted" state. */
export const BUSTED_LEVEL = WANTED_MAX_STARS;

/** Ticks without a crime before points start to decay. */
export const WANTED_DECAY_COOLDOWN_TICKS = 300;

/** Ticks between police spawn attempts while below the level's roster. */
export const POLICE_SPAWN_INTERVAL_TICKS = 90;

/**
 * Police roster per wanted level, ordered weakest first. Index 0 is the clean
 * level, so `POLICE_COMPOSITION[level]` is exactly the squad that level
 * maintains.
 *
 * @type {Readonly<Record<number, ReadonlyArray<string>>>}
 */
export const POLICE_COMPOSITION = Object.freeze({
  0: Object.freeze([]),
  1: Object.freeze(['cop']),
  2: Object.freeze(['cop', 'cop']),
  3: Object.freeze(['cop', 'cop', 'swat']),
  4: Object.freeze(['cop', 'swat', 'swat', 'swat']),
  5: Object.freeze(['cop', 'swat', 'swat', 'riot', 'riot']),
});

/** Minimum distance (pixels) at which police may spawn from the player. */
export const POLICE_SPAWN_MIN_DISTANCE = TILE_SIZE * 8;

/** Maximum distance (pixels) at which police may spawn from the player. */
export const POLICE_SPAWN_MAX_DISTANCE = TILE_SIZE * 14;

/** How many candidate spawn points to try before giving up. */
export const POLICE_SPAWN_ATTEMPTS = 12;

/**
 * Clamp a raw point total into the valid `[0, WANTED_MAX_HEAT]` range.
 *
 * @param {number} points
 * @returns {number}
 */
export function clampWantedPoints(points) {
  return clamp(Number.isFinite(points) ? points : 0, 0, WANTED_MAX_HEAT);
}

/**
 * Number of wanted stars (0-5) for a point total. Index 0 of
 * {@link WANTED_THRESHOLDS} is the clean level, so the returned value is the
 * highest `n` whose threshold has been reached.
 *
 * @param {number} points
 * @returns {number}
 */
export function wantedLevelFor(points) {
  const value = clampWantedPoints(points);
  let level = 0;
  for (let i = 1; i < WANTED_THRESHOLDS.length; i += 1) {
    if (value >= WANTED_THRESHOLDS[i]) level = i;
  }
  return level;
}

/**
 * Add points for a crime, clamped to the ceiling. Negative and non-finite
 * amounts are ignored.
 *
 * @param {number} points
 * @param {number} amount
 * @returns {number} The new point total.
 */
export function addWantedPoints(points, amount) {
  const delta = Number.isFinite(amount) ? Math.max(0, amount) : 0;
  return clampWantedPoints(points + delta);
}

/**
 * Add the points for a named crime from {@link WANTED_CRIMES}. Unknown crimes
 * add nothing.
 *
 * @param {number} points
 * @param {keyof typeof WANTED_CRIMES|string} crimeId
 * @returns {number} The new point total.
 */
export function registerCrime(points, crimeId) {
  return addWantedPoints(points, WANTED_CRIMES[crimeId] ?? 0);
}

/**
 * Advance one tick of crime-free decay.
 *
 * While `cooldownTicks > 0` the points are held and the cooldown counts down;
 * once it reaches zero the points fall by `rate` per tick. The returned object
 * always carries the (possibly decremented) cooldown so the caller can store it
 * back.
 *
 * @param {number} points
 * @param {number} cooldownTicks Ticks remaining before decay starts.
 * @param {object} [options]
 * @param {number} [options.rate=WANTED_HEAT_DECAY_PER_TICK]
 * @returns {{ points: number, cooldownTicks: number, decayed: boolean }}
 */
export function decayWantedPoints(points, cooldownTicks, { rate = WANTED_HEAT_DECAY_PER_TICK } = {}) {
  const current = clampWantedPoints(points);
  const decayRate = Number.isFinite(rate) && rate >= 0 ? rate : WANTED_HEAT_DECAY_PER_TICK;
  const cooldown = Number.isFinite(cooldownTicks) && cooldownTicks > 0 ? Math.floor(cooldownTicks) : 0;

  if (current <= 0) return { points: 0, cooldownTicks: 0, decayed: false };
  if (cooldown > 0) return { points: current, cooldownTicks: cooldown - 1, decayed: false };

  const next = Math.max(0, current - decayRate);
  return { points: next, cooldownTicks: 0, decayed: next < current };
}

/**
 * The police roster that a given wanted level maintains (weakest first).
 *
 * @param {number} level
 * @returns {ReadonlyArray<string>}
 */
export function policeRoster(level) {
  const clamped = clamp(Math.floor(Number.isFinite(level) ? level : 0), 0, WANTED_MAX_STARS);
  return POLICE_COMPOSITION[clamped] ?? POLICE_COMPOSITION[0];
}

/**
 * How many police a given wanted level wants alive.
 *
 * @param {number} level
 * @returns {number}
 */
export function policeTargetCount(level) {
  return policeRoster(level).length;
}

/**
 * Decide the next police spawn for this tick.
 *
 * One responder may be pending at a time: the timer counts down and, when it
 * reaches zero and the live force is below the level's roster, the next
 * (weakest missing) variant is returned with the timer reset. Otherwise the
 * variant is `null` and the timer keeps counting down.
 *
 * @param {object} [options]
 * @param {number} [options.level=0] Current wanted stars.
 * @param {number} [options.alivePolice=0] Live police responders.
 * @param {number} [options.spawnTimer=0] Ticks left on the current interval.
 * @param {number} [options.intervalTicks=POLICE_SPAWN_INTERVAL_TICKS]
 * @returns {{ variant: string|null, spawnTimer: number }}
 */
export function policeSpawnStep({
  level = 0,
  alivePolice = 0,
  spawnTimer = 0,
  intervalTicks = POLICE_SPAWN_INTERVAL_TICKS,
} = {}) {
  const roster = policeRoster(level);
  const alive = Number.isFinite(alivePolice) && alivePolice > 0 ? Math.floor(alivePolice) : 0;
  const interval = Number.isFinite(intervalTicks) && intervalTicks > 0 ? Math.floor(intervalTicks) : POLICE_SPAWN_INTERVAL_TICKS;

  if (alive >= roster.length) return { variant: null, spawnTimer: 0 };

  const timer = Number.isFinite(spawnTimer) && spawnTimer > 0 ? Math.floor(spawnTimer) : 0;
  if (timer > 0) return { variant: null, spawnTimer: timer - 1 };
  return { variant: roster[alive] ?? null, spawnTimer: interval };
}

/**
 * How many police must be removed to match a level's roster (0 at level 0,
 * which despawns every responder).
 *
 * @param {number} level
 * @param {number} alivePolice
 * @returns {number}
 */
export function policeDespawnCount(level, alivePolice) {
  const alive = Number.isFinite(alivePolice) && alivePolice > 0 ? Math.floor(alivePolice) : 0;
  return Math.max(0, alive - policeTargetCount(level));
}

/**
 * Pick a walkable police spawn point on a ring around a focus position.
 * Returns `null` when no candidate is walkable, so the caller can skip the
 * spawn instead of dropping a responder on top of the player.
 *
 * @param {object} map Map or normalised grid.
 * @param {number} x Focus world x, in pixels.
 * @param {number} y Focus world y, in pixels.
 * @param {object} [options]
 * @param {() => number} [options.rng=Math.random]
 * @param {number} [options.radius] Entity collision radius.
 * @param {number} [options.minDistance=POLICE_SPAWN_MIN_DISTANCE]
 * @param {number} [options.maxDistance=POLICE_SPAWN_MAX_DISTANCE]
 * @param {number} [options.attempts=POLICE_SPAWN_ATTEMPTS]
 * @returns {{ x: number, y: number }|null}
 */
export function policeSpawnPoint(map, x, y, {
  rng = Math.random,
  radius = ENEMY_TYPES.cop.radius,
  minDistance = POLICE_SPAWN_MIN_DISTANCE,
  maxDistance = POLICE_SPAWN_MAX_DISTANCE,
  attempts = POLICE_SPAWN_ATTEMPTS,
} = {}) {
  const random = typeof rng === 'function' ? rng : Math.random;
  const min = Number.isFinite(minDistance) ? Math.max(0, minDistance) : POLICE_SPAWN_MIN_DISTANCE;
  const max = Number.isFinite(maxDistance) && maxDistance > min ? maxDistance : Math.max(min, POLICE_SPAWN_MAX_DISTANCE);
  const tries = Number.isFinite(attempts) && attempts > 0 ? Math.floor(attempts) : POLICE_SPAWN_ATTEMPTS;
  const r = Number.isFinite(radius) && radius > 0 ? radius : ENEMY_TYPES.cop.radius;

  for (let attempt = 0; attempt < tries; attempt += 1) {
    const angle = random() * Math.PI * 2;
    const distance = min + random() * (max - min);
    const px = x + Math.cos(angle) * distance;
    const py = y + Math.sin(angle) * distance;
    if (!map || canStandAt(map, px, py, r)) return { x: px, y: py };
  }
  return null;
}

/**
 * Is the wanted level at the terminal "busted" threshold?
 *
 * @param {number} level
 * @returns {boolean}
 */
export function isBusted(level) {
  return (Number.isFinite(level) ? level : 0) >= BUSTED_LEVEL;
}

/**
 * Should the siren be sounding at this wanted level?
 *
 * @param {number} level
 * @returns {boolean}
 */
export function sirenActiveFor(level) {
  return (Number.isFinite(level) ? level : 0) >= 1;
}
