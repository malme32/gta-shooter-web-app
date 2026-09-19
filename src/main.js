/**
 * Browser bootstrap: wires the pure core to the canvas and owns the
 * `requestAnimationFrame` loop.
 *
 * The loop follows the classic fixed-timestep accumulator pattern: real
 * elapsed time is added to an accumulator and `advance()` runs a whole number
 * of ticks against it. `advance()` clamps both the frame delta and the number
 * of steps, so a backgrounded tab cannot make the simulation spiral.
 *
 * Keyboard and mouse handling live in `src/ui/input.js`; they only ever mutate
 * the plain intent object owned by the game state, which keeps the core pure.
 *
 * The `document` guard keeps the module importable under Node for tests that
 * only exercise `src/core/`.
 */

import { createGame, advance } from './core/game.js';
import { TILE_SIZE } from './core/constants.js';
import { createMap, ROAD, SIDEWALK, BUILDING, GRASS } from './core/map.js';
import { createInput } from './ui/input.js';

const TILE_COLORS = {
  [ROAD]: '#111827',
  [SIDEWALK]: '#334155',
  [BUILDING]: '#1e293b',
  [GRASS]: '#14532d',
};

function render(ctx, canvas, game) {
  const { camera, grid } = game;

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#05070b';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.save();
  ctx.translate(-camera.x, -camera.y);

  const minTx = Math.max(0, Math.floor(camera.x / TILE_SIZE));
  const maxTx = Math.min(grid.width - 1, Math.ceil((camera.x + camera.width) / TILE_SIZE));
  const minTy = Math.max(0, Math.floor(camera.y / TILE_SIZE));
  const maxTy = Math.min(grid.height - 1, Math.ceil((camera.y + camera.height) / TILE_SIZE));

  for (let ty = minTy; ty <= maxTy; ty += 1) {
    for (let tx = minTx; tx <= maxTx; tx += 1) {
      ctx.fillStyle = TILE_COLORS[grid.tiles[ty * grid.width + tx]] ?? '#1e293b';
      ctx.fillRect(tx * TILE_SIZE, ty * TILE_SIZE, TILE_SIZE, TILE_SIZE);
    }
  }

  renderPlayer(ctx, game.player);
  ctx.restore();

  renderHud(ctx, game);
}

function renderPlayer(ctx, player) {
  ctx.save();
  ctx.translate(player.x, player.y);
  ctx.rotate(player.aim);

  ctx.strokeStyle = '#e0f2fe';
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(player.radius * 0.4, 0);
  ctx.lineTo(player.radius + 10, 0);
  ctx.stroke();

  ctx.fillStyle = player.alive ? '#7dd3fc' : '#64748b';
  ctx.beginPath();
  ctx.arc(0, 0, player.radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function bar(ctx, x, y, width, height, ratio, color, label) {
  ctx.fillStyle = 'rgba(2, 6, 23, 0.7)';
  ctx.fillRect(x - 1, y - 1, width + 2, height + 2);
  ctx.fillStyle = color;
  ctx.fillRect(x, y, width * Math.max(0, Math.min(1, ratio)), height);
  if (label) {
    ctx.fillStyle = '#e2e8f0';
    ctx.font = '12px system-ui, sans-serif';
    ctx.fillText(label, x + width + 8, y + height - 1);
  }
}

function renderHud(ctx, game) {
  const p = game.player;
  bar(ctx, 12, 12, 160, 12, p.health / p.maxHealth, '#22c55e', `HP ${Math.round(p.health)}`);
  bar(ctx, 12, 30, 160, 12, p.armour / p.maxArmour, '#38bdf8', `AP ${Math.round(p.armour)}`);
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
  const game = createGame({
    map,
    spawn: map.spawns.playerStart,
    seed: 1337,
    viewport: { width: canvas.width, height: canvas.height },
  });

  const input = createInput({ intent: game.input, canvas, target: window });
  if (canvas.style) canvas.style.cursor = 'crosshair';

  const status = document.getElementById('status');
  if (status) {
    status.textContent = 'City online — WASD/arrows move, Shift sprints, mouse aims.';
  }

  let last = performance.now();
  let frameCount = 0;

  function frame(now) {
    advance(game, (now - last) / 1000);
    last = now;
    frameCount += 1;

    render(ctx, canvas, game);

    if (status && frameCount % 30 === 0) {
      const p = game.player;
      status.textContent = `tick ${game.tick} · hp ${Math.round(p.health)} · ap ${Math.round(p.armour)}`;
    }

    requestAnimationFrame(frame);
  }

  window.addEventListener('beforeunload', () => input.dispose());
  requestAnimationFrame(frame);
}

if (typeof document !== 'undefined') {
  bootstrap();
}
