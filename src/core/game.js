/**
 * Core game state and fixed-timestep simulation.
 *
 * This module is pure: it never touches the DOM or any browser API. The
 * renderer lives in `src/ui/` and the `requestAnimationFrame` loop in
 * `src/main.js`; both only ever call `update()` through `advance()`.
 *
 * @module core/game
 */

import {
  TICK_SECONDS,
  MAX_STEPS_PER_FRAME,
  MAX_FRAME_SECONDS,
  TILE_SIZE,
  PLAYER_RADIUS,
  PLAYER_BASE_SPEED,
  PLAYER_SPRINT_MULTIPLIER,
  PLAYER_MAX_HEALTH,
  PLAYER_STARTING_HEALTH,
  DEFAULT_WEAPON,
  WEAPONS,
  WANTED_THRESHOLDS,
  WANTED_MAX_HEAT,
  WANTED_HEAT_DECAY_PER_TICK,
} from './constants.js';
import { createRng } from './rng.js';
import { circleAabbOverlap, clamp } from './geometry.js';
import { isSolidTile } from './map.js';

/**
 * @typedef {object} GameInput
 * @property {boolean} up
 * @property {boolean} down
 * @property {boolean} left
 * @property {boolean} right
 * @property {boolean} sprint
 */

/**
 * @typedef {object} GameEvent
 * @property {string} type
 * @property {number} tick
 */

/**
 * @typedef {object} GameState
 * @property {object} map Normalised source map.
 * @property {{ width: number, height: number, tiles: number[] }} grid Row-major tile grid.
 * @property {() => number} rng
 * @property {number | null} seed
 * @property {number} tick
 * @property {number} accumulator Seconds carried between frames.
 * @property {GameInput} input
 * @property {object} player
 * @property {object[]} bullets
 * @property {GameEvent[]} events
 * @property {number} heat
 * @property {number} wanted
 * @property {boolean} gameOver
 * @property {boolean} paused
 */

function emptyInput() {
  return { up: false, down: false, left: false, right: false, sprint: false };
}

/**
 * Validate a map and flatten it to a row-major array.
 *
 * A map is `{ width, height, tiles }` where `tiles` is either a flat row-major
 * array of length `width * height` or an array of `height` rows.
 *
 * @param {object} map
 * @returns {{ width: number, height: number, tiles: number[] }}
 */
function normalizeGrid(map) {
  if (!map || typeof map !== 'object') {
    throw new Error('createGame requires a map');
  }
  const { width, height, tiles } = map;
  if (!Number.isInteger(width) || width <= 0) {
    throw new Error('map.width must be a positive integer');
  }
  if (!Number.isInteger(height) || height <= 0) {
    throw new Error('map.height must be a positive integer');
  }
  if (!tiles || typeof tiles.length !== 'number') {
    throw new Error('map.tiles is required');
  }

  if (Array.isArray(tiles) && tiles.length > 0 && Array.isArray(tiles[0])) {
    if (tiles.length !== height) {
      throw new Error('map.tiles must have exactly map.height rows');
    }
    for (const row of tiles) {
      if (row.length !== width) {
        throw new Error('each map.tiles row must have exactly map.width entries');
      }
    }
    return { width, height, tiles: tiles.flat().map(Number) };
  }

  if (tiles.length !== width * height) {
    throw new Error(`map.tiles must contain exactly ${width * height} entries`);
  }
  return { width, height, tiles: Array.from(tiles, Number) };
}

function resolveRng(rng, seed) {
  if (typeof rng === 'function') return rng;
  if (typeof rng === 'number') return createRng(rng);
  if (typeof seed === 'number') return createRng(seed);
  if (rng === undefined || rng === null) return Math.random;
  throw new Error('rng must be a function or a numeric seed');
}

function defaultSpawn(grid) {
  return {
    x: (Math.floor(grid.width / 2) + 0.5) * TILE_SIZE,
    y: (Math.floor(grid.height / 2) + 0.5) * TILE_SIZE,
  };
}

function resetPlayer(state) {
  const weapon = WEAPONS[DEFAULT_WEAPON];
  state.player = {
    id: 0,
    x: state.spawn.x,
    y: state.spawn.y,
    radius: PLAYER_RADIUS,
    speed: PLAYER_BASE_SPEED,
    health: PLAYER_STARTING_HEALTH,
    maxHealth: PLAYER_MAX_HEALTH,
    aim: 0,
    cooldown: 0,
    reloadTicks: 0,
    weapon: DEFAULT_WEAPON,
    ammo: weapon.magazineSize,
  };
}

/**
 * Create a new game state.
 *
 * @param {object} options
 * @param {object} options.map Required map (`{ width, height, tiles }`).
 * @param {Vec} [options.spawn] Optional spawn point, in world pixels.
 * @param {() => number | number} [options.rng] Random function or numeric seed.
 * @param {number} [options.seed] Numeric seed used when `rng` is omitted.
 * @returns {GameState}
 */
export function createGame({ map, spawn, rng, seed } = {}) {
  const grid = normalizeGrid(map);
  const resolvedRng = resolveRng(rng, seed);
  const numericSeed = typeof seed === 'number' ? seed : typeof rng === 'number' ? rng : null;
  const spawnPoint = spawn ? { x: spawn.x, y: spawn.y } : defaultSpawn(grid);

  /** @type {GameState} */
  const state = {
    map,
    grid,
    rng: resolvedRng,
    seed: numericSeed,
    tick: 0,
    accumulator: 0,
    input: emptyInput(),
    player: null,
    bullets: [],
    events: [],
    heat: 0,
    wanted: 0,
    gameOver: false,
    paused: false,
    spawn: spawnPoint,
  };

  resetPlayer(state);
  return state;
}

/**
 * Reset a state to its initial values, keeping the map and rng. When the game
 * was created with a numeric seed the rng is rewound so the restart is
 * reproducible.
 *
 * @param {GameState} state
 * @returns {GameState}
 */
export function restart(state) {
  if (!state || typeof state !== 'object') {
    throw new TypeError('restart requires a game state');
  }
  state.tick = 0;
  state.accumulator = 0;
  state.bullets.length = 0;
  state.events = [];
  state.heat = 0;
  state.wanted = 0;
  state.gameOver = false;
  state.paused = false;
  state.input = emptyInput();
  if (state.seed !== null) {
    state.rng = createRng(state.seed);
  }
  resetPlayer(state);
  return state;
}

/**
 * Queue an event for the next consumer to drain.
 *
 * @param {GameState} state
 * @param {string} type
 * @param {object} [data]
 * @returns {GameEvent}
 */
export function emitEvent(state, type, data = {}) {
  const event = { type, tick: state.tick, ...data };
  state.events.push(event);
  return event;
}

/**
 * Return every queued event and clear the queue.
 *
 * @param {GameState} state
 * @returns {GameEvent[]}
 */
export function drainEvents(state) {
  if (!state || !Array.isArray(state.events)) {
    throw new TypeError('drainEvents requires a game state');
  }
  const events = state.events;
  state.events = [];
  return events;
}

/**
 * Number of wanted stars for a given heat value.
 *
 * @param {number} heat
 * @returns {number}
 */
export function getWantedStars(heat) {
  let stars = 0;
  for (let i = 1; i < WANTED_THRESHOLDS.length; i += 1) {
    if (heat >= WANTED_THRESHOLDS[i]) stars = i;
  }
  return stars;
}

/**
 * Add heat (capped at the top threshold) and refresh the wanted level.
 *
 * @param {GameState} state
 * @param {number} amount
 * @returns {number} The new heat value.
 */
export function addHeat(state, amount) {
  state.heat = clamp(state.heat + amount, 0, WANTED_MAX_HEAT);
  state.wanted = getWantedStars(state.heat);
  return state.heat;
}

function tileAt(grid, tx, ty) {
  return grid.tiles[ty * grid.width + tx];
}

function isSolidAt(grid, tx, ty) {
  if (tx < 0 || ty < 0 || tx >= grid.width || ty >= grid.height) return true;
  return isSolidTile(tileAt(grid, tx, ty));
}

function collidesAt(state, x, y, r) {
  const grid = state.grid;
  const minTx = Math.floor((x - r) / TILE_SIZE);
  const maxTx = Math.floor((x + r) / TILE_SIZE);
  const minTy = Math.floor((y - r) / TILE_SIZE);
  const maxTy = Math.floor((y + r) / TILE_SIZE);

  for (let ty = minTy; ty <= maxTy; ty += 1) {
    for (let tx = minTx; tx <= maxTx; tx += 1) {
      if (!isSolidAt(grid, tx, ty)) continue;
      const box = { x: tx * TILE_SIZE, y: ty * TILE_SIZE, w: TILE_SIZE, h: TILE_SIZE };
      if (circleAabbOverlap({ x, y, r }, box)) return true;
    }
  }
  return false;
}

function movePlayer(state) {
  const p = state.player;
  const i = state.input;
  const dx = (i.right ? 1 : 0) - (i.left ? 1 : 0);
  const dy = (i.down ? 1 : 0) - (i.up ? 1 : 0);
  if (dx === 0 && dy === 0) return;

  const inv = 1 / Math.hypot(dx, dy);
  const speed = p.speed * (i.sprint ? PLAYER_SPRINT_MULTIPLIER : 1);
  const step = speed * TICK_SECONDS;
  const nx = p.x + dx * inv * step;
  const ny = p.y + dy * inv * step;

  if (!collidesAt(state, nx, p.y, p.radius)) p.x = nx;
  if (!collidesAt(state, p.x, ny, p.radius)) p.y = ny;
}

function tickCooldowns(state) {
  const p = state.player;
  if (p.cooldown > 0) p.cooldown -= 1;
  if (p.reloadTicks > 0) p.reloadTicks -= 1;
}

function updateWanted(state) {
  if (state.heat > 0) {
    state.heat = Math.max(0, state.heat - WANTED_HEAT_DECAY_PER_TICK);
  }
  state.wanted = getWantedStars(state.heat);
}

/**
 * Advance the simulation by exactly one tick.
 *
 * The tick counter always increments by one, even while paused or after game
 * over, so callers can reason about elapsed simulation time independent of the
 * render rate.
 *
 * @param {GameState} state
 * @returns {GameState}
 */
export function update(state) {
  if (!state || typeof state !== 'object') {
    throw new TypeError('update requires a game state');
  }
  state.tick += 1;
  if (state.gameOver || state.paused) return state;

  tickCooldowns(state);
  movePlayer(state);
  updateWanted(state);
  return state;
}

/**
 * Feed a wall-clock delta (seconds) into the fixed-timestep accumulator and run
 * whole ticks until it is consumed.
 *
 * The delta is clamped to `MAX_FRAME_SECONDS` and at most `MAX_STEPS_PER_FRAME`
 * ticks run per call; any remaining backlog is dropped. Both guards prevent the
 * "spiral of death" after the tab has been suspended.
 *
 * @param {GameState} state
 * @param {number} dtSeconds
 * @returns {number} How many ticks ran.
 */
export function advance(state, dtSeconds) {
  if (!state || typeof state !== 'object') {
    throw new TypeError('advance requires a game state');
  }
  let dt = Number.isFinite(dtSeconds) ? Math.max(0, dtSeconds) : 0;
  if (dt > MAX_FRAME_SECONDS) dt = MAX_FRAME_SECONDS;

  state.accumulator += dt;
  let steps = 0;
  while (state.accumulator >= TICK_SECONDS && steps < MAX_STEPS_PER_FRAME) {
    update(state);
    state.accumulator -= TICK_SECONDS;
    steps += 1;
  }

  if (state.accumulator >= TICK_SECONDS) {
    state.accumulator = 0;
  }
  return steps;
}
