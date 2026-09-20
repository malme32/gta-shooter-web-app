import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import {
  CUES,
  EVENT_CUES,
  GAME_EVENT_TYPES,
  SILENT_EVENTS,
  CUE_ATTACK_SECONDS,
  cueFor,
  isCue,
  playCueOn,
  createAudio,
} from '../src/ui/audio.js';

/**
 * A minimal stand-in for an `AudioContext` that records the oscillators it is
 * asked to schedule, so the engine can be exercised without any browser API.
 */
function fakeContext({ state = 'suspended' } = {}) {
  const started = [];
  const ramp = () => ({ setValueAtTime() {}, exponentialRampToValueAtTime() {} });
  return {
    state,
    currentTime: 0,
    destination: { name: 'destination' },
    resumeCalls: 0,
    started,
    resume() {
      this.resumeCalls += 1;
      this.state = 'running';
    },
    createOscillator() {
      const osc = {
        type: '',
        frequency: ramp(),
        connected: null,
        connect(node) {
          this.connected = node;
        },
        start() {
          started.push(this);
        },
        stop() {},
      };
      return osc;
    },
    createGain() {
      return { gain: ramp(), connect() {} };
    },
  };
}

test('cueFor maps gameplay events to their cue ids', () => {
  assert.equal(cueFor({ type: 'muzzle' }), 'shot');
  assert.equal(cueFor({ type: 'enemy_fire' }), 'enemyShot');
  assert.equal(cueFor({ type: 'bullet_wall' }), 'ricochet');
  assert.equal(cueFor({ type: 'hit' }), 'hit');
  assert.equal(cueFor({ type: 'enemy_death' }), 'death');
  assert.equal(cueFor({ type: 'loot_drop' }), 'loot');
  assert.equal(cueFor({ type: 'pickup' }), 'pickup');
  assert.equal(cueFor({ type: 'vehicle_explosion' }), 'explosion');
  assert.equal(cueFor({ type: 'vehicle_crash' }), 'crash');
  assert.equal(cueFor({ type: 'run_over' }), 'thud');
  assert.equal(cueFor({ type: 'mission_start' }), 'missionStart');
  assert.equal(cueFor({ type: 'mission_complete' }), 'missionComplete');
  assert.equal(cueFor({ type: 'player_death' }), null, 'the wasted cue is played once');
  assert.equal(cueFor({ type: 'wasted' }), 'wasted');
  assert.equal(cueFor({ type: 'busted' }), 'busted');
  assert.equal(cueFor({ type: 'police_spawn' }), 'police');
});

test('cueFor special-cases the siren toggle', () => {
  assert.equal(cueFor({ type: 'siren', active: true }), 'sirenOn');
  assert.equal(cueFor({ type: 'siren', active: false }), 'sirenOff');
  assert.equal(cueFor({ type: 'siren' }), 'sirenOn', 'defaults to the up cue');
  assert.equal(cueFor('siren'), 'sirenOn', 'bare strings are accepted');
});

test('cueFor is silent for visual-only and unknown events', () => {
  assert.equal(cueFor({ type: 'tracer' }), null);
  assert.equal(cueFor({ type: 'enemy_lost_player' }), null);
  assert.equal(cueFor({ type: 'not_a_real_event' }), null);
  assert.equal(cueFor(null), null);
  assert.equal(cueFor(undefined), null);
});

/**
 * Scan the core for its literal `emitEvent(state, 'type', ...)` call sites so
 * the cue vocabulary cannot silently drift from the events actually emitted.
 *
 * @returns {Set<string>}
 */
function emittedEventTypes() {
  const coreDir = fileURLToPath(new URL('../src/core/', import.meta.url));
  const types = new Set();
  for (const file of readdirSync(coreDir)) {
    if (!file.endsWith('.js')) continue;
    const source = readFileSync(join(coreDir, file), 'utf8');
    const pattern = /emitEvent\(\s*[A-Za-z_$][\w$]*\s*,\s*'([a-z_]+)'/g;
    let match = pattern.exec(source);
    while (match !== null) {
      types.add(match[1]);
      match = pattern.exec(source);
    }
  }
  return types;
}

test('GAME_EVENT_TYPES lists exactly the events the core emits', () => {
  const emitted = emittedEventTypes();
  assert.ok(emitted.size > 0, 'the emit-site scan found something');
  assert.deepEqual(
    [...GAME_EVENT_TYPES].sort(),
    [...emitted].sort(),
    'register every core event in GAME_EVENT_TYPES',
  );
});

test('every emitted game event maps to a cue or is documented silent', () => {
  for (const type of emittedEventTypes()) {
    const silent = SILENT_EVENTS.includes(type);
    const mapped = cueFor({ type, active: true }) !== null;
    assert.equal(mapped, !silent, `${type} should be ${silent ? 'silent' : 'mapped'}`);
  }
  for (const type of SILENT_EVENTS) {
    assert.ok(GAME_EVENT_TYPES.includes(type), `${type} is listed but not emitted`);
  }
});

test('every referenced cue exists and is well formed', () => {
  for (const id of Object.values(EVENT_CUES)) {
    if (id === null) continue;
    assert.ok(isCue(id), `EVENT_CUES references unknown cue ${id}`);
  }
  for (const [id, cue] of Object.entries(CUES)) {
    assert.ok(isCue(id));
    assert.ok(typeof cue.wave === 'string' && cue.wave.length > 0, `${id} wave`);
    assert.ok(Number.isFinite(cue.from) && cue.from > 0, `${id} from`);
    assert.ok(Number.isFinite(cue.to) && cue.to > 0, `${id} to`);
    assert.ok(Number.isFinite(cue.duration) && cue.duration > 0, `${id} duration`);
    assert.ok(Number.isFinite(cue.gain) && cue.gain > 0 && cue.gain <= 1, `${id} gain`);
  }
  assert.ok(isCue('uiStart') && isCue('uiPause') && isCue('uiResume') && isCue('uiUnmute'));
  assert.equal(isCue('nope'), false);
});

test('playCueOn schedules an oscillator with a shaped envelope', () => {
  const context = fakeContext();
  assert.equal(playCueOn(context, 'shot'), true);
  assert.equal(context.started.length, 1);
  assert.equal(context.started[0].connected.gain !== undefined, true);
  assert.equal(playCueOn(context, 'not_a_cue'), false);
  assert.equal(playCueOn(null, 'shot'), false);
});

test('the engine is inert without an AudioContext', () => {
  const audio = createAudio();
  assert.equal(audio.ready(), false);
  assert.equal(audio.unlock(), false);
  assert.equal(audio.play({ type: 'muzzle' }), null);
  assert.equal(audio.playCue('uiStart'), null);
});

test('unlock creates/resumes the context and play schedules cues', () => {
  const context = fakeContext();
  const audio = createAudio({ context });

  assert.equal(audio.ready(), true);
  assert.equal(audio.unlock(), true);
  assert.equal(context.resumeCalls, 1);
  assert.equal(context.state, 'running');

  assert.equal(audio.play({ type: 'muzzle' }), 'shot');
  assert.equal(audio.play({ type: 'tracer' }), null, 'silent events schedule nothing');
  assert.equal(audio.play({ type: 'nope' }), null);
  assert.equal(audio.playCue('uiStart'), 'uiStart');
  assert.equal(audio.playCue('not_a_cue'), null);
  assert.equal(context.started.length, 2);
});

test('mute silences the engine until it is toggled back', () => {
  const context = fakeContext();
  const audio = createAudio({ context, muted: false });

  assert.equal(audio.isMuted(), false);
  assert.equal(audio.setMuted(true), true);
  assert.equal(audio.isMuted(), true);
  assert.equal(audio.play({ type: 'muzzle' }), null);
  assert.equal(context.started.length, 0, 'muted cues schedule nothing');

  assert.equal(audio.toggleMute(), false, 'toggling unmutes');
  assert.equal(audio.play({ type: 'muzzle' }), 'shot');
  assert.equal(context.started.length, 1);

  const mutedEngine = createAudio({ context, muted: true });
  assert.equal(mutedEngine.isMuted(), true);
  assert.equal(mutedEngine.playCue('uiStart'), null);
});

test('an already-running context does not resume unnecessarily', () => {
  const context = fakeContext({ state: 'running' });
  const audio = createAudio({ context });
  assert.equal(audio.unlock(), true);
  assert.equal(context.resumeCalls, 0);
});

test('cue attack time is a small positive fade-in', () => {
  assert.ok(CUE_ATTACK_SECONDS > 0 && CUE_ATTACK_SECONDS < 0.05);
});

test('play and playCue stay bound when detached from the engine', () => {
  const context = fakeContext();
  const audio = createAudio({ context });
  const { play, playCue } = audio;

  assert.equal(playCue('uiStart'), 'uiStart');
  assert.equal(play({ type: 'muzzle' }), 'shot');
  assert.equal(context.started.length, 2);
});
