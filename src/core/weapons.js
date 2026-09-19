/**
 * Weapon handling: fire rate, spread, magazines, reserve ammo and reloading.
 *
 * This module is pure: it never touches the DOM, `window` or `document`, so it
 * runs unchanged under Node and in the browser. It operates on the plain
 * player object from `core/player.js` and the tuning table in
 * `core/constants.js`; all timings are expressed in simulation ticks so
 * behaviour is independent of the render rate.
 *
 * ## Spread cone
 *
 * `spec.spreadRad` is the **half-angle** of the firing cone. A shot may deviate
 * from the aim angle by at most `spreadRad` in either direction, so all pellets
 * satisfy `|offset| <= spec.spreadRad`:
 *
 * - multi-pellet weapons (shotgun) fan the pellets evenly across
 *   `[-spreadRad, +spreadRad]`;
 * - single-pellet weapons draw one offset uniformly from the same range using
 *   the supplied rng.
 *
 * @module core/weapons
 */

import { WEAPONS, WEAPON_SLOTS, DEFAULT_WEAPON } from './constants.js';
import { clamp, fromAngle } from './geometry.js';
import { ttlTicksFor } from './bullet.js';

/**
 * @typedef {object} FiredBullet
 * @property {number} x
 * @property {number} y
 * @property {number} vx
 * @property {number} vy
 * @property {number} angle
 * @property {number} damage
 * @property {number} ttl Lifetime in ticks.
 * @property {string} weapon
 */

/**
 * @typedef {object} FireResult
 * @property {boolean} fired
 * @property {object} spec The weapon spec that was (or would have been) used.
 * @property {number[]} angles Pellet angles, in radians.
 * @property {FiredBullet[]} bullets Spawn descriptors (empty when not fired).
 */

/**
 * Resolve a weapon id to its tuning spec, falling back to the default weapon.
 *
 * @param {string} [id]
 * @returns {Readonly<object>}
 */
export function weaponSpec(id) {
  return WEAPONS[id] ?? WEAPONS[DEFAULT_WEAPON];
}

/**
 * The weapon ids reachable from the number keys / wheel, in slot order.
 *
 * @returns {string[]} A copy, safe for callers to mutate.
 */
export function weaponSlots() {
  return WEAPON_SLOTS.slice();
}

/**
 * Zero-based slot index for a weapon id, or `-1` when it has no number key.
 *
 * @param {string} id
 * @returns {number}
 */
export function slotIndexForWeapon(id) {
  return WEAPON_SLOTS.indexOf(id);
}

/**
 * Is a reload in progress?
 *
 * @param {object} player
 * @returns {boolean}
 */
export function isReloading(player) {
  return Boolean(player) && (player.reloading === true || player.reloadTicks > 0);
}

/**
 * Can the equipped weapon fire right now? A weapon needs live owner, an empty
 * cooldown, no reload in progress and at least one round in the magazine.
 *
 * @param {object} player
 * @param {Readonly<object>} [spec=weaponSpec(player.weapon)]
 * @returns {boolean}
 */
export function canFire(player, spec = weaponSpec(player?.weapon)) {
  if (!player || player.alive === false) return false;
  if (isReloading(player)) return false;
  if (player.cooldown > 0) return false;
  return player.ammo > 0;
}

/**
 * Start a reload if the magazine is not full and reserve ammo remains.
 *
 * @param {object} player
 * @returns {boolean} `true` when a reload was started.
 */
export function beginReload(player) {
  if (!player || player.alive === false) return false;
  if (isReloading(player)) return false;
  const spec = weaponSpec(player.weapon);
  if (player.ammo >= spec.magazineSize) return false;
  if (player.reserve <= 0) return false;

  player.reloading = true;
  player.reloadTicks = spec.reloadTicks;
  return true;
}

/**
 * Move rounds from the reserve into the magazine and clear the reload.
 *
 * @param {object} player
 * @returns {number} How many rounds were transferred.
 */
export function completeReload(player) {
  if (!player) return 0;
  const spec = weaponSpec(player.weapon);
  const need = Math.max(0, spec.magazineSize - player.ammo);
  const taken = Math.min(need, Math.max(0, player.reserve));
  player.ammo += taken;
  player.reserve -= taken;
  player.reloading = false;
  player.reloadTicks = 0;
  return taken;
}

/**
 * Advance weapon timers by one tick, completing a reload exactly when its
 * countdown reaches zero.
 *
 * Every weapon's cooldown is ticked, not just the equipped one, so holstering a
 * weapon cannot freeze its firing delay. `player.cooldown` is then re-synced
 * from the equipped weapon's arsenal entry.
 *
 * @param {object} player
 * @returns {boolean} `true` when a reload completed this tick.
 */
export function tickWeapon(player) {
  if (!player) return false;

  if (player.weapons && typeof player.weapons === 'object') {
    for (const entry of Object.values(player.weapons)) {
      if (entry && Number.isFinite(entry.cooldown) && entry.cooldown > 0) entry.cooldown -= 1;
    }
    const equipped = player.weapons[player.weapon];
    player.cooldown = Number.isFinite(equipped?.cooldown) ? Math.max(0, equipped.cooldown) : 0;
  } else if (player.cooldown > 0) {
    player.cooldown -= 1;
  }

  let completed = false;
  if (player.reloadTicks > 0) {
    player.reloadTicks -= 1;
    if (player.reloadTicks <= 0) {
      completeReload(player);
      completed = true;
    }
  }
  return completed;
}

/**
 * Copy the equipped weapon's live ammo and cooldown back into its table entry.
 *
 * @param {object} player
 */
function saveWeaponState(player) {
  if (!player?.weapons) return;
  const entry = player.weapons[player.weapon];
  if (entry) {
    entry.ammo = player.ammo;
    entry.reserve = player.reserve;
    entry.cooldown = Number.isFinite(player.cooldown) ? Math.max(0, player.cooldown) : 0;
  }
}

/**
 * Load a weapon's ammo and cooldown from its table entry into the live fields.
 * A weapon that has never been fired starts ready (cooldown `0`).
 *
 * @param {object} player
 * @param {string} id
 */
function loadWeaponState(player, id) {
  const spec = weaponSpec(id);
  const entry = player.weapons?.[spec.id];
  player.weapon = spec.id;
  player.ammo = Number.isFinite(entry?.ammo) ? entry.ammo : spec.magazineSize;
  player.reserve = Number.isFinite(entry?.reserve) ? entry.reserve : spec.reserveAmmo;
  player.cooldown = Number.isFinite(entry?.cooldown) ? Math.max(0, entry.cooldown) : 0;
}

/**
 * Equip a weapon, preserving the previous weapon's ammo and cooldown. A reload
 * in progress is cancelled (it would otherwise be spent on the wrong weapon).
 * The incoming weapon's own remaining cooldown is restored, so switching away
 * and back can never grant an extra shot before `fireDelayTicks` have elapsed.
 *
 * @param {object} player
 * @param {string} id
 * @returns {boolean} `true` when the equipped weapon changed.
 */
export function switchWeapon(player, id) {
  if (!player) return false;
  const spec = WEAPONS[id];
  if (!spec || spec.id === player.weapon) return false;

  saveWeaponState(player);
  loadWeaponState(player, spec.id);
  player.reloading = false;
  player.reloadTicks = 0;
  return true;
}

/**
 * Equip the weapon in a zero-based slot (`0` = key `1`).
 *
 * @param {object} player
 * @param {number} slot
 * @returns {boolean} `true` when the equipped weapon changed.
 */
export function switchToSlot(player, slot) {
  const id = WEAPON_SLOTS[slot];
  if (!id) return false;
  return switchWeapon(player, id);
}

/**
 * Cycle the equipped weapon through `WEAPON_SLOTS` by `delta` steps (wraps in
 * both directions). A `delta` of `0` is a no-op.
 *
 * @param {object} player
 * @param {number} delta
 * @returns {string} The equipped weapon id after cycling.
 */
export function cycleWeapon(player, delta) {
  if (!player) return undefined;
  const current = slotIndexForWeapon(player.weapon);
  const index = current < 0 ? 0 : current;
  const steps = Number.isFinite(delta) ? Math.trunc(delta) : 0;
  const count = WEAPON_SLOTS.length;
  const next = (((index + steps) % count) + count) % count;
  switchWeapon(player, WEAPON_SLOTS[next]);
  return player.weapon;
}

/**
 * Angle offsets (radians, relative to the aim angle) for one shot.
 *
 * See the module docstring for the spread-cone contract. Every offset is
 * guaranteed to lie within `[-spec.spreadRad, +spec.spreadRad]`.
 *
 * @param {Readonly<object>} spec
 * @param {() => number} [rng=Math.random] Random source in `[0, 1)`.
 * @returns {number[]}
 */
export function spreadAngles(spec, rng = Math.random) {
  const pellets = Math.max(1, Math.trunc(Number.isFinite(spec?.pellets) ? spec.pellets : 1));
  const spread = Number.isFinite(spec?.spreadRad) ? Math.max(0, spec.spreadRad) : 0;

  if (pellets === 1) {
    const roll = typeof rng === 'function' ? clamp(rng(), 0, 1) : 0.5;
    return [(roll * 2 - 1) * spread];
  }

  const angles = [];
  for (let i = 0; i < pellets; i += 1) {
    angles.push(-spread + (2 * spread * i) / (pellets - 1));
  }
  return angles;
}

/**
 * Fire the equipped weapon, consuming one round and starting the cooldown.
 *
 * The caller is responsible for creating the actual projectile entities from
 * the returned spawn descriptors (this keeps the module free of entity ids).
 *
 * @param {object} player
 * @param {object} [options]
 * @param {() => number} [options.rng=Math.random]
 * @param {number} [options.x=player.x]
 * @param {number} [options.y=player.y]
 * @param {number} [options.angle=player.aim]
 * @returns {FireResult}
 */
export function fireWeapon(player, { rng = Math.random, x = player?.x, y = player?.y, angle = player?.aim } = {}) {
  const spec = weaponSpec(player?.weapon);
  if (!canFire(player, spec)) {
    return { fired: false, spec, angles: [], bullets: [] };
  }

  const offsets = spreadAngles(spec, rng);
  const muzzleAngle = Number.isFinite(angle) ? angle : 0;
  const originX = Number.isFinite(x) ? x : 0;
  const originY = Number.isFinite(y) ? y : 0;
  const ttl = ttlTicksFor(spec);

  const bullets = offsets.map((offset) => {
    const pelletAngle = muzzleAngle + offset;
    const velocity = fromAngle(pelletAngle, spec.bulletSpeed);
    return {
      x: originX,
      y: originY,
      vx: velocity.x,
      vy: velocity.y,
      angle: pelletAngle,
      damage: spec.damage,
      ttl,
      weapon: spec.id,
    };
  });

  player.ammo -= 1;
  player.cooldown = spec.fireDelayTicks;
  const entry = player.weapons?.[spec.id];
  if (entry) entry.cooldown = spec.fireDelayTicks;

  return { fired: true, spec, angles: offsets.map((offset) => muzzleAngle + offset), bullets };
}
