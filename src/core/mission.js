/**
 * Missions: a small, pure objective state machine.
 *
 * This module is pure: it never touches the DOM, `window` or `document`, so it
 * runs unchanged under Node and in the browser. A mission owns its *rules*
 * (what has to happen and what it pays); `core/game.js` stores the live mission
 * on the game state, feeds it world context each tick and cashes in the reward.
 *
 * ## Lifecycle
 *
 * Every mission starts {@link MISSION_STATUS}.INACTIVE, becomes ACTIVE when the
 * game activates it, and reaches COMPLETE exactly once (its reward is then
 * handed back to the caller). The transitions are deliberately idempotent:
 * completing an already-complete mission is a no-op, so a game tick cannot
 * award the same reward twice.
 *
 * ## Objectives
 *
 * - **eliminate** — destroy `targetCount` hostiles. The game reports each kill
 *   through {@link recordElimination}; by default police do not count, so a
 *   mission is not accidentally finished by the wanted system.
 * - **reach** — stand within `radius` of the marker at `(x, y)`.
 *
 * @module core/mission
 */

/** Mission lifecycle states. @type {Readonly<Record<string, string>>} */
export const MISSION_STATUS = Object.freeze({
  INACTIVE: 'inactive',
  ACTIVE: 'active',
  COMPLETE: 'complete',
});

/** Every objective type the game understands. @type {ReadonlyArray<string>} */
export const MISSION_OBJECTIVES = Object.freeze(['eliminate', 'reach']);

/** Cash paid for a mission when its spec omits a reward. */
export const MISSION_DEFAULT_REWARD = 250;

/** How close (pixels) the player must get to a `reach` marker. */
export const MISSION_REACH_RADIUS = 48;

/**
 * Is this a known objective type?
 *
 * @param {string} [objective]
 * @returns {boolean}
 */
export function isMissionObjective(objective) {
  return MISSION_OBJECTIVES.includes(objective);
}

/**
 * @typedef {'eliminate'|'reach'} MissionObjective
 *
 * @typedef {object} Mission
 * @property {number|string} id
 * @property {string} name
 * @property {MissionObjective} objective
 * @property {string} status One of {@link MISSION_STATUS}.
 * @property {number} reward Cash paid on completion.
 * @property {number} targetCount Eliminate: how many kills are required.
 * @property {string|null} targetType Eliminate: only kills of this archetype
 *   count (`null` = any non-police hostile).
 * @property {number} remaining Eliminate: kills still required.
 * @property {number} kills Eliminate: kills recorded so far.
 * @property {number} x Reach: marker world x, in pixels.
 * @property {number} y Reach: marker world y, in pixels.
 * @property {number} radius Reach: collection radius, in pixels.
 * @property {boolean} rewarded Whether the reward has been paid out.
 */

/**
 * Create a mission from a plain spec. Unknown objectives fall back to
 * `eliminate`; a `reach` mission's marker is normalised to finite numbers.
 *
 * @param {object} [spec]
 * @param {number|string} [spec.id='mission']
 * @param {string} [spec.name='']
 * @param {MissionObjective|string} [spec.objective='eliminate']
 * @param {number} [spec.reward=MISSION_DEFAULT_REWARD]
 * @param {number} [spec.targetCount=1] Eliminate kills required (minimum 1).
 * @param {string|null} [spec.targetType=null] Eliminate archetype filter.
 * @param {number} [spec.x=0] Reach marker x.
 * @param {number} [spec.y=0] Reach marker y.
 * @param {number} [spec.radius=MISSION_REACH_RADIUS] Reach collection radius.
 * @returns {Mission}
 */
export function createMission({
  id = 'mission',
  name = '',
  objective = 'eliminate',
  reward = MISSION_DEFAULT_REWARD,
  targetCount = 1,
  targetType = null,
  x = 0,
  y = 0,
  radius = MISSION_REACH_RADIUS,
} = {}) {
  const resolved = isMissionObjective(objective) ? objective : 'eliminate';
  const count = Number.isFinite(targetCount) && targetCount > 0 ? Math.floor(targetCount) : 1;
  return {
    id,
    name: typeof name === 'string' ? name : '',
    objective: resolved,
    status: MISSION_STATUS.INACTIVE,
    reward: Number.isFinite(reward) && reward > 0 ? reward : 0,
    targetCount: count,
    targetType: typeof targetType === 'string' && targetType.length > 0 ? targetType : null,
    remaining: count,
    kills: 0,
    x: Number.isFinite(x) ? x : 0,
    y: Number.isFinite(y) ? y : 0,
    radius: Number.isFinite(radius) && radius > 0 ? radius : MISSION_REACH_RADIUS,
    rewarded: false,
  };
}

/**
 * Is this mission currently being tracked?
 *
 * @param {Mission} mission
 * @returns {boolean}
 */
export function isMissionActive(mission) {
  return Boolean(mission) && mission.status === MISSION_STATUS.ACTIVE;
}

/**
 * Has this mission been completed?
 *
 * @param {Mission} mission
 * @returns {boolean}
 */
export function isMissionComplete(mission) {
  return Boolean(mission) && mission.status === MISSION_STATUS.COMPLETE;
}

/**
 * Activate a mission. Activating an already-active or complete mission is a
 * no-op, so a restart can safely re-activate the current mission.
 *
 * @param {Mission} mission
 * @returns {boolean} `true` when the mission was inactive and is now active.
 */
export function activateMission(mission) {
  if (!mission || mission.status !== MISSION_STATUS.INACTIVE) return false;
  mission.status = MISSION_STATUS.ACTIVE;
  return true;
}

/**
 * Record one hostile kill against an eliminate mission.
 *
 * Police kills never count unless the mission's `targetType` explicitly asks
 * for that archetype, and kills past the target are ignored. The returned
 * `remaining` is never negative.
 *
 * @param {Mission} mission
 * @param {object} [kill]
 * @param {string} [kill.type] Archetype id of the killed hostile.
 * @param {boolean} [kill.police=false] Whether the killed hostile was police.
 * @returns {number} Kills still required (unchanged when the kill was ignored).
 */
export function recordElimination(mission, { type, police = false } = {}) {
  if (!mission || !isMissionActive(mission) || mission.objective !== 'eliminate') {
    return mission ? mission.remaining : 0;
  }
  if (mission.targetType) {
    if (type !== mission.targetType) return mission.remaining;
  } else if (police) {
    return mission.remaining;
  }
  if (mission.remaining <= 0) return 0;

  mission.remaining -= 1;
  mission.kills += 1;
  return mission.remaining;
}

/**
 * Has the mission's objective been met?
 *
 * @param {Mission} mission
 * @param {{ x?: number, y?: number }} [context] World position to test for
 *   `reach` objectives (usually the player).
 * @returns {boolean}
 */
export function missionObjectiveMet(mission, context = {}) {
  if (!isMissionActive(mission)) return false;
  if (mission.objective === 'eliminate') return mission.remaining <= 0;

  const px = Number.isFinite(context?.x) ? context.x : null;
  const py = Number.isFinite(context?.y) ? context.y : null;
  if (px === null || py === null) return false;
  const dx = px - mission.x;
  const dy = py - mission.y;
  return dx * dx + dy * dy <= mission.radius * mission.radius;
}

/**
 * Complete a mission and return its reward exactly once.
 *
 * @param {Mission} mission
 * @returns {{ completed: boolean, reward: number }} `completed` is true only on
 *   the transition from active to complete.
 */
export function completeMission(mission) {
  if (!mission || mission.status !== MISSION_STATUS.ACTIVE) return { completed: false, reward: 0 };
  mission.status = MISSION_STATUS.COMPLETE;
  mission.rewarded = true;
  if (mission.remaining < 0) mission.remaining = 0;
  return { completed: true, reward: mission.reward };
}

/**
 * Advance a mission one step: complete it when its objective is met.
 *
 * @param {Mission} mission
 * @param {{ x?: number, y?: number }} [context]
 * @returns {{ status: string, completed: boolean, reward: number }}
 */
export function updateMission(mission, context = {}) {
  if (!mission) return { status: MISSION_STATUS.INACTIVE, completed: false, reward: 0 };
  if (!isMissionActive(mission)) return { status: mission.status, completed: false, reward: 0 };
  if (!missionObjectiveMet(mission, context)) {
    return { status: MISSION_STATUS.ACTIVE, completed: false, reward: 0 };
  }
  const result = completeMission(mission);
  return { status: MISSION_STATUS.COMPLETE, completed: result.completed, reward: result.reward };
}

/**
 * A pure snapshot of a mission's progress, for HUDs and events.
 *
 * @param {Mission} mission
 * @returns {{ id: (number|string), name: string, objective: string, status: string,
 *   reward: number, targetCount: number, remaining: number, kills: number,
 *   done: boolean, x: number, y: number, radius: number }}
 */
export function missionProgress(mission) {
  if (!mission) {
    return {
      id: null,
      name: '',
      objective: 'eliminate',
      status: MISSION_STATUS.INACTIVE,
      reward: 0,
      targetCount: 0,
      remaining: 0,
      kills: 0,
      done: false,
      x: 0,
      y: 0,
      radius: MISSION_REACH_RADIUS,
    };
  }
  return {
    id: mission.id,
    name: mission.name,
    objective: mission.objective,
    status: mission.status,
    reward: mission.reward,
    targetCount: mission.targetCount,
    remaining: mission.remaining,
    kills: mission.kills,
    done: mission.status === MISSION_STATUS.COMPLETE,
    x: mission.x,
    y: mission.y,
    radius: mission.radius,
  };
}

/**
 * A short, human-readable objective line for the HUD.
 *
 * @param {Mission} mission
 * @returns {string}
 */
export function missionLabel(mission) {
  if (!mission) return '';
  if (mission.objective === 'reach') return `Reach the marker (${Math.round(mission.x)}, ${Math.round(mission.y)})`;
  const done = mission.status === MISSION_STATUS.COMPLETE;
  return `Eliminate hostiles (${done ? mission.targetCount : mission.kills}/${mission.targetCount})`;
}
