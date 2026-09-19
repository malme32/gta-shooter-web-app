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
  CAMERA_VIEW_WIDTH,
  CAMERA_VIEW_HEIGHT,
  CAMERA_DEADZONE_X,
  CAMERA_DEADZONE_Y,
  CAMERA_LERP_PER_TICK,
  CAMERA_SETTLE_EPSILON,
  WANTED_THRESHOLDS,
  WANTED_MAX_HEAT,
  WANTED_HEAT_DECAY_PER_TICK,
} from './constants.js';
import { createRng } from './rng.js';
import { clamp, lerp as lerpVec } from './geometry.js';
import { clampCamera, cameraFollowTarget } from './map.js';
import { createPlayer, movePlayer as movePlayerEntity, aimAt } from './player.js';

/**
 * @typedef {object} GameInput
 * @property {boolean} up
 * @property {boolean} down
 * @property {boolean} left
 * @property {boolean} right
 * @property {boolean} sprint
 * @property {boolean} [fire]
 * @property {boolean} [reload]
 * @property {number|null} [pointerX] Canvas-space pointer x, or `null`.
 * @property {number|null} [pointerY] Canvas-space pointer y, or `null`.
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
 * @property {{ x: number, y: number, width: number, height: number }} camera
 * @property {{ x: number, y: number }} cameraDeadZone
 * @property {{ width: number, height: number }} viewport
 * @property {number} heat
 * @property {number} wanted
 * @property {boolean} gameOver
 * @property {boolean} paused
 */

function emptyInput() {
  return {
    up: false,
    down: false,
    left: false,
    right: false,
    sprint: false,
    fire: false,
    reload: false,
    pointerX: null,
    pointerY: null,
  };
}

/**
 * Normalise a viewport option, falling back to the default canvas size.
 *
 * @param {{ width?: number, height?: number }} [viewport]
 * @returns {{ width: number, height: number }}
 */
function normalizeViewport(viewport) {
  return {
    width: Number.isFinite(viewport?.width) && viewport.width > 0 ? viewport.width : CAMERA_VIEW_WIDTH,
    height: Number.isFinite(viewport?.height) && viewport.height > 0 ? viewport.height : CAMERA_VIEW_HEIGHT,
  };
}

/**
 * Normalise a camera dead-zone option.
 *
 * @param {{ x?: number, y?: number }} [deadZone]
 * @returns {{ x: number, y: number }}
 */
function normalizeDeadZone(deadZone) {
  const x = Number.isFinite(deadZone?.x) && deadZone.x >= 0 ? deadZone.x : CAMERA_DEADZONE_X;
  const y = Number.isFinite(deadZone?.y) && deadZone.y >= 0 ? deadZone.y : CAMERA_DEADZONE_Y;
  return { x, y };
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
  state.player = createPlayer({ id: 0, x: state.spawn.x, y: state.spawn.y });
}

/**
 * Re-centre the camera on the player, clamped to the map.
 *
 * @param {GameState} state
 * @returns {{ x: number, y: number, width: number, height: number }}
 */
function resetCamera(state) {
  state.camera = cameraFollowTarget(
    state.grid,
    state.spawn.x,
    state.spawn.y,
    state.viewport.width,
    state.viewport.height,
  );
  return state.camera;
}

/**
 * Create a new game state.
 *
 * @param {object} options
 * @param {object} options.map Required map (`{ width, height, tiles }`).
 * @param {Vec} [options.spawn] Optional spawn point, in world pixels.
 * @param {() => number | number} [options.rng] Random function or numeric seed.
 * @param {number} [options.seed] Numeric seed used when `rng` is omitted.
 * @param {{ width?: number, height?: number }} [options.viewport] Camera viewport size.
 * @param {{ x?: number, y?: number }} [options.deadZone] Camera dead-zone half extents.
 * @returns {GameState}
 */
export function createGame({ map, spawn, rng, seed, viewport, deadZone } = {}) {
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
    viewport: normalizeViewport(viewport),
    camera: null,
    cameraDeadZone: normalizeDeadZone(deadZone),
    heat: 0,
    wanted: 0,
    gameOver: false,
    paused: false,
    spawn: spawnPoint,
  };

  resetPlayer(state);
  resetCamera(state);
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
  Object.assign(state.input, emptyInput());
  if (state.seed !== null) {
    state.rng = createRng(state.seed);
  }
  resetPlayer(state);
  resetCamera(state);
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

/**
 * Where should the camera move to so `focus` stays inside the dead-zone?
 * Returns the current camera top-left when the focus is already inside the
 * zone, so small movements do not cause a jitter.
 *
 * @param {{ x: number, y: number, width: number, height: number }} camera
 * @param {{ x: number, y: number }} deadZone Half extents, in pixels.
 * @param {{ x: number, y: number }} focus World-space point being followed.
 * @returns {{ x: number, y: number }}
 */
export function cameraTarget(camera, deadZone, focus) {
  const dx = focus.x - (camera.x + camera.width / 2);
  const dy = focus.y - (camera.y + camera.height / 2);
  let x = camera.x;
  let y = camera.y;
  if (dx > deadZone.x) x = camera.x + (dx - deadZone.x);
  else if (dx < -deadZone.x) x = camera.x + (dx + deadZone.x);
  if (dy > deadZone.y) y = camera.y + (dy - deadZone.y);
  else if (dy < -deadZone.y) y = camera.y + (dy + deadZone.y);
  return { x, y };
}

/**
 * Advance the camera one tick: apply the dead-zone, interpolate towards the
 * target and clamp the result to the map.
 *
 * @param {GameState} state
 * @param {number} [factor=CAMERA_LERP_PER_TICK] Interpolation factor in `[0,1]`.
 * @returns {{ x: number, y: number, width: number, height: number }}
 */
export function updateCamera(state, factor = CAMERA_LERP_PER_TICK) {
  const camera = state.camera;
  const t = Number.isFinite(factor) ? clamp(factor, 0, 1) : CAMERA_LERP_PER_TICK;
  const target = cameraTarget(camera, state.cameraDeadZone, state.player);
  const moved = lerpVec(camera, target, t);

  if (Math.abs(target.x - moved.x) < CAMERA_SETTLE_EPSILON) moved.x = target.x;
  if (Math.abs(target.y - moved.y) < CAMERA_SETTLE_EPSILON) moved.y = target.y;

  state.camera = clampCamera(state.grid, { x: moved.x, y: moved.y, width: camera.width, height: camera.height });
  return state.camera;
}

/**
 * Snap the camera straight to the dead-zone target, skipping interpolation.
 *
 * @param {GameState} state
 * @returns {{ x: number, y: number, width: number, height: number }}
 */
export function snapCamera(state) {
  const { camera, cameraDeadZone } = state;
  const target = cameraTarget(camera, cameraDeadZone, state.player);
  state.camera = clampCamera(state.grid, { x: target.x, y: target.y, width: camera.width, height: camera.height });
  return state.camera;
}

/**
 * Apply a new canvas viewport size to the game state.
 *
 * The camera carries its own `width`/`height`, captured from the viewport at
 * creation time; the dead-zone, follow and clamp maths all read them. A canvas
 * or window resize must therefore refresh both the viewport **and** the camera
 * dimensions, otherwise the camera keeps framing for the old size and the
 * player drifts off-screen. The camera is re-centred on the player for the new
 * size and clamped to the map, so the dead-zone centre matches the visible
 * area immediately.
 *
 * @param {GameState} state
 * @param {number} width New viewport width, in logical pixels.
 * @param {number} height New viewport height, in logical pixels.
 * @returns {{ width: number, height: number }} The normalised viewport applied.
 */
export function setViewport(state, width, height) {
  if (!state || typeof state !== 'object') {
    throw new TypeError('setViewport requires a game state');
  }
  const viewport = normalizeViewport({ width, height });
  state.viewport = viewport;

  if (state.camera) {
    state.camera = {
      x: state.camera.x,
      y: state.camera.y,
      width: viewport.width,
      height: viewport.height,
    };
    state.camera = state.player ? snapCamera(state) : clampCamera(state.grid, state.camera);
  }
  return viewport;
}

/**
 * Convert a canvas-space point to world space for the given camera.
 *
 * @param {{ x: number, y: number }} camera
 * @param {number} screenX
 * @param {number} screenY
 * @returns {{ x: number, y: number }}
 */
export function screenToWorld(camera, screenX, screenY) {
  return { x: camera.x + screenX, y: camera.y + screenY };
}

/**
 * Point the player at the mouse when the intent carries a pointer position.
 *
 * @param {GameState} state
 * @returns {number} The aim angle, or the player's existing aim when no pointer.
 */
function updateAim(state) {
  const { pointerX, pointerY } = state.input;
  if (!Number.isFinite(pointerX) || !Number.isFinite(pointerY)) return state.player.aim;
  const world = screenToWorld(state.camera, pointerX, pointerY);
  return aimAt(state.player, world.x, world.y);
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
  updateAim(state);
  movePlayerEntity(state.grid, state.player, state.input, TICK_SECONDS);
  updateCamera(state);
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
