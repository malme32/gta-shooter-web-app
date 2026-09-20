import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PICKUP_TYPES,
  PICKUP_RADIUS,
  PICKUP_DEFAULTS,
  isPickupType,
  defaultPickupAmount,
  createPickup,
  applyPickup,
  pickupOverlaps,
} from '../src/core/pickup.js';
import { createPlayer } from '../src/core/player.js';
import { createGame, update, drainEvents } from '../src/core/game.js';

function makeMap(width, height) {
  return { width, height, tiles: new Array(width * height).fill(0) };
}

test('the pickup vocabulary and defaults are complete', () => {
  assert.deepEqual(PICKUP_TYPES, ['health', 'armour', 'ammo', 'cash']);
  for (const type of PICKUP_TYPES) {
    assert.equal(isPickupType(type), true);
    assert.ok(defaultPickupAmount(type) > 0, `${type} should have a default amount`);
    assert.equal(PICKUP_DEFAULTS[type], defaultPickupAmount(type));
  }
  assert.equal(isPickupType('rocket'), false);
  assert.equal(defaultPickupAmount('rocket'), 0);
});

test('createPickup builds a live pickup, filling in defaults', () => {
  const pickup = createPickup();
  assert.deepEqual(pickup, {
    id: 0,
    kind: 'pickup',
    pickupType: 'cash',
    x: 0,
    y: 0,
    radius: PICKUP_RADIUS,
    amount: 0,
    alive: true,
  });

  const weird = createPickup({ id: 3, pickupType: 'health', amount: Number.NaN, radius: 4, x: 7, y: 8 });
  assert.equal(weird.amount, 0, 'non-finite amounts collapse to 0');
  assert.equal(weird.radius, 4);
  assert.equal(weird.x, 7);
  assert.equal(weird.y, 8);
  assert.equal(weird.pickupType, 'health');
});

test('health pickups heal without exceeding the ceiling', () => {
  const player = createPlayer({ health: 50 });
  const result = applyPickup(player, createPickup({ pickupType: 'health', amount: 30 }));
  assert.deepEqual(result, { pickupType: 'health', amount: 30, cash: 0, applied: true });
  assert.equal(player.health, 80);

  applyPickup(player, createPickup({ pickupType: 'health', amount: 999 }));
  assert.equal(player.health, player.maxHealth);
});

test('armour pickups add armour up to the ceiling', () => {
  const player = createPlayer({ armour: 0 });
  applyPickup(player, createPickup({ pickupType: 'armour', amount: 40 }));
  assert.equal(player.armour, 40);
  applyPickup(player, createPickup({ pickupType: 'armour', amount: 999 }));
  assert.equal(player.armour, player.maxArmour);
});

test('ammo pickups top up the reserve and mirror it onto the weapon slot', () => {
  const player = createPlayer();
  const before = player.reserve;
  const result = applyPickup(player, createPickup({ pickupType: 'ammo', amount: 30 }));
  assert.deepEqual(result, { pickupType: 'ammo', amount: 30, cash: 0, applied: true });
  assert.equal(player.reserve, before + 30);
  assert.equal(player.weapons[player.weapon].reserve, player.reserve);
});

test('cash pickups are returned rather than stored on the player', () => {
  const player = createPlayer();
  const before = player.health;
  const result = applyPickup(player, createPickup({ pickupType: 'cash', amount: 75 }));
  assert.deepEqual(result, { pickupType: 'cash', amount: 75, cash: 75, applied: true });
  assert.equal(player.health, before, 'cash leaves the player untouched');
});

test('unknown pickup types fall back to cash and negative amounts are floored', () => {
  assert.deepEqual(applyPickup(null, createPickup({ pickupType: 'mystery', amount: 12 })), {
    pickupType: 'cash',
    amount: 12,
    cash: 12,
    applied: true,
  });
  assert.equal(applyPickup(null, createPickup({ pickupType: 'cash', amount: -5 })).amount, 0);
});

test('a missing player makes non-cash pickups un-applied', () => {
  const result = applyPickup(null, createPickup({ pickupType: 'health', amount: 25 }));
  assert.equal(result.applied, false);
  assert.equal(result.cash, 0);
});

test('pickupOverlaps uses the sum of both radii', () => {
  const pickup = createPickup({ x: 100, y: 100, radius: 10 });
  assert.equal(pickupOverlaps(pickup, { x: 110, y: 100, radius: 5 }), true, 'touching counts');
  assert.equal(pickupOverlaps(pickup, { x: 116, y: 100, radius: 5 }), false, 'just apart');
  assert.equal(pickupOverlaps(pickup, { x: 100, y: 100 }), true, 'an actor with no radius still touches');
  assert.equal(pickupOverlaps(pickup, null), false);
  assert.equal(pickupOverlaps(null, { x: 100, y: 100 }), false);
  assert.equal(pickupOverlaps(createPickup({ x: 0, y: 0 }), { x: 0, y: 0 }), true, 'uses the default radius');
});

test('walking over a pickup applies it, removes it and emits one event', () => {
  const game = createGame({ map: makeMap(40, 40), seed: 1 });
  game.player.health = 40;
  game.pickups.push(
    createPickup({ id: 77, pickupType: 'health', amount: 30, x: game.player.x, y: game.player.y }),
  );

  update(game);

  assert.equal(game.player.health, 70);
  assert.equal(game.pickups.length, 0, 'the collected pickup is gone');

  const events = drainEvents(game).filter((event) => event.type === 'pickup');
  assert.equal(events.length, 1);
  assert.equal(events[0].pickupId, 77);
  assert.equal(events[0].pickupType, 'health');
  assert.equal(events[0].amount, 30);
});

test('walking over a cash pickup banks cash on the game state', () => {
  const game = createGame({ map: makeMap(40, 40), seed: 1 });
  game.cash = 10;
  game.pickups.push(createPickup({ id: 5, pickupType: 'cash', amount: 90, x: game.player.x, y: game.player.y }));

  update(game);

  assert.equal(game.cash, 100);
  assert.equal(game.pickups.length, 0);
  const event = drainEvents(game).find((entry) => entry.type === 'pickup');
  assert.equal(event.amount, 90);
});

test('pickups off the player stay on the ground', () => {
  const game = createGame({ map: makeMap(40, 40), seed: 1 });
  game.pickups.push(createPickup({ id: 9, pickupType: 'cash', amount: 50, x: game.player.x + 500, y: game.player.y }));

  update(game);

  assert.equal(game.cash, 0);
  assert.equal(game.pickups.length, 1, 'an untouched pickup is not consumed');
});
