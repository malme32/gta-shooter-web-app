import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createMap,
  isSolidTile,
  isWalkableTile,
  tileAt,
  isSolidAt,
  tileBounds,
  circleHitsTile,
  circleCollides,
  canStandAt,
  moveCircle,
  mapPixelWidth,
  mapPixelHeight,
  mapPixelBounds,
  clampCamera,
  cameraFollowTarget,
  ROAD,
  SIDEWALK,
  BUILDING,
  GRASS,
  DEFAULT_MAP_WIDTH,
  DEFAULT_MAP_HEIGHT,
} from '../src/core/map.js';
import { TILE_SIZE, PLAYER_RADIUS, VEHICLE_RADIUS } from '../src/core/constants.js';
import { createGame, update } from '../src/core/game.js';

function findTile(map, predicate) {
  for (let ty = 0; ty < map.height; ty += 1) {
    for (let tx = 0; tx < map.width; tx += 1) {
      if (predicate(map.tiles[ty * map.width + tx], tx, ty, map)) return [tx, ty];
    }
  }
  return null;
}

function pixelCenter(tx, ty) {
  return { x: (tx + 0.5) * TILE_SIZE, y: (ty + 0.5) * TILE_SIZE };
}

test('createMap builds a 100x100 grid by default', () => {
  const map = createMap({ seed: 1 });
  assert.equal(map.width, DEFAULT_MAP_WIDTH);
  assert.equal(map.height, DEFAULT_MAP_HEIGHT);
  assert.equal(map.tileSize, TILE_SIZE);
  assert.equal(map.tiles.length, map.width * map.height);
  assert.ok(map.tiles.every((t) => Number.isInteger(t)));
});

test('createMap validates its options', () => {
  assert.throws(() => createMap({ width: 0 }), /map\.width/);
  assert.throws(() => createMap({ height: -3 }), /map\.height/);
  assert.throws(() => createMap({ blockSize: 2 }), /blockSize must be at least 3/);
  assert.throws(() => createMap({ width: 10, height: 10, blockSize: 10 }), /blockSize must be smaller/);
});

test('createMap is deterministic for a seed and varies between seeds', () => {
  const a = createMap({ seed: 42 });
  const b = createMap({ seed: 42 });
  const c = createMap({ seed: 43 });
  assert.deepEqual(a.tiles, b.tiles);
  assert.deepEqual(a.spawns, b.spawns);
  assert.notDeepEqual(a.tiles, c.tiles);
});

test('createMap does not mutate its options object', () => {
  const options = { width: 40, height: 40, blockSize: 8, seed: 7 };
  const snapshot = { ...options };
  createMap(options);
  assert.deepEqual(options, snapshot);
});

test('generated map uses all four tile types', () => {
  const map = createMap({ seed: 1337 });
  const used = new Set(map.tiles);
  assert.ok(used.has(ROAD), 'expected roads');
  assert.ok(used.has(SIDEWALK), 'expected sidewalks');
  assert.ok(used.has(BUILDING), 'expected buildings');
  assert.ok(used.has(GRASS), 'expected grass parks');
});

test('only buildings are solid; roads, sidewalks and grass are walkable', () => {
  assert.equal(isSolidTile(BUILDING), true);
  assert.equal(isSolidTile(ROAD), false);
  assert.equal(isSolidTile(SIDEWALK), false);
  assert.equal(isSolidTile(GRASS), false);
  assert.equal(isWalkableTile(BUILDING), false);
  assert.equal(isWalkableTile(GRASS), true);
});

test('tileAt treats out-of-bounds as a solid building', () => {
  const map = createMap({ width: 20, height: 20, blockSize: 8, seed: 2 });
  assert.equal(tileAt(map, -1, 0), BUILDING);
  assert.equal(tileAt(map, 0, -1), BUILDING);
  assert.equal(tileAt(map, map.width, 0), BUILDING);
  assert.equal(tileAt(map, 0, map.height), BUILDING);
  assert.equal(isSolidAt(map, -1, -1), true);
  assert.equal(isSolidAt(map, map.width, map.height), true);
});

test('every walkable tile centre is free of collisions for a player-sized circle', () => {
  const map = createMap({ seed: 5 });
  for (let ty = 0; ty < map.height; ty += 1) {
    for (let tx = 0; tx < map.width; tx += 1) {
      const tile = map.tiles[ty * map.width + tx];
      if (isSolidTile(tile)) continue;
      const c = pixelCenter(tx, ty);
      assert.equal(
        canStandAt(map, c.x, c.y, PLAYER_RADIUS),
        true,
        `walkable tile ${tx},${ty} should accept a circle`,
      );
    }
  }
});

test('buildings block a circle placed at their centre', () => {
  const map = createMap({ seed: 9 });
  const building = findTile(map, (tile) => tile === BUILDING);
  assert.ok(building, 'map should contain a building');
  const c = pixelCenter(building[0], building[1]);
  assert.equal(circleCollides(map, c.x, c.y, PLAYER_RADIUS), true);
  assert.equal(canStandAt(map, c.x, c.y, PLAYER_RADIUS), false);
});

test('a circle cannot move into an adjacent building', () => {
  const map = createMap({ seed: 11 });
  const spot = findTile(map, (tile, tx, ty) => isWalkableTile(tile) && isSolidAt(map, tx + 1, ty));
  assert.ok(spot, 'expected a walkable tile next to a building');
  const [tx, ty] = spot;
  const start = pixelCenter(tx, ty);

  const result = moveCircle(map, start.x, start.y, PLAYER_RADIUS, TILE_SIZE * 4, 0);
  assert.equal(result.hitX, true);
  assert.equal(result.x, start.x);
  assert.equal(result.y, start.y);
  assert.equal(canStandAt(map, result.x, result.y, PLAYER_RADIUS), true);
});

test('fast moves cannot tunnel through a building', () => {
  const map = createMap({ seed: 13 });
  const spot = findTile(map, (tile, tx, ty) => isWalkableTile(tile) && isSolidAt(map, tx + 1, ty));
  const [tx, ty] = spot;
  const start = pixelCenter(tx, ty);

  const result = moveCircle(map, start.x, start.y, PLAYER_RADIUS, TILE_SIZE * 20, 0);
  assert.equal(result.hitX, true);
  assert.equal(result.x, start.x);
  assert.equal(circleCollides(map, result.x, result.y, PLAYER_RADIUS), false);
});

test('a circle moves freely along a road', () => {
  const map = createMap({ width: 40, height: 40, blockSize: 8, seed: 4 });
  const road = findTile(map, (tile, tx, ty) => tile === ROAD && isSolidAt(map, tx, ty) === false);
  const [tx, ty] = road;
  const start = pixelCenter(tx, ty);
  const distance = TILE_SIZE * 2;

  const result = moveCircle(map, start.x, start.y, PLAYER_RADIUS, 0, distance);
  assert.equal(result.hitX, false);
  assert.equal(result.hitY, false);
  assert.equal(result.y, start.y + distance);
  assert.equal(canStandAt(map, result.x, result.y, PLAYER_RADIUS), true);
});

test('a circle cannot leave the map', () => {
  const map = createMap({ width: 40, height: 40, blockSize: 8, seed: 6 });
  const [tx, ty] = findTile(map, (tile) => tile === ROAD);
  const start = pixelCenter(tx, ty);

  const result = moveCircle(map, start.x, start.y, PLAYER_RADIUS, -TILE_SIZE * 100, 0);
  assert.equal(result.hitX, true);
  assert.ok(result.x >= 0);
  assert.ok(result.x <= mapPixelWidth(map));
  assert.equal(canStandAt(map, result.x, result.y, PLAYER_RADIUS), true);
});

test('vehicles are blocked by buildings and cannot leave the map', () => {
  const map = createMap({ seed: 21 });
  const lane = findTile(map, (tile, tx, ty) => {
    if (tx + 2 >= map.width) return false;
    if (!isWalkableTile(tile) || !isWalkableTile(tileAt(map, tx + 1, ty))) return false;
    if (!isSolidAt(map, tx + 2, ty)) return false;
    const c = pixelCenter(tx, ty);
    return canStandAt(map, c.x, c.y, VEHICLE_RADIUS);
  });
  assert.ok(lane, 'expected a vehicle-sized lane next to a building');
  const start = pixelCenter(lane[0], lane[1]);

  const blocked = moveCircle(map, start.x, start.y, VEHICLE_RADIUS, TILE_SIZE * 3, 0);
  assert.equal(blocked.hitX, true);
  assert.equal(canStandAt(map, blocked.x, blocked.y, VEHICLE_RADIUS), true);

  const escaped = moveCircle(map, start.x, start.y, VEHICLE_RADIUS, -TILE_SIZE * 100, 0);
  assert.equal(escaped.hitX, true);
  assert.ok(escaped.x >= 0);
  assert.equal(canStandAt(map, escaped.x, escaped.y, VEHICLE_RADIUS), true);
});

test('tile bounds and hit tests are geometric', () => {
  const bounds = tileBounds(3, 4);
  assert.deepEqual(bounds, { x: 3 * TILE_SIZE, y: 4 * TILE_SIZE, w: TILE_SIZE, h: TILE_SIZE });
  assert.equal(circleHitsTile(3 * TILE_SIZE + 1, 4 * TILE_SIZE + 1, 2, 3, 4), true);
  assert.equal(circleHitsTile(0, 0, 2, 3, 4), false);
});

test('map pixel helpers match the tile grid', () => {
  const map = createMap({ width: 30, height: 20, blockSize: 10, seed: 8 });
  assert.equal(mapPixelWidth(map), 30 * TILE_SIZE);
  assert.equal(mapPixelHeight(map), 20 * TILE_SIZE);
  assert.deepEqual(mapPixelBounds(map), { width: 30 * TILE_SIZE, height: 20 * TILE_SIZE });
});

test('camera is clamped so it never shows outside the map', () => {
  const map = createMap({ width: 100, height: 100, seed: 1 });
  const mapW = mapPixelWidth(map);
  const mapH = mapPixelHeight(map);
  const viewport = { width: 800, height: 600 };

  assert.deepEqual(clampCamera(map, { x: -100, y: -100, ...viewport }), { x: 0, y: 0, ...viewport });

  const far = clampCamera(map, { x: 1e6, y: 1e6, ...viewport });
  assert.equal(far.x, mapW - viewport.width);
  assert.equal(far.y, mapH - viewport.height);
  assert.ok(far.x + far.width <= mapW);
  assert.ok(far.y + far.height <= mapH);
});

test('camera centres when the viewport is larger than the map', () => {
  const map = createMap({ width: 20, height: 20, blockSize: 10, seed: 1 });
  const camera = clampCamera(map, { x: 0, y: 0, width: 2000, height: 2000 });
  assert.equal(camera.x, (mapPixelWidth(map) - 2000) / 2);
  assert.equal(camera.y, (mapPixelHeight(map) - 2000) / 2);
});

test('cameraFollowTarget keeps the target centred inside the bounds', () => {
  const map = createMap({ width: 100, height: 100, seed: 1 });
  assert.deepEqual(cameraFollowTarget(map, 0, 0, 800, 600), { x: 0, y: 0, width: 800, height: 600 });

  const corner = cameraFollowTarget(map, 1e6, 1e6, 800, 600);
  assert.equal(corner.x, mapPixelWidth(map) - 800);
  assert.equal(corner.y, mapPixelHeight(map) - 600);
});

test('clampCamera rejects malformed cameras', () => {
  const map = createMap({ width: 20, height: 20, blockSize: 10, seed: 1 });
  assert.throws(() => clampCamera(map, null), TypeError);
  assert.throws(() => clampCamera(map, { x: 0, y: 0, width: 0, height: 10 }), /positive/);
});

test('collision queries do not mutate the map', () => {
  const map = createMap({ width: 40, height: 40, blockSize: 8, seed: 3 });
  const tilesBefore = map.tiles.slice();
  const [tx, ty] = findTile(map, (tile) => tile === ROAD);
  const c = pixelCenter(tx, ty);

  circleCollides(map, c.x, c.y, PLAYER_RADIUS);
  canStandAt(map, c.x, c.y, PLAYER_RADIUS);
  moveCircle(map, c.x, c.y, PLAYER_RADIUS, TILE_SIZE, TILE_SIZE);
  clampCamera(map, { x: 10, y: 10, width: 100, height: 100 });

  assert.deepEqual(map.tiles, tilesBefore);
});

test('spawn points are named, in bounds and walkable', () => {
  const map = createMap({ seed: 2 });
  const { spawns } = map;
  assert.ok(spawns && typeof spawns === 'object');
  for (const key of ['playerStart', 'vehicleSpawns', 'enemySpawns', 'pickupSpawns', 'missionSpawns']) {
    assert.ok(key in spawns, `missing spawn group: ${key}`);
  }

  const mapW = mapPixelWidth(map);
  const mapH = mapPixelHeight(map);

  const checkPoint = (point, label) => {
    assert.ok(Number.isFinite(point.x) && Number.isFinite(point.y), `${label} must be finite`);
    assert.ok(point.x >= 0 && point.x <= mapW, `${label} x in bounds`);
    assert.ok(point.y >= 0 && point.y <= mapH, `${label} y in bounds`);
    assert.equal(canStandAt(map, point.x, point.y, PLAYER_RADIUS), true, `${label} walkable`);
  };

  checkPoint(spawns.playerStart, 'playerStart');
  for (const key of ['vehicleSpawns', 'enemySpawns', 'pickupSpawns', 'missionSpawns']) {
    assert.ok(Array.isArray(spawns[key]) && spawns[key].length > 0, `${key} non-empty`);
    spawns[key].forEach((point, i) => checkPoint(point, `${key}[${i}]`));
  }
});

test('vehicle spawns sit on road tiles', () => {
  const map = createMap({ seed: 2 });
  for (const point of map.spawns.vehicleSpawns) {
    const tx = Math.floor(point.x / TILE_SIZE);
    const ty = Math.floor(point.y / TILE_SIZE);
    assert.equal(tileAt(map, tx, ty), ROAD);
  }
});

test('createGame consumes a generated map and respects the solid palette', () => {
  const map = { width: 5, height: 1, tiles: [BUILDING, ROAD, GRASS, SIDEWALK, BUILDING] };
  const state = createGame({ map, spawn: { x: 1.5 * TILE_SIZE, y: 0.5 * TILE_SIZE } });
  state.input.right = true;

  for (let i = 0; i < 200; i += 1) update(state);

  assert.equal(circleCollides(map, state.player.x, state.player.y, state.player.radius), false);
  assert.ok(state.player.x < 4 * TILE_SIZE, 'player should be stopped by the building');
  assert.ok(state.player.x > TILE_SIZE, 'player should have crossed the walkable tiles');
});
