import test from 'node:test';
import assert from 'node:assert/strict';

import {
  WANTED_THRESHOLDS,
  WANTED_CRIMES,
  BUSTED_LEVEL,
  WANTED_DECAY_COOLDOWN_TICKS,
  POLICE_SPAWN_INTERVAL_TICKS,
  POLICE_COMPOSITION,
  clampWantedPoints,
  wantedLevelFor,
  addWantedPoints,
  registerCrime,
  decayWantedPoints,
  policeRoster,
  policeTargetCount,
  policeSpawnStep,
  policeDespawnCount,
  policeSpawnPoint,
  isBusted,
  sirenActiveFor,
} from '../src/core/wanted.js';
import {
  TILE_SIZE,
  WANTED_MAX_HEAT,
  WANTED_HEAT_DECAY_PER_TICK,
} from '../src/core/constants.js';
import {
  createGame,
  update,
  addHeat,
  drainEvents,
  getWantedStars,
} from '../src/core/game.js';
import { createRng } from '../src/core/rng.js';
import { createMap, canStandAt } from '../src/core/map.js';
import { POLICE_TYPE_IDS, isPolice, createEnemy } from '../src/core/enemy.js';
import { spriteFor, snapshotScene, ENTITY_SPRITES } from '../src/ui/render.js';
import { sirenBlink, sirenActive, SIREN_BLINK_TICKS } from '../src/ui/hud.js';

function makeMap(width, height, solids = []) {
  const tiles = new Array(width * height).fill(0);
  for (const [x, y] of solids) tiles[y * width + x] = 1;
  return { width, height, tiles };
}

test('wanted levels follow the documented thresholds', () => {
  assert.deepEqual(WANTED_THRESHOLDS, [0, 10, 40, 90, 160, 260]);
  assert.equal(wantedLevelFor(0), 0);
  assert.equal(wantedLevelFor(9.99), 0);
  assert.equal(wantedLevelFor(10), 1);
  assert.equal(wantedLevelFor(39.99), 1);
  assert.equal(wantedLevelFor(40), 2);
  assert.equal(wantedLevelFor(90), 3);
  assert.equal(wantedLevelFor(160), 4);
  assert.equal(wantedLevelFor(260), 5);
  assert.equal(wantedLevelFor(1e9), 5);
  assert.equal(wantedLevelFor(-5), 0);
  assert.equal(wantedLevelFor(Number.NaN), 0);
});

test('clampWantedPoints bounds the point total', () => {
  assert.equal(clampWantedPoints(0), 0);
  assert.equal(clampWantedPoints(-3), 0);
  assert.equal(clampWantedPoints(50), 50);
  assert.equal(clampWantedPoints(WANTED_MAX_HEAT + 100), WANTED_MAX_HEAT);
  assert.equal(clampWantedPoints(Infinity), 0, 'non-finite values are ignored');
  assert.equal(clampWantedPoints(Number.NaN), 0);
});

test('each documented crime adds its points and raises the level', () => {
  for (const [crime, value] of Object.entries(WANTED_CRIMES)) {
    const points = registerCrime(0, crime);
    assert.equal(points, value, `${crime} should be worth ${value}`);
    assert.equal(wantedLevelFor(points), wantedLevelFor(value));
  }

  assert.equal(wantedLevelFor(registerCrime(0, 'murder')), 2, 'a murder reaches two stars');
  assert.equal(wantedLevelFor(registerCrime(0, 'gunfire')), 0, 'a single shot is not a star');
  assert.equal(registerCrime(5, 'not-a-crime'), 5, 'unknown crimes add nothing');
  assert.equal(addWantedPoints(5, -100), 5, 'negative amounts are ignored');
  assert.equal(addWantedPoints(5, Number.NaN), 5, 'non-finite amounts are ignored');
  assert.equal(addWantedPoints(WANTED_MAX_HEAT, 100), WANTED_MAX_HEAT);
});

test('points hold for the crime-free cooldown then decay', () => {
  const held = decayWantedPoints(100, WANTED_DECAY_COOLDOWN_TICKS);
  assert.equal(held.points, 100, 'points are held during the cooldown');
  assert.equal(held.cooldownTicks, WANTED_DECAY_COOLDOWN_TICKS - 1);
  assert.equal(held.decayed, false);

  const decayed = decayWantedPoints(100, 0);
  assert.equal(decayed.points, 100 - WANTED_HEAT_DECAY_PER_TICK);
  assert.equal(decayed.cooldownTicks, 0);
  assert.equal(decayed.decayed, true);

  assert.deepEqual(decayWantedPoints(0, 0), { points: 0, cooldownTicks: 0, decayed: false });
  assert.equal(decayWantedPoints(0.2, 0).points, 0, 'points never go negative');
});

test('police rosters grow and toughen with the wanted level', () => {
  assert.equal(policeTargetCount(0), 0);

  let previous = 0;
  for (let level = 1; level <= 5; level += 1) {
    const roster = policeRoster(level);
    assert.ok(roster.length > previous, `level ${level} fields more police than ${level - 1}`);
    previous = roster.length;
    assert.equal(roster[0], 'cop', 'cops arrive first');
    for (const variant of roster) {
      assert.ok(POLICE_TYPE_IDS.includes(variant), `${variant} is a police archetype`);
    }
  }

  assert.ok(policeRoster(5).includes('riot'));
  assert.ok(!policeRoster(1).includes('riot'));
  assert.ok(policeRoster(5).includes('swat'));
  assert.ok(!policeRoster(2).includes('swat'));

  assert.deepEqual(policeRoster(-3), []);
  assert.deepEqual(policeRoster(99), policeRoster(5));
});

test('police spawn one at a time up to the level roster', () => {
  const spawned = [];
  let timer = 0;
  let alive = 0;
  for (let tick = 0; tick < POLICE_SPAWN_INTERVAL_TICKS * 5 + 10; tick += 1) {
    const step = policeSpawnStep({ level: 5, alivePolice: alive, spawnTimer: timer });
    timer = step.spawnTimer;
    if (step.variant) {
      spawned.push(step.variant);
      alive += 1;
    }
  }

  assert.deepEqual(spawned, [...POLICE_COMPOSITION[5]]);
  assert.equal(spawned.length, policeTargetCount(5));
});

test('police spawning respects the interval, the cap and level 0', () => {
  const first = policeSpawnStep({ level: 1, alivePolice: 0, spawnTimer: 0 });
  assert.equal(first.variant, 'cop');
  assert.equal(first.spawnTimer, POLICE_SPAWN_INTERVAL_TICKS);

  const waiting = policeSpawnStep({ level: 1, alivePolice: 0, spawnTimer: 5 });
  assert.equal(waiting.variant, null);
  assert.equal(waiting.spawnTimer, 4);

  const capped = policeSpawnStep({ level: 1, alivePolice: 1, spawnTimer: 0 });
  assert.equal(capped.variant, null);
  assert.equal(capped.spawnTimer, 0);

  assert.equal(policeSpawnStep({ level: 0, alivePolice: 0, spawnTimer: 0 }).variant, null);
});

test('policeDespawnCount trims the force and clears it at level 0', () => {
  assert.equal(policeDespawnCount(0, 0), 0);
  assert.equal(policeDespawnCount(0, 4), 4);
  assert.equal(policeDespawnCount(2, 1), 0);
  assert.equal(policeDespawnCount(1, 3), 2);
  assert.equal(policeDespawnCount(5, 2), 0);
});

test('policeSpawnPoint returns a walkable ring position or null', () => {
  const open = makeMap(200, 200);
  const point = policeSpawnPoint(open, 3200, 3200, { rng: createRng(1) });
  assert.ok(point, 'an open map always yields a spawn point');
  assert.equal(canStandAt(open, point.x, point.y, 11), true);
  const distance = Math.hypot(point.x - 3200, point.y - 3200);
  assert.ok(distance >= TILE_SIZE * 8 - 1e-6 && distance <= TILE_SIZE * 14 + 1e-6, `distance ${distance}`);

  const city = createMap({ width: 100, height: 100, seed: 3 });
  const cityPoint = policeSpawnPoint(city, city.spawns.playerStart.x, city.spawns.playerStart.y, {
    rng: createRng(2),
  });
  if (cityPoint) assert.equal(canStandAt(city, cityPoint.x, cityPoint.y, 11), true);

  assert.equal(policeSpawnPoint(makeMap(4, 4), 64, 64, { rng: createRng(1) }), null);
});

test('the busted and siren thresholds are wired to the star ladder', () => {
  assert.equal(BUSTED_LEVEL, 5);
  assert.equal(isBusted(4), false);
  assert.equal(isBusted(5), true);
  assert.equal(isBusted(6), true);
  assert.equal(sirenActiveFor(0), false);
  assert.equal(sirenActiveFor(1), true);
  assert.equal(sirenActiveFor(5), true);
});

test('a wanted level spawns police that are distinct from the map squad', () => {
  const game = createGame({ map: makeMap(80, 80), seed: 5 });
  assert.deepEqual(game.enemies, []);

  addHeat(game, WANTED_THRESHOLDS[1]);
  update(game);

  const spawns = drainEvents(game).filter((event) => event.type === 'police_spawn');
  assert.equal(spawns.length, 1);
  assert.equal(spawns[0].enemyType, 'cop');
  assert.equal(game.enemies.length, 1);
  assert.equal(isPolice(game.enemies[0]), true);
  assert.equal(game.enemies[0].police, true);
});

test('higher wanted levels summon tougher police', () => {
  const game = createGame({ map: makeMap(120, 120), seed: 9 });
  addHeat(game, WANTED_THRESHOLDS[4]);
  game.player.health = 1e9; // survive the squad so the spawner keeps running
  assert.equal(game.wanted, 4);

  for (let i = 0; i < POLICE_SPAWN_INTERVAL_TICKS * 4 + 10; i += 1) update(game);

  const police = game.enemies.filter(isPolice);
  assert.ok(police.length >= 3, `expected a squad, got ${police.length}`);
  const types = police.map((enemy) => enemy.type);
  assert.ok(types.includes('cop'));
  assert.ok(types.includes('swat'));
  assert.ok(labelsAreEscalating(types), `expected escalating types, got ${types}`);
});

test('reaching five stars starts the chase but only police contact busts you', () => {
  const game = createGame({ map: makeMap(80, 80), seed: 5 });
  addHeat(game, WANTED_MAX_HEAT);
  assert.equal(game.wanted, 5);

  // Five stars on its own is not terminal: no officer is within capture range.
  update(game);
  assert.equal(game.busted, false);
  assert.equal(game.gameOver, false);
  assert.ok(drainEvents(game).some((event) => event.type === 'siren' && event.active === true));

  // An officer getting close is what ends the run.
  game.enemies.push(createEnemy({ id: 99, type: 'cop', x: game.player.x + 4, y: game.player.y }));
  update(game);

  const events = drainEvents(game);
  const busted = events.find((event) => event.type === 'busted');
  assert.ok(busted, 'expected a busted event');
  assert.equal(busted.level, 5);
  assert.equal(busted.officerId, 99);
  assert.equal(game.busted, true);
  assert.equal(game.gameOver, true);
  assert.equal(game.outcome, 'busted');
});

test('siren events track the level and level 0 despawns the police', () => {
  const game = createGame({ map: makeMap(80, 80), seed: 5 });
  addHeat(game, WANTED_THRESHOLDS[1]);
  update(game);
  assert.equal(game.sirenActive, true);
  assert.ok(drainEvents(game).some((event) => event.type === 'siren' && event.active === true));
  assert.equal(game.enemies.filter(isPolice).length, 1);

  game.heat = 0;
  game.wanted = 0;
  update(game);

  assert.equal(game.enemies.filter(isPolice).length, 0);
  const events = drainEvents(game);
  assert.ok(events.some((event) => event.type === 'police_despawn'));
  assert.ok(events.some((event) => event.type === 'siren' && event.active === false));
  assert.equal(game.sirenActive, false);
});

test('wanted points decay after the crime-free cooldown in the game loop', () => {
  const game = createGame({ map: makeMap(4, 4), seed: 5 });
  addHeat(game, WANTED_THRESHOLDS[2]);
  assert.equal(game.wanted, 2);

  for (let i = 0; i < WANTED_DECAY_COOLDOWN_TICKS; i += 1) update(game);
  assert.equal(game.heat, WANTED_THRESHOLDS[2], 'points are held during the cooldown');

  update(game);
  assert.ok(game.heat < WANTED_THRESHOLDS[2], 'points decay once the cooldown elapses');
  assert.equal(game.wanted, getWantedStars(game.heat));
});

test('police are rendered with a dedicated sprite', () => {
  assert.equal(spriteFor({ kind: 'enemy', police: true }), ENTITY_SPRITES.police);
  assert.notEqual(ENTITY_SPRITES.police, ENTITY_SPRITES.enemy);

  const scene = snapshotScene({
    player: null,
    camera: null,
    enemies: [{ id: 1, kind: 'enemy', police: true, x: 10, y: 20, radius: 11, alive: true }],
  });
  assert.equal(scene.entities.length, 1);
  assert.equal(scene.entities[0].police, true);
});

test('the HUD siren blinks from the simulation tick', () => {
  assert.equal(sirenBlink(0), true);
  assert.equal(sirenBlink(SIREN_BLINK_TICKS - 1), true);
  assert.equal(sirenBlink(SIREN_BLINK_TICKS), false);
  assert.equal(sirenBlink(SIREN_BLINK_TICKS * 2), true);

  assert.equal(sirenActive({ wanted: 0 }), false);
  assert.equal(sirenActive({ wanted: 1 }), true);
  assert.equal(sirenActive({ wanted: 5, sirenActive: false }), false, 'the explicit flag wins');
  assert.equal(sirenActive({ wanted: 0, sirenActive: true }), true);
});

/**
 * Are the police types present in non-decreasing toughness order? Ranks come
 * from POLICE_TYPE_IDS (`cop` < `swat` < `riot`).
 *
 * @param {string[]} types
 * @returns {boolean}
 */
function labelsAreEscalating(types) {
  let rank = -1;
  for (const type of types) {
    const next = POLICE_TYPE_IDS.indexOf(type);
    if (next < rank) return false;
    rank = next;
  }
  return true;
}
