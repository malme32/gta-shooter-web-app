/**
 * Projectiles: movement, swept collision, lifetime and damage.
 *
 * This module is pure: it never touches the DOM, `window` or `document`, so it
 * runs unchanged under Node and in the browser.
 *
 * ## No tunnelling
 *
 * Bullets move far enough in a single 60 Hz tick (a rifle round covers 15 px,
 * a third of a tile) that a naive "move then test" step can skip straight over
 * a thin wall. Instead {@link stepBullet} *sweeps* the bullet's whole movement
 * for the tick: it expands every nearby solid tile by the bullet radius and
 * ray-casts the movement segment against it, stopping at the earliest hit. A
 * one-tile wall can therefore never be jumped over, however fast the round.
 *
 * The swept segment (`prevX/prevY` -> `x/y`) is also what target collision uses
 * ({@link findBulletTarget}), so a target standing between two ticks cannot be
 * missed either.
 *
 * @module core/bullet
 */

import { BULLET_RADIUS, TICK_SECONDS, TILE_SIZE } from './constants.js';
import { clamp, rayAabbIntersection, segmentCircleOverlap } from './geometry.js';
import { isSolidAt, tileBounds } from './map.js';

/**
 * @typedef {object} Bullet
 * @property {number|string} id
 * @property {'bullet'} kind
 * @property {number} x
 * @property {number} y
 * @property {number} prevX Position at the start of the last tick.
 * @property {number} prevY
 * @property {number} vx Velocity, in pixels per second.
 * @property {number} vy
 * @property {number} angle Travel direction, in radians.
 * @property {number} radius Collision radius, in pixels.
 * @property {number} damage
 * @property {number} ttl Ticks of life remaining.
 * @property {number} maxTtl Ticks of life at spawn.
 * @property {boolean} alive
 * @property {number|string|null} owner Firing entity id (never hit by own round).
 * @property {string|null} weapon Weapon id that fired the round.
 */

/**
 * @typedef {object} StepResult
 * @property {boolean} moved Did the bullet move this tick?
 * @property {boolean} hitWall Did the movement stop against a solid tile?
 * @property {{ tx: number, ty: number } | null} wall The tile hit, if any.
 * @property {boolean} expired Did the bullet run out of life?
 */

/**
 * Lifetime in ticks for a weapon, derived from its range and muzzle velocity:
 * `ceil(range / (speed * TICK_SECONDS))`, floored at one tick.
 *
 * @param {{ bulletSpeed?: number, bulletRange?: number }} spec
 * @returns {number}
 */
export function ttlTicksFor(spec) {
  const speed = Number.isFinite(spec?.bulletSpeed) && spec.bulletSpeed > 0 ? spec.bulletSpeed : 0;
  const range = Number.isFinite(spec?.bulletRange) ? spec.bulletRange : 0;
  if (speed === 0 || range <= 0) return 1;
  return Math.max(1, Math.ceil(range / (speed * TICK_SECONDS)));
}

/**
 * Create a live bullet.
 *
 * @param {object} [options]
 * @param {number|string} [options.id=0]
 * @param {number} [options.x=0]
 * @param {number} [options.y=0]
 * @param {number} [options.vx=0] Velocity, in pixels per second.
 * @param {number} [options.vy=0]
 * @param {number} [options.damage=0]
 * @param {number} [options.ttl=1] Lifetime in ticks.
 * @param {number|string|null} [options.owner=null]
 * @param {string|null} [options.weapon=null]
 * @param {number} [options.radius=BULLET_RADIUS]
 * @param {number} [options.angle] Travel angle; defaults to the velocity angle.
 * @returns {Bullet}
 */
export function createBullet({
  id = 0,
  x = 0,
  y = 0,
  vx = 0,
  vy = 0,
  damage = 0,
  ttl = 1,
  owner = null,
  weapon = null,
  radius = BULLET_RADIUS,
  angle,
} = {}) {
  const travel = Number.isFinite(angle) ? angle : Math.atan2(vy, vx);
  const life = Number.isFinite(ttl) ? Math.max(0, Math.trunc(ttl)) : 0;

  return {
    id,
    kind: 'bullet',
    x,
    y,
    prevX: x,
    prevY: y,
    vx,
    vy,
    angle: travel,
    radius,
    damage: Number.isFinite(damage) ? damage : 0,
    ttl: life,
    maxTtl: life,
    alive: true,
    owner,
    weapon,
  };
}

/**
 * World-space AABB of a bullet (used by tests and debug drawing).
 *
 * @param {Bullet} bullet
 * @returns {{ x: number, y: number, w: number, h: number }}
 */
export function bulletAabb(bullet) {
  const r = Number.isFinite(bullet?.radius) ? bullet.radius : BULLET_RADIUS;
  const x = Number.isFinite(bullet?.x) ? bullet.x : 0;
  const y = Number.isFinite(bullet?.y) ? bullet.y : 0;
  return { x: x - r, y: y - r, w: r * 2, h: r * 2 };
}

/**
 * Sweep a circle of radius `r` through a translation `(dx, dy)` and stop at the
 * first solid tile. Uses a Minkowski-expanded AABB per candidate tile, which is
 * conservative at tile corners (it may clip a corner a fraction early) but can
 * never let a bullet pass through a wall.
 *
 * @param {object} map Map or normalised grid (`{ width, height, tiles }`).
 * @param {number} x Start x.
 * @param {number} y Start y.
 * @param {number} r Collision radius.
 * @param {number} dx Movement this step.
 * @param {number} dy
 * @returns {{ x: number, y: number, hit: boolean, t: number, tx: number, ty: number }}
 *   The stopped position, whether a wall was hit, the fraction of the movement
 *   travelled (`0..1`) and the tile hit (`-1,-1` when none).
 */
export function sweepCircleTiles(map, x, y, r, dx, dy) {
  const radius = Number.isFinite(r) && r > 0 ? r : 0;
  const moveX = Number.isFinite(dx) ? dx : 0;
  const moveY = Number.isFinite(dy) ? dy : 0;
  if (moveX === 0 && moveY === 0) {
    return { x, y, hit: false, t: 0, tx: -1, ty: -1 };
  }
  if (!map) {
    return { x: x + moveX, y: y + moveY, hit: false, t: 1, tx: -1, ty: -1 };
  }

  const minTx = Math.floor((Math.min(x, x + moveX) - radius) / TILE_SIZE);
  const maxTx = Math.floor((Math.max(x, x + moveX) + radius) / TILE_SIZE);
  const minTy = Math.floor((Math.min(y, y + moveY) - radius) / TILE_SIZE);
  const maxTy = Math.floor((Math.max(y, y + moveY) + radius) / TILE_SIZE);

  let bestT = Infinity;
  let hitTx = -1;
  let hitTy = -1;

  for (let ty = minTy; ty <= maxTy; ty += 1) {
    for (let tx = minTx; tx <= maxTx; tx += 1) {
      if (!isSolidAt(map, tx, ty)) continue;
      const bounds = tileBounds(tx, ty);
      const box = {
        x: bounds.x - radius,
        y: bounds.y - radius,
        w: bounds.w + radius * 2,
        h: bounds.h + radius * 2,
      };
      const t = rayAabbIntersection({ x, y }, { x: moveX, y: moveY }, box);
      if (t === null || t > 1 || t >= bestT) continue;
      bestT = t;
      hitTx = tx;
      hitTy = ty;
    }
  }

  if (bestT === Infinity) {
    return { x: x + moveX, y: y + moveY, hit: false, t: 1, tx: -1, ty: -1 };
  }

  const t = clamp(bestT, 0, 1);
  return { x: x + moveX * t, y: y + moveY * t, hit: true, t, tx: hitTx, ty: hitTy };
}

/**
 * Advance a bullet by one tick: sweep its movement against the tiles, update
 * its position and count its lifetime down.
 *
 * A bullet that hits a wall or reaches zero ttl is marked dead. The bullet is
 * mutated in place; callers use the returned result to emit events.
 *
 * @param {object} map
 * @param {Bullet} bullet
 * @param {number} [dtSeconds=TICK_SECONDS]
 * @returns {StepResult}
 */
export function stepBullet(map, bullet, dtSeconds = TICK_SECONDS) {
  if (!bullet || bullet.alive === false) {
    return { moved: false, hitWall: false, wall: null, expired: false };
  }

  const dt = Number.isFinite(dtSeconds) ? Math.max(0, dtSeconds) : 0;
  bullet.prevX = bullet.x;
  bullet.prevY = bullet.y;

  const sweep = sweepCircleTiles(
    map,
    bullet.x,
    bullet.y,
    bullet.radius,
    bullet.vx * dt,
    bullet.vy * dt,
  );
  bullet.x = sweep.x;
  bullet.y = sweep.y;
  bullet.ttl -= 1;

  const expired = bullet.ttl <= 0;
  if (sweep.hit || expired) bullet.alive = false;

  return {
    moved: true,
    hitWall: sweep.hit,
    wall: sweep.hit ? { tx: sweep.tx, ty: sweep.ty } : null,
    expired,
  };
}

/**
 * The nearest live target whose circle overlaps this tick's swept path.
 *
 * The bullet's owner is skipped, so a shot can never hit whoever fired it.
 *
 * @param {Bullet} bullet
 * @param {ReadonlyArray<{ id?: number|string, x: number, y: number, radius?: number, alive?: boolean }>} [targets]
 * @returns {{ target: object, distanceSq: number } | null}
 */
export function findBulletTarget(bullet, targets = []) {
  if (!bullet || !Array.isArray(targets)) return null;

  const segment = { x1: bullet.prevX, y1: bullet.prevY, x2: bullet.x, y2: bullet.y };
  const bulletRadius = Number.isFinite(bullet.radius) ? bullet.radius : BULLET_RADIUS;
  let best = null;
  let bestDistanceSq = Infinity;

  for (const target of targets) {
    if (!target || target.alive === false) continue;
    if (bullet.owner !== null && bullet.owner !== undefined && target.id === bullet.owner) continue;
    if (!Number.isFinite(target.x) || !Number.isFinite(target.y)) continue;

    const targetRadius = Number.isFinite(target.radius) ? target.radius : 0;
    if (!segmentCircleOverlap(segment, { x: target.x, y: target.y, r: targetRadius + bulletRadius })) {
      continue;
    }

    const dx = target.x - bullet.prevX;
    const dy = target.y - bullet.prevY;
    const distanceSq = dx * dx + dy * dy;
    if (distanceSq < bestDistanceSq) {
      bestDistanceSq = distanceSq;
      best = { target, distanceSq };
    }
  }

  return best;
}

/**
 * Apply damage to any actor, draining armour before health. Works for enemies
 * that have no armour fields (treated as zero armour).
 *
 * @param {object} target
 * @param {number} amount
 * @returns {{ dealt: number, absorbed: number, health: number, killed: boolean }}
 */
export function applyBulletDamage(target, amount) {
  const dealt = Number.isFinite(amount) ? Math.max(0, amount) : 0;
  if (!target || dealt === 0 || target.alive === false) {
    return { dealt, absorbed: 0, health: target?.health ?? 0, killed: false };
  }

  const armour = Number.isFinite(target.armour) ? Math.max(0, target.armour) : 0;
  const maxArmour = Number.isFinite(target.maxArmour) ? target.maxArmour : armour;
  const absorbed = Math.min(armour, dealt);
  const health = Number.isFinite(target.health) ? target.health : 0;

  target.armour = clamp(armour - absorbed, 0, maxArmour);
  target.health = Math.max(0, health - (dealt - absorbed));
  target.alive = target.health > 0;

  return { dealt, absorbed, health: target.health, killed: !target.alive };
}
