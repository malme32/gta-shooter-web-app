/**
 * Browser bootstrap: wires the pure core to the canvas and owns the
 * `requestAnimationFrame` loop.
 *
 * The loop follows the classic fixed-timestep accumulator pattern: real
 * elapsed time is added to an accumulator and `advance()` runs a whole number
 * of ticks against it. `advance()` clamps both the frame delta and the number
 * of steps, so a backgrounded tab cannot make the simulation spiral.
 *
 * Because the simulation runs at 60 Hz but displays may refresh at 120/144 Hz,
 * the renderer draws an **interpolated** scene: the previous tick's snapshot is
 * blended with the current one using `alphaFor(game.accumulator)`. This keeps
 * motion smooth on high-refresh displays without changing gameplay.
 *
 * Rendering lives in `src/ui/render.js` and the HUD in `src/ui/hud.js`; input
 * handling in `src/ui/input.js`. The canvas backing store is scaled by the
 * device pixel ratio so it is crisp, while the camera works in logical pixels.
 *
 * The `document` guard keeps the module importable under Node for tests that
 * only exercise `src/core/`.
 */

import { createGame, setViewport } from './core/game.js';
import { createMap } from './core/map.js';
import { createInput } from './ui/input.js';
import {
  clearCanvas,
  renderWorld,
  sampleFrame,
  snapshotScene,
} from './ui/render.js';
import { renderHud, weaponLabel } from './ui/hud.js';

/**
 * Last CSS size seen from `getBoundingClientRect()`.
 *
 * The canvas backing store is DPR-scaled, so `canvas.width`/`canvas.height`
 * are physical pixels and must never be used as a CSS fallback: doing so would
 * compound the backing size every frame whenever the element is temporarily
 * detached (rect reports zero). Remembering the last good CSS size avoids that.
 */
let lastCssSize = { width: 0, height: 0 };

function cssSize(canvas) {
  const rect = typeof canvas.getBoundingClientRect === 'function' ? canvas.getBoundingClientRect() : null;
  if (rect && rect.width > 0 && rect.height > 0) {
    lastCssSize = { width: rect.width, height: rect.height };
  }
  return {
    width: lastCssSize.width > 0 ? lastCssSize.width : 960,
    height: lastCssSize.height > 0 ? lastCssSize.height : 540,
  };
}

/**
 * Resize the backing store to the CSS size at the current device pixel ratio.
 *
 * The CSS box is never touched (styles.css sizes the canvas), so this only
 * changes the number of physical pixels and the camera viewport.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} game
 * @returns {number} The device pixel ratio in use.
 */
function syncCanvasSize(canvas, ctx, game) {
  const { width, height } = cssSize(canvas);
  const dpr = Math.min(globalThis.devicePixelRatio || 1, 2);
  const backingWidth = Math.max(1, Math.round(width * dpr));
  const backingHeight = Math.max(1, Math.round(height * dpr));

  if (canvas.width !== backingWidth || canvas.height !== backingHeight) {
    canvas.width = backingWidth;
    canvas.height = backingHeight;
  }
  ctx.imageSmoothingEnabled = true;

  if (game.viewport?.width !== width || game.viewport?.height !== height) {
    setViewport(game, width, height);
  }
  return dpr;
}

function bootstrap() {
  const canvas = document.getElementById('game');
  if (!(canvas instanceof HTMLCanvasElement)) {
    return;
  }

  const ctx = canvas.getContext('2d');
  if (!ctx) {
    return;
  }

  const initial = cssSize(canvas);
  const map = createMap({ seed: 1337 });
  const game = createGame({
    map,
    spawn: map.spawns.playerStart,
    seed: 1337,
    viewport: initial,
  });

  const input = createInput({ intent: game.input, canvas, target: window });
  if (canvas.style) canvas.style.cursor = 'crosshair';

  const status = document.getElementById('status');
  if (status) {
    status.textContent =
      'City online — WASD/arrows move, Shift sprints, mouse aims, click fires, R reloads, 1/2/3 or wheel switch weapons, E enters/exits a vehicle, Space handbrakes while driving. Hostiles patrol the streets.';
  }

  let dpr = syncCanvasSize(canvas, ctx, game);
  let prevSnapshot = snapshotScene(game);

  let last = performance.now();
  let frameCount = 0;

  function frame(now) {
    const dt = (now - last) / 1000;
    last = now;
    frameCount += 1;

    dpr = syncCanvasSize(canvas, ctx, game);
    const sample = sampleFrame(game, dt, prevSnapshot);
    prevSnapshot = sample.prevSnapshot;

    const { width, height } = game.viewport;
    const scene = sample.scene;

    const driving = game.player.vehicleId !== null && game.player.vehicleId !== undefined;
    clearCanvas(ctx, { width, height, dpr });
    renderWorld(ctx, {
      grid: game.grid,
      camera: scene.camera,
      player: driving ? null : scene.player,
      entities: scene.entities,
    });
    renderHud(ctx, game, { width, height });

    if (status && frameCount % 30 === 0) {
      const p = game.player;
      status.textContent = `tick ${game.tick} · hp ${Math.round(p.health)} · ap ${Math.round(p.armour)} · wanted ${game.wanted} · ${weaponLabel(p.weapon)} ${p.ammo}/${p.reserve} · threats ${game.enemies.length} · $${game.cash}`;
    }

    requestAnimationFrame(frame);
  }

  // The frame loop already re-syncs every frame, but reacting to `resize`
  // applies the new camera viewport immediately instead of one frame later.
  const onResize = () => {
    dpr = syncCanvasSize(canvas, ctx, game);
  };
  window.addEventListener('resize', onResize);

  window.addEventListener('beforeunload', () => {
    input.dispose();
    window.removeEventListener('resize', onResize);
  });
  requestAnimationFrame(frame);
}

if (typeof document !== 'undefined') {
  bootstrap();
}
