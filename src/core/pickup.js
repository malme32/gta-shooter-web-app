/**
 * Pickups: ground loot that restores health, armour or ammo, or awards cash.
 *
 * This module is pure: it never touches the DOM, `window` or `document`, so it
 * runs unchanged under Node and in the browser. It owns both the *data* side of
 * a pickup (see {@link createPickup}) and the *collection* rules (see
 * {@link applyPickup}); the simulation wiring lives in `core/game.js`, which
 * walks the pickup list each tick and applies whatever the player steps on.
 *
 * `core/enemy.js` re-exports {@link createPickup} and {@link PICKUP_RADIUS} for
 * backwards compatibility, so the enemy loot table and the pickup system share
 * exactly one implementation.
 *
 * @module core/pickup
 */

import { healPlayer, addArmour } from './player.js';

/**
 * @typedef {'health'|'armour'|'ammo'|'cash'} PickupType
 *
 * @typedef {object} Pickup
 * @property {number|string} id
 * @property {'pickup'} kind
 * @property {PickupType} pickupType
 * @property {number} x
 * @property {number} y
 * @property {number} radius Collision radius, in pixels.
 * @property {number} amount
 * @property {boolean} alive
 *
 * @typedef {object} PickupResult
 * @property {PickupType} pickupType The effect that was applied.
 * @property {number} amount The requested amount.
 * @property {number} cash Cash awarded by the pickup (0 for non-cash types).
 * @property {boolean} applied `true` when the pickup had a valid target.
 */

/** Every pickup effect the game understands. @type {ReadonlyArray<PickupType>} */
export const PICKUP_TYPES = Object.freeze(['health', 'armour', 'ammo', 'cash']);

/** Pickup collision radius, in world pixels. */
export const PICKUP_RADIUS = 10;

/**
 * Default amount restored/awarded by each pickup type when a map places one
 * without an explicit amount.
 *
 * @type {Readonly<Record<PickupType, number>>}
 */
export const PICKUP_DEFAULTS = Object.freeze({
  health: 25,
  armour: 25,
  ammo: 60,
  cash: 50,
});

/**
 * Is this a known pickup effect?
 *
 * @param {string} [type]
 * @returns {type is PickupType}
 */
export function isPickupType(type) {
  return PICKUP_TYPES.includes(type);
}

/**
 * Default amount for a pickup type (`0` for unknown types).
 *
 * @param {string} [type]
 * @returns {number}
 */
export function defaultPickupAmount(type) {
  return PICKUP_DEFAULTS[type] ?? 0;
}

/**
 * Create a pickup at a world position.
 *
 * @param {object} [options]
 * @param {number|string} [options.id=0]
 * @param {PickupType} [options.pickupType='cash']
 * @param {number} [options.x=0]
 * @param {number} [options.y=0]
 * @param {number} [options.amount=0]
 * @param {number} [options.radius=PICKUP_RADIUS]
 * @returns {Pickup}
 */
export function createPickup({ id = 0, pickupType = 'cash', x = 0, y = 0, amount = 0, radius = PICKUP_RADIUS } = {}) {
  return {
    id,
    kind: 'pickup',
    pickupType,
    x,
    y,
    radius,
    amount: Number.isFinite(amount) ? amount : 0,
    alive: true,
  };
}

/**
 * Apply a pickup to a player. Health, armour and ammo mutate the player in
 * place (all clamped to their ceilings); cash is *returned* rather than stored,
 * because the running money total lives on the game state, not the player.
 *
 * Unknown pickup types fall back to cash, matching the enemy loot table. A
 * pickup aimed at a missing player is reported as not applied, so the caller
 * can decide whether to consume it.
 *
 * @param {object|null} player
 * @param {Pickup} pickup
 * @returns {PickupResult}
 */
export function applyPickup(player, pickup) {
  const type = isPickupType(pickup?.pickupType) ? pickup.pickupType : 'cash';
  const amount = Number.isFinite(pickup?.amount) ? Math.max(0, pickup.amount) : 0;

  if (type === 'cash') {
    return { pickupType: 'cash', amount, cash: amount, applied: true };
  }
  if (!player) {
    return { pickupType: type, amount, cash: 0, applied: false };
  }

  switch (type) {
    case 'health':
      healPlayer(player, amount);
      break;
    case 'armour':
      addArmour(player, amount);
      break;
    case 'ammo': {
      const reserve = Number.isFinite(player.reserve) ? player.reserve : 0;
      player.reserve = reserve + amount;
      // Keep the per-weapon ammo table in sync with the flat mirror the HUD
      // and firing code read, exactly as the weapon system does.
      const slot = player.weapon && player.weapons ? player.weapons[player.weapon] : null;
      if (slot && typeof slot === 'object') slot.reserve = player.reserve;
      break;
    }
    default:
      break;
  }

  return { pickupType: type, amount, cash: 0, applied: true };
}

/**
 * Do a pickup and an actor overlap? Uses the sum of their radii, so a pickup
 * lying on the ground is collected as soon as the actor touches it.
 *
 * @param {Pickup} pickup
 * @param {{ x: number, y: number, radius?: number }|null} actor
 * @returns {boolean}
 */
export function pickupOverlaps(pickup, actor) {
  if (!pickup || !actor) return false;
  const pickupRadius = Number.isFinite(pickup.radius) ? pickup.radius : PICKUP_RADIUS;
  const actorRadius = Number.isFinite(actor.radius) ? actor.radius : 0;
  const reach = pickupRadius + actorRadius;
  const dx = (actor.x ?? 0) - (pickup.x ?? 0);
  const dy = (actor.y ?? 0) - (pickup.y ?? 0);
  return dx * dx + dy * dy <= reach * reach;
}
