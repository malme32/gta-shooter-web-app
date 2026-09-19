import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createVehicle,
  stepVehicle,
  runOverDamage,
  runOverDamageTick,
  damageInRadius,
  explodeVehicle,
  applyVehicleDamage,
  findNearestVehicle,
  findVehicleById,
  findExitPosition,
  enterVehicle,
  exitVehicle,
  normalizeAngle,
} from '../src/core/vehicle.js';
import { createGame, update, drainEvents } from '../src/core/game.js';
import { createPlayer } from '../src/core/player.js';
import { createBullet } from '../src/core/bullet.js';
import { canStandAt } from '../src/core/map.js';
import {
  TICK_SECONDS,
  TILE_SIZE,
  VEHICLE_RADIUS,
  VEHICLE_MAX_HEALTH,
  VEHICLE_MAX_SPEED,
  VEHICLE_RUNOVER_MIN_SPEED,
  VEHICLE_EXPLOSION_DAMAGE,
} from '../src/core/constants.js';
import { snapshotScene, interpolateScene } from '../src/ui/render.js';
import { computeHudLayout, drivingVehicle, formatSpeed } from '../src/ui/hud.js';

function makeMap(width, height, solids = []) {
  const tiles = new Array(width * height).fill(0);
  for (const [x, y] of solids) tiles[y * width + x] = 1;
  return { width, height, tiles };
}

function bordered(width, height) {
  const solids = [];
  for (let x = 0; x < width; x += 1) solids.push([x, 0], [x, height - 1]);
  for (let y = 0; y < height; y += 1) solids.push([0, y], [width - 1, y]);
  return makeMap(width, height, solids);
}

/** Every tile is a building except the single tile at (2, 2). */
function boxedTile() {
  const map = makeMap(5, 5, []);
  map.tiles.fill(1);
  map.tiles[2 * 5 + 2] = 0;
  return map;
}

function makeEntity(overrides = {}) {
  return {
    id: 'e1',
    kind: 'enemy',
    x: 0,
    y: 0,
    radius: 10,
    health: 100,
    maxHealth: 100,
    alive: true,
    ...overrides,
  };
}

test('createVehicle initialises stats, clamps health and normalises the angle', () => {
  const vehicle = createVehicle({ id: 'v1', x: 10, y: 20, angle: Math.PI * 3, health: 500 });
  assert.equal(vehicle.kind, 'vehicle');
  assert.equal(vehicle.x, 10);
  assert.equal(vehicle.y, 20);
  assert.equal(vehicle.radius, VEHICLE_RADIUS);
  assert.equal(vehicle.health, VEHICLE_MAX_HEALTH);
  assert.equal(vehicle.maxHealth, VEHICLE_MAX_HEALTH);
  assert.equal(vehicle.alive, true);
  assert.equal(vehicle.occupiedBy, null);
  assert.ok(Math.abs(vehicle.angle) <= Math.PI);
  assert.equal(normalizeAngle(-Math.PI * 3), Math.PI);
  assert.equal(createVehicle({ health: 0 }).alive, false);
});

test('throttle accelerates a vehicle and friction brings it to a stop', () => {
  const map = bordered(400, 20);
  const vehicle = createVehicle({ x: 4 * TILE_SIZE, y: 10 * TILE_SIZE });

  const first = stepVehicle(map, vehicle, { throttle: 1 }, TICK_SECONDS);
  assert.equal(first.crashed, false);
  assert.ok(vehicle.speed > 0);

  const afterThrottle = vehicle.speed;
  stepVehicle(map, vehicle, {}, TICK_SECONDS);
  assert.ok(vehicle.speed < afterThrottle, 'coasting must shed speed');

  for (let i = 0; i < 400; i += 1) stepVehicle(map, vehicle, {}, TICK_SECONDS);
  assert.equal(vehicle.speed, 0);
});

test('a vehicle never exceeds its top speed', () => {
  const map = bordered(400, 20);
  const vehicle = createVehicle({ x: 4 * TILE_SIZE, y: 10 * TILE_SIZE });
  for (let i = 0; i < 120; i += 1) stepVehicle(map, vehicle, { throttle: 1 }, TICK_SECONDS);
  assert.ok(vehicle.speed <= VEHICLE_MAX_SPEED + 1e-9);
  assert.ok(vehicle.speed > VEHICLE_MAX_SPEED - 1);
});

test('steering only applies while the vehicle is moving', () => {
  const map = bordered(40, 40);
  const parked = createVehicle({ x: 20 * TILE_SIZE, y: 20 * TILE_SIZE, angle: 0 });
  stepVehicle(map, parked, { steer: 1 }, TICK_SECONDS);
  assert.equal(parked.angle, 0, 'a stationary vehicle must not pivot');

  const moving = createVehicle({ x: 20 * TILE_SIZE, y: 20 * TILE_SIZE, angle: 0, speed: 200 });
  stepVehicle(map, moving, { steer: 1 }, TICK_SECONDS);
  assert.notEqual(moving.angle, 0);
});

test('steering mirrors when reversing', () => {
  const map = bordered(40, 40);
  const forward = createVehicle({ x: 20 * TILE_SIZE, y: 20 * TILE_SIZE, speed: 200 });
  const reverse = createVehicle({ x: 20 * TILE_SIZE, y: 20 * TILE_SIZE, speed: -200 });
  stepVehicle(map, forward, { steer: 1 }, TICK_SECONDS);
  stepVehicle(map, reverse, { steer: 1 }, TICK_SECONDS);
  assert.ok(forward.angle * reverse.angle < 0, 'reverse steering should be mirrored');
});

test('the handbrake brakes harder than coasting', () => {
  const map = bordered(40, 40);
  const coast = createVehicle({ x: 20 * TILE_SIZE, y: 20 * TILE_SIZE, speed: 300 });
  const braked = createVehicle({ x: 20 * TILE_SIZE, y: 20 * TILE_SIZE, speed: 300 });
  stepVehicle(map, coast, {}, TICK_SECONDS);
  stepVehicle(map, braked, { handbrake: true }, TICK_SECONDS);
  assert.ok(braked.speed < coast.speed);
});

test('a vehicle cannot drive through a building', () => {
  const solids = [];
  for (let y = 1; y <= 4; y += 1) solids.push([4, y]);
  const map = makeMap(10, 6, solids);
  const vehicle = createVehicle({ x: 2 * TILE_SIZE + 16, y: 2 * TILE_SIZE + 16, angle: 0 });

  let crashed = false;
  for (let i = 0; i < 240; i += 1) {
    const result = stepVehicle(map, vehicle, { throttle: 1 }, TICK_SECONDS);
    crashed = crashed || result.crashed;
  }

  assert.ok(crashed, 'the vehicle should register a crash against the wall');
  assert.ok(vehicle.x + vehicle.radius <= 4 * TILE_SIZE + 1e-6, `vehicle tunnelled to ${vehicle.x}`);
});

test('applyVehicleDamage drains health and kills at zero', () => {
  const vehicle = createVehicle({ health: 100 });
  const hit = applyVehicleDamage(vehicle, 30);
  assert.equal(hit.health, 70);
  assert.equal(hit.killed, false);

  const lethal = applyVehicleDamage(vehicle, 500);
  assert.equal(vehicle.health, 0);
  assert.equal(vehicle.alive, false);
  assert.equal(lethal.killed, true);

  assert.equal(applyVehicleDamage(null, 10).ignored, true);
});

test('runOverDamage is zero when crawling and scales with speed', () => {
  assert.equal(runOverDamage(0), 0);
  assert.equal(runOverDamage(VEHICLE_RUNOVER_MIN_SPEED - 1), 0);
  assert.ok(runOverDamage(VEHICLE_MAX_SPEED) > runOverDamage(VEHICLE_RUNOVER_MIN_SPEED));
  assert.equal(runOverDamage(VEHICLE_MAX_SPEED + 5000), runOverDamage(VEHICLE_MAX_SPEED));
});

test('run-over damages a target once per contact and again after re-entry', () => {
  const vehicle = createVehicle({ x: 320, y: 320, speed: 260 });
  const target = makeEntity({ x: 320, y: 320 });

  const first = runOverDamageTick(vehicle, [target]);
  assert.equal(first.length, 1);
  const health = target.health;
  assert.ok(health < 100);

  assert.equal(runOverDamageTick(vehicle, [target]).length, 0, 'contact re-application must be suppressed');
  assert.equal(target.health, health);

  target.x = 5000;
  runOverDamageTick(vehicle, [target]);
  target.x = 320;
  assert.equal(runOverDamageTick(vehicle, [target]).length, 1, 're-entering contact should damage again');
});

test('a contact is remembered across a slow tick and does not re-damage', () => {
  const vehicle = createVehicle({ x: 320, y: 320, speed: VEHICLE_MAX_SPEED });
  const target = makeEntity({ x: 320, y: 320 });

  assert.equal(runOverDamageTick(vehicle, [target]).length, 1);
  const health = target.health;

  // Crawl while still touching: no damage, but the contact must not be lost.
  vehicle.speed = 10;
  assert.equal(runOverDamageTick(vehicle, [target]).length, 0);
  assert.equal(target.health, health);

  // Speed back up without parting: still the same contact, no second hit.
  vehicle.speed = VEHICLE_MAX_SPEED;
  assert.equal(runOverDamageTick(vehicle, [target]).length, 0, 'a slow tick must not re-arm the contact');
  assert.equal(target.health, health);
});

test('run-over ignores slow vehicles, dead targets and other vehicles', () => {
  const slow = createVehicle({ x: 0, y: 0, speed: 10 });
  const target = makeEntity({ x: 0, y: 0 });
  assert.equal(runOverDamageTick(slow, [target]).length, 0);

  const fast = createVehicle({ x: 0, y: 0, speed: 300 });
  const dead = makeEntity({ x: 0, y: 0, alive: false });
  const other = createVehicle({ id: 'other', x: 0, y: 0 });
  assert.equal(runOverDamageTick(fast, [dead, other]).length, 0);
});

test('damageInRadius only hits live entities inside the blast', () => {
  const vehicle = createVehicle({ x: 100, y: 100 });
  const near = makeEntity({ id: 'near', x: 120, y: 100 });
  const far = makeEntity({ id: 'far', x: 900, y: 100 });
  const dead = makeEntity({ id: 'dead', x: 110, y: 100, alive: false });
  const hits = damageInRadius([vehicle, near, far, dead], 100, 100, 96, 80, { exclude: vehicle });
  assert.deepEqual(hits.map((hit) => hit.target.id), ['near']);
  assert.equal(near.health, 20);
  assert.equal(far.health, 100);
});

test('findNearestVehicle picks the closest enterable vehicle in range', () => {
  const vehicles = [
    createVehicle({ id: 'far', x: 100, y: 0 }),
    createVehicle({ id: 'near', x: 20, y: 0 }),
    createVehicle({ id: 'dead', x: 5, y: 0, health: 0 }),
    createVehicle({ id: 'taken', x: 8, y: 0 }),
  ];
  vehicles[3].occupiedBy = 42;

  assert.equal(findNearestVehicle(vehicles, 0, 0, 40).id, 'near');
  assert.equal(findNearestVehicle(vehicles, 1000, 1000, 40), null);
  assert.equal(findVehicleById(vehicles, 'taken').id, 'taken');
  assert.equal(findVehicleById(vehicles, 'missing'), null);
});

test('enterVehicle claims the seat and snaps the player onto the vehicle', () => {
  const vehicle = createVehicle({ id: 'v1', x: 50, y: 60, angle: 0.5 });
  const player = createPlayer({ id: 7 });

  assert.equal(enterVehicle(vehicle, player), true);
  assert.equal(vehicle.occupiedBy, 7);
  assert.equal(player.vehicleId, 'v1');
  assert.equal(player.x, 50);
  assert.equal(player.y, 60);
  assert.equal(player.aim, 0.5);

  assert.equal(enterVehicle(vehicle, createPlayer({ id: 8 })), false, 'an occupied vehicle cannot be entered');
});

test('exitVehicle places the player on a safe tile and clears the seat', () => {
  const map = bordered(20, 20);
  const vehicle = createVehicle({ id: 'v1', x: 10 * TILE_SIZE, y: 10 * TILE_SIZE });
  const player = createPlayer({ id: 1 });
  enterVehicle(vehicle, player);

  const position = exitVehicle(vehicle, player, map);
  assert.ok(position);
  assert.equal(player.vehicleId, null);
  assert.equal(vehicle.occupiedBy, null);
  assert.ok(canStandAt(map, player.x, player.y, player.radius));
});

test('exitVehicle refuses to place the player inside a building', () => {
  const map = boxedTile();
  const center = { x: 2.5 * TILE_SIZE, y: 2.5 * TILE_SIZE };
  const vehicle = createVehicle({ id: 'v1', x: center.x, y: center.y });
  const player = createPlayer({ id: 1 });
  enterVehicle(vehicle, player);

  assert.equal(findExitPosition(map, vehicle, player.radius), null);
  assert.equal(exitVehicle(vehicle, player, map), null);
  assert.equal(player.vehicleId, 'v1', 'the player must stay inside when boxed in');
});

test('explodeVehicle destroys the vehicle and damages nearby entities only', () => {
  const vehicle = createVehicle({ id: 'v1', x: 100, y: 100, health: 50 });
  const near = makeEntity({ id: 'near', x: 120, y: 100 });
  const far = makeEntity({ id: 'far', x: 500, y: 100 });

  const boom = explodeVehicle(vehicle, [vehicle, near, far]);
  assert.equal(vehicle.alive, false);
  assert.equal(vehicle.exploded, true);
  assert.equal(vehicle.health, 0);
  assert.equal(vehicle.speed, 0);
  assert.equal(near.health, 100 - VEHICLE_EXPLOSION_DAMAGE);
  assert.equal(far.health, 100);
  assert.equal(boom.hits.length, 1);
});

test('E enters the nearest vehicle, drives it, and E again exits to a safe tile', () => {
  const map = bordered(30, 30);
  const startX = 5 * TILE_SIZE;
  const vehicleX = startX + 20;
  const game = createGame({
    map,
    spawn: { x: startX, y: 5 * TILE_SIZE },
    vehicles: [{ id: 'v1', x: vehicleX, y: 5 * TILE_SIZE }],
  });

  game.input.enter = true;
  update(game);
  assert.equal(game.player.vehicleId, 'v1');
  assert.equal(game.vehicles[0].occupiedBy, game.player.id);
  assert.ok(drainEvents(game).some((event) => event.type === 'vehicle_enter'));

  game.input.up = true;
  for (let i = 0; i < 30; i += 1) update(game);
  game.input.up = false;
  assert.ok(game.player.x > vehicleX, 'the player should move with the vehicle');
  assert.equal(game.player.x, game.vehicles[0].x);

  game.input.enter = true;
  update(game);
  assert.equal(game.player.vehicleId, null);
  assert.equal(game.vehicles[0].occupiedBy, null);
  assert.ok(canStandAt(map, game.player.x, game.player.y, game.player.radius));
});

test('driving over a target damages it through the game simulation', () => {
  const map = bordered(40, 40);
  const startX = 5 * TILE_SIZE;
  const game = createGame({
    map,
    spawn: { x: startX, y: 5 * TILE_SIZE },
    vehicles: [{ id: 'v1', x: startX, y: 5 * TILE_SIZE }],
  });
  const enemy = makeEntity({ id: 'e1', x: startX + 140, y: 5 * TILE_SIZE });
  game.targets.push(enemy);

  game.input.enter = true;
  update(game);
  game.input.up = true;

  let runOver = null;
  for (let i = 0; i < 180 && !runOver; i += 1) {
    update(game);
    runOver = drainEvents(game).find((event) => event.type === 'run_over') ?? null;
  }

  assert.ok(runOver, 'expected a run_over event');
  assert.equal(runOver.targetId, 'e1');
  assert.ok(enemy.health < 100);
});

test('shooting a vehicle to destruction detonates it and damages nearby enemies', () => {
  const map = bordered(30, 30);
  const vehicleX = 10 * TILE_SIZE;
  const game = createGame({
    map,
    spawn: { x: 5 * TILE_SIZE, y: 5 * TILE_SIZE },
    vehicles: [{ id: 'v1', x: vehicleX, y: 5 * TILE_SIZE }],
  });
  const enemy = makeEntity({ id: 'e1', x: vehicleX + 30, y: 5 * TILE_SIZE });
  game.targets.push(enemy);
  game.vehicles[0].health = 10;

  game.bullets.push(
    createBullet({ id: 99, x: vehicleX - 8, y: 5 * TILE_SIZE, vx: 600, vy: 0, damage: 50, ttl: 5, owner: 0 }),
  );
  update(game);

  const events = drainEvents(game);
  assert.equal(game.vehicles[0].alive, false);
  assert.ok(events.some((event) => event.type === 'vehicle_explosion'));
  assert.ok(enemy.health < 100, 'the blast should damage a nearby enemy');
});

test('a blast that destroys another vehicle chain-detonates it', () => {
  const map = bordered(30, 30);
  const ax = 10 * TILE_SIZE;
  const game = createGame({
    map,
    spawn: { x: 5 * TILE_SIZE, y: 5 * TILE_SIZE },
    vehicles: [
      { id: 'v1', x: ax, y: 5 * TILE_SIZE },
      { id: 'v2', x: ax + 40, y: 5 * TILE_SIZE },
    ],
  });
  const [first, second] = game.vehicles;
  first.health = 10;
  second.health = 10;

  game.bullets.push(
    createBullet({ id: 99, x: ax - 8, y: 5 * TILE_SIZE, vx: 600, vy: 0, damage: 50, ttl: 5, owner: 0 }),
  );
  update(game);

  const explosions = drainEvents(game).filter((event) => event.type === 'vehicle_explosion');
  assert.equal(explosions.length, 2, 'both vehicles should detonate');
  assert.equal(first.exploded, true);
  assert.equal(second.exploded, true);
  assert.equal(second.alive, false);
});

test('the HUD shows vehicle health and speed while driving', () => {
  assert.equal(formatSpeed(0), '0 km/h');
  assert.equal(formatSpeed(100), '35 km/h');
  assert.equal(formatSpeed(-200), '70 km/h');
  assert.equal(formatSpeed(NaN), '0 km/h');

  const game = { player: { vehicleId: 'v1' }, vehicles: [{ id: 'v1', health: 50, maxHealth: 100, speed: 120 }] };
  assert.equal(drivingVehicle(game).id, 'v1');
  assert.equal(drivingVehicle({ player: { vehicleId: null }, vehicles: [] }), null);
  assert.equal(drivingVehicle({ player: {}, vehicles: [] }), null);

  const layout = computeHudLayout(960, 540);
  for (const key of ['vehicle', 'speed']) {
    assert.ok(layout[key], `missing ${key} rect`);
    assert.ok(layout[key].x + layout[key].width <= 960);
    assert.ok(layout[key].y + layout[key].height <= 540);
  }
  assert.equal(layout.drivingVisible, true);
  assert.equal(computeHudLayout(960, 120).drivingVisible, false, 'hide the speed row on a short canvas');
});

test('vehicles are snapshotted and interpolated by heading', () => {
  const game = {
    player: null,
    camera: null,
    vehicles: [{ id: 'v1', kind: 'vehicle', x: 10, y: 20, radius: VEHICLE_RADIUS, angle: 0.25, alive: true }],
  };
  const scene = snapshotScene(game);
  assert.equal(scene.entities.length, 1);
  assert.equal(scene.entities[0].angle, 0.25);

  const prev = { player: null, camera: null, entities: [{ id: 'v1', x: 0, y: 0, angle: 0 }] };
  const curr = { player: null, camera: null, entities: [{ id: 'v1', x: 10, y: 0, angle: 1 }] };
  const blended = interpolateScene(prev, curr, 0.5);
  assert.ok(Math.abs(blended.entities[0].angle - 0.5) < 1e-9);
});
