/**
 * Enemy AI: line-of-sight, a four-state machine, steering and fire cadence.
 *
 * This module is pure: it never touches the DOM, `window` or `document`, so it
 * runs unchanged under Node and in the browser. It operates on the plain enemy
 * objects from `core/enemy.js` and the tile grid from `core/map.js`.
 *
 * ## State machine
 *
 * ```text
 *            sees target                     within attackRange && sees target
 *   idle ───────────────▶ chase ───────────────────────────────▶ attack
 *     │                    │  ▲                                     │
 *     │ idleTicks elapsed  │  └─────────── target moves out of range ┘
 *     ▼                    │
 *   patrol ──── sees target┘
 *     ▲                    │
 *     └──── no line-of-sight for loseSightTicks ticks ──────────┘
 * ```
 *
 * The `loseSightTicks` timeout is per archetype (`ENEMY_TYPES[type].loseSightTicks`)
 * and is **documented behaviour**: once it elapses the enemy forgets the player
 * and returns to patrol.
 *
 * ## Determinism
 *
 * The only randomness is patrol-point selection and firing spread, both drawn
 * from the rng passed to {@link aiTick}. With a seeded rng (`core/rng.js`) the
 * whole transition sequence is reproducible.
 *
 * @module core/ai
 */

import { TICK_SECONDS, TILE_SIZE } from './constants.js';
import { clamp, distance, fromAngle, rayAabbIntersection } from './geometry.js';
import { canStandAt, isSolidAt, moveCircle, tileBounds } from './map.js';
import { isEnemyAlive, enemySpec } from './enemy.js';
import { weaponSpec, spreadAngles } from './weapons.js';
import { ttlTicksFor } from './bullet.js';

/** The four AI states. @type {Readonly<Record<string, string>>} */
export const AI_STATES = Object.freeze({
  IDLE: 'idle',
  PATROL: 'patrol',
  CHASE: 'chase',
  ATTACK: 'attack',
});

/** How close (pixels) an enemy must be to a patrol waypoint to consider it reached. */
export const PATROL_ARRIVE_RADIUS = 12;

/** Patrol waypoint sampling: minimum and maximum distance from home, in pixels. */
export const PATROL_MIN_DISTANCE = TILE_SIZE;
export const PATROL_MAX_DISTANCE = TILE_SIZE * 5;

/** How many rng draws to spend looking for a walkable patrol waypoint. */
export const PATROL_ATTEMPTS = 8;

/**
 * @typedef {object} AiContext
 * @property {object} [player] Target to sense and attack.
 * @property {() => number} [rng=Math.random] Random source in `[0, 1)`.
 * @property {number} [dtSeconds=TICK_SECONDS]
 *
 * @typedef {object} AiResult
 * @property {string} state State after the tick.
 * @property {string} previousState State before the tick.
 * @property {boolean} visible Did the enemy have line-of-sight to the target?
 * @property {boolean} fired Did the enemy fire this tick?
 * @property {object[]} bullets Projectile spawn descriptors (empty unless fired).
 * @property {boolean} lostTarget Did it give up on the target this tick?
 * @property {boolean} alerted Did it newly acquire the target this tick?
 */

/**
 * Is there an unobstructed line between two world points?
 *
 * The segment is tested against every solid tile in its bounding box using a
 * ray/AABB intersection, so a thin wall can never be missed regardless of the
 * sampling rate. Out-of-bounds tiles count as solid, so an off-map target is
 * never visible.
 *
 * @param {object} map Map or normalised grid (`{ width, height, tiles }`).
 * @param {number} ax Segment start x.
 * @param {number} ay Segment start y.
 * @param {number} bx Segment end x.
 * @param {number} by Segment end y.
 * @param {number} [radius=0] Inflate the tiles by this radius (entity thickness).
 * @returns {boolean} `true` when nothing solid blocks the segment.
 */
export function lineOfSight(map, ax, ay, bx, by, radius = 0) {
  if (!map) return true;
  if (![ax, ay, bx, by].every((value) => Number.isFinite(value))) return false;

  const dx = bx - ax;
  const dy = by - ay;
  if (dx === 0 && dy === 0) return !isSolidAt(map, Math.floor(ax / TILE_SIZE), Math.floor(ay / TILE_SIZE));

  const pad = Number.isFinite(radius) && radius > 0 ? radius : 0;
  const minTx = Math.floor((Math.min(ax, bx) - pad) / TILE_SIZE);
  const maxTx = Math.floor((Math.max(ax, bx) + pad) / TILE_SIZE);
  const minTy = Math.floor((Math.min(ay, by) - pad) / TILE_SIZE);
  const maxTy = Math.floor((Math.max(ay, by) + pad) / TILE_SIZE);

  for (let ty = minTy; ty <= maxTy; ty += 1) {
    for (let tx = minTx; tx <= maxTx; tx += 1) {
      if (!isSolidAt(map, tx, ty)) continue;
      const bounds = tileBounds(tx, ty);
      const box = {
        x: bounds.x - pad,
        y: bounds.y - pad,
        w: bounds.w + pad * 2,
        h: bounds.h + pad * 2,
      };
      const t = rayAabbIntersection({ x: ax, y: ay }, { x: dx, y: dy }, box);
      if (t !== null && t >= 0 && t <= 1) return false;
    }
  }
  return true;
}

/**
 * Can the enemy see the target right now? Requires a live target within
 * `sightRange` and an unobstructed line of sight.
 *
 * @param {object} map
 * @param {object} enemy
 * @param {object} target
 * @param {object} [spec=enemySpec(enemy?.type)]
 * @returns {boolean}
 */
export function canSee(map, enemy, target, spec = enemySpec(enemy?.type)) {
  if (!enemy || !target || target.alive === false) return false;

  const range = Number.isFinite(spec?.sightRange) ? spec.sightRange : 0;
  if (distance(enemy, target) > range) return false;
  return lineOfSight(map, enemy.x, enemy.y, target.x, target.y, enemy.radius);
}

/**
 * Move an enemy one step towards a world point, sliding along buildings.
 *
 * When the direct step is blocked the enemy tries a perpendicular step, which
 * lets it round a corner instead of pressing into the wall. The enemy is
 * mutated in place.
 *
 * @param {object} map
 * @param {object} enemy
 * @param {number} targetX
 * @param {number} targetY
 * @param {number} [dtSeconds=TICK_SECONDS]
 * @returns {{ moved: boolean, x: number, y: number }}
 */
export function steerToward(map, enemy, targetX, targetY, dtSeconds = TICK_SECONDS) {
  if (!enemy) return { moved: false, x: 0, y: 0 };
  const dx = targetX - enemy.x;
  const dy = targetY - enemy.y;
  const length = Math.hypot(dx, dy);
  if (length === 0 || !map) return { moved: false, x: enemy.x, y: enemy.y };

  const dt = Number.isFinite(dtSeconds) ? Math.max(0, dtSeconds) : 0;
  const step = Math.max(0, enemy.speed) * dt;
  const ux = dx / length;
  const uy = dy / length;

  let result = moveCircle(map, enemy.x, enemy.y, enemy.radius, ux * step, uy * step);
  if (result.x === enemy.x && result.y === enemy.y && step > 0) {
    result = moveCircle(map, enemy.x, enemy.y, enemy.radius, -uy * step, ux * step);
  }

  const moved = result.x !== enemy.x || result.y !== enemy.y;
  enemy.x = result.x;
  enemy.y = result.y;
  enemy.aim = Math.atan2(uy, ux);
  return { moved, x: enemy.x, y: enemy.y };
}

/**
 * Pick a walkable patrol waypoint near the enemy's home. Draws a bounded number
 * of candidates from the rng and falls back to home, so it always terminates.
 *
 * @param {object} map
 * @param {object} enemy
 * @param {() => number} [rng=Math.random]
 * @returns {{ x: number, y: number }}
 */
export function choosePatrolTarget(map, enemy, rng = Math.random) {
  const home = enemy?.home ?? { x: enemy?.x ?? 0, y: enemy?.y ?? 0 };
  const random = typeof rng === 'function' ? rng : Math.random;

  for (let attempt = 0; attempt < PATROL_ATTEMPTS; attempt += 1) {
    const angle = random() * Math.PI * 2;
    const span = PATROL_MAX_DISTANCE - PATROL_MIN_DISTANCE;
    const dist = PATROL_MIN_DISTANCE + random() * span;
    const x = home.x + Math.cos(angle) * dist;
    const y = home.y + Math.sin(angle) * dist;
    if (!map || canStandAt(map, x, y, enemy.radius)) return { x, y };
  }
  return { x: home.x, y: home.y };
}

/**
 * Move a random-walking enemy whose current waypoint has been reached.
 *
 * @param {object} map
 * @param {object} enemy
 * @param {() => number} rng
 */
function ensurePatrolTarget(map, enemy, rng) {
  if (!enemy.patrolTarget) {
    enemy.patrolTarget = choosePatrolTarget(map, enemy, rng);
  }
}

/**
 * Change state, recording the previous value on the enemy.
 *
 * @param {object} enemy
 * @param {string} next
 * @returns {boolean} `true` when the state actually changed.
 */
function setState(enemy, next) {
  if (enemy.state === next) return false;
  enemy.previousState = enemy.state;
  enemy.state = next;
  return true;
}

/**
 * Build the projectile spawn descriptors for one enemy shot.
 *
 * @param {object} enemy
 * @param {object} spec Archetype spec.
 * @param {number} aimAngle
 * @param {() => number} rng
 * @returns {object[]}
 */
function fire(enemy, spec, aimAngle, rng) {
  const weapon = weaponSpec(spec.weapon);
  const offsets = spreadAngles(
    { pellets: spec.pellets ?? weapon.pellets, spreadRad: spec.spreadRad ?? weapon.spreadRad },
    rng,
  );
  const ttl = ttlTicksFor({
    bulletSpeed: spec.bulletSpeed ?? weapon.bulletSpeed,
    bulletRange: spec.bulletRange ?? weapon.bulletRange,
  });

  return offsets.map((offset) => {
    const angle = aimAngle + offset;
    const velocity = fromAngle(angle, spec.bulletSpeed ?? weapon.bulletSpeed);
    return {
      x: enemy.x,
      y: enemy.y,
      vx: velocity.x,
      vy: velocity.y,
      angle,
      damage: spec.damage,
      ttl,
      weapon: spec.weapon,
    };
  });
}

/**
 * Advance one enemy's behaviour by a single tick.
 *
 * @param {object} map Map or normalised grid.
 * @param {object} enemy
 * @param {AiContext} [context]
 * @returns {AiResult}
 */
export function aiTick(map, enemy, { player, rng = Math.random, dtSeconds = TICK_SECONDS } = {}) {
  const previousState = enemy?.state ?? AI_STATES.IDLE;
  const result = {
    state: previousState,
    previousState,
    visible: false,
    fired: false,
    bullets: [],
    lostTarget: false,
    alerted: false,
  };
  if (!isEnemyAlive(enemy)) return result;

  const spec = enemySpec(enemy.type);
  const random = typeof rng === 'function' ? rng : Math.random;

  if (enemy.cooldown > 0) enemy.cooldown -= 1;

  const visible = canSee(map, enemy, player, spec);
  result.visible = visible;

  if (visible) {
    enemy.lostTicks = 0;
    enemy.idleTicks = 0;
    enemy.lastKnown = { x: player.x, y: player.y };
    const inRange = distance(enemy, player) <= spec.attackRange;
    setState(enemy, inRange ? AI_STATES.ATTACK : AI_STATES.CHASE);
  } else if (enemy.state === AI_STATES.ATTACK || enemy.state === AI_STATES.CHASE) {
    enemy.lostTicks += 1;
    if (enemy.lostTicks > spec.loseSightTicks) {
      setState(enemy, AI_STATES.PATROL);
      enemy.lastKnown = null;
      enemy.patrolTarget = null;
      enemy.idleTicks = 0;
      result.lostTarget = true;
    } else if (enemy.state === AI_STATES.ATTACK) {
      setState(enemy, AI_STATES.CHASE);
    }
  }

  switch (enemy.state) {
    case AI_STATES.ATTACK: {
      const targetX = enemy.lastKnown?.x ?? player?.x ?? enemy.x;
      const targetY = enemy.lastKnown?.y ?? player?.y ?? enemy.y;
      enemy.aim = Math.atan2(targetY - enemy.y, targetX - enemy.x);
      if (visible && enemy.cooldown <= 0) {
        result.bullets = fire(enemy, spec, enemy.aim, random);
        enemy.cooldown = spec.fireDelayTicks;
        result.fired = true;
      }
      break;
    }
    case AI_STATES.CHASE: {
      const target = visible ? player : enemy.lastKnown;
      if (target) {
        const arrived = distance(enemy, target) <= PATROL_ARRIVE_RADIUS;
        if (visible || !arrived) {
          steerToward(map, enemy, target.x, target.y, dtSeconds);
        }
      } else {
        setState(enemy, AI_STATES.IDLE);
      }
      break;
    }
    case AI_STATES.PATROL: {
      ensurePatrolTarget(map, enemy, random);
      const waypoint = enemy.patrolTarget;
      if (waypoint) {
        const reached = steerToward(map, enemy, waypoint.x, waypoint.y, dtSeconds);
        if (!reached.moved && distance(enemy, waypoint) <= PATROL_ARRIVE_RADIUS) {
          enemy.patrolTarget = null;
        }
      }
      break;
    }
    default: {
      enemy.idleTicks += 1;
      if (enemy.idleTicks >= spec.idleTicks) {
        setState(enemy, AI_STATES.PATROL);
        enemy.patrolTarget = null;
        ensurePatrolTarget(map, enemy, random);
      }
    }
  }

  result.alerted = (previousState === AI_STATES.IDLE || previousState === AI_STATES.PATROL) &&
    (enemy.state === AI_STATES.CHASE || enemy.state === AI_STATES.ATTACK);
  result.state = enemy.state;
  return result;
}
