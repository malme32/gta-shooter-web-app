import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createGame,
  update,
  restart,
  drainEvents,
  addHeat,
  computeScore,
  GAME_OUTCOMES,
  SCORE_PER_KILL,
} from '../src/core/game.js';
import { createEnemy, killEnemy } from '../src/core/enemy.js';
import {
  createMemoryStorage,
  readBest,
  writeBest,
  recordBest,
  normaliseRecord,
  BEST_RECORD_KEY,
} from '../src/ui/storage.js';

function makeMap(width, height, spawns = {}) {
  return {
    width,
    height,
    tiles: new Array(width * height).fill(0),
    spawns: {
      vehicleSpawns: [],
      enemySpawns: [],
      pickupSpawns: [],
      missionSpawns: [],
      ...spawns,
    },
  };
}

test('the campaign activates its first mission and announces it', () => {
  const game = createGame({
    map: makeMap(80, 80),
    missions: [{ id: 'm1', objective: 'eliminate', targetCount: 1, reward: 100 }],
  });

  assert.ok(game.mission, 'a mission is active from the first tick');
  assert.equal(game.mission.id, 'm1');
  assert.equal(game.outcome, null);
  assert.equal(game.gameOver, false);

  const start = drainEvents(game).find((event) => event.type === 'mission_start');
  assert.ok(start, 'expected a mission_start event');
  assert.equal(start.missionId, 'm1');
  assert.equal(start.reward, 100);
});

test('a map without missions leaves the run mission-free', () => {
  const game = createGame({ map: makeMap(40, 40) });
  assert.deepEqual(game.missions, []);
  assert.equal(game.mission, null);
});

test('an eliminate mission tracks its objective and pays the cash reward', () => {
  const game = createGame({
    map: makeMap(80, 80),
    spawn: { x: 400, y: 400 },
    seed: 1,
    missions: [{ id: 'm1', objective: 'eliminate', targetCount: 2, reward: 300 }],
  });

  game.enemies.push(createEnemy({ id: 1, type: 'thug', x: 410, y: 400 }));
  game.enemies.push(createEnemy({ id: 2, type: 'thug', x: 420, y: 400 }));
  drainEvents(game);

  killEnemy(game.enemies[0]);
  update(game);
  assert.equal(game.mission.remaining, 1, 'progress is tracked kill by kill');
  assert.equal(game.cash, 0);

  killEnemy(game.enemies[0]);
  update(game);

  assert.equal(game.mission.remaining, 0);
  assert.equal(game.cash, 300, 'the reward is banked');
  assert.equal(game.outcome, GAME_OUTCOMES.WON, 'the final mission wins the run');
  assert.equal(game.gameOver, true);

  const complete = drainEvents(game).find((event) => event.type === 'mission_complete');
  assert.ok(complete, 'expected a mission_complete event');
  assert.equal(complete.reward, 300);
  assert.equal(complete.cash, 300);
});

test('a reach mission completes when the player reaches the marker', () => {
  const game = createGame({
    map: makeMap(80, 80),
    spawn: { x: 100, y: 100 },
    seed: 1,
    missions: [{ id: 'r1', objective: 'reach', x: 400, y: 400, radius: 40, reward: 150 }],
  });

  update(game);
  assert.equal(game.outcome, null, 'still running while away from the marker');

  game.player.x = 400;
  game.player.y = 405;
  update(game);

  assert.equal(game.cash, 150);
  assert.equal(game.outcome, GAME_OUTCOMES.WON);
});

test('a passed mid-campaign mission sets missionComplete and restart resumes the next one', () => {
  const missions = [
    { id: 'm1', objective: 'eliminate', targetCount: 1, reward: 100 },
    { id: 'm2', objective: 'reach', x: 400, y: 400, radius: 40, reward: 200 },
  ];
  const game = createGame({ map: makeMap(80, 80), spawn: { x: 400, y: 400 }, seed: 1, missions });

  game.enemies.push(createEnemy({ id: 1, type: 'thug', x: 410, y: 400 }));
  killEnemy(game.enemies[0]);
  update(game);

  assert.equal(game.outcome, GAME_OUTCOMES.MISSION_COMPLETE);
  assert.equal(game.gameOver, true);
  assert.equal(game.missionIndex, 1, 'the next mission is queued');

  restart(game);

  assert.equal(game.outcome, null);
  assert.equal(game.gameOver, false);
  assert.equal(game.cash, 0);
  assert.equal(game.mission.id, 'm2');
  assert.equal(game.mission.status, 'active');
});

test('death is the terminal wasted state', () => {
  const game = createGame({
    map: makeMap(40, 40),
    missions: [{ id: 'm1', objective: 'eliminate', targetCount: 1 }],
  });

  game.player.health = 0;
  game.player.alive = false;
  update(game);

  assert.equal(game.outcome, GAME_OUTCOMES.WASTED);
  assert.equal(game.gameOver, true);
  const types = drainEvents(game).map((event) => event.type);
  assert.ok(types.includes('wasted'));
  assert.ok(types.includes('player_death'));
});

test('five stars alone is not busted, but police contact is', () => {
  const game = createGame({ map: makeMap(80, 80), spawn: { x: 400, y: 400 }, seed: 1 });
  addHeat(game, 260);
  update(game);

  assert.equal(game.wanted, 5);
  assert.equal(game.outcome, null, 'the chase is on but the run continues');
  assert.equal(game.busted, false);

  game.enemies.push(createEnemy({ id: 7, type: 'cop', x: game.player.x + 2, y: game.player.y }));
  update(game);

  assert.equal(game.outcome, GAME_OUTCOMES.BUSTED);
  assert.equal(game.busted, true);
  assert.equal(game.gameOver, true);
});

test('restart resets the world, wanted level, cash and campaign', () => {
  const map = makeMap(80, 80, {
    pickupSpawns: [{ x: 100, y: 100 }, { x: 200, y: 200 }],
  });
  const game = createGame({
    map,
    spawn: { x: 400, y: 400 },
    seed: 1,
    missions: [{ id: 'm1', objective: 'eliminate', targetCount: 1, reward: 100 }],
  });

  game.cash = 999;
  game.kills = 5;
  game.player.health = 10;
  addHeat(game, 260);
  game.outcome = GAME_OUTCOMES.WASTED;
  game.gameOver = true;

  restart(game);

  assert.equal(game.cash, 0);
  assert.equal(game.kills, 0);
  assert.equal(game.wanted, 0);
  assert.equal(game.heat, 0);
  assert.equal(game.outcome, null);
  assert.equal(game.gameOver, false);
  assert.equal(game.tick, 0);
  assert.equal(game.player.health, game.player.maxHealth);
  assert.equal(game.pickups.length, map.spawns.pickupSpawns.length, 'map pickups are restored');
  assert.equal(game.mission.id, 'm1');
  assert.equal(game.mission.status, 'active');
});

test('computeScore combines cash and kills', () => {
  assert.equal(computeScore({ cash: 100, kills: 3 }), 100 + 3 * SCORE_PER_KILL);
  assert.equal(computeScore(null), 0);
  assert.equal(computeScore({ cash: -50, kills: -2 }), 0);
});

test('a best record round-trips through storage', () => {
  const store = createMemoryStorage();
  assert.deepEqual(readBest(store), { score: 0, cash: 0 });

  const result = recordBest(store, { score: 120, cash: 80 });
  assert.equal(result.improved, true);
  assert.deepEqual(result.best, { score: 120, cash: 80 });
  assert.deepEqual(readBest(store), { score: 120, cash: 80 });
});

test('recordBest only writes when a value improves', () => {
  const store = createMemoryStorage();
  recordBest(store, { score: 100, cash: 50 });

  const worse = recordBest(store, { score: 40, cash: 10 });
  assert.equal(worse.improved, false);
  assert.deepEqual(worse.best, { score: 100, cash: 50 });

  const mixed = recordBest(store, { score: 50, cash: 200 });
  assert.equal(mixed.improved, true, 'a better cash alone still counts');
  assert.deepEqual(mixed.best, { score: 100, cash: 200 });
});

test('corrupt or unusable storage degrades to an empty record without throwing', () => {
  const store = createMemoryStorage();
  store.setItem(BEST_RECORD_KEY, '{not valid json');
  assert.deepEqual(readBest(store), { score: 0, cash: 0 });

  const throwing = {
    getItem() {
      throw new Error('storage disabled');
    },
    setItem() {
      throw new Error('storage disabled');
    },
  };
  assert.deepEqual(readBest(throwing), { score: 0, cash: 0 });
  assert.equal(writeBest(throwing, { score: 1, cash: 1 }), false);
});

test('normaliseRecord floors amounts and rejects bad input', () => {
  assert.deepEqual(normaliseRecord({ score: -5, cash: 2.9 }), { score: 0, cash: 2 });
  assert.deepEqual(normaliseRecord({ score: Number.NaN, cash: 'x' }), { score: 0, cash: 0 });
  assert.deepEqual(normaliseRecord(undefined), { score: 0, cash: 0 });
});
