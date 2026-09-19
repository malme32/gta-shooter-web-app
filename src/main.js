/**
 * Browser bootstrap: wires the pure core to the canvas and owns the
 * `requestAnimationFrame` loop.
 *
 * The loop follows the classic fixed-timestep accumulator pattern: real
 * elapsed time is added to an accumulator and `advance()` runs a whole number
 * of ticks against it. `advance()` clamps both the frame delta and the number
 * of steps, so a backgrounded tab cannot make the simulation spiral.
 *
 * Rendering, input handling and audio live in `src/ui/` in later tasks; this
 * file stays a thin composition layer.
 *
 * The `document` guard keeps the module importable under Node for tests that
 * only exercise `src/core/`.
 */

import { createGame, advance } from './core/game.js';
import { TILE_SIZE } from './core/constants.js';
import { createMap, ROAD, SIDEWALK, BUILDING, GRASS } from './core/map.js';

const TILE_COLORS = {
  [ROAD]: '#111827',
  [SIDEWALK]: '#334155',
  [BUILDING]: '#1e293b',
  [GRASS]: '#14532d',
};

function bindKeyboard(input) {
  const set = (event, pressed) => {
    switch (event.code) {
      case 'ArrowUp':
      case 'KeyW':
        input.up = pressed;
        break;
      case 'ArrowDown':
      case 'KeyS':
        input.down = pressed;
        break;
      case 'ArrowLeft':
      case 'KeyA':
        input.left = pressed;
        break;
      case 'ArrowRight':
      case 'KeyD':
        input.right = pressed;
        break;
      case 'ShiftLeft':
      case 'ShiftRight':
        input.sprint = pressed;
        break;
      default:
        return;
    }
    event.preventDefault();
  };

  window.addEventListener('keydown', (event) => set(event, true));
  window.addEventListener('keyup', (event) => set(event, false));
}

function render(ctx, canvas, game) {
  ctx.fillStyle = '#05070b';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const { grid } = game;
  for (let ty = 0; ty < grid.height; ty += 1) {
    for (let tx = 0; tx < grid.width; tx += 1) {
      ctx.fillStyle = TILE_COLORS[grid.tiles[ty * grid.width + tx]] ?? '#1e293b';
      ctx.fillRect(tx * TILE_SIZE, ty * TILE_SIZE, TILE_SIZE, TILE_SIZE);
    }
  }

  const p = game.player;
  ctx.fillStyle = '#7dd3fc';
  ctx.beginPath();
  ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
  ctx.fill();
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

  const map = createMap({ seed: 1337 });
  const game = createGame({ map, spawn: map.spawns.playerStart, seed: 1337 });
  bindKeyboard(game.input);

  const status = document.getElementById('status');
  if (status) {
    status.textContent = 'City online — move with WASD or the arrow keys.';
  }

  let last = performance.now();
  let frameCount = 0;

  function frame(now) {
    advance(game, (now - last) / 1000);
    last = now;
    frameCount += 1;

    render(ctx, canvas, game);

    if (status && frameCount % 30 === 0) {
      status.textContent = `tick ${game.tick} · frame ${frameCount}`;
    }

    requestAnimationFrame(frame);
  }

  requestAnimationFrame(frame);
}

if (typeof document !== 'undefined') {
  bootstrap();
}
