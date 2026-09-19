import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createIntent,
  resetIntent,
  actionForKey,
  applyKey,
  toCanvasPoint,
  applyPointer,
  createInput,
  KEY_ACTIONS,
} from '../src/ui/input.js';

class FakeTarget {
  constructor() {
    this.handlers = new Map();
  }

  addEventListener(type, handler) {
    const list = this.handlers.get(type) ?? [];
    list.push(handler);
    this.handlers.set(type, list);
  }

  removeEventListener(type, handler) {
    const list = this.handlers.get(type) ?? [];
    this.handlers.set(
      type,
      list.filter((entry) => entry !== handler),
    );
  }

  emit(type, event = {}) {
    const full = { preventDefault() {}, ...event };
    for (const handler of this.handlers.get(type) ?? []) handler(full);
  }

  count(type) {
    return (this.handlers.get(type) ?? []).length;
  }
}

test('createIntent starts idle with an unknown pointer', () => {
  const intent = createIntent();
  for (const key of ['up', 'down', 'left', 'right', 'sprint', 'fire', 'reload']) {
    assert.equal(intent[key], false);
  }
  assert.equal(intent.pointerX, null);
  assert.equal(intent.pointerY, null);
});

test('actionForKey maps WASD, the arrows and modifiers', () => {
  assert.equal(actionForKey('KeyW'), 'up');
  assert.equal(actionForKey('ArrowUp'), 'up');
  assert.equal(actionForKey('KeyA'), 'left');
  assert.equal(actionForKey('ArrowLeft'), 'left');
  assert.equal(actionForKey('KeyS'), 'down');
  assert.equal(actionForKey('ArrowDown'), 'down');
  assert.equal(actionForKey('KeyD'), 'right');
  assert.equal(actionForKey('ArrowRight'), 'right');
  assert.equal(actionForKey('ShiftLeft'), 'sprint');
  assert.equal(actionForKey('ShiftRight'), 'sprint');
  assert.equal(actionForKey('Space'), 'fire');
  assert.equal(actionForKey('KeyR'), 'reload');
  assert.equal(actionForKey('KeyZ'), null);
});

test('applyKey toggles the matching intent field and reports handling', () => {
  const intent = createIntent();
  assert.equal(applyKey(intent, 'KeyW', true), true);
  assert.equal(intent.up, true);
  assert.equal(applyKey(intent, 'KeyW', false), true);
  assert.equal(intent.up, false);
  assert.equal(applyKey(intent, 'KeyZ', true), false);
  assert.deepEqual(KEY_ACTIONS.ArrowUp, 'up');
});

test('resetIntent clears every field in place', () => {
  const intent = createIntent();
  intent.up = true;
  intent.fire = true;
  intent.pointerX = 5;
  const same = resetIntent(intent);
  assert.equal(same, intent);
  assert.deepEqual(intent, createIntent());
});

test('toCanvasPoint handles identity and CSS-scaled canvases', () => {
  const identity = toCanvasPoint(3, 4, { left: 0, top: 0, width: 960, height: 540 }, 960, 540);
  assert.deepEqual(identity, { x: 3, y: 4 });

  const scaled = toCanvasPoint(250, 155, { left: 10, top: 20, width: 480, height: 270 }, 960, 540);
  assert.deepEqual(scaled, { x: 480, y: 270 });
});

test('applyPointer writes canvas-space coordinates', () => {
  const intent = createIntent();
  const canvas = {
    width: 960,
    height: 540,
    getBoundingClientRect: () => ({ left: 10, top: 20, width: 480, height: 270 }),
  };
  applyPointer(intent, { clientX: 250, clientY: 155 }, canvas);
  assert.deepEqual({ x: intent.pointerX, y: intent.pointerY }, { x: 480, y: 270 });
});

test('createInput wires keys, mouse, blur and dispose', () => {
  const target = new FakeTarget();
  const canvas = {
    width: 960,
    height: 540,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 960, height: 540 }),
  };
  const { intent, dispose } = createInput({ target, canvas });

  let prevented = 0;
  target.emit('keydown', { code: 'KeyD', preventDefault: () => { prevented += 1; } });
  assert.equal(intent.right, true);
  assert.equal(prevented, 1);

  target.emit('keydown', { code: 'ArrowUp' });
  assert.equal(intent.up, true);

  target.emit('keyup', { code: 'KeyD' });
  assert.equal(intent.right, false);

  target.emit('mousemove', { clientX: 100, clientY: 50 });
  assert.deepEqual({ x: intent.pointerX, y: intent.pointerY }, { x: 100, y: 50 });

  target.emit('mousedown', { button: 0 });
  assert.equal(intent.fire, true);
  target.emit('mouseup', { button: 0 });
  assert.equal(intent.fire, false);

  target.emit('blur');
  assert.deepEqual(intent, createIntent());

  assert.ok(target.count('keydown') > 0);
  dispose();
  assert.equal(target.count('keydown'), 0);
  dispose();
});

test('createInput without a usable target is a harmless no-op', () => {
  const { intent, dispose } = createInput({ target: null });
  assert.equal(dispose(), undefined);
  assert.deepEqual(intent, createIntent());
});

test('createInput fills a caller-supplied intent object', () => {
  const target = new FakeTarget();
  const supplied = createIntent();
  const { intent } = createInput({ target, intent: supplied });
  assert.equal(intent, supplied);
  target.emit('keydown', { code: 'ShiftLeft' });
  assert.equal(supplied.sprint, true);
});
