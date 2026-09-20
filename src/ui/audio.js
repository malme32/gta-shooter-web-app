/**
 * Procedural Web Audio for the top-down shooter.
 *
 * There are **no shipped audio files**: every cue is synthesised on the fly
 * from an oscillator + gain envelope described by the data tables below. The
 * mapping from a game event to a cue is a pure function, {@link cueFor}, so the
 * whole vocabulary can be unit tested under Node without an `AudioContext`.
 *
 * The engine is deliberately lazy: browsers refuse to start audio until the
 * user has interacted with the page, so {@link createAudio} builds the
 * `AudioContext` only when {@link createAudio.unlock} is called from a real
 * gesture (pointer or key). Until then — and whenever the context is
 * unavailable, as under Node — {@link createAudio.play} is a harmless no-op.
 *
 * @module ui/audio
 */

/**
 * Every event type the core emits, so the mapping can be checked exhaustively.
 *
 * `test/audio.test.js` verifies this list against the literal type strings at
 * the core's `emitEvent(...)` call sites, so an event added to the core fails
 * until it is registered here (and given a cue or declared silent).
 *
 * @type {ReadonlyArray<string>}
 */
export const GAME_EVENT_TYPES = Object.freeze([
  'mission_start',
  'tracer',
  'muzzle',
  'hit',
  'bullet_wall',
  'enemy_alert',
  'enemy_lost_player',
  'enemy_fire',
  'enemy_death',
  'loot_drop',
  'pickup',
  'player_death',
  'wasted',
  'mission_complete',
  'police_despawn',
  'police_spawn',
  'siren',
  'busted',
  'vehicle_enter_failed',
  'vehicle_enter',
  'vehicle_exit_blocked',
  'vehicle_exit',
  'vehicle_explosion',
  'run_over',
  'vehicle_crash',
]);

/**
 * Cue synthesis descriptors. `from`/`to` are oscillator frequencies in Hz
 * (`to` defaults to `from`, i.e. a steady tone), `duration` is seconds and
 * `gain` the peak amplitude. Nothing here loads a file; the engine turns each
 * descriptor into an `OscillatorNode` and a `GainNode`.
 *
 * @type {Readonly<Record<string, { wave: string, from: number, to: number, duration: number, gain: number }>>}
 */
export const CUES = Object.freeze({
  shot: Object.freeze({ wave: 'square', from: 760, to: 180, duration: 0.09, gain: 0.16 }),
  enemyShot: Object.freeze({ wave: 'sawtooth', from: 480, to: 150, duration: 0.08, gain: 0.1 }),
  ricochet: Object.freeze({ wave: 'square', from: 1800, to: 600, duration: 0.05, gain: 0.08 }),
  hit: Object.freeze({ wave: 'sawtooth', from: 900, to: 260, duration: 0.06, gain: 0.12 }),
  thud: Object.freeze({ wave: 'sine', from: 220, to: 70, duration: 0.14, gain: 0.2 }),
  explosion: Object.freeze({ wave: 'sawtooth', from: 160, to: 40, duration: 0.5, gain: 0.28 }),
  crash: Object.freeze({ wave: 'square', from: 320, to: 90, duration: 0.18, gain: 0.18 }),
  death: Object.freeze({ wave: 'triangle', from: 340, to: 80, duration: 0.28, gain: 0.16 }),
  pickup: Object.freeze({ wave: 'sine', from: 660, to: 1320, duration: 0.14, gain: 0.16 }),
  loot: Object.freeze({ wave: 'sine', from: 440, to: 880, duration: 0.1, gain: 0.1 }),
  missionStart: Object.freeze({ wave: 'triangle', from: 523, to: 784, duration: 0.25, gain: 0.14 }),
  missionComplete: Object.freeze({ wave: 'sine', from: 659, to: 1319, duration: 0.45, gain: 0.18 }),
  alert: Object.freeze({ wave: 'square', from: 880, to: 760, duration: 0.08, gain: 0.08 }),
  police: Object.freeze({ wave: 'sawtooth', from: 392, to: 660, duration: 0.3, gain: 0.12 }),
  sirenOn: Object.freeze({ wave: 'sine', from: 700, to: 1050, duration: 0.4, gain: 0.14 }),
  sirenOff: Object.freeze({ wave: 'sine', from: 700, to: 380, duration: 0.3, gain: 0.12 }),
  carEnter: Object.freeze({ wave: 'triangle', from: 220, to: 440, duration: 0.16, gain: 0.12 }),
  carExit: Object.freeze({ wave: 'triangle', from: 440, to: 220, duration: 0.16, gain: 0.12 }),
  denied: Object.freeze({ wave: 'square', from: 220, to: 140, duration: 0.12, gain: 0.1 }),
  wasted: Object.freeze({ wave: 'sawtooth', from: 320, to: 60, duration: 0.9, gain: 0.22 }),
  busted: Object.freeze({ wave: 'square', from: 660, to: 180, duration: 0.6, gain: 0.2 }),
  uiStart: Object.freeze({ wave: 'sine', from: 523, to: 1046, duration: 0.2, gain: 0.15 }),
  uiPause: Object.freeze({ wave: 'sine', from: 440, to: 330, duration: 0.12, gain: 0.12 }),
  uiResume: Object.freeze({ wave: 'sine', from: 440, to: 660, duration: 0.12, gain: 0.12 }),
  // Only audible on unmute: muting by definition plays nothing.
  uiUnmute: Object.freeze({ wave: 'sine', from: 330, to: 440, duration: 0.1, gain: 0.12 }),
});

/**
 * Event type -> cue id. A `null` entry means the event is intentionally silent.
 *
 * @type {Readonly<Record<string, string|null>>}
 */
export const EVENT_CUES = Object.freeze({
  mission_start: 'missionStart',
  tracer: null,
  muzzle: 'shot',
  hit: 'hit',
  bullet_wall: 'ricochet',
  enemy_alert: 'alert',
  enemy_lost_player: null,
  enemy_fire: 'enemyShot',
  enemy_death: 'death',
  loot_drop: 'loot',
  pickup: 'pickup',
  // `player_death` and `wasted` fire on the same tick and share the `wasted`
  // cue; keeping one silent avoids scheduling two identical oscillators.
  player_death: null,
  wasted: 'wasted',
  mission_complete: 'missionComplete',
  police_despawn: 'sirenOff',
  police_spawn: 'police',
  siren: 'sirenOn',
  busted: 'busted',
  vehicle_enter_failed: 'denied',
  vehicle_enter: 'carEnter',
  vehicle_exit_blocked: 'denied',
  vehicle_exit: 'carExit',
  vehicle_explosion: 'explosion',
  run_over: 'thud',
  vehicle_crash: 'crash',
});

/** Events that deliberately make no sound. */
export const SILENT_EVENTS = Object.freeze(['tracer', 'enemy_lost_player', 'player_death']);

/**
 * Map a game event to the cue it should play.
 *
 * Pure: accepts either an event object (`{ type, ... }`) or a bare event-type
 * string, so it is trivial to unit test and to reuse outside the engine. The
 * `siren` event is special-cased on its `active` flag, so the same event toggles
 * the up and down cue.
 *
 * @param {{ type?: string, active?: boolean }|string|null|undefined} event
 * @returns {string|null} A {@link CUES} id, or `null` when the event is silent
 *   or unknown.
 */
export function cueFor(event) {
  const type = typeof event === 'string' ? event : event?.type;
  if (type === 'siren') return event?.active === false ? 'sirenOff' : 'sirenOn';
  return EVENT_CUES[type] ?? null;
}

/**
 * Is `id` a known cue?
 *
 * @param {string} id
 * @returns {boolean}
 */
export function isCue(id) {
  return typeof id === 'string' && Object.prototype.hasOwnProperty.call(CUES, id);
}

/** Default attack (fade-in) time for a cue, in seconds. */
export const CUE_ATTACK_SECONDS = 0.005;

/**
 * Schedule one cue on an `AudioContext`. Exposed so tests can drive it with a
 * fake context; the real engine calls it through {@link createAudio.playCue}.
 *
 * @param {AudioContext} context
 * @param {string} id A {@link CUES} id.
 * @returns {boolean} `true` when the cue was scheduled.
 */
export function playCueOn(context, id) {
  const cue = CUES[id];
  if (!context || !cue) return false;

  const now = typeof context.currentTime === 'number' ? context.currentTime : 0;
  const oscillator = context.createOscillator();
  const amp = context.createGain();

  oscillator.type = cue.wave;
  oscillator.frequency.setValueAtTime(cue.from, now);
  if (cue.to !== cue.from) {
    oscillator.frequency.exponentialRampToValueAtTime(Math.max(1, cue.to), now + cue.duration);
  }

  amp.gain.setValueAtTime(0.0001, now);
  amp.gain.exponentialRampToValueAtTime(Math.max(0.0001, cue.gain), now + CUE_ATTACK_SECONDS);
  amp.gain.exponentialRampToValueAtTime(0.0001, now + cue.duration);

  oscillator.connect(amp);
  amp.connect(context.destination);
  oscillator.start(now);
  oscillator.stop(now + cue.duration + 0.02);
  return true;
}

/**
 * Pick the browser's audio constructor, if present. Kept separate so the module
 * imports cleanly under Node.
 *
 * @returns {Function|null}
 */
function audioContextConstructor() {
  const scope = globalThis;
  return scope.AudioContext ?? scope.webkitAudioContext ?? null;
}

/**
 * Create the game's audio engine.
 *
 * The returned object is inert until {@link createAudio.unlock} succeeds, which
 * mirrors the browser autoplay policy: the caller should invoke it from the
 * first real user gesture. `play`/`playCue` return the cue id they scheduled, or
 * `null` when muted or not ready, which also makes them easy to assert on.
 *
 * @param {object} [options]
 * @param {AudioContext} [options.context] Explicit context (tests inject a fake).
 * @param {boolean} [options.muted=false] Start muted.
 * @returns {{
 *   unlock: () => boolean,
 *   play: (event: object|string) => string|null,
 *   playCue: (id: string) => string|null,
 *   setMuted: (value: boolean) => boolean,
 *   toggleMute: () => boolean,
 *   isMuted: () => boolean,
 *   ready: () => boolean,
 * }}
 */
export function createAudio({ context = null, muted = false } = {}) {
  let ctx = context;
  let isMutedFlag = Boolean(muted);

  function ensureContext() {
    if (ctx) return ctx;
    const AudioContextClass = audioContextConstructor();
    if (!AudioContextClass) return null;
    try {
      ctx = new AudioContextClass();
    } catch {
      ctx = null;
    }
    return ctx;
  }

  /**
   * Play a cue id directly (used for UI sounds). A closure rather than a method
   * so it can be passed around as a callback without losing its receiver.
   *
   * @param {string|null} id
   * @returns {string|null}
   */
  function playCue(id) {
    if (isMutedFlag || !isCue(id)) return null;
    const context2 = ensureContext();
    if (!context2) return null;
    return playCueOn(context2, id) ? id : null;
  }

  /**
   * Play the cue for a game event.
   *
   * @param {object|string} event
   * @returns {string|null}
   */
  function play(event) {
    return playCue(cueFor(event));
  }

  return {
    /**
     * Create/resume the audio context from a user gesture.
     * @returns {boolean} `true` when audio is ready to play.
     */
    unlock() {
      const context2 = ensureContext();
      if (!context2) return false;
      if (typeof context2.resume === 'function' && context2.state === 'suspended') {
        try {
          context2.resume();
        } catch {
          // A failed resume simply leaves the context suspended; harmless.
        }
      }
      return true;
    },

    play,
    playCue,

    /**
     * Mute or unmute every future cue.
     * @param {boolean} value
     * @returns {boolean} The new muted state.
     */
    setMuted(value) {
      isMutedFlag = Boolean(value);
      return isMutedFlag;
    },

    /**
     * Flip the mute state.
     * @returns {boolean} The new muted state.
     */
    toggleMute() {
      isMutedFlag = !isMutedFlag;
      return isMutedFlag;
    },

    /** @returns {boolean} */
    isMuted() {
      return isMutedFlag;
    },

    /** @returns {boolean} Whether a context is available. */
    ready() {
      return Boolean(ctx);
    },
  };
}
