import test from 'node:test';
import assert from 'node:assert/strict';

import {
  alphaFor,
  lerpAngle,
  interpolatePoint,
  interpolateActor,
  interpolateCamera,
  worldToScreen,
  visibleTileBounds,
  snapshotScene,
  interpolateScene,
  spriteFor,
  TILE_COLORS,
  PLAYER_SPRITE,
  ENTITY_SPRITES,
} from '../src/ui/render.js';
import {
  barFillRatio,
  healthColor,
  starStates,
  weaponLabel,
  formatCash,
  computeHudLayout,
  HUD_COLORS,
  HUD_DEFAULTS,
} from '../src/ui/hud.js';
import { TILE_SIZE, TICK_SECONDS, WEAPONS } from '../src/core/constants.js';
import { createMap } from '../src/core/map.js';
import { createGame } from '../src/core/game.js';

test('alphaFor maps the accumulator onto [0, 1]', () => {
  assert.equal(alphaFor(0), 0);
  assert.equal(alphaFor(TICK_SECONDS), 1);
  assert.equal(alphaFor(TICK_SECONDS / 2), 0.5);
  assert.equal(alphaFor(TICK_SECONDS * 4), 1);
  assert.equal(alphaFor(-TICK_SECONDS), 0);
});

test('alphaFor tolerates missing or invalid input', () => {
  assert.equal(alphaFor(NaN), 0);
  assert.equal(alphaFor(undefined), 0);
  assert.equal(alphaFor(TICK_SECONDS, 0), 1);
  assert.equal(alphaFor(0.01, undefined), 0.01 / TICK_SECONDS);
});

test('lerpAngle takes the shortest arc across the +/-pi seam', () => {
  const start = Math.PI - 0.1;
  const end = -Math.PI + 0.1;
  const mid = lerpAngle(start, end, 0.5);
  assert.ok(Math.abs(Math.abs(mid) - Math.PI) < 0.01, `expected near +/-pi, got ${mid}`);
});

test('lerpAngle clamps its factor and handles bad angles', () => {
  assert.equal(lerpAngle(0, 1, 5), 1);
  assert.equal(lerpAngle(0, 1, -5), 0);
  assert.equal(lerpAngle(NaN, 0.5, 0.5), 0.25);
});

test('interpolatePoint blends two samples', () => {
  const mid = interpolatePoint({ x: 0, y: 10 }, { x: 10, y: 20 }, 0.5);
  assert.deepEqual(mid, { x: 5, y: 15 });
});

test('interpolatePoint falls back when one side is missing', () => {
  assert.deepEqual(interpolatePoint(null, { x: 3, y: 4 }, 0.5), { x: 3, y: 4 });
  assert.deepEqual(interpolatePoint({ x: 3, y: 4 }, null, 0.5), { x: 3, y: 4 });
  assert.deepEqual(interpolatePoint(null, null, 0.5), { x: 0, y: 0 });
});

test('interpolateActor keeps current fields and blends position and aim', () => {
  const prev = { x: 0, y: 0, aim: 0, health: 50 };
  const curr = { x: 10, y: 0, aim: Math.PI / 2, health: 40 };
  const actor = interpolateActor(prev, curr, 0.5);
  assert.equal(actor.x, 5);
  assert.equal(actor.y, 0);
  assert.equal(actor.health, 40);
  assert.ok(Math.abs(actor.aim - Math.PI / 4) < 1e-9);
});

test('interpolateActor returns null when there is no current sample', () => {
  assert.equal(interpolateActor(null, null, 0.5), null);
});

test('interpolateCamera blends position but keeps the viewport size', () => {
  const prev = { x: 0, y: 0, width: 960, height: 540 };
  const curr = { x: 20, y: 10, width: 960, height: 540 };
  const camera = interpolateCamera(prev, curr, 0.25);
  assert.deepEqual(camera, { x: 5, y: 2.5, width: 960, height: 540 });
});

test('worldToScreen subtracts the camera', () => {
  const screen = worldToScreen({ x: 100, y: 50 }, 130, 70);
  assert.deepEqual(screen, { x: 30, y: 20 });
});

test('visibleTileBounds clips the viewport to the grid', () => {
  const grid = { width: 100, height: 100 };
  const bounds = visibleTileBounds({ x: 0, y: 0, width: 960, height: 540 }, grid);
  assert.equal(bounds.minTx, 0);
  assert.equal(bounds.minTy, 0);
  assert.equal(bounds.maxTx, Math.ceil(960 / TILE_SIZE));
  assert.equal(bounds.maxTy, Math.ceil(540 / TILE_SIZE));
});

test('visibleTileBounds never exceeds the grid edges', () => {
  const grid = { width: 4, height: 4 };
  const bounds = visibleTileBounds({ x: 0, y: 0, width: 960, height: 540 }, grid);
  assert.equal(bounds.maxTx, 3);
  assert.equal(bounds.maxTy, 3);
});

test('snapshotScene captures player, camera and entities without mutation', () => {
  const game = {
    player: { x: 1, y: 2, aim: 0.5, radius: 12, alive: true, weapon: 'pistol' },
    camera: { x: 10, y: 20, width: 960, height: 540, extra: 'ignored' },
    entities: [{ id: 'e1', kind: 'pedestrian', x: 5, y: 6, alive: true }],
    bullets: [{ id: 'b1', kind: 'bullet', x: 7, y: 8 }],
  };
  const scene = snapshotScene(game);
  assert.deepEqual(scene.player, { x: 1, y: 2, aim: 0.5, radius: 12, alive: true, weapon: 'pistol' });
  scene.camera.x = 999;
  assert.equal(game.camera.x, 10, 'snapshot must not alias the live camera');
  assert.equal(scene.entities.length, 2);
  assert.equal(scene.entities[1].id, 'b1');
});

test('interpolateScene blends by id and drops vanished entities', () => {
  const prev = {
    player: { x: 0, y: 0, aim: 0 },
    camera: { x: 0, y: 0, width: 960, height: 540 },
    entities: [
      { id: 'a', x: 0, y: 0 },
      { id: 'gone', x: 100, y: 100 },
    ],
  };
  const curr = {
    player: { x: 10, y: 0, aim: 0 },
    camera: { x: 0, y: 0, width: 960, height: 540 },
    entities: [
      { id: 'a', x: 10, y: 0 },
      { id: 'new', x: 50, y: 50 },
    ],
  };
  const scene = interpolateScene(prev, curr, 0.5);
  assert.equal(scene.player.x, 5);
  const ids = scene.entities.map((e) => e.id).sort();
  assert.deepEqual(ids, ['a', 'new']);
  assert.equal(scene.entities.find((e) => e.id === 'a').x, 5);
  assert.equal(scene.entities.find((e) => e.id === 'new').x, 50);
});

test('spriteFor selects a known sprite and falls back', () => {
  assert.equal(spriteFor({ kind: 'vehicle' }), ENTITY_SPRITES.vehicle);
  assert.equal(spriteFor({ kind: 'unknown' }), ENTITY_SPRITES.default);
  assert.equal(spriteFor(null), ENTITY_SPRITES.default);
});

test('render module exposes a colour for every map tile', () => {
  const map = createMap({ seed: 7 });
  for (const tile of map.tiles) {
    assert.ok(TILE_COLORS[tile], `missing colour for tile ${tile}`);
  }
  assert.ok(PLAYER_SPRITE.body);
});

test('every renderable entity kind has a procedural sprite', () => {
  for (const kind of ['vehicle', 'pedestrian', 'bullet', 'pickup']) {
    assert.ok(ENTITY_SPRITES[kind], `missing sprite for ${kind}`);
    assert.equal(ENTITY_SPRITES[kind].shape, kind === 'pedestrian' ? 'person' : kind);
  }
});

test('a fresh game snapshot interpolates into a valid scene', () => {
  const map = createMap({ seed: 1337 });
  const game = createGame({ map, spawn: map.spawns.playerStart, seed: 1337 });
  const scene = interpolateScene(null, snapshotScene(game), 0.5);
  assert.ok(scene.player);
  assert.ok(scene.camera);
  assert.equal(scene.player.x, game.player.x);
});

test('barFillRatio clamps and guards against a zero max', () => {
  assert.equal(barFillRatio(50, 100), 0.5);
  assert.equal(barFillRatio(200, 100), 1);
  assert.equal(barFillRatio(-10, 100), 0);
  assert.equal(barFillRatio(10, 0), 1);
  assert.equal(barFillRatio(NaN, 100), 0);
});

test('healthColor switches to danger below a quarter health', () => {
  assert.equal(healthColor(0.5), HUD_COLORS.health);
  assert.equal(healthColor(0.1), HUD_COLORS.healthLow);
  assert.equal(healthColor(0.25), HUD_COLORS.health);
});

test('starStates lights stars up to the wanted level', () => {
  assert.deepEqual(starStates(0, 3), [false, false, false]);
  assert.deepEqual(starStates(2, 3), [true, true, false]);
  assert.deepEqual(starStates(9, 3), [true, true, true]);
  assert.deepEqual(starStates(1), [true, false, false, false, false]);
  assert.equal(starStates(3, HUD_DEFAULTS.maxStars).length, 5);
});

test('weaponLabel resolves known weapons and falls back to the id', () => {
  assert.equal(weaponLabel('smg'), WEAPONS.smg.name);
  assert.equal(weaponLabel('plasma'), 'plasma');
});

test('formatCash renders a GTA-style amount', () => {
  assert.equal(formatCash(0), '$0');
  assert.equal(formatCash(1234), '$1,234');
  assert.equal(formatCash(-50), '$-50');
  assert.equal(formatCash(NaN), '$0');
});

test('computeHudLayout places every panel inside the canvas', () => {
  const layout = computeHudLayout(960, 540);
  for (const key of ['health', 'armour', 'ammo', 'weapon', 'wanted', 'cash']) {
    const rect = layout[key];
    assert.ok(rect, `missing ${key} rect`);
    assert.ok(rect.x >= 0 && rect.y >= 0, `${key} starts off-screen`);
    assert.ok(rect.x + rect.width <= 960, `${key} overflows width`);
    assert.ok(rect.y + rect.height <= 540, `${key} overflows height`);
  }
  assert.ok(layout.wanted.x > layout.health.x);
});

test('computeHudLayout falls back to a sane size for bad input', () => {
  const layout = computeHudLayout(0, undefined);
  assert.equal(layout.width, 960);
  assert.equal(layout.height, 540);
});
