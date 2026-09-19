import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AI_STATES,
  PATROL_ARRIVE_RADIUS,
  PATROL_TIMEOUT_TICKS,
  lineOfSight,
  canSee,
  steerToward,
  choosePatrolTarget,
  aiTick,
} from '../src/core/ai.js';
import { ENEMY_TYPES, createEnemy, isEnemyAlive } from '../src/core/enemy.js';
import { createGame, update, drainEvents } from '../src/core/game.js';
import { createRng } from '../src/core/rng.js';
import { TILE_SIZE } from '../src/core/constants.js';
import { canStandAt } from '../src/core/map.js';

function makeMap(width, height, solids = [], spawns = {}) {
  const tiles = new Array(width * height).fill(0);
  for (const [x, y] of solids) tiles[y * width + x] = 1;
  return { width, height, tiles, ...spawns };
}

function wallColumn(width, height, tx) {
  const solids = [];
  for (let ty = 0; ty < height; ty += 1) solids.push([tx, ty]);
  return makeMap(width, height, solids);
}

test('lineOfSight is clear on open ground and blocked by a building', () => {
  const open = makeMap(20, 20);
  assert.equal(lineOfSight(open, 100, 100, 400, 100), true);

  const walled = wallColumn(20, 20, 5);
  assert.equal(lineOfSight(walled, 100, 16, 400, 16), false, 'a full wall blocks the segment');
  assert.equal(lineOfSight(walled, 100, 16, 150, 16), true, 'a segment that stops short of the wall is clear');
  assert.equal(lineOfSight(null, 0, 0, 100, 100), true, 'no map means nothing to block');
});

test('lineOfSight treats out-of-bounds as solid', () => {
  const map = makeMap(10, 10);
  assert.equal(lineOfSight(map, 100, 100, 5000, 100), false);
  assert.equal(lineOfSight(map, 100, 100, -500, 100), false);
});

test('canSee requires both range and an unobstructed line', () => {
  const map = makeMap(40, 40);
  const thug = createEnemy({ id: 1, type: 'thug', x: 100, y: 100 });
  const spec = ENEMY_TYPES.thug;

  const near = { id: 0, x: 100 + spec.sightRange - 10, y: 100, alive: true };
  assert.equal(canSee(map, thug, near, spec), true);

  const far = { id: 0, x: 100 + spec.sightRange + 50, y: 100, alive: true };
  assert.equal(canSee(map, thug, far, spec), false);

  const walled = wallColumn(40, 40, 5);
  const behindWall = { id: 0, x: 5 * TILE_SIZE + 200, y: 100, alive: true };
  assert.equal(canSee(walled, thug, behindWall, spec), false);
  assert.equal(canSee(map, thug, { id: 0, x: 120, y: 100, alive: false }, spec), false);
});

test('an idle enemy acquires a visible player and chases from out of attack range', () => {
  const map = makeMap(40, 40);
  const thug = createEnemy({ id: 1, type: 'thug', x: 100, y: 100 });
  const spec = ENEMY_TYPES.thug;
  const player = { id: 0, x: 100 + spec.attackRange + 20, y: 100, alive: true };

  const result = aiTick(map, thug, { player, rng: createRng(1) });
  assert.equal(result.previousState, AI_STATES.IDLE);
  assert.equal(result.state, AI_STATES.CHASE);
  assert.equal(result.visible, true);
  assert.equal(result.alerted, true);
  assert.equal(result.fired, false);
});

test('an idle enemy waits idleTicks before patrolling when it cannot see the player', () => {
  const map = makeMap(40, 40);
  const thug = createEnemy({ id: 1, type: 'thug', x: 100, y: 100 });
  const spec = ENEMY_TYPES.thug;
  const player = { id: 0, x: 5000, y: 5000, alive: true };
  const rng = createRng(2);

  for (let i = 0; i < spec.idleTicks - 1; i += 1) {
    aiTick(map, thug, { player, rng });
  }
  assert.equal(thug.state, AI_STATES.IDLE);

  aiTick(map, thug, { player, rng });
  assert.equal(thug.state, AI_STATES.PATROL);
  assert.ok(thug.patrolTarget, 'patrolling picks a waypoint');
});

test('an enemy attacks and fires within range, respecting the fire cadence', () => {
  const map = makeMap(40, 40);
  const thug = createEnemy({ id: 1, type: 'thug', x: 100, y: 100 });
  const spec = ENEMY_TYPES.thug;
  const player = { id: 0, x: 100 + spec.attackRange - 20, y: 100, alive: true };
  const rng = createRng(3);

  const first = aiTick(map, thug, { player, rng });
  assert.equal(first.state, AI_STATES.ATTACK);
  assert.equal(first.fired, true);
  assert.equal(first.bullets.length, spec.pellets);
  assert.equal(thug.cooldown, spec.fireDelayTicks);

  const bullet = first.bullets[0];
  assert.equal(bullet.weapon, spec.weapon);
  assert.equal(bullet.damage, spec.damage);
  assert.ok(bullet.ttl > 0);

  const second = aiTick(map, thug, { player, rng });
  assert.equal(second.fired, false, 'the cooldown gates the next shot');

  thug.cooldown = 0;
  const third = aiTick(map, thug, { player, rng });
  assert.equal(third.fired, true);
});

test('the brute fires a spread of pellets', () => {
  const map = makeMap(40, 40);
  const brute = createEnemy({ id: 1, type: 'brute', x: 100, y: 100 });
  const spec = ENEMY_TYPES.brute;
  const player = { id: 0, x: 200, y: 100, alive: true };

  const result = aiTick(map, brute, { player, rng: createRng(5) });
  assert.equal(result.fired, true);
  assert.equal(result.bullets.length, spec.pellets);
  const angles = result.bullets.map((bullet) => bullet.angle);
  assert.ok(Math.max(...angles) - Math.min(...angles) <= 2 * spec.spreadRad + 1e-9);
});

test('an enemy loses the player after loseSightTicks without line of sight', () => {
  const map = makeMap(60, 60);
  const thug = createEnemy({ id: 1, type: 'thug', x: 100, y: 100 });
  const spec = ENEMY_TYPES.thug;
  const rng = createRng(4);

  const visible = { id: 0, x: 100 + spec.attackRange + 20, y: 100, alive: true };
  aiTick(map, thug, { player: visible, rng });
  assert.equal(thug.state, AI_STATES.CHASE);

  const hidden = { id: 0, x: 10000, y: 10000, alive: true };
  for (let i = 0; i < spec.loseSightTicks - 1; i += 1) {
    const result = aiTick(map, thug, { player: hidden, rng });
    assert.equal(result.lostTarget, false);
    assert.equal(thug.state, AI_STATES.CHASE, `still hunting at lostTicks=${thug.lostTicks}`);
  }

  const timeout = aiTick(map, thug, { player: hidden, rng });
  assert.equal(timeout.lostTarget, true, 'forgets exactly when the timeout elapses');
  assert.equal(thug.state, AI_STATES.PATROL);
  assert.equal(thug.lostTicks, spec.loseSightTicks);
});

test('an enemy that breaks line of sight while attacking drops to chase', () => {
  const map = makeMap(60, 60);
  const thug = createEnemy({ id: 1, type: 'thug', x: 100, y: 100 });
  const spec = ENEMY_TYPES.thug;
  const rng = createRng(6);

  const inRange = { id: 0, x: 100 + spec.attackRange - 20, y: 100, alive: true };
  aiTick(map, thug, { player: inRange, rng });
  assert.equal(thug.state, AI_STATES.ATTACK);

  const hidden = { id: 0, x: 10000, y: 10000, alive: true };
  const result = aiTick(map, thug, { player: hidden, rng });
  assert.equal(result.state, AI_STATES.CHASE);
  assert.equal(result.lostTarget, false);
});

test('steering slides along buildings and never enters a solid tile', () => {
  const walled = wallColumn(40, 40, 5);
  const wallLeft = 5 * TILE_SIZE;
  const enemy = createEnemy({ id: 1, type: 'thug', x: 100, y: 100 });

  for (let i = 0; i < 200; i += 1) {
    steerToward(walled, enemy, 400, 100);
  }

  assert.ok(enemy.x + enemy.radius <= wallLeft + 1e-6, `enemy stopped at the wall (x=${enemy.x})`);
  assert.equal(canStandAt(walled, enemy.x, enemy.y, enemy.radius), true);
});

test('choosePatrolTarget returns a walkable point and is deterministic', () => {
  const map = wallColumn(40, 40, 5);
  const enemy = createEnemy({ id: 1, type: 'thug', x: 100, y: 100 });

  const a = choosePatrolTarget(map, enemy, createRng(9));
  const b = choosePatrolTarget(map, enemy, createRng(9));
  assert.deepEqual(a, b);
  assert.equal(canStandAt(map, a.x, a.y, enemy.radius), true);
});

test('a patrolling enemy walks and selects multiple waypoints over time', () => {
  const map = makeMap(80, 80);
  const enemy = createEnemy({ id: 1, type: 'thug', x: 1280, y: 1280 });
  enemy.state = AI_STATES.PATROL;
  const player = { id: 0, x: -100000, y: -100000, alive: true };
  const rng = createRng(4321);
  const startX = enemy.x;
  const startY = enemy.y;
  const waypoints = new Set();

  for (let i = 0; i < 6000; i += 1) {
    aiTick(map, enemy, { player, rng });
    if (enemy.patrolTarget) {
      waypoints.add(`${enemy.patrolTarget.x},${enemy.patrolTarget.y}`);
    }
  }

  assert.ok(waypoints.size > 1, `expected several patrol waypoints, saw ${waypoints.size}`);
  assert.ok(
    enemy.x !== startX || enemy.y !== startY,
    'a patrolling enemy must actually move, not freeze on one waypoint',
  );
});

test('patrol abandons an unreachable waypoint instead of freezing', () => {
  const map = wallColumn(40, 40, 5);
  const enemy = createEnemy({ id: 1, type: 'thug', x: 100, y: 100 });
  enemy.state = AI_STATES.PATROL;
  enemy.patrolTarget = { x: 400, y: 100 };
  enemy.patrolTicks = 0;
  const player = { id: 0, x: -100000, y: -100000, alive: true };
  const rng = createRng(11);

  let abandoned = false;
  for (let i = 0; i < PATROL_TIMEOUT_TICKS + 10 && !abandoned; i += 1) {
    aiTick(map, enemy, { player, rng });
    abandoned = !enemy.patrolTarget || enemy.patrolTarget.x !== 400 || enemy.patrolTarget.y !== 100;
  }

  assert.equal(abandoned, true, 'the unreachable waypoint is eventually dropped');
  assert.ok(enemy.x + enemy.radius <= 5 * TILE_SIZE + 1e-6, 'the enemy stays out of the wall');
});

test('AI transitions are deterministic under a seeded rng', () => {
  const map = makeMap(60, 60);
  const player = { id: 0, x: 300, y: 300, alive: true };
  const run = () => {
    const enemy = createEnemy({ id: 1, type: 'shooter', x: 100, y: 100 });
    const rng = createRng(1234);
    const trace = [];
    for (let i = 0; i < 400; i += 1) {
      const result = aiTick(map, enemy, { player, rng });
      trace.push({
        state: result.state,
        x: enemy.x,
        y: enemy.y,
        aim: enemy.aim,
        cooldown: enemy.cooldown,
        lostTicks: enemy.lostTicks,
        patrolTarget: enemy.patrolTarget,
        fired: result.fired,
        bullets: result.bullets.map((bullet) => [bullet.x, bullet.y, bullet.vx, bullet.vy]),
      });
    }
    return trace;
  };

  assert.deepEqual(run(), run());
});

test('the game loop runs the enemy AI and enemy fire damages the player', () => {
  const map = makeMap(40, 40, [], { enemySpawns: [{ x: 420, y: 320 }] });
  const game = createGame({ map, spawn: { x: 320, y: 320 }, seed: 8 });

  let playerHit = false;
  for (let i = 0; i < 180 && !playerHit; i += 1) {
    update(game);
    playerHit = drainEvents(game).some((event) => event.type === 'hit' && event.targetId === 0);
  }

  assert.equal(playerHit, true, 'an enemy bullet should hit the player');
  assert.ok(game.player.health < 100, `player took damage (hp=${game.player.health})`);
});

test('the game loop is deterministic under a seeded rng', () => {
  const map = makeMap(60, 60, [], { enemySpawns: [{ x: 420, y: 300 }, { x: 200, y: 500 }] });
  const run = () => {
    const game = createGame({ map, spawn: { x: 300, y: 300 }, seed: 77 });
    const trace = [];
    for (let i = 0; i < 300; i += 1) {
      update(game);
      trace.push(game.enemies.map((enemy) => [enemy.x, enemy.y, enemy.aim, enemy.state, enemy.cooldown]));
      trace.push(game.bullets.map((bullet) => [bullet.x, bullet.y, bullet.alive]));
    }
    return trace;
  };

  assert.deepEqual(run(), run());
});

test('a game with no enemy spawns has an empty squad and never fires', () => {
  const map = makeMap(20, 20);
  const game = createGame({ map, seed: 1 });
  assert.deepEqual(game.enemies, []);
  for (let i = 0; i < 60; i += 1) update(game);
  assert.equal(game.enemies.length, 0);
  assert.equal(isEnemyAlive(game.player), true);
});
