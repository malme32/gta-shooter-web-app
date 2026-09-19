import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createGame,
  update,
  advance,
  restart,
  drainEvents,
  emitEvent,
  addHeat,
  getWantedStars,
} from '../src/core/game.js';
import { createRng } from '../src/core/rng.js';
import {
  TICK_SECONDS,
  MAX_STEPS_PER_FRAME,
  TILE_SIZE,
  PLAYER_RADIUS,
  WANTED_MAX_HEAT,
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

test('createGame requires a map', () => {
  assert.throws(() => createGame(), /requires a map/);
  assert.throws(() => createGame({}), /requires a map/);
  assert.throws(() => createGame({ map: null }), /requires a map/);
});

test('createGame validates map dimensions and tile count', () => {
  assert.throws(() => createGame({ map: { width: 0, height: 2, tiles: [] } }), /width/);
  assert.throws(() => createGame({ map: { width: 2, height: -1, tiles: [] } }), /height/);
  assert.throws(
    () => createGame({ map: { width: 2, height: 2, tiles: [0, 0, 0] } }),
    /exactly 4 entries/,
  );
  assert.throws(
    () => createGame({ map: { width: 2, height: 2, tiles: [[0, 0]] } }),
    /height rows/,
  );
  assert.throws(
    () => createGame({ map: { width: 2, height: 2, tiles: [[0, 0, 0], [0, 0, 0]] } }),
    /row/,
  );
});

test('createGame accepts flat and row-major maps', () => {
  const flat = createGame({ map: makeMap(3, 2) });
  assert.deepEqual(flat.grid.tiles, [0, 0, 0, 0, 0, 0]);

  const rows = createGame({ map: { width: 2, height: 2, tiles: [[0, 1], [1, 0]] } });
  assert.deepEqual(rows.grid.tiles, [0, 1, 1, 0]);
  assert.equal(rows.grid.width, 2);
  assert.equal(rows.grid.height, 2);
});

test('createGame initialises a deterministic zero state', () => {
  const state = createGame({ map: makeMap(6, 4), seed: 1 });
  assert.equal(state.tick, 0);
  assert.equal(state.accumulator, 0);
  assert.equal(state.heat, 0);
  assert.equal(state.wanted, 0);
  assert.equal(state.gameOver, false);
  assert.equal(state.paused, false);
  assert.deepEqual(state.bullets, []);
  assert.deepEqual(state.events, []);
  assert.equal(state.player.x, (Math.floor(6 / 2) + 0.5) * TILE_SIZE);
  assert.equal(state.player.y, (Math.floor(4 / 2) + 0.5) * TILE_SIZE);
  assert.equal(state.player.radius, PLAYER_RADIUS);
});

test('createGame accepts a spawn override', () => {
  const state = createGame({ map: makeMap(6, 4), spawn: { x: 10, y: 20 } });
  assert.equal(state.player.x, 10);
  assert.equal(state.player.y, 20);
});

test('update advances tick by exactly one per call, independent of render rate', () => {
  const state = createGame({ map: makeMap(6, 4) });
  for (let i = 0; i < 600; i += 1) {
    const before = state.tick;
    update(state);
    assert.equal(state.tick, before + 1);
  }
  assert.equal(state.tick, 600);
});

test('update still ticks while paused or game over', () => {
  const state = createGame({ map: makeMap(6, 4) });
  state.paused = true;
  update(state);
  assert.equal(state.tick, 1);
  state.paused = false;
  state.gameOver = true;
  update(state);
  assert.equal(state.tick, 2);
});

test('advance runs whole ticks from a wall-clock delta', () => {
  const state = createGame({ map: makeMap(6, 4) });
  assert.equal(advance(state, 0), 0);
  assert.equal(state.tick, 0);

  assert.equal(advance(state, TICK_SECONDS / 2), 0);
  assert.equal(state.tick, 0);

  assert.equal(advance(state, TICK_SECONDS / 2), 1);
  assert.equal(state.tick, 1);

  assert.equal(advance(state, TICK_SECONDS), 1);
  assert.equal(state.tick, 2);

  assert.equal(advance(state, TICK_SECONDS * 3.5), 3);
  assert.equal(state.tick, 5);
});

test('advance ignores negative and non-finite deltas', () => {
  const state = createGame({ map: makeMap(6, 4) });
  assert.equal(advance(state, -1), 0);
  assert.equal(advance(state, Number.NaN), 0);
  assert.equal(advance(state, Infinity), 0);
  assert.equal(advance(state, 1e9), MAX_STEPS_PER_FRAME);
});

test('advance clamps steps per frame and drops the backlog (no spiral of death)', () => {
  const state = createGame({ map: makeMap(6, 4) });

  const steps = advance(state, 5);
  assert.equal(steps, MAX_STEPS_PER_FRAME);
  assert.equal(state.tick, MAX_STEPS_PER_FRAME);
  assert.equal(state.accumulator, 0);

  assert.equal(advance(state, TICK_SECONDS), 1);
  assert.equal(state.tick, MAX_STEPS_PER_FRAME + 1);
});

test('repeated huge deltas never exceed the per-frame step budget', () => {
  const state = createGame({ map: makeMap(6, 4) });
  for (let i = 0; i < 10; i += 1) {
    assert.equal(advance(state, 10), MAX_STEPS_PER_FRAME);
  }
  assert.equal(state.tick, 10 * MAX_STEPS_PER_FRAME);
  assert.equal(state.accumulator, 0);
});

test('drainEvents returns queued events and clears the queue', () => {
  const state = createGame({ map: makeMap(6, 4) });
  assert.deepEqual(drainEvents(state), []);

  emitEvent(state, 'shot_fired', { weapon: 'pistol' });
  update(state);
  emitEvent(state, 'crime_witnessed', { heat: 10 });

  const events = drainEvents(state);
  assert.equal(events.length, 2);
  assert.equal(events[0].type, 'shot_fired');
  assert.equal(events[0].tick, 0);
  assert.equal(events[1].type, 'crime_witnessed');
  assert.equal(events[1].heat, 10);
  assert.deepEqual(drainEvents(state), []);
});

test('restart resets the run but keeps the map and spawn', () => {
  const map = makeMap(6, 4);
  const state = createGame({ map, seed: 5 });
  state.input.left = true;
  update(state);
  addHeat(state, 100);
  emitEvent(state, 'noise');
  state.gameOver = true;

  const spawn = { x: state.spawn.x, y: state.spawn.y };
  restart(state);

  assert.equal(state.tick, 0);
  assert.equal(state.accumulator, 0);
  assert.equal(state.heat, 0);
  assert.equal(state.wanted, 0);
  assert.equal(state.gameOver, false);
  assert.equal(state.paused, false);
  assert.deepEqual(state.events, []);
  assert.deepEqual(state.bullets, []);
  assert.equal(state.map, map);
  assert.deepEqual({ x: state.player.x, y: state.player.y }, spawn);
  assert.equal(state.input.left, false);
});

test('createGame accepts a seeded rng and replays it deterministically', () => {
  const map = makeMap(4, 4);
  const a = createGame({ map, seed: 123 });
  const b = createGame({ map, seed: 123 });
  for (let i = 0; i < 10; i += 1) {
    assert.equal(a.rng(), b.rng());
  }

  const c = createGame({ map, seed: 124 });
  const d = createGame({ map, seed: 123 });
  let differed = false;
  for (let i = 0; i < 10; i += 1) {
    if (c.rng() !== d.rng()) differed = true;
  }
  assert.ok(differed, 'different seeds should diverge');
});

test('createGame accepts an rng function and restart rewinds a seeded rng', () => {
  const map = makeMap(4, 4);
  const rng = createRng(7);
  const state = createGame({ map, rng });
  assert.equal(state.rng, rng);

  const seeded = createGame({ map, seed: 99 });
  const first = seeded.rng();
  restart(seeded);
  assert.equal(seeded.rng(), first);
});

test('getWantedStars maps heat to the configured thresholds', () => {
  assert.equal(getWantedStars(0), 0);
  assert.equal(getWantedStars(9.9), 0);
  assert.equal(getWantedStars(10), 1);
  assert.equal(getWantedStars(39.9), 1);
  assert.equal(getWantedStars(40), 2);
  assert.equal(getWantedStars(260), 5);
  assert.equal(getWantedStars(1e9), 5);
});

test('addHeat clamps to the maximum and refreshes the wanted level', () => {
  const state = createGame({ map: makeMap(4, 4) });
  addHeat(state, 15);
  assert.equal(state.heat, 15);
  assert.equal(state.wanted, 1);

  addHeat(state, 1e6);
  assert.equal(state.heat, WANTED_MAX_HEAT);
  assert.equal(state.wanted, 5);
});

test('heat decays a little every tick', () => {
  const state = createGame({ map: makeMap(4, 4) });
  addHeat(state, 100);
  update(state);
  assert.ok(state.heat < 100);
  assert.equal(state.wanted, getWantedStars(state.heat));
});

test('the player moves with input and slides along walls', () => {
  const state = createGame({ map: bordered(5, 5) });
  const startX = state.player.x;
  const startY = state.player.y;

  for (let i = 0; i < 10; i += 1) update(state);
  assert.equal(state.player.x, startX);
  assert.equal(state.player.y, startY);

  state.input.left = true;
  for (let i = 0; i < 200; i += 1) update(state);

  assert.ok(state.player.x < startX, 'player should have moved left');
  assert.ok(
    state.player.x >= TILE_SIZE + PLAYER_RADIUS - 1e-9,
    `player should stop at the wall (x=${state.player.x})`,
  );
  assert.equal(state.player.y, startY);
});

test('missing or malformed state is rejected', () => {
  assert.throws(() => update(), /requires a game state/);
  assert.throws(() => advance(), /requires a game state/);
  assert.throws(() => restart(), /requires a game state/);
  assert.throws(() => drainEvents(), /requires a game state/);
});
