/**
 * Canvas rendering for the top-down shooter.
 *
 * The simulation runs at a fixed 60 Hz (see `core/game.js`), but displays often
 * refresh at 120/144 Hz. Drawing the raw tick state would therefore repeat or
 * stutter, so the renderer interpolates between the previous and current tick
 * using the accumulator fraction:
 *
 * ```js
 * const alpha = alphaFor(game.accumulator, TICK_SECONDS); // 0..1
 * const view = interpolateScene(prevSnapshot, currSnapshot, alpha);
 * ```
 *
 * Every helper in this module is pure and Node-testable; only the `draw*`/`render*`
 * functions touch a `CanvasRenderingContext2D`. Sprites are generated
 * procedurally from the palette tables below, so the game makes **no external
 * image or asset requests**.
 *
 * @module ui/render
 */

import { TILE_SIZE, TICK_SECONDS } from '../core/constants.js';
import { advance } from '../core/game.js';
import { clamp, lerp as lerpVec } from '../core/geometry.js';
import { ROAD, SIDEWALK, BUILDING, GRASS } from '../core/map.js';

/** Tile value -> fill colour. Indexed by the map's tile constants. */
export const TILE_COLORS = Object.freeze({
  [ROAD]: '#111827',
  [SIDEWALK]: '#334155',
  [BUILDING]: '#1e293b',
  [GRASS]: '#14532d',
  default: '#1e293b',
});

/** Procedural player sprite colours. No bitmaps are ever loaded. */
export const PLAYER_SPRITE = Object.freeze({
  body: '#7dd3fc',
  dead: '#64748b',
  outline: '#0b1220',
  weapon: '#0f172a',
  barrel: '#cbd5e1',
  head: '#f8d7b0',
  shadow: 'rgba(0, 0, 0, 0.35)',
});

/**
 * Procedural entity sprite descriptors. `shape` selects the draw routine in
 * {@link drawEntity}; there are no external assets.
 */
export const ENTITY_SPRITES = Object.freeze({
  vehicle: Object.freeze({ shape: 'vehicle', width: 34, height: 20, color: '#f97316', outline: '#7c2d12' }),
  pedestrian: Object.freeze({ shape: 'person', radius: 8, color: '#f472b6', outline: '#831843' }),
  bullet: Object.freeze({ shape: 'bullet', radius: 4, color: '#fde047', outline: '#a16207' }),
  pickup: Object.freeze({ shape: 'pickup', radius: 9, color: '#a3e635', outline: '#3f6212' }),
  default: Object.freeze({ shape: 'circle', radius: 10, color: '#94a3b8', outline: '#334155' }),
});

/** @param {object} [entity] @returns {object} */
export function spriteFor(entity) {
  return ENTITY_SPRITES[entity?.kind] ?? ENTITY_SPRITES.default;
}

/**
 * Convert the fixed-timestep accumulator into a `[0, 1]` interpolation factor.
 *
 * A full tick's worth of leftover time maps to `1`, so the factor never
 * overshoots the next simulation state.
 *
 * @param {number} accumulator Seconds carried by the fixed-timestep loop.
 * @param {number} [tickSeconds=TICK_SECONDS] Duration of one tick, in seconds.
 * @returns {number} Interpolation fraction in `[0, 1]`.
 */
export function alphaFor(accumulator, tickSeconds = TICK_SECONDS) {
  const tick = Number.isFinite(tickSeconds) && tickSeconds > 0 ? tickSeconds : TICK_SECONDS;
  const raw = Number.isFinite(accumulator) ? accumulator / tick : 0;
  return clamp(raw, 0, 1);
}

/**
 * Interpolate between two angles along the shortest arc.
 *
 * @param {number} a Start angle in radians.
 * @param {number} b End angle in radians.
 * @param {number} t Interpolation factor.
 * @returns {number}
 */
export function lerpAngle(a, b, t) {
  const from = Number.isFinite(a) ? a : 0;
  const to = Number.isFinite(b) ? b : 0;
  const k = Number.isFinite(t) ? clamp(t, 0, 1) : 0;
  let delta = (to - from) % (Math.PI * 2);
  if (delta > Math.PI) delta -= Math.PI * 2;
  if (delta < -Math.PI) delta += Math.PI * 2;
  return from + delta * k;
}

/**
 * Interpolate a point between a previous and a current sample.
 *
 * When either endpoint is missing the other one is returned unchanged, so an
 * entity that just spawned or despawned is still drawn correctly.
 *
 * @param {{ x: number, y: number }|null|undefined} prev
 * @param {{ x: number, y: number }|null|undefined} curr
 * @param {number} t
 * @returns {{ x: number, y: number }}
 */
export function interpolatePoint(prev, curr, t) {
  if (!prev && !curr) return { x: 0, y: 0 };
  if (!prev) return { x: curr.x, y: curr.y };
  if (!curr) return { x: prev.x, y: prev.y };
  return lerpVec(prev, curr, clamp(Number.isFinite(t) ? t : 0, 0, 1));
}

/**
 * Interpolate an actor (player or entity) between two samples, keeping every
 * non-positional field from the current sample.
 *
 * @template {{ x: number, y: number, aim?: number }} T
 * @param {T|null|undefined} prev
 * @param {T|null|undefined} curr
 * @param {number} t
 * @returns {T|null}
 */
export function interpolateActor(prev, curr, t) {
  if (!curr) return prev ? { ...prev } : null;
  const point = interpolatePoint(prev, curr, t);
  const aim =
    prev && Number.isFinite(prev.aim) && Number.isFinite(curr.aim)
      ? lerpAngle(prev.aim, curr.aim, t)
      : curr.aim;
  return { ...curr, x: point.x, y: point.y, aim };
}

/**
 * Interpolate a camera's position while keeping the current viewport size.
 *
 * @param {{ x: number, y: number, width: number, height: number }|null|undefined} prev
 * @param {{ x: number, y: number, width: number, height: number }|null|undefined} curr
 * @param {number} t
 * @returns {{ x: number, y: number, width: number, height: number }|null}
 */
export function interpolateCamera(prev, curr, t) {
  if (!curr) return prev ? { ...prev } : null;
  const point = interpolatePoint(prev, curr, t);
  return { x: point.x, y: point.y, width: curr.width, height: curr.height };
}

/**
 * Convert a world-space point to canvas/screen space for a camera.
 *
 * @param {{ x: number, y: number }} camera
 * @param {number} x
 * @param {number} y
 * @returns {{ x: number, y: number }}
 */
export function worldToScreen(camera, x, y) {
  return { x: x - camera.x, y: y - camera.y };
}

/**
 * Tile rectangle currently visible through the camera, clamped to the grid.
 *
 * Iterating only these tiles keeps large maps cheap to draw. When the viewport
 * lies entirely outside the map `max < min` and the caller draws nothing.
 *
 * @param {{ x: number, y: number, width: number, height: number }} camera
 * @param {{ width: number, height: number }} grid
 * @param {number} [tileSize=TILE_SIZE]
 * @returns {{ minTx: number, maxTx: number, minTy: number, maxTy: number }}
 */
export function visibleTileBounds(camera, grid, tileSize = TILE_SIZE) {
  const size = Number.isFinite(tileSize) && tileSize > 0 ? tileSize : TILE_SIZE;
  const width = Number.isFinite(grid?.width) ? grid.width : 0;
  const height = Number.isFinite(grid?.height) ? grid.height : 0;
  const cx = Number.isFinite(camera?.x) ? camera.x : 0;
  const cy = Number.isFinite(camera?.y) ? camera.y : 0;
  const cw = Number.isFinite(camera?.width) ? camera.width : 0;
  const ch = Number.isFinite(camera?.height) ? camera.height : 0;

  return {
    minTx: Math.max(0, Math.floor(cx / size)),
    maxTx: Math.min(width - 1, Math.ceil((cx + cw) / size)),
    minTy: Math.max(0, Math.floor(cy / size)),
    maxTy: Math.min(height - 1, Math.ceil((cy + ch) / size)),
  };
}

function collectEntities(game) {
  const entities = [];
  if (Array.isArray(game?.entities)) entities.push(...game.entities);
  if (Array.isArray(game?.bullets)) entities.push(...game.bullets);
  return entities;
}

/**
 * Capture the renderable fields of a game state so they can be interpolated on
 * the next frame. Keeping the snapshot separate means the core game state is
 * never mutated by the renderer.
 *
 * Every entity (and projectile) **must carry a stable, unique `id`** so that
 * {@link interpolateScene} can match the same actor across snapshots, plus a
 * `kind` so {@link spriteFor} can choose its procedural sprite. Entities
 * without an `id` collapse onto a single `Map` key and jitter.
 *
 * @param {object} game
 * @returns {{ player: object|null, camera: object|null, entities: object[] }}
 */
export function snapshotScene(game) {
  const player = game?.player
    ? {
        x: game.player.x,
        y: game.player.y,
        aim: game.player.aim,
        radius: game.player.radius,
        alive: game.player.alive,
      }
    : null;

  return {
    player,
    camera: game?.camera ? { ...game.camera } : null,
    entities: collectEntities(game).map((entity) => ({
      id: entity.id,
      kind: entity.kind,
      x: entity.x,
      y: entity.y,
      radius: entity.radius,
      alive: entity.alive,
    })),
  };
}

/**
 * Interpolate a full scene between two snapshots.
 *
 * Entities are matched by their **stable, unique `id`** so ones that appear or
 * disappear between ticks do not corrupt the interpolation of the others; their
 * `kind` is kept from the current sample so {@link spriteFor} stays correct.
 *
 * @param {{ player: object|null, camera: object|null, entities: object[] }|null} prev
 * @param {{ player: object|null, camera: object|null, entities: object[] }} curr
 * @param {number} t
 * @returns {object}
 */
export function interpolateScene(prev, curr, t) {
  if (!curr) return prev ?? { player: null, camera: null, entities: [] };
  const prevEntities = new Map();
  for (const entity of prev?.entities ?? []) prevEntities.set(entity.id, entity);

  return {
    player: interpolateActor(prev?.player, curr.player, t),
    camera: interpolateCamera(prev?.camera, curr.camera, t),
    entities: (curr.entities ?? []).map((entity) => {
      const point = interpolatePoint(prevEntities.get(entity.id), entity, t);
      return { ...entity, x: point.x, y: point.y };
    }),
  };
}

/**
 * Advance the fixed-timestep simulation by `dtSeconds` and produce the
 * interpolated scene to draw for this frame.
 *
 * The state is snapshotted **before** `advance()` runs so that `prevSnapshot`
 * always holds the previous *tick*, not the current one. Frames that consume no
 * whole tick (`steps === 0`) keep that previous snapshot and blend it towards
 * the unchanged current state using the growing accumulator, which is what
 * produces sub-tick motion on 120/144 Hz displays. Snapshotting after
 * `advance()` would make `prev` and `curr` identical on those frames and leave
 * high-refresh rendering stepped at 60 Hz.
 *
 * @param {object} game Game state mutated in place by `advance()`.
 * @param {number} dtSeconds Seconds elapsed since the previous frame.
 * @param {{ player: object|null, camera: object|null, entities: object[] }|null} prevSnapshot
 *   Snapshot returned by the previous call (or `snapshotScene(game)` initially).
 * @returns {{ steps: number, alpha: number, prevSnapshot: object, scene: object }}
 *   `prevSnapshot` must be fed back into the next call to keep motion smooth.
 */
export function sampleFrame(game, dtSeconds, prevSnapshot) {
  const before = snapshotScene(game);
  const steps = advance(game, dtSeconds);
  const base = steps > 0 ? before : prevSnapshot;
  const alpha = alphaFor(game.accumulator, TICK_SECONDS);
  return {
    steps,
    alpha,
    prevSnapshot: base,
    scene: interpolateScene(base, snapshotScene(game), alpha),
  };
}

/**
 * Clear the whole canvas in logical (CSS-pixel) coordinates.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} [options]
 * @param {number} [options.width=0]
 * @param {number} [options.height=0]
 * @param {number} [options.dpr=1] Device pixel ratio used to scale the backing store.
 * @param {string} [options.background='#05070b']
 */
export function clearCanvas(ctx, { width = 0, height = 0, dpr = 1, background = '#05070b' } = {}) {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, width, height);
}

/**
 * Draw only the tiles visible through the camera. Assumes the context has
 * already been translated into world space.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {{ width: number, height: number, tiles: ArrayLike<number> }} grid
 * @param {{ x: number, y: number, width: number, height: number }} camera
 * @param {object} [options]
 * @param {number} [options.tileSize=TILE_SIZE]
 * @param {Record<number|string, string>} [options.palette=TILE_COLORS]
 * @returns {number} How many tiles were drawn.
 */
export function drawMap(ctx, grid, camera, { tileSize = TILE_SIZE, palette = TILE_COLORS } = {}) {
  if (!grid || !camera) return 0;
  const bounds = visibleTileBounds(camera, grid, tileSize);
  let drawn = 0;
  for (let ty = bounds.minTy; ty <= bounds.maxTy; ty += 1) {
    for (let tx = bounds.minTx; tx <= bounds.maxTx; tx += 1) {
      const tile = grid.tiles[ty * grid.width + tx];
      ctx.fillStyle = palette[tile] ?? palette.default;
      ctx.fillRect(tx * tileSize, ty * tileSize, tileSize, tileSize);
      drawn += 1;
    }
  }
  return drawn;
}

function drawVehicle(ctx, sprite) {
  const { width, height, color, outline } = sprite;
  ctx.fillStyle = color;
  ctx.strokeStyle = outline;
  ctx.lineWidth = 2;
  ctx.fillRect(-width / 2, -height / 2, width, height);
  ctx.strokeRect(-width / 2, -height / 2, width, height);
  ctx.fillStyle = outline;
  ctx.fillRect(-width * 0.18, -height * 0.32, width * 0.36, height * 0.64);
}

function drawPerson(ctx, sprite) {
  const { radius, color, outline } = sprite;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(0, 0, radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = outline;
  ctx.beginPath();
  ctx.arc(0, -radius * 0.4, radius * 0.45, 0, Math.PI * 2);
  ctx.fill();
}

function drawBullet(ctx, sprite) {
  const { radius, color } = sprite;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(0, 0, radius, 0, Math.PI * 2);
  ctx.fill();
}

function drawPickup(ctx, sprite) {
  const { radius, color, outline } = sprite;
  ctx.save();
  ctx.rotate(Math.PI / 4);
  ctx.fillStyle = color;
  ctx.strokeStyle = outline;
  ctx.lineWidth = 2;
  ctx.fillRect(-radius * 0.7, -radius * 0.7, radius * 1.4, radius * 1.4);
  ctx.strokeRect(-radius * 0.7, -radius * 0.7, radius * 1.4, radius * 1.4);
  ctx.restore();
}

function drawCircle(ctx, sprite) {
  const { radius, color, outline } = sprite;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(0, 0, radius, 0, Math.PI * 2);
  ctx.fill();
  if (outline) {
    ctx.strokeStyle = outline;
    ctx.lineWidth = 2;
    ctx.stroke();
  }
}

/**
 * Draw a single procedurally-generated entity sprite.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {{ x: number, y: number, kind?: string, radius?: number, alive?: boolean }} entity
 * @returns {boolean} `false` when the entity was skipped (dead or absent).
 */
export function drawEntity(ctx, entity) {
  if (!entity || entity.alive === false) return false;
  const sprite = spriteFor(entity);
  ctx.save();
  ctx.translate(entity.x, entity.y);
  switch (sprite.shape) {
    case 'vehicle':
      drawVehicle(ctx, sprite);
      break;
    case 'person':
      drawPerson(ctx, sprite);
      break;
    case 'bullet':
      drawBullet(ctx, sprite);
      break;
    case 'pickup':
      drawPickup(ctx, sprite);
      break;
    default:
      drawCircle(ctx, sprite);
  }
  ctx.restore();
  return true;
}

/**
 * Draw every live entity in a list. Assumes a world-space context.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {Array<object>} [entities]
 * @returns {number} How many entities were drawn.
 */
export function drawEntities(ctx, entities = []) {
  let drawn = 0;
  for (const entity of entities) {
    if (drawEntity(ctx, entity)) drawn += 1;
  }
  return drawn;
}

/**
 * Draw the player's procedural sprite, oriented along the aim angle. Assumes a
 * world-space context.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {{ x: number, y: number, aim?: number, radius?: number, alive?: boolean }} player
 * @param {object} [sprite=PLAYER_SPRITE]
 */
export function drawPlayer(ctx, player, sprite = PLAYER_SPRITE) {
  if (!player) return;
  const radius = Number.isFinite(player.radius) ? player.radius : 12;
  const alive = player.alive !== false;

  ctx.save();
  ctx.translate(player.x, player.y);

  ctx.fillStyle = sprite.shadow;
  ctx.beginPath();
  ctx.ellipse(0, radius * 0.55, radius * 0.95, radius * 0.5, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.rotate(player.aim ?? 0);

  ctx.fillStyle = sprite.weapon;
  ctx.fillRect(radius * 0.35, -3, radius + 10, 6);
  ctx.fillStyle = sprite.barrel;
  ctx.fillRect(radius + 6, -2, 8, 4);

  ctx.fillStyle = alive ? sprite.body : sprite.dead;
  ctx.strokeStyle = sprite.outline;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(0, 0, radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = sprite.head;
  ctx.beginPath();
  ctx.arc(radius * 0.25, 0, radius * 0.42, 0, Math.PI * 2);
  ctx.fill();

  ctx.restore();
}

/**
 * Render one frame of the world.
 *
 * The caller owns the device-pixel-ratio transform (see {@link clearCanvas});
 * this function only translates by the camera and restores afterwards.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} scene
 * @param {{ width: number, height: number, tiles: ArrayLike<number> }} scene.grid
 * @param {{ x: number, y: number, width: number, height: number }} scene.camera Interpolated camera.
 * @param {object|null} scene.player Interpolated player.
 * @param {Array<object>} [scene.entities] Interpolated entities.
 * @param {object} [options]
 * @param {number} [options.tileSize=TILE_SIZE]
 * @param {Record<number|string, string>} [options.palette=TILE_COLORS]
 * @returns {boolean} `false` when there was nothing to draw.
 */
export function renderWorld(ctx, { grid, camera, player, entities = [] } = {}, { tileSize = TILE_SIZE, palette = TILE_COLORS } = {}) {
  if (!ctx || !grid || !camera) return false;

  ctx.save();
  ctx.translate(-camera.x, -camera.y);
  drawMap(ctx, grid, camera, { tileSize, palette });
  drawEntities(ctx, entities);
  drawPlayer(ctx, player);
  ctx.restore();

  return true;
}
