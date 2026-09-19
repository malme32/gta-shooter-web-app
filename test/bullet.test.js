import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ttlTicksFor,
  createBullet,
  bulletAabb,
  sweepCircleTiles,
  stepBullet,
  findBulletTarget,
  applyBulletDamage,
} from '../src/core/bullet.js';
import { createGame, update, drainEvents } from '../src/core/game.js';
import { WEAPONS, TICK_SECONDS, TILE_SIZE, BULLET_RADIUS } from '../src/core/constants.js';

function makeMap(width, height, solids = []) {
  const tiles = new Array(width * height).fill(0);
  for (const [x, y] of solids) tiles[y * width + x] = 1;
  return { width, height, tiles };
}

function wallColumn(width, height, tx) {
  const solids = [];
  for (let ty = 0; ty < height; ty += 1) solids.push([tx, ty]);
  return makeMap(width, height, solids);
}

test('ttlTicksFor derives ticks from range and muzzle velocity', () => {
  for (const spec of Object.values(WEAPONS)) {
    const expected = Math.max(1, Math.ceil(spec.bulletRange / (spec.bulletSpeed * TICK_SECONDS)));
    assert.equal(ttlTicksFor(spec), expected);
  }
  assert.equal(ttlTicksFor({ bulletSpeed: 0, bulletRange: 100 }), 1);
  assert.equal(ttlTicksFor({}), 1);
});

test('createBullet fills sensible defaults and remembers its path start', () => {
  const bullet = createBullet({ id: 4, x: 10, y: 20, vx: 60, vy: 0, damage: 7, ttl: 5, owner: 1, weapon: 'pistol' });
  assert.equal(bullet.id, 4);
  assert.equal(bullet.kind, 'bullet');
  assert.equal(bullet.radius, BULLET_RADIUS);
  assert.equal(bullet.prevX, 10);
  assert.equal(bullet.prevY, 20);
  assert.equal(bullet.alive, true);
  assert.equal(bullet.ttl, 5);
  assert.equal(bullet.maxTtl, 5);
  assert.equal(bullet.angle, 0);
  assert.deepEqual(bulletAabb(bullet), { x: 10 - BULLET_RADIUS, y: 20 - BULLET_RADIUS, w: BULLET_RADIUS * 2, h: BULLET_RADIUS * 2 });
});

test('stepBullet advances by velocity * dt and updates prev', () => {
  const map = makeMap(40, 40);
  const bullet = createBullet({ x: 100, y: 100, vx: 600, vy: 0, ttl: 10 });
  const result = stepBullet(map, bullet, TICK_SECONDS);

  assert.equal(result.moved, true);
  assert.equal(result.hitWall, false);
  assert.equal(bullet.prevX, 100);
  assert.equal(bullet.x, 100 + 600 * TICK_SECONDS);
  assert.equal(bullet.ttl, 9);
  assert.equal(bullet.alive, true);
});

test('stepBullet stops at a thin wall however fast the bullet travels', () => {
  const map = wallColumn(40, 40, 5);
  const wallLeft = 5 * TILE_SIZE;

  const bullet = createBullet({ x: 100, y: 16, vx: 6000, vy: 0, ttl: 10, radius: BULLET_RADIUS });
  const result = stepBullet(map, bullet, TICK_SECONDS);

  assert.equal(result.hitWall, true, 'must not tunnel through the wall');
  assert.equal(result.wall.tx, 5);
  assert.equal(bullet.alive, false);
  assert.ok(bullet.x <= wallLeft, `stopped at/before the wall (x=${bullet.x})`);
  assert.ok(bullet.x >= wallLeft - BULLET_RADIUS - 1e-6, 'stops at the wall face, not earlier');
});

test('stepBullet does not hit a wall it misses', () => {
  const map = makeMap(40, 40, [[5, 0], [5, 1]]);
  const bullet = createBullet({ x: 100, y: 16 * TILE_SIZE, vx: 6000, vy: 0, ttl: 10 });
  const result = stepBullet(map, bullet, TICK_SECONDS);

  assert.equal(result.hitWall, false);
  assert.equal(bullet.alive, true);
  assert.equal(bullet.x, 100 + 6000 * TICK_SECONDS);
});

test('bullets expire when their ttl reaches zero', () => {
  const map = makeMap(40, 40);
  const bullet = createBullet({ x: 100, y: 100, vx: 1, vy: 0, ttl: 2 });
  assert.equal(stepBullet(map, bullet).expired, false);
  const last = stepBullet(map, bullet);
  assert.equal(last.expired, true);
  assert.equal(bullet.alive, false);
  assert.equal(stepBullet(map, bullet).moved, false, 'dead bullets do not move');
});

test('sweepCircleTiles returns the full move on an open map and handles no map', () => {
  const map = makeMap(40, 40);
  assert.deepEqual(sweepCircleTiles(map, 10, 10, 3, 50, 0), {
    x: 60,
    y: 10,
    hit: false,
    t: 1,
    tx: -1,
    ty: -1,
  });
  assert.deepEqual(sweepCircleTiles(null, 10, 10, 3, 50, 0), {
    x: 60,
    y: 10,
    hit: false,
    t: 1,
    tx: -1,
    ty: -1,
  });
  assert.deepEqual(sweepCircleTiles(map, 10, 10, 3, 0, 0), {
    x: 10,
    y: 10,
    hit: false,
    t: 0,
    tx: -1,
    ty: -1,
  });
});

test('findBulletTarget hits the nearest live target along the swept path', () => {
  const bullet = createBullet({ x: 0, y: 0, vx: 60, vy: 0, radius: 3, owner: 99 });
  bullet.x = 50;
  bullet.prevX = 0;

  const near = { id: 1, x: 10, y: 0, radius: 8, alive: true };
  const far = { id: 2, x: 45, y: 0, radius: 8, alive: true };
  const hit = findBulletTarget(bullet, [far, near]);
  assert.equal(hit.target.id, 1);
});

test('findBulletTarget ignores the owner, the dead and anything behind the path', () => {
  const bullet = createBullet({ x: 0, y: 0, vx: 60, vy: 0, radius: 3, owner: 7 });
  bullet.x = 50;
  bullet.prevX = 0;

  assert.equal(findBulletTarget(bullet, [{ id: 7, x: 25, y: 0, radius: 8, alive: true }]), null);
  assert.equal(findBulletTarget(bullet, [{ id: 1, x: 25, y: 0, radius: 8, alive: false }]), null);
  assert.equal(findBulletTarget(bullet, [{ id: 2, x: -80, y: 0, radius: 8, alive: true }]), null);
  assert.equal(findBulletTarget(bullet, [{ id: 3, x: 25, y: 400, radius: 8, alive: true }]), null);
});

test('applyBulletDamage drains armour before health and reports kills', () => {
  const target = { id: 1, health: 100, maxHealth: 100, armour: 50, maxArmour: 100, alive: true };

  const first = applyBulletDamage(target, 30);
  assert.deepEqual(first, { dealt: 30, absorbed: 30, health: 100, killed: false });
  assert.equal(target.armour, 20);
  assert.equal(target.health, 100);

  const second = applyBulletDamage(target, 50);
  assert.equal(second.absorbed, 20);
  assert.equal(target.health, 70);
  assert.equal(target.armour, 0);
  assert.equal(target.alive, true);

  const lethal = applyBulletDamage(target, 500);
  assert.equal(lethal.killed, true);
  assert.equal(target.health, 0);
  assert.equal(target.alive, false);

  assert.deepEqual(applyBulletDamage(target, 10), { dealt: 10, absorbed: 0, health: 0, killed: false });
  assert.equal(applyBulletDamage(null, 10).dealt, 10);
});

test('applyBulletDamage treats enemies without armour as unarmoured', () => {
  const enemy = { id: 9, health: 30, alive: true };
  const result = applyBulletDamage(enemy, 12);
  assert.deepEqual(result, { dealt: 12, absorbed: 0, health: 18, killed: false });
  assert.equal(enemy.armour, 0);
  assert.equal(enemy.alive, true);
});

test('game bullets damage the correct target and emit a hit event', () => {
  const map = makeMap(40, 40);
  const game = createGame({ map, spawn: { x: 320, y: 320 }, seed: 3 });
  game.player.aim = 0;
  game.targets.push({ id: 1, x: 360, y: 320, radius: 10, health: 100, maxHealth: 100, armour: 0, maxArmour: 0, alive: true });
  game.targets.push({ id: 2, x: 560, y: 320, radius: 10, health: 100, maxHealth: 100, armour: 0, maxArmour: 0, alive: true });
  game.input.fire = true;

  let hit = null;
  for (let i = 0; i < 30 && !hit; i += 1) {
    update(game);
    hit = drainEvents(game).find((event) => event.type === 'hit');
  }

  assert.ok(hit, 'a hit event should be emitted');
  assert.equal(hit.targetId, 1);
  assert.equal(hit.amount, WEAPONS.pistol.damage);
  assert.equal(game.targets[0].health, 100 - WEAPONS.pistol.damage);
  assert.equal(game.targets[1].health, 100, 'the other target is untouched');
  assert.equal(game.bullets.length, 0, 'the bullet is consumed on impact');
});

test('game bullets emit tracer and muzzle events when firing', () => {
  const map = makeMap(40, 40);
  const game = createGame({ map, spawn: { x: 320, y: 320 }, seed: 3 });
  game.player.aim = 0;
  game.input.fire = true;
  update(game);

  const events = drainEvents(game);
  assert.equal(events.filter((event) => event.type === 'muzzle').length, 1);
  const tracers = events.filter((event) => event.type === 'tracer');
  assert.equal(tracers.length, 1);
  assert.equal(tracers[0].bulletId, game.bullets[0].id);
  assert.equal(tracers[0].weapon, 'pistol');
});
