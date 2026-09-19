/**
 * Player entity: movement, aim, health and armour.
 *
 * This module is pure: it never touches the DOM, `window` or `document`, so it
 * runs unchanged under Node and in the browser. Position updates go through the
 * shared circle-vs-tile collision resolver in `core/map.js`, so a player can
 * never pass through a building and always slides along walls.
 *
 * @module core/player
 */

import {
  TICK_SECONDS,
  PLAYER_RADIUS,
  PLAYER_BASE_SPEED,
  PLAYER_SPRINT_MULTIPLIER,
  PLAYER_MAX_HEALTH,
  PLAYER_STARTING_HEALTH,
  PLAYER_MAX_ARMOUR,
  PLAYER_STARTING_ARMOUR,
  DEFAULT_WEAPON,
  WEAPONS,
} from './constants.js';
import { clamp } from './geometry.js';
import { moveCircle } from './map.js';

/**
 * @typedef {object} MoveIntent
 * @property {boolean} [up]
 * @property {boolean} [down]
 * @property {boolean} [left]
 * @property {boolean} [right]
 * @property {boolean} [sprint]
 * @typedef {{ x: number, y: number }} Vec
 */

/**
 * @typedef {object} Player
 * @property {number} id
 * @property {number} x
 * @property {number} y
 * @property {number} radius Collision radius, in pixels.
 * @property {number} speed Base walk speed, in pixels per second.
 * @property {number} health Current health (`0..maxHealth`).
 * @property {number} maxHealth
 * @property {number} armour Current armour (`0..maxArmour`).
 * @property {number} maxArmour
 * @property {boolean} alive
 * @property {number} aim Aim angle, in radians, measured from the +x axis.
 * @property {number} cooldown Ticks until the next shot may be fired.
 * @property {number} reloadTicks Ticks remaining on an in-progress reload.
 * @property {boolean} reloading Whether a reload is in progress.
 * @property {string} weapon Currently equipped weapon id.
 * @property {number} ammo Rounds left in the equipped weapon's magazine.
 * @property {number} reserve Reserve rounds available to reload from.
 * @property {Record<string, { ammo: number, reserve: number }>} weapons
 *   Per-weapon magazine/reserve state, so switching weapons preserves each
 *   one's ammo.
 * @property {boolean} fireHeld Previous tick's trigger state, used for
 *   semi-automatic edge detection.
 * @property {number|string|null} vehicleId Id of the vehicle being driven, or
 *   `null` when on foot.
 */

/**
 * Build the initial per-weapon ammo table.
 *
 * @param {Record<string, { ammo?: number, reserve?: number }>} [overrides]
 * @returns {Record<string, { ammo: number, reserve: number }>}
 */
function createArsenal(overrides) {
  /** @type {Record<string, { ammo: number, reserve: number }>} */
  const arsenal = {};
  for (const spec of Object.values(WEAPONS)) {
    const given = overrides?.[spec.id];
    const ammo = Number.isFinite(given?.ammo) ? given.ammo : spec.magazineSize;
    const reserve = Number.isFinite(given?.reserve) ? given.reserve : spec.reserveAmmo;
    arsenal[spec.id] = { ammo, reserve };
  }
  return arsenal;
}

/**
 * Create a player at a world position.
 *
 * @param {object} [options]
 * @param {number} [options.id=0]
 * @param {number} [options.x=0] World x, in pixels.
 * @param {number} [options.y=0] World y, in pixels.
 * @param {number} [options.radius=PLAYER_RADIUS]
 * @param {number} [options.speed=PLAYER_BASE_SPEED] Base walk speed (px/s).
 * @param {number} [options.health=PLAYER_STARTING_HEALTH]
 * @param {number} [options.armour=PLAYER_STARTING_ARMOUR]
 * @param {string} [options.weapon=DEFAULT_WEAPON]
 * @param {Record<string, { ammo?: number, reserve?: number }>} [options.weapons]
 *   Initial magazine/reserve overrides keyed by weapon id.
 * @returns {Player}
 */
export function createPlayer({
  id = 0,
  x = 0,
  y = 0,
  radius = PLAYER_RADIUS,
  speed = PLAYER_BASE_SPEED,
  health = PLAYER_STARTING_HEALTH,
  armour = PLAYER_STARTING_ARMOUR,
  weapon = DEFAULT_WEAPON,
  weapons,
} = {}) {
  const spec = WEAPONS[weapon] ?? WEAPONS[DEFAULT_WEAPON];
  const maxHealth = PLAYER_MAX_HEALTH;
  const maxArmour = PLAYER_MAX_ARMOUR;
  const arsenal = createArsenal(weapons);

  return {
    id,
    x,
    y,
    radius,
    speed,
    maxHealth,
    health: clamp(Number.isFinite(health) ? health : maxHealth, 0, maxHealth),
    maxArmour,
    armour: clamp(Number.isFinite(armour) ? armour : 0, 0, maxArmour),
    alive: (Number.isFinite(health) ? health : maxHealth) > 0,
    aim: 0,
    cooldown: 0,
    reloadTicks: 0,
    reloading: false,
    weapon: spec.id,
    ammo: arsenal[spec.id].ammo,
    reserve: arsenal[spec.id].reserve,
    weapons: arsenal,
    fireHeld: false,
    vehicleId: null,
  };
}

/**
 * Is the player still alive? A player is alive only while `alive` is set and
 * health is positive, so the two can never disagree.
 *
 * @param {Player} player
 * @returns {boolean}
 */
export function isAlive(player) {
  return Boolean(player) && player.alive === true && player.health > 0;
}

/**
 * Movement speed (px/s) for a player, accounting for sprint.
 *
 * @param {Player} player
 * @param {boolean} [sprint]
 * @returns {number}
 */
export function speedFor(player, sprint = false) {
  return player.speed * (sprint ? PLAYER_SPRINT_MULTIPLIER : 1);
}

/**
 * Turn the eight-direction movement intent into a unit direction vector.
 * Diagonals are normalised, so a diagonal run covers the same distance as a
 * cardinal one.
 *
 * @param {MoveIntent} input
 * @returns {Vec} Unit vector, or `{x:0,y:0}` when idle.
 */
export function moveIntent(input) {
  const i = input ?? {};
  const dx = (i.right ? 1 : 0) - (i.left ? 1 : 0);
  const dy = (i.down ? 1 : 0) - (i.up ? 1 : 0);
  if (dx === 0 && dy === 0) return { x: 0, y: 0 };
  const inv = 1 / Math.hypot(dx, dy);
  return { x: dx * inv, y: dy * inv };
}

/**
 * Move a player by one time step, resolving collisions against the tile map.
 *
 * The player is mutated in place. Axes are resolved independently by
 * {@link moveCircle}, so hitting a building slides the player along it instead
 * of stopping dead.
 *
 * @param {object} map Map or normalised grid (`{ width, height, tiles }`).
 * @param {Player} player
 * @param {MoveIntent} input
 * @param {number} [dtSeconds=TICK_SECONDS]
 * @returns {{ x: number, y: number, hitX: boolean, hitY: boolean, moved: boolean }}
 */
export function movePlayer(map, player, input, dtSeconds = TICK_SECONDS) {
  const idle = { x: player.x, y: player.y, hitX: false, hitY: false, moved: false };
  if (!map || !player || !isAlive(player)) return idle;

  const dir = moveIntent(input);
  if (dir.x === 0 && dir.y === 0) return idle;

  const dt = Number.isFinite(dtSeconds) ? Math.max(0, dtSeconds) : 0;
  const step = speedFor(player, Boolean(input?.sprint)) * dt;
  const result = moveCircle(map, player.x, player.y, player.radius, dir.x * step, dir.y * step);
  const moved = result.x !== player.x || result.y !== player.y;
  player.x = result.x;
  player.y = result.y;

  return { x: result.x, y: result.y, hitX: result.hitX, hitY: result.hitY, moved };
}

/**
 * Point the player at a world-space target and store the aim angle.
 *
 * @param {Player} player
 * @param {number} targetX
 * @param {number} targetY
 * @returns {number} The aim angle in radians.
 */
export function aimAt(player, targetX, targetY) {
  const angle = Math.atan2(targetY - player.y, targetX - player.x);
  player.aim = angle;
  return angle;
}

/**
 * Set the aim angle directly (radians).
 *
 * @param {Player} player
 * @param {number} angle
 * @returns {number}
 */
export function setAim(player, angle) {
  const next = Number.isFinite(angle) ? angle : 0;
  player.aim = next;
  return next;
}

/**
 * Apply damage, draining armour before health. Health is floored at zero and a
 * player whose health reaches zero is marked dead.
 *
 * @param {Player} player
 * @param {number} amount Raw damage (negative and non-finite values are ignored).
 * @returns {{ amount: number, absorbed: number, health: number, armour: number, killed: boolean, ignored: boolean }}
 */
export function applyDamage(player, amount) {
  const dealt = Number.isFinite(amount) ? Math.max(0, amount) : 0;
  if (!player || dealt === 0 || !isAlive(player)) {
    return {
      amount: dealt,
      absorbed: 0,
      health: player ? player.health : 0,
      armour: player ? player.armour : 0,
      killed: false,
      ignored: true,
    };
  }

  const absorbed = Math.min(player.armour, dealt);
  const toHealth = dealt - absorbed;
  player.armour = clamp(player.armour - absorbed, 0, player.maxArmour);
  player.health = clamp(player.health - toHealth, 0, player.maxHealth);

  const killed = player.health <= 0;
  player.alive = !killed;

  return {
    amount: dealt,
    absorbed,
    health: player.health,
    armour: player.armour,
    killed,
    ignored: false,
  };
}

/**
 * Restore health up to the ceiling. Does not revive a dead player.
 *
 * @param {Player} player
 * @param {number} amount
 * @returns {number} The new health value.
 */
export function healPlayer(player, amount) {
  if (!player || !isAlive(player)) return player ? player.health : 0;
  const healed = Number.isFinite(amount) ? Math.max(0, amount) : 0;
  player.health = clamp(player.health + healed, 0, player.maxHealth);
  return player.health;
}

/**
 * Add armour up to the ceiling.
 *
 * @param {Player} player
 * @param {number} amount
 * @returns {number} The new armour value.
 */
export function addArmour(player, amount) {
  if (!player) return 0;
  const gained = Number.isFinite(amount) ? Math.max(0, amount) : 0;
  player.armour = clamp(player.armour + gained, 0, player.maxArmour);
  return player.armour;
}
