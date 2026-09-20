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
  WEAPON_SLOTS,
  VEHICLE_EXPLOSION_HEAT,
} from './constants.js';
import { createRng } from './rng.js';
import { clamp, lerp as lerpVec } from './geometry.js';
import { clampCamera, cameraFollowTarget } from './map.js';
import {
  createPlayer,
  movePlayer as movePlayerEntity,
  aimAt,
  isAlive as isPlayerAlive,
} from './player.js';
import {
  weaponSpec,
  switchToSlot,
  cycleWeapon,
  beginReload,
  tickWeapon,
  fireWeapon,
} from './weapons.js';
import { createBullet, stepBullet, findBulletTarget, applyBulletDamage } from './bullet.js';
import {
  createVehicle,
  stepVehicle,
  enterVehicle,
  exitVehicle,
  findNearestVehicle,
  findVehicleById,
  findExitPosition,
  runOverDamageTick,
  explodeVehicle,
} from './vehicle.js';
import { ENEMY_TYPE_IDS, createEnemy, isEnemyAlive, isPolice, enemySpec, rollLoot } from './enemy.js';
import { createPickup, applyPickup as applyPickupToPlayer, pickupOverlaps, PICKUP_TYPES, defaultPickupAmount } from './pickup.js';
import {
  createMission,
  activateMission,
  recordElimination,
  updateMission,
  missionProgress,
  MISSION_DEFAULT_REWARD,
} from './mission.js';
import { aiTick } from './ai.js';
import {
  wantedLevelFor,
  addWantedPoints,
  decayWantedPoints,
  policeSpawnStep,
  policeDespawnCount,
  policeSpawnPoint,
  isBusted,
  sirenActiveFor,
  findCapturingOfficer,
  WANTED_DECAY_COOLDOWN_TICKS,
} from './wanted.js';

/**
 * Terminal run outcomes. `null` means the run is still live. Every non-null
 * outcome sets `gameOver` and can be cleared by {@link restart}.
 *
 * `missionComplete` means a mission was passed but the campaign continues after
 * a restart; `won` means the final mission was passed.
 *
 * @type {Readonly<Record<string, string>>}
 */
export const GAME_OUTCOMES = Object.freeze({
  WASTED: 'wasted',
  BUSTED: 'busted',
  MISSION_COMPLETE: 'missionComplete',
  WON: 'won',
});

/** Score added to the run score for each hostile defeated. */
export const SCORE_PER_KILL = 10;

/**
 * @typedef {object} GameInput
 * @property {boolean} up
 * @property {boolean} down
 * @property {boolean} left
 * @property {boolean} right
 * @property {boolean} sprint
 * @property {boolean} [fire]
 * @property {boolean} [reload]
 * @property {boolean} [weapon1] One-shot intent: equip slot 1.
 * @property {boolean} [weapon2]
 * @property {boolean} [weapon3]
 * @property {number} [cycleWeapon] Accumulated wheel steps (negative = up).
 * @property {boolean} [enter] One-shot intent: enter/exit the nearest vehicle.
 * @property {boolean} [handbrake] Held while the handbrake key is down.
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
 * @property {object[]} bullets Live projectiles.
 * @property {number} nextBulletId Monotonic id source for new projectiles.
 * @property {object[]} targets Shootable actors (enemies, props); pure data.
 * @property {object[]} enemies Live enemy actors driven by `core/ai.js`.
 * @property {number} nextEnemyId Monotonic id source for new enemies.
 * @property {object[]} pickups Loot dropped by dead enemies.
 * @property {number} nextPickupId Monotonic id source for new pickups.
 * @property {number} cash Money collected from loot.
 * @property {object[]} vehicles Drivable vehicles.
 * @property {number} nextVehicleId Monotonic id source for new vehicles.
 * @property {Array<object>|null} vehicleSpecs Explicit spawn overrides.
 * @property {GameEvent[]} events
 * @property {{ x: number, y: number, width: number, height: number }} camera
 * @property {{ x: number, y: number }} cameraDeadZone
 * @property {{ width: number, height: number }} viewport
 * @property {number} heat
 * @property {number} wanted
 * @property {number} wantedCooldown Ticks left before wanted points decay.
 * @property {number} policeSpawnTimer Ticks left before the next police spawn.
 * @property {boolean} busted Whether the 5-star terminal state was reached.
 * @property {number} sirenLevel Wanted level described by the last siren event.
 * @property {boolean} sirenActive Whether the siren is currently sounding.
 * @property {object[]} missions Campaign mission specs, in order.
 * @property {number} missionIndex Index of the mission `restart` will activate.
 * @property {object|null} mission The currently active mission.
 * @property {number} kills Hostiles defeated this run (score input).
 * @property {string|null} outcome Terminal outcome (see {@link GAME_OUTCOMES}).
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
    weapon1: false,
    weapon2: false,
    weapon3: false,
    cycleWeapon: 0,
    enter: false,
    handbrake: false,
    restart: false,
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
  const hasRngFunction = typeof rng === 'function';
  const hasNumericSeed = typeof seed === 'number';
  if (hasRngFunction && hasNumericSeed) {
    throw new Error('createGame accepts either a function rng or a numeric seed, not both');
  }
  if (hasRngFunction) return rng;
  if (typeof rng === 'number') return createRng(rng);
  if (hasNumericSeed) return createRng(seed);
  if (rng === undefined || rng === null) return Math.random;
  throw new Error('rng must be a function or a numeric seed');
}

function defaultSpawn(grid) {
  return {
    x: (Math.floor(grid.width / 2) + 0.5) * TILE_SIZE,
    y: (Math.floor(grid.height / 2) + 0.5) * TILE_SIZE,
  };
}

/**
 * Collect enemy spawn points from a map. Supports both the generated map's
 * `spawns.enemySpawns` and a top-level `enemySpawns` array, so hand-authored
 * maps can place enemies without the full spawn structure.
 *
 * @param {object} map
 * @returns {Array<{ x: number, y: number }>}
 */
function enemySpawnPoints(map) {
  if (Array.isArray(map?.enemySpawns)) return map.enemySpawns;
  if (Array.isArray(map?.spawns?.enemySpawns)) return map.spawns.enemySpawns;
  return [];
}

/**
 * (Re)create the enemy squad from the map's spawn points, cycling through the
 * archetype list so spawns are deterministic. Ids are stable across a restart.
 *
 * @param {GameState} state
 * @returns {object[]} The freshly spawned enemies.
 */
function spawnEnemies(state) {
  const points = enemySpawnPoints(state.map);
  state.enemies = points.map((point, index) =>
    createEnemy({
      id: index + 1,
      type: ENEMY_TYPE_IDS[index % ENEMY_TYPE_IDS.length],
      x: point.x,
      y: point.y,
    }),
  );
  state.nextEnemyId = points.length + 1;
  return state.enemies;
}

/**
 * Build the campaign's mission specs from the map. An explicit `map.missions`
 * array wins; otherwise the map's `spawns.missionSpawns` become `reach`
 * objectives preceded by an `eliminate` objective sized to the enemy squad.
 * A map with neither gets no campaign, so plain test maps keep behaving as
 * before.
 *
 * @param {object} map
 * @returns {Array<object>}
 */
function campaignSpecs(map) {
  if (Array.isArray(map?.missions)) return map.missions;
  const spawns = Array.isArray(map?.spawns?.missionSpawns) ? map.spawns.missionSpawns : [];
  if (spawns.length === 0) return [];

  const specs = [
    {
      id: 'mission-1',
      name: 'Clear the block',
      objective: 'eliminate',
      targetCount: Math.max(1, Math.min(enemySpawnPoints(map).length || 3, 12)),
      reward: MISSION_DEFAULT_REWARD,
    },
  ];
  spawns.forEach((point, index) => {
    specs.push({
      id: `mission-${index + 2}`,
      name: `Reach checkpoint ${index + 1}`,
      objective: 'reach',
      x: point.x,
      y: point.y,
      reward: MISSION_DEFAULT_REWARD,
    });
  });
  return specs;
}

/**
 * Build a fresh mission list from the state's specs. Ids and targets are
 * regenerated on every restart so a completed mission cannot stay complete.
 *
 * @param {GameState} state
 * @returns {object[]}
 */
function buildMissions(state) {
  const specs = Array.isArray(state.missionSpecs) ? state.missionSpecs : [];
  return specs.map((spec, index) => {
    const { id, ...rest } = spec ?? {};
    return createMission({ id: id ?? `mission-${index + 1}`, ...rest });
  });
}

/**
 * Reset the campaign to `index` and activate that mission (if any), emitting a
 * `mission_start` event.
 *
 * @param {GameState} state
 * @param {number} [index=0]
 */
function resetMissions(state, index = 0) {
  state.missions = buildMissions(state);
  const clamped =
    Number.isFinite(index) && index >= 0 && index < state.missions.length ? Math.floor(index) : 0;
  state.missionIndex = clamped;
  state.mission = state.missions[clamped] ?? null;
  if (!state.mission) return;

  activateMission(state.mission);
  emitEvent(state, 'mission_start', {
    missionId: state.mission.id,
    name: state.mission.name,
    objective: state.mission.objective,
    targetCount: state.mission.targetCount,
    reward: state.mission.reward,
    x: state.mission.x,
    y: state.mission.y,
    radius: state.mission.radius,
  });
}

/**
 * Place the map's named health/armour/ammo/cash pickups on the ground, cycling
 * through the pickup types so every effect is reachable. Ids are stable across
 * a restart.
 *
 * @param {GameState} state
 */
function resetPickups(state) {
  state.pickups = [];
  state.nextPickupId = 1;
  const spawns = Array.isArray(state.map?.spawns?.pickupSpawns) ? state.map.spawns.pickupSpawns : [];
  for (const point of spawns) {
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) continue;
    const pickupType = PICKUP_TYPES[state.pickups.length % PICKUP_TYPES.length];
    state.pickups.push(
      createPickup({
        id: state.nextPickupId,
        pickupType,
        amount: defaultPickupAmount(pickupType),
        x: point.x,
        y: point.y,
      }),
    );
    state.nextPickupId += 1;
  }
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
 * Fill `state.vehicles` from the explicit spawn overrides or the map's named
 * vehicle spawn points. Ids are stable across a restart so a saved reference
 * keeps pointing at the same car.
 *
 * @param {GameState} state
 */
function resetVehicles(state) {
  state.vehicles = [];
  state.nextVehicleId = 0;
  const mapSpawns = Array.isArray(state.map?.spawns?.vehicleSpawns) ? state.map.spawns.vehicleSpawns : [];
  const specs = Array.isArray(state.vehicleSpecs) ? state.vehicleSpecs : mapSpawns;

  for (const spec of specs) {
    if (!spec || !Number.isFinite(spec.x) || !Number.isFinite(spec.y)) continue;
    const id = spec.id ?? `vehicle-${state.nextVehicleId}`;
    state.vehicles.push(
      createVehicle({
        id,
        x: spec.x,
        y: spec.y,
        angle: Number.isFinite(spec.angle) ? spec.angle : 0,
      }),
    );
    state.nextVehicleId += 1;
  }
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
 * @param {Array<{ id?: number|string, x: number, y: number, angle?: number }>} [options.vehicles]
 *   Explicit vehicle spawns; when omitted the map's `spawns.vehicleSpawns` are used.
 * @param {Array<object>} [options.missions] Explicit campaign specs; when
 *   omitted the map's `missions` (or `spawns.missionSpawns`) are used.
 * @returns {GameState}
 */
export function createGame({ map, spawn, rng, seed, viewport, deadZone, vehicles, missions } = {}) {
  const grid = normalizeGrid(map);
  const resolvedRng = resolveRng(rng, seed);
  let numericSeed = null;
  if (typeof rng !== 'function') {
    if (typeof seed === 'number') numericSeed = seed;
    else if (typeof rng === 'number') numericSeed = rng;
  }
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
    nextBulletId: 0,
    targets: [],
    enemies: [],
    nextEnemyId: 1,
    pickups: [],
    nextPickupId: 1,
    cash: 0,
    vehicles: [],
    nextVehicleId: 0,
    vehicleSpecs: Array.isArray(vehicles) ? vehicles : null,
    events: [],
    viewport: normalizeViewport(viewport),
    camera: null,
    cameraDeadZone: normalizeDeadZone(deadZone),
    heat: 0,
    wanted: 0,
    wantedCooldown: 0,
    policeSpawnTimer: 0,
    busted: false,
    sirenLevel: 0,
    sirenActive: false,
    missions: [],
    missionIndex: 0,
    mission: null,
    missionSpecs: Array.isArray(missions) ? missions : campaignSpecs(map),
    kills: 0,
    outcome: null,
    gameOver: false,
    paused: false,
    spawn: spawnPoint,
  };

  resetPlayer(state);
  resetCamera(state);
  resetVehicles(state);
  spawnEnemies(state);
  resetPickups(state);
  resetMissions(state, 0);
  return state;
}

/**
 * Reset a state to its initial values, keeping the map and rng. Live bullets
 * and shootable targets are discarded. When the game was created with a numeric
 * seed the rng is rewound so the restart is reproducible.
 *
 * The existing `input` object is cleared in place rather than replaced, so
 * references captured elsewhere (for example the keyboard listeners bound in
 * `src/main.js`) stay valid across a restart.
 *
 * @param {GameState} state
 * @returns {GameState}
 */
export function restart(state) {
  if (!state || typeof state !== 'object') {
    throw new TypeError('restart requires a game state');
  }
  // A passed mission advances the campaign; a win starts it over. Deaths and
  // arrests replay the mission the run was on.
  const previousOutcome = state.outcome;
  state.tick = 0;
  state.accumulator = 0;
  state.bullets.length = 0;
  state.nextBulletId = 0;
  state.targets.length = 0;
  state.cash = 0;
  state.kills = 0;
  state.events = [];
  state.heat = 0;
  state.wanted = 0;
  state.wantedCooldown = 0;
  state.policeSpawnTimer = 0;
  state.busted = false;
  state.sirenLevel = 0;
  state.sirenActive = false;
  state.outcome = null;
  state.gameOver = false;
  state.paused = false;
  if (state.input) {
    Object.assign(state.input, emptyInput());
  } else {
    state.input = emptyInput();
  }
  if (state.seed !== null) {
    state.rng = createRng(state.seed);
  }
  resetPlayer(state);
  resetCamera(state);
  resetVehicles(state);
  spawnEnemies(state);
  resetPickups(state);
  resetMissions(state, previousOutcome === GAME_OUTCOMES.WON ? 0 : state.missionIndex);
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
 * Run score: cash banked plus a bounty per hostile defeated. The HUD and the
 * best-score store both read this, so the number has one definition.
 *
 * @param {GameState} state
 * @returns {number}
 */
export function computeScore(state) {
  const cash = Number.isFinite(state?.cash) ? Math.max(0, Math.trunc(state.cash)) : 0;
  const kills = Number.isFinite(state?.kills) ? Math.max(0, Math.trunc(state.kills)) : 0;
  return cash + kills * SCORE_PER_KILL;
}

/**
 * Number of wanted stars for a given heat value.
 *
 * @param {number} heat
 * @returns {number}
 */
export function getWantedStars(heat) {
  return wantedLevelFor(heat);
}

/**
 * Add wanted points (capped at the top threshold), reset the crime-free decay
 * cooldown and refresh the wanted level.
 *
 * @param {GameState} state
 * @param {number} amount
 * @returns {number} The new heat value.
 */
export function addHeat(state, amount) {
  state.heat = addWantedPoints(state.heat, amount);
  state.wanted = wantedLevelFor(state.heat);
  state.wantedCooldown = WANTED_DECAY_COOLDOWN_TICKS;
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

/**
 * Spawn a projectile from a weapon fire descriptor, assign it an id and emit
 * the matching `tracer` event.
 *
 * @param {GameState} state
 * @param {object} spawn Plain `{ x, y, vx, vy, angle, damage, ttl, weapon }`.
 * @param {number} owner Firing entity id.
 * @returns {object} The created bullet.
 */
function spawnProjectile(state, spawn, owner) {
  const bullet = createBullet({ ...spawn, id: state.nextBulletId, owner });
  state.nextBulletId += 1;
  state.bullets.push(bullet);
  emitEvent(state, 'tracer', {
    bulletId: bullet.id,
    owner,
    weapon: spawn.weapon,
    x: spawn.x,
    y: spawn.y,
    angle: spawn.angle,
    vx: spawn.vx,
    vy: spawn.vy,
  });
  return bullet;
}

/**
 * Consume weapon intents from the input for one tick: number-key / wheel
 * selection, reload, then firing. Firing emits a `muzzle` event and one
 * `tracer` event per pellet.
 *
 * @param {GameState} state
 */
function updateWeapon(state) {
  const player = state.player;
  const input = state.input;

  for (let slot = 0; slot < WEAPON_SLOTS.length; slot += 1) {
    const flag = `weapon${slot + 1}`;
    if (input[flag]) {
      switchToSlot(player, slot);
      input[flag] = false;
    }
  }
  if (input.cycleWeapon) {
    cycleWeapon(player, input.cycleWeapon);
    input.cycleWeapon = 0;
  }

  if (input.reload) beginReload(player);

  const spec = weaponSpec(player.weapon);
  const held = input.fire === true;
  const pressed = held && !player.fireHeld;
  player.fireHeld = held;
  const wantsToFire = spec.automatic ? held : pressed;

  if (!wantsToFire) return;
  const result = fireWeapon(player, { rng: state.rng, x: player.x, y: player.y, angle: player.aim });
  if (!result.fired) return;

  emitEvent(state, 'muzzle', {
    weapon: result.spec.id,
    x: player.x,
    y: player.y,
    angle: player.aim,
    pellets: result.spec.pellets,
    ammo: player.ammo,
  });
  for (const spawn of result.bullets) spawnProjectile(state, spawn, player.id);
}

/**
 * Move every live bullet one tick and resolve collisions. A bullet that
 * overlaps a target deals damage and emits a `hit` event; one that reaches a
 * wall emits `bullet_wall`. Dead bullets are compacted out in place.
 *
 * @param {GameState} state
 */
function updateBullets(state) {
  const bullets = state.bullets;
  const shootables = state.targets.concat(
    state.vehicles,
    Array.isArray(state.enemies) ? state.enemies : [],
    state.player ? [state.player] : [],
  );
  let write = 0;

  for (let i = 0; i < bullets.length; i += 1) {
    const bullet = bullets[i];
    if (!bullet || bullet.alive === false) continue;

    const result = stepBullet(state.grid, bullet, TICK_SECONDS);
    const hit = findBulletTarget(bullet, shootables);

    if (hit) {
      const damage = applyBulletDamage(hit.target, bullet.damage);
      bullet.alive = false;
      emitEvent(state, 'hit', {
        bulletId: bullet.id,
        owner: bullet.owner,
        weapon: bullet.weapon,
        targetId: hit.target.id,
        amount: bullet.damage,
        absorbed: damage.absorbed,
        health: damage.health,
        killed: damage.killed,
        x: bullet.x,
        y: bullet.y,
      });
      if (hit.target.kind === 'vehicle' && damage.killed) detonateVehicle(state, hit.target);
    } else if (result.hitWall) {
      emitEvent(state, 'bullet_wall', {
        bulletId: bullet.id,
        owner: bullet.owner,
        weapon: bullet.weapon,
        x: bullet.x,
        y: bullet.y,
        tx: result.wall.tx,
        ty: result.wall.ty,
      });
    }

    if (bullet.alive) bullets[write++] = bullet;
  }

  bullets.length = write;
}

/**
 * Run one tick of AI for every live enemy and spawn any bullets they fire.
 * Emits `enemy_alert` when an enemy newly acquires the player and
 * `enemy_lost_player` when it forgets them.
 *
 * @param {GameState} state
 */
function updateEnemies(state) {
  if (!Array.isArray(state.enemies)) return;
  for (const enemy of state.enemies) {
    if (!isEnemyAlive(enemy)) continue;
    const result = aiTick(state.grid, enemy, {
      player: state.player,
      rng: state.rng,
      dtSeconds: TICK_SECONDS,
    });

    if (result.alerted) {
      emitEvent(state, 'enemy_alert', { enemyId: enemy.id, enemyType: enemy.type, x: enemy.x, y: enemy.y });
    }
    if (result.lostTarget) {
      emitEvent(state, 'enemy_lost_player', { enemyId: enemy.id, enemyType: enemy.type, x: enemy.x, y: enemy.y });
    }
    if (!result.fired) continue;

    emitEvent(state, 'enemy_fire', {
      enemyId: enemy.id,
      enemyType: enemy.type,
      weapon: enemySpec(enemy.type).weapon,
      x: enemy.x,
      y: enemy.y,
      angle: enemy.aim,
      pellets: result.bullets.length,
    });
    for (const spawn of result.bullets) {
      spawnProjectile(state, spawn, enemy.id);
    }
  }
}

/**
 * Remove dead enemies, emit their death and roll their loot exactly once. A
 * dropped pickup is given the next pickup id and queued on `state.pickups`.
 *
 * @param {GameState} state
 */
function reapEnemies(state) {
  const enemies = state.enemies;
  if (!Array.isArray(enemies)) return;
  let write = 0;

  for (let i = 0; i < enemies.length; i += 1) {
    const enemy = enemies[i];
    if (isEnemyAlive(enemy)) {
      enemies[write++] = enemy;
      continue;
    }
    if (enemy.deadHandled) continue;

    enemy.deadHandled = true;
    emitEvent(state, 'enemy_death', {
      enemyId: enemy.id,
      enemyType: enemy.type,
      x: enemy.x,
      y: enemy.y,
    });

    state.kills += 1;
    if (state.mission) {
      recordElimination(state.mission, { type: enemy.type, police: isPolice(enemy) });
    }

    const loot = rollLoot(state.rng, enemy.type);
    if (!loot) continue;
    const pickup = createPickup({
      id: state.nextPickupId,
      pickupType: loot.type,
      amount: loot.amount,
      x: enemy.x,
      y: enemy.y,
    });
    state.nextPickupId += 1;
    state.pickups.push(pickup);
    emitEvent(state, 'loot_drop', {
      enemyId: enemy.id,
      pickupId: pickup.id,
      pickupType: pickup.pickupType,
      amount: pickup.amount,
      x: pickup.x,
      y: pickup.y,
    });
  }

  enemies.length = write;
}

/**
 * Let the player walk over pickups lying on the ground. Each collection is
 * applied through `core/pickup.js`, cash is banked on the game state and a
 * `pickup` event is emitted. Collected pickups are compacted out in place; a
 * pickup that could not be applied (no live player) is left on the ground.
 *
 * @param {GameState} state
 */
function updatePickups(state) {
  if (!Array.isArray(state.pickups) || !isPlayerAlive(state.player)) return;
  const pickups = state.pickups;
  let write = 0;

  for (let i = 0; i < pickups.length; i += 1) {
    const pickup = pickups[i];
    if (!pickup || pickup.alive === false) continue;

    if (!pickupOverlaps(pickup, state.player)) {
      pickups[write++] = pickup;
      continue;
    }

    const applied = applyPickupToPlayer(state.player, pickup);
    if (!applied.applied) {
      pickups[write++] = pickup;
      continue;
    }

    if (applied.cash) state.cash += applied.cash;
    pickup.alive = false;
    emitEvent(state, 'pickup', {
      pickupId: pickup.id,
      pickupType: applied.pickupType,
      amount: applied.amount,
      cash: applied.cash,
      x: pickup.x,
      y: pickup.y,
    });
  }

  pickups.length = write;
}

/**
 * Set the run's terminal outcome. The first terminal state wins, so a mission
 * completion and a death on the same tick cannot both claim the run; the
 * `gameOver` flag is kept in agreement with `outcome`.
 *
 * @param {GameState} state
 * @param {string} outcome One of {@link GAME_OUTCOMES}.
 * @returns {string|null} The outcome in force after the call.
 */
function setOutcome(state, outcome) {
  if (state.outcome !== null) return state.outcome;
  state.outcome = outcome;
  state.gameOver = true;
  return state.outcome;
}

/**
 * Is the run still live (no terminal outcome yet)?
 *
 * @param {GameState} state
 * @returns {boolean}
 */
function isRunLive(state) {
  return state.outcome === null;
}

/**
 * Flag game over once the player has died. Death is the `wasted` terminal
 * state; it emits both the legacy `player_death` and the `wasted` event.
 *
 * @param {GameState} state
 */
function updatePlayerDeath(state) {
  if (isPlayerAlive(state.player)) return;
  if (!isRunLive(state)) return;
  emitEvent(state, 'player_death', { x: state.player.x, y: state.player.y });
  emitEvent(state, 'wasted', { x: state.player.x, y: state.player.y });
  setOutcome(state, GAME_OUTCOMES.WASTED);
}

/**
 * Advance the active mission: cash in any completed objective and move the
 * campaign on. Completing the final mission wins the run; completing an earlier
 * one ends the run in the `missionComplete` state so `restart` can resume the
 * campaign at the next mission.
 *
 * @param {GameState} state
 */
function updateMissions(state) {
  if (!state.mission || !isRunLive(state)) return;

  const result = updateMission(state.mission, state.player);
  if (!result.completed) return;

  state.cash += result.reward;
  const progress = missionProgress(state.mission);
  emitEvent(state, 'mission_complete', {
    missionId: progress.id,
    name: progress.name,
    objective: progress.objective,
    reward: result.reward,
    cash: state.cash,
  });

  const nextIndex = state.missionIndex + 1;
  if (nextIndex < state.missions.length) {
    state.missionIndex = nextIndex;
    setOutcome(state, GAME_OUTCOMES.MISSION_COMPLETE);
  } else {
    setOutcome(state, GAME_OUTCOMES.WON);
  }
}

/**
 * How many live police responders the game currently has.
 *
 * @param {GameState} state
 * @returns {number}
 */
function countAlivePolice(state) {
  if (!Array.isArray(state.enemies)) return 0;
  let count = 0;
  for (const enemy of state.enemies) {
    if (isPolice(enemy) && isEnemyAlive(enemy)) count += 1;
  }
  return count;
}

/**
 * Remove police responders (then emit `police_despawn`), newest first. Used
 * when the wanted level drops or resets to zero.
 *
 * @param {GameState} state
 * @param {number} count
 * @returns {number} How many were actually removed.
 */
function despawnPolice(state, count) {
  if (!Array.isArray(state.enemies)) return 0;
  let remaining = Math.max(0, Math.floor(count));
  let removed = 0;
  for (let i = state.enemies.length - 1; i >= 0 && remaining > 0; i -= 1) {
    const enemy = state.enemies[i];
    if (!isPolice(enemy)) continue;
    state.enemies.splice(i, 1);
    remaining -= 1;
    removed += 1;
    emitEvent(state, 'police_despawn', {
      enemyId: enemy.id,
      enemyType: enemy.type,
      x: enemy.x,
      y: enemy.y,
      wanted: state.wanted,
    });
  }
  return removed;
}

/**
 * Spawn one police responder of `variant` on a walkable ring around the player.
 * Returns `null` when no valid spawn point is available.
 *
 * @param {GameState} state
 * @param {string} variant
 * @returns {object|null}
 */
function spawnPolice(state, variant) {
  const spec = enemySpec(variant);
  const point = policeSpawnPoint(state.grid, state.player.x, state.player.y, {
    rng: state.rng,
    radius: spec.radius,
  });
  if (!point) return null;

  const enemy = createEnemy({ id: state.nextEnemyId, type: variant, x: point.x, y: point.y });
  state.nextEnemyId += 1;
  state.enemies.push(enemy);
  emitEvent(state, 'police_spawn', {
    enemyId: enemy.id,
    enemyType: enemy.type,
    x: enemy.x,
    y: enemy.y,
    wanted: state.wanted,
  });
  return enemy;
}

/**
 * Match the live police force to the current wanted level: despawn the excess
 * (all of it at level 0) then spawn reinforcements up to the level's roster.
 *
 * @param {GameState} state
 */
function updatePolice(state) {
  if (!Array.isArray(state.enemies)) return;

  const excess = policeDespawnCount(state.wanted, countAlivePolice(state));
  if (excess > 0) despawnPolice(state, excess);

  const step = policeSpawnStep({
    level: state.wanted,
    alivePolice: countAlivePolice(state),
    spawnTimer: state.policeSpawnTimer,
  });
  state.policeSpawnTimer = step.spawnTimer;
  if (step.variant) spawnPolice(state, step.variant);
}

/**
 * Emit a `siren` event whenever the wanted level (and therefore the siren
 * state) changes, so the renderer/audio layer can react.
 *
 * @param {GameState} state
 */
function updateSiren(state) {
  const active = sirenActiveFor(state.wanted);
  if (state.wanted === state.sirenLevel && active === state.sirenActive) return;
  const previousLevel = state.sirenLevel;
  state.sirenLevel = state.wanted;
  state.sirenActive = active;
  emitEvent(state, 'siren', { active, level: state.wanted, previousLevel });
}

/**
 * Reaching {@link BUSTED_LEVEL} stars is terminal: flag `busted`, emit the
 * event and end the run.
 *
 * @param {GameState} state
 */
function updateBusted(state) {
  if (state.busted || !isBusted(state.wanted) || !isRunLive(state)) return;
  const officer = findCapturingOfficer(state.player, state.enemies);
  if (!officer) return;
  state.busted = true;
  emitEvent(state, 'busted', {
    level: state.wanted,
    officerId: officer.id,
    x: state.player.x,
    y: state.player.y,
  });
  setOutcome(state, GAME_OUTCOMES.BUSTED);
}

/**
 * Advance the wanted system one tick: crime-free decay, police escalation,
 * the siren event and the 5-star busted check.
 *
 * @param {GameState} state
 */
function updateWanted(state) {
  const decayed = decayWantedPoints(state.heat, state.wantedCooldown);
  state.heat = decayed.points;
  state.wantedCooldown = decayed.cooldownTicks;
  state.wanted = wantedLevelFor(state.heat);

  updatePolice(state);
  updateSiren(state);
  updateBusted(state);
}

/**
 * Entities a moving vehicle can run over. The generic `targets` list keeps the
 * feature self-contained; an `enemies` list (enemy system) is included too when
 * present.
 *
 * @param {GameState} state
 * @returns {object[]}
 */
function groundTargets(state) {
  const list = [];
  if (Array.isArray(state.targets)) list.push(...state.targets);
  if (Array.isArray(state.enemies)) list.push(...state.enemies);
  return list;
}

/**
 * The vehicle the player is currently driving, if any. A reference to a dead or
 * missing vehicle is cleared so the player cannot stay "inside" a wreck.
 *
 * @param {GameState} state
 * @returns {object|null}
 */
function drivingVehicle(state) {
  const id = state.player ? state.player.vehicleId : null;
  if (id === null || id === undefined) return null;
  const vehicle = findVehicleById(state.vehicles, id);
  if (!vehicle || vehicle.alive === false) {
    if (state.player) state.player.vehicleId = null;
    return null;
  }
  return vehicle;
}

/**
 * Enter the closest vehicle in range.
 *
 * @param {GameState} state
 * @returns {object|null} The vehicle entered, or `null`.
 */
function enterNearestVehicle(state) {
  const player = state.player;
  if (!player) return null;
  const vehicle = findNearestVehicle(state.vehicles, player.x, player.y);
  if (!vehicle) {
    emitEvent(state, 'vehicle_enter_failed', { x: player.x, y: player.y });
    return null;
  }
  enterVehicle(vehicle, player);
  emitEvent(state, 'vehicle_enter', { vehicleId: vehicle.id, x: vehicle.x, y: vehicle.y });
  return vehicle;
}

/**
 * Leave a vehicle at a safe spot, emitting `vehicle_exit_blocked` when there is
 * no room and the player has to stay inside.
 *
 * @param {GameState} state
 * @param {object} vehicle
 * @returns {boolean}
 */
function leaveVehicle(state, vehicle) {
  const position = exitVehicle(vehicle, state.player, state.grid);
  if (!position) {
    emitEvent(state, 'vehicle_exit_blocked', { vehicleId: vehicle.id, x: vehicle.x, y: vehicle.y });
    return false;
  }
  emitEvent(state, 'vehicle_exit', { vehicleId: vehicle.id, x: position.x, y: position.y });
  return true;
}

/**
 * Consume the one-shot enter/exit intent: leave the current vehicle if driving,
 * otherwise get into the nearest one in range.
 *
 * @param {GameState} state
 */
function handleVehicleIntent(state) {
  if (!state.input.enter) return;
  state.input.enter = false;
  const vehicle = drivingVehicle(state);
  if (vehicle) leaveVehicle(state, vehicle);
  else enterNearestVehicle(state);
}

/**
 * Destroy a vehicle: explode it, damage every entity in the blast, add wanted
 * heat and, if the player was driving, eject them to a safe spot when possible.
 *
 * @param {GameState} state
 * @param {object} vehicle
 */
function detonateVehicle(state, vehicle) {
  if (!vehicle || vehicle.exploded) return;
  const wasDriving = state.player ? state.player.vehicleId === vehicle.id : false;
  if (wasDriving) state.player.vehicleId = null;

  const victims = [];
  const push = (entity) => {
    if (entity && entity !== vehicle && !victims.includes(entity)) victims.push(entity);
  };
  push(state.player);
  for (const list of [state.targets, state.enemies, state.vehicles]) {
    if (!Array.isArray(list)) continue;
    for (const entity of list) push(entity);
  }

  const boom = explodeVehicle(vehicle, victims);
  addHeat(state, VEHICLE_EXPLOSION_HEAT);
  emitEvent(state, 'vehicle_explosion', {
    vehicleId: vehicle.id,
    x: boom.x,
    y: boom.y,
    radius: boom.radius,
    damage: boom.damage,
    victims: boom.hits.map((hit) => hit.target.id),
  });

  // A blast that writes off another vehicle sets it off too, so a pile-up
  // chain-detonates instead of leaving inert wrecks behind.
  for (const hit of boom.hits) {
    const target = hit.target;
    if (target && target.kind === 'vehicle' && target.alive === false && !target.exploded) {
      detonateVehicle(state, target);
    }
  }

  if (wasDriving && state.player && state.player.alive) {
    const position = findExitPosition(state.grid, vehicle, state.player.radius);
    if (position) {
      state.player.x = position.x;
      state.player.y = position.y;
    }
  }
}

/**
 * One tick of driving: integrate the vehicle, resolve run-overs and keep the
 * player's position locked to the vehicle so the camera follows it.
 *
 * @param {GameState} state
 * @param {object} vehicle
 */
function updateDriving(state, vehicle) {
  const input = state.input;
  const result = stepVehicle(
    state.grid,
    vehicle,
    {
      throttle: (input.up ? 1 : 0) - (input.down ? 1 : 0),
      steer: (input.right ? 1 : 0) - (input.left ? 1 : 0),
      handbrake: Boolean(input.handbrake),
    },
    TICK_SECONDS,
  );

  for (const hit of runOverDamageTick(vehicle, groundTargets(state))) {
    emitEvent(state, 'run_over', {
      vehicleId: vehicle.id,
      targetId: hit.target.id,
      amount: hit.dealt,
      health: hit.health,
      killed: hit.killed,
      x: vehicle.x,
      y: vehicle.y,
      speed: vehicle.speed,
    });
  }

  if (result.crashed) {
    emitEvent(state, 'vehicle_crash', { vehicleId: vehicle.id, x: vehicle.x, y: vehicle.y, speed: vehicle.speed });
  }

  if (state.player) {
    state.player.x = vehicle.x;
    state.player.y = vehicle.y;
    state.player.aim = vehicle.angle;
  }

  if (!vehicle.alive) detonateVehicle(state, vehicle);
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

  handleVehicleIntent(state);
  updateEnemies(state);

  const vehicle = drivingVehicle(state);
  if (vehicle) {
    updateDriving(state, vehicle);
  } else {
    tickWeapon(state.player);
    updateAim(state);
    updateWeapon(state);
    movePlayerEntity(state.grid, state.player, state.input, TICK_SECONDS);
  }

  updateBullets(state);
  reapEnemies(state);
  updateMissions(state);
  updatePickups(state);
  updatePlayerDeath(state);
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
