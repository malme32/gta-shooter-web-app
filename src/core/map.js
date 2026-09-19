/**
 * City map: tile grid, spawn points, collision queries and camera clamping.
 *
 * Everything in this module is pure: it never touches the DOM, `window` or
 * `document`, so it can be unit tested under Node and reused by both the
 * simulation core and the renderer.
 *
 * ## Map shape
 *
 * A map is `{ width, height, tiles }` where `width`/`height` are tile counts
 * and `tiles` is a flat row-major array of `width * height` tile values. This
 * matches the contract accepted by `createGame()` in `core/game.js`.
 *
 * ## Tile palette
 *
 * Only `BUILDING` blocks movement; `ROAD`, `SIDEWALK` and `GRASS` are all
 * walkable. Out-of-bounds tiles count as `BUILDING`, so no entity can ever
 * leave the map.
 *
 * @module core/map
 */

import {
  TILE_SIZE,
  TILE_ROAD,
  TILE_SIDEWALK,
  TILE_BUILDING,
  TILE_GRASS,
  SOLID_TILES,
  VEHICLE_RADIUS,
} from './constants.js';
import { createRng } from './rng.js';
import { circleAabbOverlap, clamp } from './geometry.js';

/** Walkable road tile. */
export const ROAD = TILE_ROAD;
/** Walkable sidewalk tile. */
export const SIDEWALK = TILE_SIDEWALK;
/** Solid building tile (blocks movement). */
export const BUILDING = TILE_BUILDING;
/** Walkable grass / park tile. */
export const GRASS = TILE_GRASS;

/** Default grid size, in tiles. */
export const DEFAULT_MAP_WIDTH = 100;
export const DEFAULT_MAP_HEIGHT = 100;
/** Default distance between roads, in tiles. */
export const DEFAULT_BLOCK_SIZE = 10;

/** Probability that a city block becomes a grass park instead of buildings. */
const PARK_CHANCE = 0.18;

/**
 * @typedef {{ x: number, y: number }} Vec
 * @typedef {object} MapSpawns
 * @property {Vec} playerStart
 * @property {Vec[]} vehicleSpawns
 * @property {Vec[]} enemySpawns
 * @property {Vec[]} pickupSpawns
 * @property {Vec[]} missionSpawns
 * @typedef {object} GameMap
 * @property {number} width
 * @property {number} height
 * @property {number[]} tiles Row-major tile values.
 * @property {number} blockSize
 * @property {number} tileSize
 * @property {MapSpawns} spawns
 */

/** @param {number} value @param {string} name */
function assertPositiveInt(value, name) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
}

/**
 * Lookup of every solid tile value. Derived from `SOLID_TILES` so adding a new
 * solid tile to the constant is enough to make it block movement.
 */
const SOLID_TILE_SET = new Set(SOLID_TILES);

/**
 * Does this tile value block movement?
 *
 * @param {number} tile
 * @returns {boolean}
 */
export function isSolidTile(tile) {
  return SOLID_TILE_SET.has(tile);
}

/**
 * Is this tile value walkable?
 *
 * @param {number} tile
 * @returns {boolean}
 */
export function isWalkableTile(tile) {
  return !isSolidTile(tile);
}

/**
 * Read a tile, treating anything outside the grid as a solid building so the
 * map edge acts as an impenetrable wall.
 *
 * @param {GameMap} map
 * @param {number} tx
 * @param {number} ty
 * @returns {number}
 */
export function tileAt(map, tx, ty) {
  if (tx < 0 || ty < 0 || tx >= map.width || ty >= map.height) return TILE_BUILDING;
  return map.tiles[ty * map.width + tx];
}

/**
 * Is the tile at `tx,ty` solid? Out-of-bounds counts as solid.
 *
 * @param {GameMap} map
 * @param {number} tx
 * @param {number} ty
 * @returns {boolean}
 */
export function isSolidAt(map, tx, ty) {
  return isSolidTile(tileAt(map, tx, ty));
}

/**
 * World-space AABB of a tile.
 *
 * @param {number} tx
 * @param {number} ty
 * @returns {{ x: number, y: number, w: number, h: number }}
 */
export function tileBounds(tx, ty) {
  return { x: tx * TILE_SIZE, y: ty * TILE_SIZE, w: TILE_SIZE, h: TILE_SIZE };
}

/**
 * Does a circle overlap the tile at `tx,ty`? Use {@link isSolidAt} first if you
 * only care about solid tiles.
 *
 * @param {number} cx
 * @param {number} cy
 * @param {number} r
 * @param {number} tx
 * @param {number} ty
 * @returns {boolean}
 */
export function circleHitsTile(cx, cy, r, tx, ty) {
  return circleAabbOverlap({ x: cx, y: cy, r }, tileBounds(tx, ty));
}

/**
 * Does a circle overlap any solid tile (including the out-of-bounds border)?
 *
 * @param {GameMap} map
 * @param {number} cx
 * @param {number} cy
 * @param {number} r
 * @returns {boolean}
 */
export function circleCollides(map, cx, cy, r) {
  const minTx = Math.floor((cx - r) / TILE_SIZE);
  const maxTx = Math.floor((cx + r) / TILE_SIZE);
  const minTy = Math.floor((cy - r) / TILE_SIZE);
  const maxTy = Math.floor((cy + r) / TILE_SIZE);

  for (let ty = minTy; ty <= maxTy; ty += 1) {
    for (let tx = minTx; tx <= maxTx; tx += 1) {
      if (!isSolidAt(map, tx, ty)) continue;
      if (circleHitsTile(cx, cy, r, tx, ty)) return true;
    }
  }
  return false;
}

/**
 * Can a circle of radius `r` occupy `cx,cy` without overlapping a building or
 * leaving the map?
 *
 * @param {GameMap} map
 * @param {number} cx
 * @param {number} cy
 * @param {number} r
 * @returns {boolean}
 */
export function canStandAt(map, cx, cy, r) {
  return !circleCollides(map, cx, cy, r);
}

/**
 * Slide a circle by `dx,dy`, resolving each axis independently against solid
 * tiles. The move is split into sub-steps no larger than half a tile so fast
 * entities cannot tunnel through a building.
 *
 * @param {GameMap} map
 * @param {number} x
 * @param {number} y
 * @param {number} r
 * @param {number} dx
 * @param {number} dy
 * @returns {{ x: number, y: number, hitX: boolean, hitY: boolean }}
 */
export function moveCircle(map, x, y, r, dx, dy) {
  const stepX = Number.isFinite(dx) ? dx : 0;
  const stepY = Number.isFinite(dy) ? dy : 0;
  const maxComponent = Math.max(Math.abs(stepX), Math.abs(stepY));
  if (maxComponent === 0) return { x, y, hitX: false, hitY: false };

  const substeps = Math.max(1, Math.ceil(maxComponent / (TILE_SIZE / 2)));
  const sx = stepX / substeps;
  const sy = stepY / substeps;
  let px = x;
  let py = y;
  let hitX = false;
  let hitY = false;

  for (let i = 0; i < substeps; i += 1) {
    if (sx !== 0) {
      const nx = px + sx;
      if (circleCollides(map, nx, py, r)) hitX = true;
      else px = nx;
    }
    if (sy !== 0) {
      const ny = py + sy;
      if (circleCollides(map, px, ny, r)) hitY = true;
      else py = ny;
    }
  }

  return { x: px, y: py, hitX, hitY };
}

/** @param {GameMap} map @returns {number} Map width in world pixels. */
export function mapPixelWidth(map) {
  return map.width * TILE_SIZE;
}

/** @param {GameMap} map @returns {number} Map height in world pixels. */
export function mapPixelHeight(map) {
  return map.height * TILE_SIZE;
}

/** @param {GameMap} map @returns {{ width: number, height: number }} */
export function mapPixelBounds(map) {
  return { width: mapPixelWidth(map), height: mapPixelHeight(map) };
}

/**
 * Clamp a camera so its viewport never shows anything outside the map.
 *
 * When the viewport is larger than the map on an axis the camera is centred on
 * that axis instead (there is nothing better to show).
 *
 * @param {GameMap} map
 * @param {{ x: number, y: number, width: number, height: number }} camera
 * @returns {{ x: number, y: number, width: number, height: number }}
 */
export function clampCamera(map, camera) {
  if (!camera || typeof camera !== 'object') {
    throw new TypeError('clampCamera requires a camera');
  }
  const { width, height } = camera;
  if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) {
    throw new Error('camera.width and camera.height must be positive numbers');
  }

  const mapW = mapPixelWidth(map);
  const mapH = mapPixelHeight(map);
  const startX = Number.isFinite(camera.x) ? camera.x : 0;
  const startY = Number.isFinite(camera.y) ? camera.y : 0;

  const x = width >= mapW ? (mapW - width) / 2 : clamp(startX, 0, mapW - width);
  const y = height >= mapH ? (mapH - height) / 2 : clamp(startY, 0, mapH - height);

  return { x, y, width, height };
}

/**
 * Centre a clamped camera on a world-space target.
 *
 * @param {GameMap} map
 * @param {number} targetX
 * @param {number} targetY
 * @param {number} width Viewport width in pixels.
 * @param {number} height Viewport height in pixels.
 * @returns {{ x: number, y: number, width: number, height: number }}
 */
export function cameraFollowTarget(map, targetX, targetY, width, height) {
  return clampCamera(map, { x: targetX - width / 2, y: targetY - height / 2, width, height });
}

/** @param {number} tx @param {number} ty @returns {Vec} */
function tileCenter(tx, ty) {
  return { x: (tx + 0.5) * TILE_SIZE, y: (ty + 0.5) * TILE_SIZE };
}

/**
 * Evenly sample up to `count` entries from `tiles`, preserving order.
 *
 * @param {Array<[number, number]>} tiles
 * @param {number} count
 * @returns {Array<[number, number]>}
 */
function spread(tiles, count) {
  if (!Array.isArray(tiles) || tiles.length === 0 || count <= 0) return [];
  if (tiles.length <= count) return tiles.slice();
  const out = [];
  for (let i = 0; i < count; i += 1) {
    out.push(tiles[Math.floor((i * tiles.length) / count)]);
  }
  return out;
}

/**
 * Sample up to `count` tile centres that a circle of `radius` can occupy,
 * trying each pool in order and returning `[]` when none fit.
 *
 * @param {{ width: number, height: number, tiles: number[] }} grid
 * @param {Array<Array<[number, number]>>} pools
 * @param {number} count
 * @param {number} radius
 * @returns {Vec[]}
 */
function spreadFitting(grid, pools, count, radius) {
  for (const tiles of pools) {
    const fits = tiles
      .map(([tx, ty]) => tileCenter(tx, ty))
      .filter((point) => canStandAt(grid, point.x, point.y, radius));
    if (fits.length > 0) return spread(fits, count);
  }
  return [];
}

/**
 * The road tile closest to a tile coordinate.
 *
 * @param {Array<[number, number]>} tiles
 * @param {number} tx
 * @param {number} ty
 * @returns {[number, number]}
 */
function nearestTile(tiles, tx, ty) {
  let best = tiles[0];
  let bestDist = Infinity;
  for (const candidate of tiles) {
    const dx = candidate[0] - tx;
    const dy = candidate[1] - ty;
    const dist = dx * dx + dy * dy;
    if (dist < bestDist) {
      bestDist = dist;
      best = candidate;
    }
  }
  return best;
}

/**
 * Choose walkable tiles at least `minTiles` away from `origin`, falling back to
 * the whole pool when there are not enough far candidates.
 *
 * @param {Array<[number, number]>} tiles
 * @param {Vec} origin
 * @param {number} count
 * @param {number} minTiles
 * @returns {Vec[]}
 */
function pickFar(tiles, origin, count, minTiles) {
  const minDistSq = (minTiles * TILE_SIZE) ** 2;
  const far = tiles.filter(([tx, ty]) => {
    const c = tileCenter(tx, ty);
    const dx = c.x - origin.x;
    const dy = c.y - origin.y;
    return dx * dx + dy * dy >= minDistSq;
  });
  const pool = far.length >= count ? far : tiles;
  return spread(pool, count).map(([tx, ty]) => tileCenter(tx, ty));
}

/**
 * Collect the named spawn points from a generated grid.
 *
 * @param {{ width: number, height: number, blockSize: number, tiles: number[] }} grid
 * @returns {MapSpawns}
 */
function buildSpawns(grid) {
  const { width, height, blockSize, tiles } = grid;
  const roads = [];
  const intersections = [];
  const sidewalks = [];

  for (let ty = 0; ty < height; ty += 1) {
    for (let tx = 0; tx < width; tx += 1) {
      const tile = tiles[ty * width + tx];
      if (tile === TILE_ROAD) {
        roads.push([tx, ty]);
        if (tx % blockSize === 0 && ty % blockSize === 0) intersections.push([tx, ty]);
      } else if (tile === TILE_SIDEWALK) {
        sidewalks.push([tx, ty]);
      }
    }
  }

  const grass = [];
  for (let ty = 0; ty < height; ty += 1) {
    for (let tx = 0; tx < width; tx += 1) {
      if (tiles[ty * width + tx] === TILE_GRASS) grass.push([tx, ty]);
    }
  }

  const startTile = nearestTile(roads, Math.floor(width / 2), Math.floor(height / 2));
  const playerStart = tileCenter(startTile[0], startTile[1]);
  const vehiclePool = intersections.length > 0 ? intersections : roads;
  const missionPool = intersections.length > 0 ? intersections : roads;
  const enemyPool = grass.length > 0 ? grass : sidewalks.length > 0 ? sidewalks : roads;
  const pickupPool = roads.concat(sidewalks);

  return {
    playerStart,
    vehicleSpawns: spreadFitting(grid, [vehiclePool, roads], 8, VEHICLE_RADIUS),
    enemySpawns: pickFar(enemyPool, playerStart, 8, 8),
    pickupSpawns: spread(pickupPool, 12).map(([tx, ty]) => tileCenter(tx, ty)),
    missionSpawns: spread(missionPool, 4).map(([tx, ty]) => tileCenter(tx, ty)),
  };
}

/**
 * The tile value for a grid coordinate in a city-block layout.
 *
 * Roads run on every multiple of `blockSize`; the ring of tiles next to a road
 * is sidewalk; the interior is a park (grass) on park blocks and buildings
 * otherwise.
 *
 * @param {number} tx
 * @param {number} ty
 * @param {number} blockSize
 * @param {number} blocksX
 * @param {Set<number>} parkBlocks
 * @returns {number}
 */
function tileFor(tx, ty, blockSize, blocksX, parkBlocks) {
  const bx = tx % blockSize;
  const by = ty % blockSize;
  if (bx === 0 || by === 0) return TILE_ROAD;

  const onRing = bx === 1 || by === 1 || bx === blockSize - 1 || by === blockSize - 1;
  if (onRing) return TILE_SIDEWALK;

  const blockX = Math.floor(tx / blockSize);
  const blockY = Math.floor(ty / blockSize);
  return parkBlocks.has(blockY * blocksX + blockX) ? TILE_GRASS : TILE_BUILDING;
}

/**
 * Row-major index of block `(1, 1)`.
 *
 * Block `(1, 1)` always contains an interior core when `blockSize >= 4` and
 * `blocksX, blocksY > 1`, so it is the safe place to force a park or a building
 * when the random pass produced only one of the two.
 *
 * @param {number} blocksX
 * @returns {number}
 */
function interiorBlockIndex(blocksX) {
  return blocksX + 1;
}

/**
 * Generate a deterministic city map.
 *
 * @param {object} [options]
 * @param {number} [options.width=100] Grid width in tiles.
 * @param {number} [options.height=100] Grid height in tiles.
 * @param {number} [options.blockSize=10] Road spacing in tiles (`>= 4`).
 * @param {number} [options.seed=1] Seed used when `rng` is omitted.
 * @param {() => number} [options.rng] Random function (`[0,1)`), for tests.
 * @returns {GameMap}
 */
export function createMap({
  width = DEFAULT_MAP_WIDTH,
  height = DEFAULT_MAP_HEIGHT,
  blockSize = DEFAULT_BLOCK_SIZE,
  seed = 1,
  rng,
} = {}) {
  assertPositiveInt(width, 'map.width');
  assertPositiveInt(height, 'map.height');
  assertPositiveInt(blockSize, 'map.blockSize');
  if (blockSize < 4) throw new Error('map.blockSize must be at least 4');
  if (blockSize >= width || blockSize >= height) {
    throw new Error('map.blockSize must be smaller than map.width and map.height');
  }

  const random = typeof rng === 'function' ? rng : createRng(seed);
  const blocksX = Math.ceil(width / blockSize);
  const blocksY = Math.ceil(height / blockSize);
  const parkBlocks = new Set();

  for (let by = 0; by < blocksY; by += 1) {
    for (let bx = 0; bx < blocksX; bx += 1) {
      if (random() < PARK_CHANCE) parkBlocks.add(by * blocksX + bx);
    }
  }
  if (parkBlocks.size === 0 && blocksX > 1 && blocksY > 1) {
    parkBlocks.add(interiorBlockIndex(blocksX));
  }
  if (parkBlocks.size === blocksX * blocksY && blocksX * blocksY > 1) {
    parkBlocks.delete(0);
  }

  const tiles = new Array(width * height);
  for (let ty = 0; ty < height; ty += 1) {
    for (let tx = 0; tx < width; tx += 1) {
      tiles[ty * width + tx] = tileFor(tx, ty, blockSize, blocksX, parkBlocks);
    }
  }

  return {
    width,
    height,
    tiles,
    blockSize,
    tileSize: TILE_SIZE,
    spawns: buildSpawns({ width, height, blockSize, tiles }),
  };
}
