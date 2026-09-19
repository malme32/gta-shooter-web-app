import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  createPlayer,
  isAlive,
  speedFor,
  moveIntent,
  movePlayer,
  aimAt,
  setAim,
  applyDamage,
  healPlayer,
  addArmour,
} from '../src/core/player.js';
import {
  createGame,
  update,
  restart,
  updateCamera,
  snapCamera,
  cameraTarget,
  screenToWorld,
} from '../src/core/game.js';
import { createMap, mapPixelWidth, mapPixelHeight } from '../src/core/map.js';
import {
  TICK_SECONDS,
  TILE_SIZE,
  PLAYER_RADIUS,
  PLAYER_BASE_SPEED,
  PLAYER_SPRINT_MULTIPLIER,
  PLAYER_MAX_HEALTH,
  PLAYER_MAX_ARMOUR,
} from '../src/core/constants.js';

function makeMap(width, height, solids = []) {
  const tiles = new Array(width * height).fill(0);
  for (const [x, y] of solids) tiles[y * width + x] = 1;
  return { width, height, tiles };
}

function bordered(width, height) {
  const solids = [];
  for (let x = 0; x < width; x += 1) {
    solids.push([x, 0], [x, height - 1]);
  }
  for (let y = 0; y < height; y += 1) {
    solids.push([0, y], [width - 1, y]);
  }
  return makeMap(width, height, solids);
}

const NONE = { up: false, down: false, left: false, right: false, sprint: false };

test('createPlayer initialises health, armour and liveness', () => {
  const player = createPlayer({ x: 10, y: 20 });
  assert.equal(player.x, 10);
  assert.equal(player.y, 20);
  assert.equal(player.radius, PLAYER_RADIUS);
  assert.equal(player.speed, PLAYER_BASE_SPEED);
  assert.equal(player.health, PLAYER_MAX_HEALTH);
  assert.equal(player.armour, 0);
  assert.equal(player.alive, true);
  assert.equal(player.aim, 0);
});

test('createPlayer clamps starting health and armour to their ceilings', () => {
  const player = createPlayer({ health: 500, armour: 500 });
  assert.equal(player.health, PLAYER_MAX_HEALTH);
  assert.equal(player.armour, PLAYER_MAX_ARMOUR);
});

test('isAlive tracks health as well as the alive flag', () => {
  const player = createPlayer();
  assert.equal(isAlive(player), true);
  player.health = 0;
  assert.equal(isAlive(player), false);
});

test('speedFor applies the sprint multiplier', () => {
  const player = createPlayer();
  assert.equal(speedFor(player, false), PLAYER_BASE_SPEED);
  assert.equal(speedFor(player, true), PLAYER_BASE_SPEED * PLAYER_SPRINT_MULTIPLIER);
});

test('moveIntent maps the eight directions to unit vectors', () => {
  assert.deepEqual(moveIntent(NONE), { x: 0, y: 0 });
  assert.deepEqual(moveIntent({ right: true }), { x: 1, y: 0 });
  assert.deepEqual(moveIntent({ left: true }), { x: -1, y: 0 });
  assert.deepEqual(moveIntent({ up: true }), { x: 0, y: -1 });
  assert.deepEqual(moveIntent({ down: true }), { x: 0, y: 1 });

  const diagonal = moveIntent({ right: true, down: true });
  assert.ok(Math.abs(Math.hypot(diagonal.x, diagonal.y) - 1) < 1e-12);
  assert.ok(Math.abs(diagonal.x - Math.SQRT1_2) < 1e-12);

  const opposite = moveIntent({ left: true, right: true });
  assert.deepEqual(opposite, { x: 0, y: 0 });
});

test('movePlayer translates at base speed for one tick', () => {
  const map = makeMap(20, 20);
  const player = createPlayer({ x: 100, y: 100 });
  const result = movePlayer(map, player, { right: true });
  assert.equal(result.moved, true);
  assert.ok(Math.abs(player.x - (100 + PLAYER_BASE_SPEED * TICK_SECONDS)) < 1e-12);
  assert.equal(player.y, 100);
});

test('diagonal movement is normalised to the same distance as cardinal', () => {
  const map = makeMap(20, 20);
  const cardinal = createPlayer({ x: 200, y: 200 });
  const diagonal = createPlayer({ x: 200, y: 200 });

  for (let i = 0; i < 30; i += 1) {
    movePlayer(map, cardinal, { right: true });
    movePlayer(map, diagonal, { right: true, down: true });
  }

  const cardinalDistance = Math.hypot(cardinal.x - 200, cardinal.y - 200);
  const diagonalDistance = Math.hypot(diagonal.x - 200, diagonal.y - 200);
  assert.ok(Math.abs(cardinalDistance - diagonalDistance) < 1e-9);
});

test('sprinting moves further than walking in the same time', () => {
  const map = makeMap(20, 20);
  const walk = createPlayer({ x: 100, y: 100 });
  const run = createPlayer({ x: 100, y: 100 });
  for (let i = 0; i < 10; i += 1) {
    movePlayer(map, walk, { right: true });
    movePlayer(map, run, { right: true, sprint: true });
  }
  assert.ok(run.x > walk.x);
});

test('a player cannot pass through a building', () => {
  const map = bordered(8, 8);
  const player = createPlayer({ x: 4 * TILE_SIZE, y: 4 * TILE_SIZE });
  for (let i = 0; i < 500; i += 1) {
    movePlayer(map, player, { left: true });
  }
  assert.ok(player.x >= TILE_SIZE + PLAYER_RADIUS - 1e-9, `x=${player.x}`);
  assert.equal(player.y, 4 * TILE_SIZE);
});

test('a player slides along a wall instead of stopping dead', () => {
  const map = bordered(8, 8);
  const player = createPlayer({ x: TILE_SIZE + PLAYER_RADIUS, y: 4 * TILE_SIZE });
  const startY = player.y;
  for (let i = 0; i < 30; i += 1) {
    movePlayer(map, player, { left: true, down: true });
  }
  assert.equal(player.x, TILE_SIZE + PLAYER_RADIUS);
  assert.ok(player.y > startY, 'player should slide down the wall');
});

test('a dead player does not move', () => {
  const map = makeMap(20, 20);
  const player = createPlayer({ x: 100, y: 100 });
  applyDamage(player, 1000);
  const result = movePlayer(map, player, { right: true });
  assert.equal(result.moved, false);
  assert.equal(player.x, 100);
});

test('aimAt points the player at a world target', () => {
  const player = createPlayer({ x: 100, y: 100 });
  assert.ok(Math.abs(aimAt(player, 200, 100) - 0) < 1e-12);
  assert.ok(Math.abs(aimAt(player, 100, 200) - Math.PI / 2) < 1e-12);
  assert.ok(Math.abs(Math.abs(aimAt(player, 0, 100)) - Math.PI) < 1e-12);
  assert.ok(Math.abs(aimAt(player, 100, 0) + Math.PI / 2) < 1e-12);
});

test('setAim stores the angle and ignores non-finite input', () => {
  const player = createPlayer();
  setAim(player, 1.25);
  assert.equal(player.aim, 1.25);
  setAim(player, Number.NaN);
  assert.equal(player.aim, 0);
});

test('damage drains armour before health', () => {
  const player = createPlayer();
  addArmour(player, 30);
  const result = applyDamage(player, 50);
  assert.equal(result.absorbed, 30);
  assert.equal(player.armour, 0);
  assert.equal(player.health, PLAYER_MAX_HEALTH - 20);
  assert.equal(result.killed, false);
  assert.equal(player.alive, true);
});

test('damage with no armour goes straight to health', () => {
  const player = createPlayer();
  applyDamage(player, 40);
  assert.equal(player.health, 60);
  assert.equal(player.armour, 0);
});

test('health floored at zero marks the player dead', () => {
  const player = createPlayer();
  const result = applyDamage(player, 1e6);
  assert.equal(player.health, 0);
  assert.equal(result.killed, true);
  assert.equal(player.alive, false);
  assert.equal(isAlive(player), false);
});

test('damage to a dead player is ignored', () => {
  const player = createPlayer();
  player.health = 0;
  player.alive = false;
  const result = applyDamage(player, 50);
  assert.equal(result.ignored, true);
  assert.equal(player.health, 0);
});

test('healPlayer restores health up to the ceiling and cannot revive', () => {
  const player = createPlayer();
  applyDamage(player, 40);
  healPlayer(player, 1000);
  assert.equal(player.health, PLAYER_MAX_HEALTH);

  applyDamage(player, 1000);
  healPlayer(player, 50);
  assert.equal(player.health, 0);
  assert.equal(player.alive, false);
});

test('addArmour clamps to the armour ceiling', () => {
  const player = createPlayer();
  addArmour(player, 1e6);
  assert.equal(player.armour, PLAYER_MAX_ARMOUR);
});

test('core/player.js contains no DOM references in code', () => {
  const source = readFileSync(new URL('../src/core/player.js', import.meta.url), 'utf8');
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(code, /\b(document|window|navigator|localStorage)\b/);
});

test('the camera starts centred on the player and inside the map', () => {
  const map = createMap({ width: 100, height: 100, seed: 1 });
  const state = createGame({ map, viewport: { width: 800, height: 600 } });
  assert.equal(state.camera.width, 800);
  assert.equal(state.camera.height, 600);
  assert.equal(state.camera.x, state.player.x - 400);
  assert.equal(state.camera.y, state.player.y - 300);
  assert.ok(state.camera.x >= 0 && state.camera.x + 800 <= mapPixelWidth(map));
  assert.ok(state.camera.y >= 0 && state.camera.y + 600 <= mapPixelHeight(map));
});

test('cameraTarget keeps the focus inside the dead-zone', () => {
  const camera = { x: 0, y: 0, width: 800, height: 600 };
  const deadZone = { x: 72, y: 48 };
  const centre = { x: 400, y: 300 };

  assert.deepEqual(cameraTarget(camera, deadZone, centre), { x: 0, y: 0 });
  assert.deepEqual(cameraTarget(camera, deadZone, { x: 400 + 60, y: 300 }), { x: 0, y: 0 });
  assert.deepEqual(cameraTarget(camera, deadZone, { x: 400 + 100, y: 300 }), { x: 28, y: 0 });
  assert.deepEqual(cameraTarget(camera, deadZone, { x: 400, y: 300 - 60 }), { x: 0, y: -12 });
});

test('updateCamera interpolates towards its target and stays clamped', () => {
  const map = createMap({ width: 100, height: 100, seed: 1 });
  const state = createGame({ map, viewport: { width: 800, height: 600 }, deadZone: { x: 0, y: 0 } });
  state.camera = { x: 0, y: 0, width: 800, height: 600 };
  state.player.x = 1000;
  state.player.y = 300;

  updateCamera(state);
  assert.ok(state.camera.x > 0 && state.camera.x < 600, `x=${state.camera.x}`);
  assert.equal(state.camera.y, 0);
  assert.ok(state.camera.x + 800 <= mapPixelWidth(map));
});

test('snapCamera jumps straight to the clamped target', () => {
  const map = createMap({ width: 100, height: 100, seed: 1 });
  const state = createGame({ map, viewport: { width: 800, height: 600 }, deadZone: { x: 0, y: 0 } });
  state.camera = { x: 0, y: 0, width: 800, height: 600 };
  state.player.x = 1e6;
  state.player.y = 1e6;

  snapCamera(state);
  assert.equal(state.camera.x, mapPixelWidth(map) - 800);
  assert.equal(state.camera.y, mapPixelHeight(map) - 600);
});

test('small player moves inside the dead-zone leave the camera still', () => {
  const map = createMap({ width: 100, height: 100, seed: 1 });
  const state = createGame({ map, viewport: { width: 800, height: 600 } });
  const startX = state.camera.x;
  state.input.right = true;
  for (let i = 0; i < 5; i += 1) update(state);
  assert.equal(state.camera.x, startX);
});

test('the camera follows the player once they leave the dead-zone', () => {
  const map = createMap({ width: 100, height: 100, seed: 1 });
  const state = createGame({ map, viewport: { width: 800, height: 600 } });
  const startX = state.camera.x;
  state.input.right = true;
  for (let i = 0; i < 200; i += 1) update(state);

  assert.ok(state.camera.x > startX, 'camera should trail the player');
  assert.ok(state.camera.x <= mapPixelWidth(map) - 800);
  assert.ok(state.camera.x + 800 >= state.player.x);
});

test('screenToWorld offsets a canvas point by the camera', () => {
  const camera = { x: 100, y: 50, width: 800, height: 600 };
  assert.deepEqual(screenToWorld(camera, 10, 20), { x: 110, y: 70 });
});

test('the mouse pointer sets the player aim angle', () => {
  const map = createMap({ width: 100, height: 100, seed: 1 });
  const state = createGame({ map, viewport: { width: 800, height: 600 } });
  state.input.pointerX = 800;
  state.input.pointerY = 300;

  const world = screenToWorld(state.camera, state.input.pointerX, state.input.pointerY);
  const expected = Math.atan2(world.y - state.player.y, world.x - state.player.x);

  update(state);
  assert.ok(Math.abs(state.player.aim - expected) < 1e-12);
});

test('restart keeps the input reference so the bound input keeps working', () => {
  const state = createGame({ map: makeMap(8, 8) });
  const cached = state.input;

  cached.left = true;
  state.gameOver = true;
  restart(state);

  assert.equal(state.input, cached, 'input object must survive restart');
  assert.equal(cached.left, false, 'restart should reset the intent in place');

  cached.left = true;
  const startX = state.player.x;
  for (let i = 0; i < 10; i += 1) update(state);
  assert.ok(state.player.x < startX, 'cached input must still drive movement');
});
