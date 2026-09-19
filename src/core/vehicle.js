/**
 * Vehicles: arcade driving physics, occupancy, run-over damage and explosions.
 *
 * This module is pure: it never touches the DOM, `window` or `document`, so it
 * runs unchanged under Node and in the browser. Battery-included around a
 * single mutable `vehicle` record:
 *
 * - {@link stepVehicle} integrates throttle/steer/friction and resolves the
 *   movement against the tile map with the shared circle-vs-tile resolver, so a
 *   vehicle can never drive through a building.
 * - {@link findNearestVehicle} / {@link enterVehicle} / {@link exitVehicle}
 *   handle getting in and out; an exit spot is only chosen when the player
 *   circle fits without overlapping a building.
 * - {@link runOverDamageTick} applies speed-scaled damage to entities the
 *   vehicle drives over, once per contact.
 * - {@link explodeVehicle} damages everything inside a blast radius when the
 *   vehicle is destroyed.
 *
 * ## Arcade steering
 *
 * Steering is proportional to the signed forward speed, so a stationary vehicle
 * cannot pivot on the spot and a reversing vehicle steers the other way. The
 * handbrake multiplies the turn rate for a slidey, arcade feel.
 *
 * @module core/vehicle
 */

import {
  TICK_SECONDS,
  TILE_SIZE,
  VEHICLE_RADIUS,
  VEHICLE_MAX_HEALTH,
  VEHICLE_ACCELERATION,
  VEHICLE_BRAKE,
  VEHICLE_MAX_SPEED,
  VEHICLE_REVERSE_SPEED,
  VEHICLE_FRICTION,
  VEHICLE_HANDBRAKE_DECEL,
  VEHICLE_STEER_RATE,
  VEHICLE_HANDBRAKE_STEER_MULTIPLIER,
  VEHICLE_CRASH_SPEED_FACTOR,
  VEHICLE_ENTER_RANGE,
  VEHICLE_EXIT_CLEARANCE,
  VEHICLE_RUNOVER_MIN_SPEED,
  VEHICLE_RUNOVER_DAMAGE,
  VEHICLE_EXPLOSION_RADIUS,
  VEHICLE_EXPLOSION_DAMAGE,
  PLAYER_RADIUS,
} from './constants.js';
import { clamp } from './geometry.js';
import { canStandAt, moveCircle } from './map.js';
import { applyBulletDamage } from './bullet.js';

/**
 * @typedef {object} Vehicle
 * @property {number|string} id
 * @property {'vehicle'} kind
 * @property {number} x
 * @property {number} y
 * @property {number} angle Heading, in radians.
 * @property {number} speed Signed speed along the heading, in pixels/second.
 * @property {number} radius Collision radius, in pixels.
 * @property {number} maxHealth
 * @property {number} health
 * @property {boolean} alive
 * @property {boolean} exploded
 * @property {number|string|null} occupiedBy Id of the driving entity, or null.
 * @property {Set<number|string>} contacts Ids currently being run over.
 *
 * @typedef {object} DriveIntent
 * @property {number} [throttle] `-1..1`; positive accelerates forward.
 * @property {number} [steer] `-1..1`; positive turns right.
 * @property {boolean} [handbrake]
 */

/**
 * Wrap an angle to the `(-pi, pi]` range.
 *
 * @param {number} angle
 * @returns {number}
 */
export function normalizeAngle(angle) {
  const value = Number.isFinite(angle) ? angle : 0;
  const wrapped = value % (Math.PI * 2);
  if (wrapped > Math.PI) return wrapped - Math.PI * 2;
  if (wrapped <= -Math.PI) return wrapped + Math.PI * 2;
  return wrapped;
}

/**
 * Move `value` towards `target` by at most `maxDelta`, without overshooting.
 *
 * @param {number} value
 * @param {number} target
 * @param {number} maxDelta
 * @returns {number}
 */
function moveToward(value, target, maxDelta) {
  if (value < target) return Math.min(target, value + maxDelta);
  if (value > target) return Math.max(target, value - maxDelta);
  return value;
}

/**
 * Create a vehicle at a world position.
 *
 * @param {object} [options]
 * @param {number|string} [options.id=0]
 * @param {number} [options.x=0]
 * @param {number} [options.y=0]
 * @param {number} [options.angle=0] Initial heading, in radians.
 * @param {number} [options.speed=0] Initial signed speed, in pixels/second.
 * @param {number} [options.radius=VEHICLE_RADIUS]
 * @param {number} [options.health=VEHICLE_MAX_HEALTH]
 * @returns {Vehicle}
 */
export function createVehicle({
  id = 0,
  x = 0,
  y = 0,
  angle = 0,
  speed = 0,
  radius = VEHICLE_RADIUS,
  health = VEHICLE_MAX_HEALTH,
} = {}) {
  const maxHealth = VEHICLE_MAX_HEALTH;
  const hp = clamp(Number.isFinite(health) ? health : maxHealth, 0, maxHealth);
  return {
    id,
    kind: 'vehicle',
    x,
    y,
    angle: normalizeAngle(angle),
    speed: Number.isFinite(speed) ? speed : 0,
    radius: Number.isFinite(radius) ? radius : VEHICLE_RADIUS,
    maxHealth,
    health: hp,
    alive: hp > 0,
    exploded: false,
    occupiedBy: null,
    contacts: new Set(),
  };
}

/**
 * Damage a vehicle, marking it dead when health reaches zero. The caller
 * decides whether a lethal hit should also detonate it.
 *
 * @param {Vehicle} vehicle
 * @param {number} amount
 * @returns {{ dealt: number, health: number, killed: boolean, ignored: boolean }}
 */
export function applyVehicleDamage(vehicle, amount) {
  const dealt = Number.isFinite(amount) ? Math.max(0, amount) : 0;
  if (!vehicle || dealt === 0 || vehicle.alive === false) {
    return { dealt, health: vehicle ? vehicle.health : 0, killed: false, ignored: true };
  }
  vehicle.health = Math.max(0, vehicle.health - dealt);
  const killed = vehicle.health <= 0;
  if (killed) vehicle.alive = false;
  return { dealt, health: vehicle.health, killed, ignored: false };
}

/**
 * Integrate one tick of arcade driving.
 *
 * Steering is scaled by the signed speed divided by the top speed, so a
 * stationary vehicle does not turn and reversing mirrors the steering. Holding
 * the handbrake brakes hard and multiplies the turn rate. Movement is resolved
 * by {@link moveCircle} against the tile map; hitting a building scrubs most of
 * the speed, so a vehicle can never drive through one.
 *
 * @param {object} map Map or normalised grid (`{ width, height, tiles }`).
 * @param {Vehicle} vehicle
 * @param {DriveIntent} [intent]
 * @param {number} [dtSeconds=TICK_SECONDS]
 * @returns {{ moved: boolean, hitX: boolean, hitY: boolean, crashed: boolean, speed: number }}
 */
export function stepVehicle(map, vehicle, intent = {}, dtSeconds = TICK_SECONDS) {
  const idle = {
    moved: false,
    hitX: false,
    hitY: false,
    crashed: false,
    speed: vehicle && Number.isFinite(vehicle.speed) ? vehicle.speed : 0,
  };
  if (!vehicle || vehicle.alive === false) return idle;

  const dt = Number.isFinite(dtSeconds) ? Math.max(0, dtSeconds) : 0;
  const throttle = clamp(Number.isFinite(intent.throttle) ? intent.throttle : 0, -1, 1);
  const steer = clamp(Number.isFinite(intent.steer) ? intent.steer : 0, -1, 1);
  const handbrake = Boolean(intent.handbrake);

  let speed = Number.isFinite(vehicle.speed) ? vehicle.speed : 0;

  if (handbrake) {
    speed = moveToward(speed, 0, VEHICLE_HANDBRAKE_DECEL * dt);
  } else if (throttle > 0) {
    speed = clamp(speed + VEHICLE_ACCELERATION * throttle * dt, -VEHICLE_MAX_SPEED, VEHICLE_MAX_SPEED);
  } else if (throttle < 0) {
    if (speed > 0) speed = moveToward(speed, 0, VEHICLE_BRAKE * -throttle * dt);
    else speed = clamp(speed + VEHICLE_ACCELERATION * throttle * dt, -VEHICLE_REVERSE_SPEED, VEHICLE_REVERSE_SPEED);
  } else {
    speed = moveToward(speed, 0, VEHICLE_FRICTION * dt);
  }

  const grip = handbrake ? VEHICLE_HANDBRAKE_STEER_MULTIPLIER : 1;
  const speedRatio = clamp(speed / VEHICLE_MAX_SPEED, -1, 1);
  vehicle.angle = normalizeAngle(vehicle.angle + steer * VEHICLE_STEER_RATE * grip * speedRatio * dt);

  const startX = vehicle.x;
  const startY = vehicle.y;
  const dx = Math.cos(vehicle.angle) * speed * dt;
  const dy = Math.sin(vehicle.angle) * speed * dt;
  const moved = moveCircle(map, startX, startY, vehicle.radius, dx, dy);
  const crashed = (moved.hitX && dx !== 0) || (moved.hitY && dy !== 0);

  vehicle.x = moved.x;
  vehicle.y = moved.y;
  if (crashed) speed *= VEHICLE_CRASH_SPEED_FACTOR;
  vehicle.speed = speed;

  return {
    moved: moved.x !== startX || moved.y !== startY,
    hitX: moved.hitX,
    hitY: moved.hitY,
    crashed,
    speed,
  };
}

/**
 * Damage that a run-over deals at a given impact speed, scaled from 50% to
 * 100% of `VEHICLE_RUNOVER_DAMAGE` between the minimum and top speed. Zero
 * below the threshold, so a crawling vehicle does not hurt anyone.
 *
 * @param {number} speed Signed speed, in pixels/second.
 * @returns {number}
 */
export function runOverDamage(speed) {
  const s = Math.abs(Number.isFinite(speed) ? speed : 0);
  if (s < VEHICLE_RUNOVER_MIN_SPEED) return 0;
  const span = Math.max(1e-6, VEHICLE_MAX_SPEED - VEHICLE_RUNOVER_MIN_SPEED);
  const t = clamp((s - VEHICLE_RUNOVER_MIN_SPEED) / span, 0, 1);
  return Math.round(VEHICLE_RUNOVER_DAMAGE * (0.5 + 0.5 * t));
}

/**
 * Apply run-over damage to every entity the vehicle is currently touching.
 *
 * Damage is dealt once per contact: an entity that keeps overlapping the
 * vehicle is not damaged again until it leaves and re-enters. `vehicle.contacts`
 * tracks the entities touched on the last tick.
 *
 * @param {Vehicle} vehicle
 * @param {ReadonlyArray<{ id?: number|string, kind?: string, x: number, y: number, radius?: number, alive?: boolean }>} [targets]
 * @returns {Array<{ target: object, dealt: number, absorbed: number, health: number, killed: boolean }>}
 */
export function runOverDamageTick(vehicle, targets = []) {
  if (!vehicle || vehicle.alive === false || !Array.isArray(targets) || targets.length === 0) {
    if (vehicle) vehicle.contacts = new Set();
    return [];
  }
  const previous = vehicle.contacts instanceof Set ? vehicle.contacts : new Set();
  const damage = runOverDamage(vehicle.speed);
  const overlapping = new Set();
  const damaged = new Set();
  const hits = [];

  if (damage > 0) {
    const reach = Number.isFinite(vehicle.radius) ? vehicle.radius : VEHICLE_RADIUS;
    for (const target of targets) {
      if (!target || target === vehicle || target.alive === false || target.kind === 'vehicle') continue;
      if (!Number.isFinite(target.x) || !Number.isFinite(target.y) || !Number.isFinite(target.health)) continue;
      const tr = Number.isFinite(target.radius) ? target.radius : 0;
      const limit = reach + tr;
      const dx = target.x - vehicle.x;
      const dy = target.y - vehicle.y;
      if (dx * dx + dy * dy > limit * limit) continue;

      overlapping.add(target.id);
      if (damaged.has(target.id) || previous.has(target.id)) continue;
      damaged.add(target.id);
      const result = applyBulletDamage(target, damage);
      hits.push({ target, ...result });
    }
  }

  vehicle.contacts = overlapping;
  return hits;
}

/**
 * Apply damage to every live entity whose circle overlaps a blast, excluding the
 * blast source itself. Works for players, enemies and other vehicles alike.
 *
 * @param {ReadonlyArray<object>} entities
 * @param {number} x
 * @param {number} y
 * @param {number} radius
 * @param {number} damage
 * @param {{ exclude?: object|null }} [options]
 * @returns {Array<{ target: object, dealt: number, absorbed: number, health: number, killed: boolean }>}
 */
export function damageInRadius(entities, x, y, radius, damage, { exclude = null } = {}) {
  const hits = [];
  if (!Array.isArray(entities)) return hits;
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(radius) || radius <= 0) return hits;
  const dealt = Number.isFinite(damage) ? Math.max(0, damage) : 0;

  for (const entity of entities) {
    if (!entity || entity === exclude || entity.alive === false) continue;
    if (!Number.isFinite(entity.x) || !Number.isFinite(entity.y)) continue;
    const er = Number.isFinite(entity.radius) ? entity.radius : 0;
    const limit = radius + er;
    const dx = entity.x - x;
    const dy = entity.y - y;
    if (dx * dx + dy * dy > limit * limit) continue;
    hits.push({ target: entity, ...applyBulletDamage(entity, dealt) });
  }
  return hits;
}

/**
 * Detonate a vehicle: mark it destroyed and damage everything inside the blast
 * radius. Returns a description of the explosion and its hits.
 *
 * @param {Vehicle} vehicle
 * @param {ReadonlyArray<object>} [entities] Candidates, including the driver.
 * @param {object} [options]
 * @param {number} [options.damage=VEHICLE_EXPLOSION_DAMAGE]
 * @param {number} [options.radius=VEHICLE_EXPLOSION_RADIUS]
 * @returns {{ x: number, y: number, radius: number, damage: number, hits: Array<object> }}
 */
export function explodeVehicle(vehicle, entities = [], { damage = VEHICLE_EXPLOSION_DAMAGE, radius = VEHICLE_EXPLOSION_RADIUS } = {}) {
  if (!vehicle) return { x: 0, y: 0, radius: 0, damage: 0, hits: [] };
  const x = vehicle.x;
  const y = vehicle.y;

  vehicle.health = 0;
  vehicle.alive = false;
  vehicle.exploded = true;
  vehicle.speed = 0;
  vehicle.occupiedBy = null;

  return { x, y, radius, damage, hits: damageInRadius(entities, x, y, radius, damage, { exclude: vehicle }) };
}

/**
 * The closest enterable vehicle within range of a point.
 *
 * @param {ReadonlyArray<Vehicle>} vehicles
 * @param {number} x
 * @param {number} y
 * @param {number} [range=VEHICLE_ENTER_RANGE] Centre distance to the hull edge.
 * @returns {Vehicle|null}
 */
export function findNearestVehicle(vehicles, x, y, range = VEHICLE_ENTER_RANGE) {
  if (!Array.isArray(vehicles) || !Number.isFinite(x) || !Number.isFinite(y)) return null;
  const reach = Number.isFinite(range) && range > 0 ? range : VEHICLE_ENTER_RANGE;

  let best = null;
  let bestDistanceSq = Infinity;
  for (const vehicle of vehicles) {
    if (!vehicle || vehicle.alive === false || vehicle.occupiedBy !== null) continue;
    if (!Number.isFinite(vehicle.x) || !Number.isFinite(vehicle.y)) continue;
    const vr = Number.isFinite(vehicle.radius) ? vehicle.radius : 0;
    const dx = vehicle.x - x;
    const dy = vehicle.y - y;
    const distanceSq = dx * dx + dy * dy;
    const limit = reach + vr;
    if (distanceSq > limit * limit) continue;
    if (distanceSq < bestDistanceSq) {
      bestDistanceSq = distanceSq;
      best = vehicle;
    }
  }
  return best;
}

/**
 * Find a vehicle by id.
 *
 * @param {ReadonlyArray<Vehicle>} vehicles
 * @param {number|string|null|undefined} id
 * @returns {Vehicle|null}
 */
export function findVehicleById(vehicles, id) {
  if (!Array.isArray(vehicles) || id === null || id === undefined) return null;
  return vehicles.find((vehicle) => vehicle && vehicle.id === id) ?? null;
}

/**
 * Choose a spot to leave a vehicle at, clear of buildings and the map edge.
 *
 * Eight directions are tried at increasing distances around the vehicle; the
 * first spot where the player circle fits is returned. `null` means every
 * candidate is blocked, so the player must stay in the vehicle.
 *
 * @param {object} map Map or normalised grid.
 * @param {Vehicle} vehicle
 * @param {number} [playerRadius=PLAYER_RADIUS]
 * @returns {{ x: number, y: number }|null}
 */
export function findExitPosition(map, vehicle, playerRadius = PLAYER_RADIUS) {
  if (!vehicle || !map) return null;
  const radius = Number.isFinite(playerRadius) && playerRadius > 0 ? playerRadius : PLAYER_RADIUS;
  const hull = Number.isFinite(vehicle.radius) ? vehicle.radius : VEHICLE_RADIUS;
  const base = hull + radius + VEHICLE_EXIT_CLEARANCE;
  const distances = [base, base + TILE_SIZE * 0.5, base + TILE_SIZE];

  for (const distance of distances) {
    for (let i = 0; i < 8; i += 1) {
      const angle = vehicle.angle + (i * Math.PI) / 4;
      const x = vehicle.x + Math.cos(angle) * distance;
      const y = vehicle.y + Math.sin(angle) * distance;
      if (canStandAt(map, x, y, radius)) return { x, y };
    }
  }
  return null;
}

/**
 * Put a player into a vehicle: claims the seat and snaps the player to it.
 *
 * @param {Vehicle} vehicle
 * @param {object} player
 * @returns {boolean} `true` when the player entered.
 */
export function enterVehicle(vehicle, player) {
  if (!vehicle || !player || vehicle.alive === false || vehicle.occupiedBy !== null) return false;
  vehicle.occupiedBy = player.id;
  player.vehicleId = vehicle.id;
  player.x = vehicle.x;
  player.y = vehicle.y;
  player.aim = vehicle.angle;
  return true;
}

/**
 * Put a player out of a vehicle at a safe spot. When no safe spot exists the
 * player stays inside and `null` is returned, so a player can never be placed
 * inside a building.
 *
 * @param {Vehicle} vehicle
 * @param {object} player
 * @param {object} map
 * @returns {{ x: number, y: number }|null}
 */
export function exitVehicle(vehicle, player, map) {
  if (!vehicle || !player) return null;
  const position = findExitPosition(map, vehicle, player.radius);
  if (!position) return null;
  player.x = position.x;
  player.y = position.y;
  player.vehicleId = null;
  vehicle.occupiedBy = null;
  return position;
}
