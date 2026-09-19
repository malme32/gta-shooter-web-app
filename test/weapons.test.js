import test from 'node:test';
import assert from 'node:assert/strict';

import {
  weaponSpec,
  weaponSlots,
  slotIndexForWeapon,
  isReloading,
  canFire,
  beginReload,
  completeReload,
  tickWeapon,
  switchWeapon,
  switchToSlot,
  cycleWeapon,
  spreadAngles,
  fireWeapon,
} from '../src/core/weapons.js';
import { createPlayer } from '../src/core/player.js';
import { createGame, update, drainEvents } from '../src/core/game.js';
import { WEAPONS, WEAPON_SLOTS, DEFAULT_WEAPON, TICK_SECONDS } from '../src/core/constants.js';

function makeMap(width, height, solids = []) {
  const tiles = new Array(width * height).fill(0);
  for (const [x, y] of solids) tiles[y * width + x] = 1;
  return { width, height, tiles };
}

/** Deterministic rng returning values from a list, then 0.5. */
function rngSeq(values) {
  let i = 0;
  return () => (i < values.length ? values[i++] : 0.5);
}

test('weaponSpec resolves known weapons and falls back to the default', () => {
  assert.equal(weaponSpec('smg'), WEAPONS.smg);
  assert.equal(weaponSpec('shotgun').pellets, 10);
  assert.equal(weaponSpec('plasma'), WEAPONS[DEFAULT_WEAPON]);
  assert.equal(weaponSpec(undefined), WEAPONS[DEFAULT_WEAPON]);
});

test('weaponSlots mirrors WEAPON_SLOTS and returns a mutable copy', () => {
  assert.deepEqual(weaponSlots(), WEAPON_SLOTS.slice());
  const copy = weaponSlots();
  copy.push('nope');
  assert.equal(weaponSlots().length, WEAPON_SLOTS.length);
  assert.equal(slotIndexForWeapon('pistol'), 0);
  assert.equal(slotIndexForWeapon('smg'), 1);
  assert.equal(slotIndexForWeapon('shotgun'), 2);
  assert.equal(slotIndexForWeapon('rifle'), -1);
});

test('canFire requires a live, loaded, cool and non-reloading weapon', () => {
  const player = createPlayer();
  assert.equal(canFire(player), true);

  player.cooldown = 1;
  assert.equal(canFire(player), false);
  player.cooldown = 0;

  player.ammo = 0;
  assert.equal(canFire(player), false);
  player.ammo = WEAPONS.pistol.magazineSize;

  player.reloading = true;
  assert.equal(canFire(player), false);
  player.reloading = false;

  player.alive = false;
  assert.equal(canFire(player), false);
});

test('fireWeapon consumes one round and arms the cooldown for every slot', () => {
  for (const id of WEAPON_SLOTS) {
    const spec = WEAPONS[id];
    const player = createPlayer({ weapon: id });
    const before = player.ammo;

    const result = fireWeapon(player, { rng: () => 0.5 });

    assert.equal(result.fired, true, `${id} should fire`);
    assert.equal(result.spec, spec);
    assert.equal(player.ammo, before - 1, `${id} should consume one round`);
    assert.equal(player.cooldown, spec.fireDelayTicks, `${id} cooldown must match constants`);
    assert.equal(result.bullets.length, spec.pellets);
    for (const bullet of result.bullets) {
      assert.equal(bullet.damage, spec.damage);
      assert.ok(bullet.ttl >= 1);
    }
  }
});

test('fire rate: a second shot is blocked until exactly fireDelayTicks elapse', () => {
  const spec = WEAPONS.pistol;
  const player = createPlayer({ weapon: 'pistol' });

  assert.equal(fireWeapon(player).fired, true);
  assert.equal(fireWeapon(player).fired, false, 'cannot fire while cooling down');

  for (let i = 1; i < spec.fireDelayTicks; i += 1) {
    tickWeapon(player);
    assert.equal(canFire(player), false, `cooling at tick ${i}`);
  }
  tickWeapon(player);
  assert.equal(player.cooldown, 0);
  assert.equal(fireWeapon(player).fired, true, 'fires again once the cooldown clears');
});

test('an empty magazine cannot fire', () => {
  const player = createPlayer({ weapons: { pistol: { ammo: 1, reserve: 0 } } });
  assert.equal(fireWeapon(player).fired, true);
  assert.equal(player.ammo, 0);

  const empty = fireWeapon(player);
  assert.equal(empty.fired, false);
  assert.equal(empty.bullets.length, 0);
  assert.equal(player.ammo, 0);
});

test('beginReload refuses a full magazine or an empty reserve', () => {
  const full = createPlayer();
  assert.equal(beginReload(full), false);

  const dry = createPlayer({ weapons: { pistol: { ammo: 0, reserve: 0 } } });
  assert.equal(beginReload(dry), false);

  const ready = createPlayer({ weapons: { pistol: { ammo: 3, reserve: 10 } } });
  assert.equal(beginReload(ready), true);
  assert.equal(ready.reloading, true);
  assert.equal(ready.reloadTicks, WEAPONS.pistol.reloadTicks);
  assert.equal(isReloading(ready), true);
});

test('reload takes exactly reloadTicks and transfers from the reserve', () => {
  const spec = WEAPONS.shotgun;
  const player = createPlayer({ weapon: 'shotgun', weapons: { shotgun: { ammo: 1, reserve: 20 } } });

  beginReload(player);
  assert.equal(player.reloadTicks, spec.reloadTicks);

  for (let i = 1; i < spec.reloadTicks; i += 1) {
    tickWeapon(player);
    assert.equal(player.reloading, true, `still reloading at tick ${i}`);
    assert.equal(player.ammo, 1);
  }
  tickWeapon(player);

  assert.equal(player.reloading, false);
  assert.equal(player.reloadTicks, 0);
  assert.equal(player.ammo, spec.magazineSize);
  assert.equal(player.reserve, 20 - (spec.magazineSize - 1));
});

test('reload only takes what the reserve holds', () => {
  const player = createPlayer({ weapons: { pistol: { ammo: 2, reserve: 5 } } });
  beginReload(player);
  player.reloadTicks = 1;
  tickWeapon(player);

  assert.equal(player.ammo, 7);
  assert.equal(player.reserve, 0);
  assert.equal(player.reloading, false);
});

test('completeReload is a no-op on a full magazine', () => {
  const player = createPlayer();
  assert.equal(completeReload(player), 0);
  assert.equal(player.ammo, WEAPONS.pistol.magazineSize);
});

test('shotgun fires 10 pellets, all inside the documented spread cone', () => {
  const spec = WEAPONS.shotgun;
  assert.equal(spec.pellets, 10);

  const angles = spreadAngles(spec, () => 0.5);
  assert.equal(angles.length, 10);
  for (const offset of angles) {
    assert.ok(offset >= -spec.spreadRad - 1e-9 && offset <= spec.spreadRad + 1e-9, `offset ${offset}`);
  }
  assert.equal(angles[0], -spec.spreadRad);
  assert.equal(angles[angles.length - 1], spec.spreadRad);

  const player = createPlayer({ weapon: 'shotgun' });
  const shot = fireWeapon(player, { rng: () => 0.5, angle: 1.234 });
  assert.equal(shot.fired, true);
  assert.equal(shot.bullets.length, 10);
  for (let i = 0; i < shot.bullets.length; i += 1) {
    const bullet = shot.bullets[i];
    assert.ok(Math.abs(bullet.angle - 1.234) <= spec.spreadRad + 1e-9);
    assert.ok(Math.abs(bullet.angle - shot.angles[i]) < 1e-9);
  }
});

test('single-pellet spread stays within the cone for any rng roll', () => {
  const spec = WEAPONS.smg;
  const low = spreadAngles(spec, rngSeq([0]))[0];
  const high = spreadAngles(spec, rngSeq([1]))[0];
  assert.equal(low, -spec.spreadRad);
  assert.equal(high, spec.spreadRad);
  assert.equal(spreadAngles(spec, rngSeq([0.5]))[0], 0);
});

test('switching weapons preserves each magazine and cancels a reload', () => {
  const player = createPlayer();
  fireWeapon(player);
  player.cooldown = 0;
  fireWeapon(player);
  assert.equal(player.ammo, 10);

  assert.equal(switchToSlot(player, 1), true);
  assert.equal(player.weapon, 'smg');
  assert.equal(player.ammo, WEAPONS.smg.magazineSize);

  player.ammo = 5;
  assert.equal(beginReload(player), true);
  assert.equal(isReloading(player), true);

  assert.equal(switchToSlot(player, 0), true);
  assert.equal(player.weapon, 'pistol');
  assert.equal(player.ammo, 10, 'pistol magazine remembered');
  assert.equal(player.reloading, false);
  assert.equal(player.reloadTicks, 0);

  assert.equal(switchWeapon(player, 'pistol'), false, 'same weapon is a no-op');
  assert.equal(switchWeapon(player, 'plasma'), false, 'unknown weapon is a no-op');
});

test('switching weapons does not bypass the firing cooldown', () => {
  const spec = WEAPONS.pistol;
  const player = createPlayer({ weapon: 'pistol' });

  assert.equal(fireWeapon(player).fired, true);
  assert.equal(player.cooldown, spec.fireDelayTicks);

  assert.equal(switchToSlot(player, 1), true);
  assert.equal(player.weapon, 'smg');
  assert.equal(player.cooldown, 0, 'a weapon that has not fired starts ready');

  assert.equal(switchToSlot(player, 0), true);
  assert.equal(player.weapon, 'pistol');
  assert.equal(player.cooldown, spec.fireDelayTicks, 'the pistol cooldown is restored');

  assert.equal(canFire(player), false, 'still cooling after the switch round trip');
  assert.equal(fireWeapon(player).fired, false, 'switching must not grant a free shot');

  for (let i = 1; i < spec.fireDelayTicks; i += 1) tickWeapon(player);
  assert.equal(canFire(player), false, `cooling at tick ${spec.fireDelayTicks - 1}`);
  tickWeapon(player);
  assert.equal(player.cooldown, 0);
  assert.equal(fireWeapon(player).fired, true, 'fires once fireDelayTicks have elapsed');
});

test('a holstered weapon keeps cooling down', () => {
  const spec = WEAPONS.pistol;
  const player = createPlayer({ weapon: 'pistol' });
  fireWeapon(player);

  switchToSlot(player, 1);
  for (let i = 0; i < 4; i += 1) tickWeapon(player);

  switchToSlot(player, 0);
  assert.equal(player.cooldown, spec.fireDelayTicks - 4);
  assert.equal(canFire(player), false);
});

test('cycleWeapon walks the slot list and wraps in both directions', () => {
  const player = createPlayer({ weapon: 'pistol' });
  assert.equal(cycleWeapon(player, 1), 'smg');
  assert.equal(cycleWeapon(player, 1), 'shotgun');
  assert.equal(cycleWeapon(player, 1), 'pistol');
  assert.equal(cycleWeapon(player, -1), 'shotgun');
  assert.equal(cycleWeapon(player, 5), 'smg');
  assert.equal(cycleWeapon(player, 0), 'smg', 'zero steps is a no-op');
});

test('game update fires on trigger and consumes ammo', () => {
  const map = makeMap(40, 40);
  const game = createGame({ map, spawn: { x: 320, y: 320 }, seed: 7 });
  game.player.aim = 0;
  game.input.fire = true;

  update(game);
  assert.equal(game.player.ammo, WEAPONS.pistol.magazineSize - 1);
  const events = drainEvents(game);
  assert.equal(events.filter((e) => e.type === 'muzzle').length, 1);
  assert.equal(events.filter((e) => e.type === 'tracer').length, 1);
  assert.equal(game.bullets.length, 1);

  update(game);
  assert.equal(game.player.ammo, WEAPONS.pistol.magazineSize - 1, 'semi-auto does not repeat while held');
});

test('automatic fire repeats every fireDelayTicks and R starts a reload', () => {
  const map = makeMap(40, 40);
  const game = createGame({ map, spawn: { x: 320, y: 320 }, seed: 7 });
  game.player.aim = 0;
  switchToSlot(game.player, 1);
  game.input.fire = true;

  const spec = WEAPONS.smg;
  for (let i = 0; i < spec.fireDelayTicks; i += 1) update(game);
  assert.equal(game.player.ammo, spec.magazineSize - 1, 'one shot per fire delay');

  game.input.fire = false;
  game.input.reload = true;
  update(game);
  assert.equal(game.player.reloading, true);
  assert.equal(game.player.reloadTicks, spec.reloadTicks);

  game.input.reload = false;
  for (let i = 0; i < spec.reloadTicks; i += 1) update(game);
  assert.equal(game.player.ammo, spec.magazineSize);
  assert.equal(game.player.reserve, spec.reserveAmmo - 1);
});

test('number keys and the wheel switch weapons through the game input', () => {
  const map = makeMap(40, 40);
  const game = createGame({ map, spawn: { x: 320, y: 320 }, seed: 7 });

  game.input.weapon2 = true;
  update(game);
  assert.equal(game.player.weapon, 'smg');
  assert.equal(game.input.weapon2, false, 'one-shot intent is consumed');

  game.input.cycleWeapon = 1;
  update(game);
  assert.equal(game.player.weapon, 'shotgun');
  assert.equal(game.input.cycleWeapon, 0, 'wheel accumulator is consumed');
});

test('the wheel applies every accumulated step in one tick', () => {
  const map = makeMap(40, 40);
  const game = createGame({ map, spawn: { x: 320, y: 320 }, seed: 7 });

  game.input.cycleWeapon = 2;
  update(game);
  assert.equal(game.player.weapon, 'shotgun', 'two forward steps from pistol');
  assert.equal(game.input.cycleWeapon, 0);

  game.input.cycleWeapon = -2;
  update(game);
  assert.equal(game.player.weapon, 'pistol', 'two back steps from shotgun');
});

test('switching away and back through game input keeps the fire delay', () => {
  const map = makeMap(40, 40);
  const game = createGame({ map, spawn: { x: 320, y: 320 }, seed: 7 });
  game.player.aim = 0;
  const spec = WEAPONS.pistol;

  game.input.fire = true;
  update(game);
  assert.equal(game.player.ammo, spec.magazineSize - 1);

  game.input.fire = false;
  game.input.weapon2 = true;
  update(game);
  assert.equal(game.player.weapon, 'smg');

  game.input.weapon1 = true;
  update(game);
  assert.equal(game.player.weapon, 'pistol');

  game.input.fire = true;
  update(game);
  assert.equal(game.player.ammo, spec.magazineSize - 1, 'no free shot after switching back');

  game.input.fire = false;
  for (let i = 0; i < spec.fireDelayTicks; i += 1) update(game);
  game.input.fire = true;
  update(game);
  assert.equal(game.player.ammo, spec.magazineSize - 2, 'fires only after the full delay');
});

test('fireWeapon tolerates invalid / missing state', () => {
  assert.equal(fireWeapon(null).fired, false);
  const dead = createPlayer({ health: 0 });
  assert.equal(dead.alive, false);
  assert.equal(fireWeapon(dead).fired, false);
});

test('ttl derived from range/speed keeps bullets alive for the full range', () => {
  for (const spec of Object.values(WEAPONS)) {
    const ticks = Math.ceil(spec.bulletRange / (spec.bulletSpeed * TICK_SECONDS));
    const player = createPlayer({ weapon: spec.id });
    const shot = fireWeapon(player);
    assert.equal(shot.bullets[0].ttl, Math.max(1, ticks));
  }
});
