import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ENEMY_TYPES,
  ENEMY_TYPE_IDS,
  enemySpec,
  createEnemy,
  isEnemyAlive,
  applyEnemyDamage,
  killEnemy,
  rollLoot,
  createPickup,
  PICKUP_RADIUS,
} from '../src/core/enemy.js';
import { createGame, update, drainEvents, restart } from '../src/core/game.js';
import { createMap, isWalkableTile } from '../src/core/map.js';
import { createRng } from '../src/core/rng.js';
import { TILE_SIZE } from '../src/core/constants.js';

function makeMap(width, height, solids = [], spawns = {}) {
  const tiles = new Array(width * height).fill(0);
  for (const [x, y] of solids) tiles[y * width + x] = 1;
  return { width, height, tiles, ...spawns };
}

test('enemySpec resolves every archetype and falls back to thug', () => {
  for (const id of ENEMY_TYPE_IDS) {
    assert.equal(enemySpec(id), ENEMY_TYPES[id]);
  }
  assert.equal(enemySpec('unknown'), ENEMY_TYPES.thug);
  assert.equal(enemySpec(undefined), ENEMY_TYPES.thug);
  assert.equal(ENEMY_TYPE_IDS.length, 3);
});

test('createEnemy copies archetype stats and starts at full health', () => {
  for (const id of ENEMY_TYPE_IDS) {
    const spec = ENEMY_TYPES[id];
    const enemy = createEnemy({ id: 3, type: id, x: 10, y: 20 });
    assert.equal(enemy.kind, 'enemy');
    assert.equal(enemy.type, id);
    assert.equal(enemy.name, spec.name);
    assert.equal(enemy.health, spec.maxHealth);
    assert.equal(enemy.maxHealth, spec.maxHealth);
    assert.equal(enemy.armour, spec.armour);
    assert.equal(enemy.radius, spec.radius);
    assert.equal(enemy.speed, spec.speed);
    assert.equal(enemy.alive, true);
    assert.equal(enemy.state, 'idle');
    assert.deepEqual(enemy.home, { x: 10, y: 20 });
  }
});

test('createEnemy honours a health override and never spawns above the ceiling', () => {
  assert.equal(createEnemy({ type: 'thug', health: 10 }).health, 10);
  assert.equal(createEnemy({ type: 'thug', health: 9999 }).health, ENEMY_TYPES.thug.maxHealth);
  assert.equal(createEnemy({ type: 'thug', health: 0 }).alive, false);
});

test('applyEnemyDamage drains armour before health and reports kills', () => {
  const brute = createEnemy({ type: 'brute', id: 1 });
  assert.equal(brute.maxHealth, 220);
  assert.equal(brute.armour, 50);

  const first = applyEnemyDamage(brute, 30);
  assert.deepEqual(first, { amount: 30, absorbed: 30, health: 220, armour: 20, killed: false, ignored: false });
  assert.equal(isEnemyAlive(brute), true);

  const second = applyEnemyDamage(brute, 100);
  assert.equal(second.absorbed, 20);
  assert.equal(brute.armour, 0);
  assert.equal(brute.health, 140);
  assert.equal(second.killed, false);

  const lethal = applyEnemyDamage(brute, 1000);
  assert.equal(lethal.killed, true);
  assert.equal(brute.health, 0);
  assert.equal(brute.alive, false);
  assert.equal(isEnemyAlive(brute), false);
});

test('applyEnemyDamage ignores dead enemies, zero and negative amounts', () => {
  const dead = createEnemy({ type: 'thug', health: 0 });
  assert.equal(applyEnemyDamage(dead, 10).ignored, true);
  assert.equal(applyEnemyDamage(dead, 10).killed, false);

  const live = createEnemy({ type: 'thug' });
  assert.equal(applyEnemyDamage(live, 0).ignored, true);
  assert.equal(applyEnemyDamage(live, -5).ignored, true);
  assert.equal(applyEnemyDamage(live, -5).amount, 0);
  assert.equal(applyEnemyDamage(null, 10).ignored, true);
});

test('killEnemy marks an enemy dead exactly once', () => {
  const enemy = createEnemy({ type: 'thug' });
  assert.equal(killEnemy(enemy), true);
  assert.equal(enemy.alive, false);
  assert.equal(enemy.health, 0);
  assert.equal(killEnemy(enemy), false, 'killing a dead enemy is a no-op');
});

test('rollLoot is deterministic for a seeded rng', () => {
  const a = createRng(7);
  const b = createRng(7);
  for (let i = 0; i < 25; i += 1) {
    assert.deepEqual(rollLoot(a, 'shooter'), rollLoot(b, 'shooter'));
  }
});

test('rollLoot respects the drop chance and stays inside the amount bounds', () => {
  assert.equal(rollLoot(() => 1, 'thug'), null, 'a roll at the top of the range never drops');

  const guaranteed = rollLoot(() => 0, 'thug');
  assert.deepEqual(guaranteed, { type: 'cash', amount: 10 }, 'first weighted entry at the minimum amount');

  const spec = ENEMY_TYPES.shooter;
  const seen = new Set();
  const rng = createRng(21);
  for (let i = 0; i < 200; i += 1) {
    const loot = rollLoot(rng, spec);
    if (!loot) continue;
    seen.add(loot.type);
    const entry = spec.loot.table.find((item) => item.type === loot.type);
    assert.ok(entry, `unknown loot type ${loot.type}`);
    assert.ok(loot.amount >= entry.min && loot.amount <= entry.max, `${loot.amount} outside [${entry.min}, ${entry.max}]`);
  }
  assert.ok(seen.size > 0, 'at least one drop across 200 rolls');
});

test('createPickup builds a live pickup with a default radius', () => {
  const pickup = createPickup({ id: 5, pickupType: 'health', amount: 25, x: 7, y: 9 });
  assert.deepEqual(pickup, {
    id: 5,
    kind: 'pickup',
    pickupType: 'health',
    x: 7,
    y: 9,
    radius: PICKUP_RADIUS,
    amount: 25,
    alive: true,
  });
});

test('createGame spawns enemies from map.spawns.enemySpawns', () => {
  const map = createMap({ width: 60, height: 60, seed: 4 });
  const game = createGame({ map, seed: 4 });

  assert.equal(game.enemies.length, map.spawns.enemySpawns.length);
  assert.ok(game.enemies.length > 0, 'the generated map should place some enemies');
  game.enemies.forEach((enemy, index) => {
    assert.equal(enemy.id, index + 1);
    assert.equal(enemy.type, ENEMY_TYPE_IDS[index % ENEMY_TYPE_IDS.length]);
    assert.deepEqual({ x: enemy.x, y: enemy.y }, map.spawns.enemySpawns[index]);
  });
  assert.deepEqual(game.targets, [], 'enemies are tracked separately from the generic target list');
});

test('createGame also accepts a top-level map.enemySpawns list', () => {
  const map = makeMap(20, 20, [], { enemySpawns: [{ x: 100, y: 100 }] });
  const game = createGame({ map, seed: 1 });
  assert.equal(game.enemies.length, 1);
  assert.equal(game.enemies[0].x, 100);
  assert.equal(game.enemies[0].type, 'thug');
});

test('enemy death removes it, emits an event and drops deterministic loot', () => {
  const map = makeMap(20, 20, [], { enemySpawns: [{ x: 100, y: 100 }] });
  const game = createGame({ map, spawn: { x: 40, y: 40 }, seed: 2 });
  game.rng = () => 0;

  const enemy = game.enemies[0];
  enemy.health = 1;
  applyEnemyDamage(enemy, 999);
  assert.equal(isEnemyAlive(enemy), false);

  const events = drainEvents(game);
  update(game);

  assert.equal(game.enemies.length, 0, 'the dead enemy is reaped');
  assert.equal(game.pickups.length, 1);
  assert.equal(game.pickups[0].pickupType, 'cash');
  assert.equal(game.pickups[0].amount, 10);

  const all = events.concat(drainEvents(game));
  assert.ok(all.some((event) => event.type === 'enemy_death'));
  assert.ok(all.some((event) => event.type === 'loot_drop'));
});

test('a killed enemy drops nothing when the loot roll fails', () => {
  const map = makeMap(20, 20, [], { enemySpawns: [{ x: 100, y: 100 }] });
  const game = createGame({ map, spawn: { x: 40, y: 40 }, seed: 2 });
  game.rng = () => 1;

  applyEnemyDamage(game.enemies[0], 999);
  update(game);

  assert.equal(game.enemies.length, 0);
  assert.equal(game.pickups.length, 0);
});

test('pickups are collected by the player and apply their effect', () => {
  const map = makeMap(20, 20);
  const game = createGame({ map, spawn: { x: 100, y: 100 }, seed: 3 });

  game.pickups.push(createPickup({ id: 1, pickupType: 'cash', amount: 25, x: game.player.x, y: game.player.y }));
  update(game);
  assert.equal(game.cash, 25);
  assert.equal(game.pickups.length, 0);
  assert.ok(drainEvents(game).some((event) => event.type === 'pickup'));

  game.player.health = 50;
  game.pickups.push(createPickup({ id: 2, pickupType: 'health', amount: 20, x: game.player.x, y: game.player.y }));
  update(game);
  assert.equal(game.player.health, 70);

  game.player.armour = 0;
  game.pickups.push(createPickup({ id: 3, pickupType: 'armour', amount: 15, x: game.player.x, y: game.player.y }));
  update(game);
  assert.equal(game.player.armour, 15);

  const reserve = game.player.reserve;
  game.pickups.push(createPickup({ id: 4, pickupType: 'ammo', amount: 30, x: game.player.x, y: game.player.y }));
  update(game);
  assert.equal(game.player.reserve, reserve + 30);
});

test('restart respawns the squad and clears loot and cash', () => {
  const map = createMap({ width: 60, height: 60, seed: 4 });
  const game = createGame({ map, seed: 4 });
  const total = game.enemies.length;

  game.enemies.pop();
  game.pickups.push(createPickup({ id: 9, pickupType: 'cash', amount: 10, x: 0, y: 0 }));
  game.cash = 500;
  game.nextPickupId = 10;

  restart(game);

  assert.equal(game.enemies.length, total);
  assert.equal(game.pickups.length, 0);
  assert.equal(game.cash, 0);
  assert.equal(game.nextPickupId, 1);
  assert.deepEqual(game.enemies.map((enemy) => enemy.id), Array.from({ length: total }, (_, i) => i + 1));
});

test('player fire kills an enemy and removes it from the world', () => {
  const map = makeMap(40, 40, [], { enemySpawns: [{ x: 360, y: 320 }] });
  const game = createGame({ map, spawn: { x: 320, y: 320 }, seed: 3 });
  game.player.aim = 0;

  let killed = false;
  for (let i = 0; i < 240 && !killed; i += 1) {
    game.input.fire = i % 2 === 0;
    update(game);
    killed = game.enemies.length === 0;
  }

  assert.equal(killed, true, 'the enemy should die to sustained pistol fire');
  assert.equal(game.player.health > 0, true, 'the player survives the exchange');
});

test('map spawn points are not inside solid tiles', () => {
  const map = createMap({ width: 80, height: 80, seed: 11 });
  for (const spawn of map.spawns.enemySpawns) {
    const tx = Math.floor(spawn.x / TILE_SIZE);
    const ty = Math.floor(spawn.y / TILE_SIZE);
    assert.equal(isWalkableTile(map.tiles[ty * map.width + tx]), true, `enemy spawn (${tx},${ty}) must be walkable`);
  }
});
