/**
 * Enemy entities: archetype stats, health, damage, death and loot.
 *
 * This module is pure: it never touches the DOM, `window` or `document`, so it
 * runs unchanged under Node and in the browser. It owns the *data* side of the
 * enemy system; the decision-making (idle/patrol/chase/attack) lives in
 * `core/ai.js` and the simulation wiring in `core/game.js`.
 *
 * ## Archetypes
 *
 * Three archetypes ship out of the box — `thug` (close-range pistol), `shooter`
 * (longer-range SMG) and `brute` (armoured shotgun) — all described by the
 * frozen {@link ENEMY_TYPES} table. Every field that affects gameplay is a tick
 * count, so behaviour is independent of the render rate.
 *
 * ## Loot
 *
 * Each archetype carries a `loot` descriptor: a drop `chance` plus a weighted
 * table of pickups. {@link rollLoot} draws from it with a caller-supplied rng,
 * so a seeded game drops exactly the same loot every run.
 *
 * @module core/enemy
 */

import { clamp } from './geometry.js';
import { applyBulletDamage } from './bullet.js';
import { createPickup, PICKUP_RADIUS } from './pickup.js';

// The pickup data type and its factory live in `core/pickup.js`; re-export them
// here so the enemy loot table and the pickup system share one implementation.
export { createPickup, PICKUP_RADIUS };

/**
 * @typedef {object} LootDrop
 * @property {'cash'|'health'|'armour'|'ammo'} type
 * @property {number} amount
 *
 * @typedef {object} LootTableEntry
 * @property {LootDrop['type']} type
 * @property {number} weight Relative draw weight.
 * @property {number} min Minimum amount (inclusive).
 * @property {number} max Maximum amount (inclusive).
 *
 * @typedef {object} LootSpec
 * @property {number} chance Probability in `[0,1]` that anything drops.
 * @property {LootTableEntry[]} table Weighted pickup table.
 *
 * @typedef {object} Pickup
 * @property {number|string} id
 * @property {'pickup'} kind
 * @property {LootDrop['type']} pickupType
 * @property {number} x
 * @property {number} y
 * @property {number} radius Collision radius, in pixels.
 * @property {number} amount
 * @property {boolean} alive
 *
 * @typedef {object} Enemy
 * @property {number|string} id
 * @property {'enemy'} kind
 * @property {string} type Archetype id.
 * @property {string} name Display name.
 * @property {number} x
 * @property {number} y
 * @property {Vec} home Spawn point, used as the patrol anchor.
 * @property {number} radius Collision radius, in pixels.
 * @property {number} speed Base movement speed, in pixels per second.
 * @property {number} maxHealth
 * @property {number} health
 * @property {number} maxArmour
 * @property {number} armour
 * @property {boolean} alive
 * @property {number} aim Facing angle, in radians.
 * @property {number} cooldown Ticks until the next shot may be fired.
 * @property {boolean} police Whether this is a police responder (wanted system).
 * @property {string} state Current AI state (see `core/ai.js`).
 * @property {number} lostTicks Ticks since the target was last seen.
 * @property {number} idleTicks Ticks spent idle.
 * @property {{ x: number, y: number }|null} lastKnown Where the target was last seen.
 * @property {{ x: number, y: number }|null} patrolTarget Current patrol waypoint.
 * @property {number} patrolTicks Ticks spent walking to the current waypoint.
 * @property {boolean} deadHandled Whether death has been reaped (loot rolled).
 */

/**
 * @typedef {object} EnemySpec
 * @property {string} id
 * @property {string} name
 * @property {number} maxHealth
 * @property {number} armour
 * @property {number} radius
 * @property {number} speed
 * @property {number} sightRange How far the enemy can see, in pixels.
 * @property {number} attackRange Distance at which it stops and fires.
 * @property {number} loseSightTicks Ticks without line-of-sight before it gives up.
 * @property {number} idleTicks Ticks spent idle before starting a patrol.
 * @property {number} fireDelayTicks Ticks between shots (fire cadence).
 * @property {number} damage Per-pellet damage.
 * @property {number} spreadRad Half-angle of the firing cone, in radians.
 * @property {number} pellets Projectiles per shot.
 * @property {string} weapon Weapon id used for projectile speed/range.
 * @property {number} bulletSpeed Muzzle velocity override, in pixels per second.
 * @property {number} bulletRange Effective range override, in pixels.
 * @property {LootSpec} loot
 * @property {boolean} [police] Marks a police responder spawned by the wanted
 *   system (`core/wanted.js`); civilians leave this unset.
 */

/** Archetype ids in a fixed order, for deterministic spawning. @type {ReadonlyArray<string>} */
export const ENEMY_TYPE_IDS = Object.freeze(['thug', 'shooter', 'brute']);

/**
 * Police archetype ids in escalating order of strength. The wanted system
 * spawns these by star level (`core/wanted.js`); they are deliberately kept out
 * of {@link ENEMY_TYPE_IDS} so a map's ambient squad never starts with police.
 *
 * @type {ReadonlyArray<string>}
 */
export const POLICE_TYPE_IDS = Object.freeze(['cop', 'swat', 'riot']);

/**
 * Frozen archetype tuning table.
 *
 * @type {Readonly<Record<string, EnemySpec>>}
 */
export const ENEMY_TYPES = Object.freeze({
  thug: Object.freeze({
    id: 'thug',
    name: 'Thug',
    maxHealth: 60,
    armour: 0,
    radius: 11,
    speed: 95,
    sightRange: 340,
    attackRange: 240,
    loseSightTicks: 150,
    idleTicks: 45,
    fireDelayTicks: 42,
    damage: 10,
    spreadRad: 0.1,
    pellets: 1,
    weapon: 'pistol',
    bulletSpeed: 640,
    bulletRange: 420,
    loot: Object.freeze({
      chance: 0.5,
      table: Object.freeze([
        Object.freeze({ type: 'cash', weight: 4, min: 10, max: 40 }),
        Object.freeze({ type: 'ammo', weight: 3, min: 6, max: 14 }),
        Object.freeze({ type: 'health', weight: 1, min: 15, max: 25 }),
        Object.freeze({ type: 'armour', weight: 1, min: 10, max: 20 }),
      ]),
    }),
  }),
  shooter: Object.freeze({
    id: 'shooter',
    name: 'Shooter',
    maxHealth: 80,
    armour: 0,
    radius: 11,
    speed: 110,
    sightRange: 460,
    attackRange: 380,
    loseSightTicks: 180,
    idleTicks: 30,
    fireDelayTicks: 20,
    damage: 8,
    spreadRad: 0.07,
    pellets: 1,
    weapon: 'smg',
    bulletSpeed: 720,
    bulletRange: 480,
    loot: Object.freeze({
      chance: 0.7,
      table: Object.freeze([
        Object.freeze({ type: 'cash', weight: 3, min: 20, max: 70 }),
        Object.freeze({ type: 'ammo', weight: 4, min: 7, max: 21 }),
        Object.freeze({ type: 'health', weight: 2, min: 15, max: 30 }),
        Object.freeze({ type: 'armour', weight: 2, min: 15, max: 30 }),
      ]),
    }),
  }),
  brute: Object.freeze({
    id: 'brute',
    name: 'Brute',
    maxHealth: 220,
    armour: 50,
    radius: 16,
    speed: 70,
    sightRange: 300,
    attackRange: 150,
    loseSightTicks: 210,
    idleTicks: 60,
    fireDelayTicks: 60,
    damage: 12,
    spreadRad: 0.2,
    pellets: 6,
    weapon: 'shotgun',
    bulletSpeed: 600,
    bulletRange: 260,
    loot: Object.freeze({
      chance: 0.9,
      table: Object.freeze([
        Object.freeze({ type: 'cash', weight: 3, min: 60, max: 160 }),
        Object.freeze({ type: 'ammo', weight: 3, min: 10, max: 24 }),
        Object.freeze({ type: 'health', weight: 3, min: 25, max: 50 }),
        Object.freeze({ type: 'armour', weight: 3, min: 25, max: 50 }),
      ]),
    }),
  }),
  cop: Object.freeze({
    id: 'cop',
    name: 'Police Officer',
    police: true,
    maxHealth: 90,
    armour: 10,
    radius: 11,
    speed: 118,
    sightRange: 460,
    attackRange: 320,
    loseSightTicks: 240,
    idleTicks: 24,
    fireDelayTicks: 28,
    damage: 9,
    spreadRad: 0.08,
    pellets: 1,
    weapon: 'pistol',
    bulletSpeed: 700,
    bulletRange: 460,
    loot: Object.freeze({
      chance: 0.4,
      table: Object.freeze([
        Object.freeze({ type: 'cash', weight: 3, min: 15, max: 45 }),
        Object.freeze({ type: 'ammo', weight: 3, min: 6, max: 16 }),
        Object.freeze({ type: 'armour', weight: 2, min: 10, max: 25 }),
      ]),
    }),
  }),
  swat: Object.freeze({
    id: 'swat',
    name: 'SWAT Officer',
    police: true,
    maxHealth: 140,
    armour: 50,
    radius: 12,
    speed: 124,
    sightRange: 500,
    attackRange: 380,
    loseSightTicks: 280,
    idleTicks: 18,
    fireDelayTicks: 14,
    damage: 10,
    spreadRad: 0.06,
    pellets: 1,
    weapon: 'smg',
    bulletSpeed: 760,
    bulletRange: 500,
    loot: Object.freeze({
      chance: 0.6,
      table: Object.freeze([
        Object.freeze({ type: 'cash', weight: 2, min: 30, max: 80 }),
        Object.freeze({ type: 'ammo', weight: 4, min: 10, max: 24 }),
        Object.freeze({ type: 'armour', weight: 3, min: 20, max: 40 }),
      ]),
    }),
  }),
  riot: Object.freeze({
    id: 'riot',
    name: 'Riot Trooper',
    police: true,
    maxHealth: 260,
    armour: 90,
    radius: 16,
    speed: 84,
    sightRange: 340,
    attackRange: 170,
    loseSightTicks: 300,
    idleTicks: 30,
    fireDelayTicks: 55,
    damage: 13,
    spreadRad: 0.2,
    pellets: 6,
    weapon: 'shotgun',
    bulletSpeed: 620,
    bulletRange: 280,
    loot: Object.freeze({
      chance: 0.8,
      table: Object.freeze([
        Object.freeze({ type: 'cash', weight: 2, min: 60, max: 140 }),
        Object.freeze({ type: 'ammo', weight: 3, min: 12, max: 26 }),
        Object.freeze({ type: 'health', weight: 2, min: 30, max: 55 }),
        Object.freeze({ type: 'armour', weight: 3, min: 30, max: 55 }),
      ]),
    }),
  }),
});

/**
 * Is this actor a police responder spawned by the wanted system?
 *
 * @param {object} [enemy]
 * @returns {boolean}
 */
export function isPolice(enemy) {
  return Boolean(enemy) && enemy.police === true;
}

/**
 * Resolve an archetype id to its spec, falling back to the `thug`.
 *
 * @param {string} [type]
 * @returns {EnemySpec}
 */
export function enemySpec(type) {
  return ENEMY_TYPES[type] ?? ENEMY_TYPES.thug;
}

/**
 * Create an enemy of a given archetype.
 *
 * @param {object} [options]
 * @param {number|string} [options.id=-1] Unique id; game spawns use ids `>= 1`
 *   so they never collide with the player (id `0`).
 * @param {string} [options.type='thug'] Archetype id.
 * @param {number} [options.x=0] World x, in pixels.
 * @param {number} [options.y=0] World y, in pixels.
 * @param {number} [options.health] Health override (defaults to the archetype's max).
 * @param {number} [options.armour] Armour override.
 * @returns {Enemy}
 */
export function createEnemy({ id = -1, type = 'thug', x = 0, y = 0, health, armour } = {}) {
  const spec = enemySpec(type);
  const maxHealth = spec.maxHealth;
  const maxArmour = spec.armour;
  const startHealth = Number.isFinite(health) ? clamp(health, 0, maxHealth) : maxHealth;

  return {
    id,
    kind: 'enemy',
    type: spec.id,
    name: spec.name,
    x,
    y,
    home: { x, y },
    radius: spec.radius,
    speed: spec.speed,
    maxHealth,
    health: startHealth,
    maxArmour,
    armour: Number.isFinite(armour) ? clamp(armour, 0, maxArmour) : maxArmour,
    alive: startHealth > 0,
    aim: 0,
    cooldown: 0,
    police: spec.police === true,
    state: 'idle',
    lostTicks: 0,
    idleTicks: 0,
    lastKnown: null,
    patrolTarget: null,
    patrolTicks: 0,
    deadHandled: false,
  };
}

/**
 * Is the enemy still alive? `alive` and `health` are kept in agreement, so this
 * is simply `alive === true`.
 *
 * @param {Enemy} enemy
 * @returns {boolean}
 */
export function isEnemyAlive(enemy) {
  return Boolean(enemy) && enemy.alive === true && enemy.health > 0;
}

/**
 * Apply damage, draining armour before health. Health is floored at zero and an
 * enemy whose health reaches zero is marked dead.
 *
 * Delegates to the shared {@link applyBulletDamage} so enemies and every other
 * shootable actor use exactly one armour-before-health implementation; the
 * result is re-shaped to the enemy-facing field names.
 *
 * @param {Enemy} enemy
 * @param {number} amount Raw damage (negative and non-finite values are ignored).
 * @returns {{ amount: number, absorbed: number, health: number, armour: number, killed: boolean, ignored: boolean }}
 */
export function applyEnemyDamage(enemy, amount) {
  const dealt = Number.isFinite(amount) ? Math.max(0, amount) : 0;
  if (!enemy || dealt === 0 || !isEnemyAlive(enemy)) {
    return {
      amount: dealt,
      absorbed: 0,
      health: enemy ? enemy.health : 0,
      armour: enemy ? enemy.armour : 0,
      killed: false,
      ignored: true,
    };
  }

  const result = applyBulletDamage(enemy, dealt);
  return {
    amount: result.dealt,
    absorbed: result.absorbed,
    health: result.health,
    armour: enemy.armour,
    killed: result.killed,
    ignored: false,
  };
}

/**
 * Mark an enemy dead immediately (used by tests and scripted kills).
 *
 * @param {Enemy} enemy
 * @returns {boolean} `true` when the enemy was alive and is now dead.
 */
export function killEnemy(enemy) {
  if (!enemy || !isEnemyAlive(enemy)) return false;
  enemy.health = 0;
  enemy.alive = false;
  return true;
}

/**
 * Draw one entry from a weighted loot table. Pure; uses the supplied rng.
 *
 * @param {ReadonlyArray<LootTableEntry>} table
 * @param {() => number} rng
 * @returns {LootDrop|null} `null` for an empty table.
 */
function drawLoot(table, rng) {
  if (!Array.isArray(table) || table.length === 0) return null;
  const total = table.reduce((sum, entry) => sum + Math.max(0, entry.weight ?? 0), 0);
  if (total <= 0) return null;

  let roll = clamp(typeof rng === 'function' ? rng() : 0, 0, 0.999999999) * total;
  let chosen = table[table.length - 1];
  for (const entry of table) {
    roll -= Math.max(0, entry.weight ?? 0);
    if (roll < 0) {
      chosen = entry;
      break;
    }
  }

  const span = Math.max(0, Math.trunc(chosen.max ?? 0) - Math.trunc(chosen.min ?? 0) + 1);
  const amount = Math.trunc(chosen.min ?? 0) + (span > 0 ? Math.floor(clamp(rng(), 0, 0.999999999) * span) : 0);
  return { type: chosen.type, amount };
}

/**
 * Roll an enemy's loot table. Draws one value for the drop chance and, when
 * something drops, one more for the type and one for the amount (three draws
 * total), so a seeded rng always yields the same result.
 *
 * @param {() => number} [rng=Math.random]
 * @param {EnemySpec|string} [spec] Archetype spec or id.
 * @returns {LootDrop|null}
 */
export function rollLoot(rng = Math.random, spec = ENEMY_TYPES.thug) {
  const resolved = typeof spec === 'string' ? enemySpec(spec) : spec;
  const loot = resolved?.loot;
  if (!loot) return null;

  const chance = Number.isFinite(loot.chance) ? clamp(loot.chance, 0, 1) : 0;
  if (chance <= 0) return null;
  if (typeof rng === 'function' && rng() >= chance) return null;
  return drawLoot(loot.table, rng);
}

// `createPickup` / `PICKUP_RADIUS` are re-exported at the top of this module
// from `core/pickup.js`, which owns the single pickup implementation.
