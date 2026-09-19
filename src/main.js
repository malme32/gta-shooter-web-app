/**
 * Entry point for the top-down shooter.
 *
 * T1 ships only the page shell: this module mounts the canvas and paints a
 * placeholder. The game loop, input and rendering land in later tasks.
 *
 * The `document` guard keeps the module importable under Node (for tests that
 * only exercise `src/core/` and `src/ui/`) without touching the DOM.
 */
function bootstrap() {
  const canvas = document.getElementById('game');
  if (!(canvas instanceof HTMLCanvasElement)) {
    return;
  }

  const ctx = canvas.getContext('2d');
  if (!ctx) {
    return;
  }

  ctx.fillStyle = '#05070b';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.fillStyle = '#7dd3fc';
  ctx.font = '20px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('Scaffold ready', canvas.width / 2, canvas.height / 2);
}

if (typeof document !== 'undefined') {
  bootstrap();
}
