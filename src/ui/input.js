/**
 * Browser input: turns keyboard and mouse events into a plain intent object.
 *
 * The intent is deliberately data-only so `src/core/` can consume it without
 * importing anything browser-specific:
 *
 * ```js
 * { up, down, left, right, sprint, fire, reload, pointerX, pointerY }
 * ```
 *
 * `pointerX`/`pointerY` are canvas-space pixels; the core converts them to a
 * world position with the camera when it computes the aim angle.
 *
 * The event wiring touches `window`/`document`, but every transformation is
 * exposed as a pure helper so it can be unit tested under Node.
 *
 * @module ui/input
 */

/** Keyboard code -> intent field. WASD and the arrow keys are aliases. */
export const KEY_ACTIONS = Object.freeze({
  ArrowUp: 'up',
  KeyW: 'up',
  ArrowDown: 'down',
  KeyS: 'down',
  ArrowLeft: 'left',
  KeyA: 'left',
  ArrowRight: 'right',
  KeyD: 'right',
  ShiftLeft: 'sprint',
  ShiftRight: 'sprint',
  Space: 'fire',
  KeyR: 'reload',
  Digit1: 'weapon1',
  Numpad1: 'weapon1',
  Digit2: 'weapon2',
  Numpad2: 'weapon2',
  Digit3: 'weapon3',
  Numpad3: 'weapon3',
  KeyE: 'enter',
  Enter: 'restart',
  NumpadEnter: 'restart',
});

/**
 * Keys that additionally set a derived intent field. `Space` is both the
 * trigger (on foot) and the handbrake (driving); the core decides which to use
 * from the current context.
 */
export const DERIVED_KEYS = Object.freeze({
  Space: 'handbrake',
});

/**
 * @typedef {object} InputIntent
 * @property {boolean} up
 * @property {boolean} down
 * @property {boolean} left
 * @property {boolean} right
 * @property {boolean} sprint
 * @property {boolean} fire
 * @property {boolean} reload
 * @property {boolean} weapon1 One-shot: equip weapon slot 1 (key `1`).
 * @property {boolean} weapon2
 * @property {boolean} weapon3
 * @property {number} cycleWeapon Accumulated wheel steps (negative = up).
 * @property {boolean} enter One-shot: enter/exit the nearest vehicle (key `E`).
 * @property {boolean} restart One-shot: restart the run after a terminal state (key `Enter`).
 * @property {boolean} handbrake Held while `Space` is down (handbrake while driving).
 * @property {number|null} pointerX Canvas-space pointer x, or `null` when unknown.
 * @property {number|null} pointerY Canvas-space pointer y, or `null` when unknown.
 */

/**
 * Create a fresh, idle intent.
 *
 * @returns {InputIntent}
 */
export function createIntent() {
  return {
    up: false,
    down: false,
    left: false,
    right: false,
    sprint: false,
    fire: false,
    reload: false,
    weapon1: false,
    weapon2: false,
    weapon3: false,
    cycleWeapon: 0,
    enter: false,
    restart: false,
    handbrake: false,
    pointerX: null,
    pointerY: null,
  };
}

/**
 * Reset every intent field to idle, in place, so existing references stay
 * valid (for example after the window loses focus).
 *
 * @param {InputIntent} intent
 * @returns {InputIntent}
 */
export function resetIntent(intent) {
  const next = createIntent();
  Object.assign(intent, next);
  return intent;
}

/**
 * Which intent field does a keyboard code drive? `null` when unmapped.
 *
 * @param {string} code
 * @returns {keyof InputIntent | null}
 */
export function actionForKey(code) {
  return KEY_ACTIONS[code] ?? null;
}

/**
 * Apply a key state to an intent, mutating it in place.
 *
 * @param {InputIntent} intent
 * @param {string} code
 * @param {boolean} pressed
 * @returns {boolean} `true` when the code was recognised (so callers know to
 *   prevent the browser default, e.g. for the arrow keys and space).
 */
export function applyKey(intent, code, pressed) {
  const action = actionForKey(code);
  if (!action) return false;
  intent[action] = Boolean(pressed);
  return true;
}

/**
 * Map client (page) coordinates to canvas coordinates, honouring a CSS-scaled
 * canvas. A canvas rendered at its intrinsic size is the identity transform.
 *
 * @param {number} clientX
 * @param {number} clientY
 * @param {{ left: number, top: number, width: number, height: number }} rect
 * @param {number} [canvasWidth=rect.width] Intrinsic canvas width.
 * @param {number} [canvasHeight=rect.height] Intrinsic canvas height.
 * @returns {{ x: number, y: number }}
 */
export function toCanvasPoint(clientX, clientY, rect, canvasWidth = rect.width, canvasHeight = rect.height) {
  const scaleX = rect.width ? canvasWidth / rect.width : 1;
  const scaleY = rect.height ? canvasHeight / rect.height : 1;
  return {
    x: (clientX - rect.left) * scaleX,
    y: (clientY - rect.top) * scaleY,
  };
}

function pointerRect(event, canvas) {
  if (canvas && typeof canvas.getBoundingClientRect === 'function') {
    return canvas.getBoundingClientRect();
  }
  const width = canvas && Number.isFinite(canvas.width) ? canvas.width : 0;
  const height = canvas && Number.isFinite(canvas.height) ? canvas.height : 0;
  return { left: 0, top: 0, width, height };
}

/**
 * Update an intent's pointer position from a mouse event.
 *
 * @param {InputIntent} intent
 * @param {{ clientX: number, clientY: number }} event
 * @param {object} [canvas]
 * @returns {InputIntent}
 */
export function applyPointer(intent, event, canvas) {
  const rect = pointerRect(event, canvas);
  const point = toCanvasPoint(event.clientX, event.clientY, rect, canvas?.width, canvas?.height);
  intent.pointerX = point.x;
  intent.pointerY = point.y;
  return intent;
}

function defaultTarget() {
  return typeof window !== 'undefined' ? window : null;
}

/**
 * Bind keyboard and mouse listeners to a target and keep an intent object up to
 * date.
 *
 * @param {object} [options]
 * @param {InputIntent} [options.intent] Intent to fill; one is created if omitted.
 * @param {EventTarget} [options.target=window] Event source.
 * @param {object} [options.canvas] Canvas used to convert pointer coordinates.
 * @returns {{ intent: InputIntent, dispose: () => void }}
 */
export function createInput({ intent = createIntent(), target = defaultTarget(), canvas = null } = {}) {
  if (!target || typeof target.addEventListener !== 'function') {
    return { intent, dispose() {} };
  }

  const onKeyDown = (event) => {
    if (applyKey(intent, event.code, true)) event.preventDefault?.();
    const derived = DERIVED_KEYS[event.code];
    if (derived) intent[derived] = true;
  };
  const onKeyUp = (event) => {
    if (applyKey(intent, event.code, false)) event.preventDefault?.();
    const derived = DERIVED_KEYS[event.code];
    if (derived) intent[derived] = false;
  };
  const onMouseMove = (event) => applyPointer(intent, event, canvas);
  const onMouseDown = (event) => {
    if (event.button === 0 || event.button === undefined) intent.fire = true;
  };
  const onMouseUp = (event) => {
    if (event.button === 0 || event.button === undefined) intent.fire = false;
  };
  const onWheel = (event) => {
    const step = Math.sign(event.deltaY ?? 0);
    if (step !== 0) intent.cycleWeapon += step;
  };
  const onContextMenu = (event) => event.preventDefault?.();
  const onBlur = () => resetIntent(intent);

  target.addEventListener('keydown', onKeyDown);
  target.addEventListener('keyup', onKeyUp);
  target.addEventListener('mousemove', onMouseMove);
  target.addEventListener('mousedown', onMouseDown);
  target.addEventListener('mouseup', onMouseUp);
  target.addEventListener('wheel', onWheel);
  target.addEventListener('contextmenu', onContextMenu);
  target.addEventListener('blur', onBlur);

  return {
    intent,
    dispose() {
      target.removeEventListener('keydown', onKeyDown);
      target.removeEventListener('keyup', onKeyUp);
      target.removeEventListener('mousemove', onMouseMove);
      target.removeEventListener('mousedown', onMouseDown);
      target.removeEventListener('mouseup', onMouseUp);
      target.removeEventListener('wheel', onWheel);
      target.removeEventListener('contextmenu', onContextMenu);
      target.removeEventListener('blur', onBlur);
    },
  };
}
