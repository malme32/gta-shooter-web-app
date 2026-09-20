import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MISSION_STATUS,
  MISSION_OBJECTIVES,
  MISSION_DEFAULT_REWARD,
  MISSION_REACH_RADIUS,
  isMissionObjective,
  createMission,
  isMissionActive,
  isMissionComplete,
  activateMission,
  recordElimination,
  missionObjectiveMet,
  completeMission,
  updateMission,
  missionProgress,
  missionLabel,
} from '../src/core/mission.js';

test('the objective vocabulary is fixed', () => {
  assert.deepEqual(MISSION_OBJECTIVES, ['eliminate', 'reach']);
  assert.equal(isMissionObjective('eliminate'), true);
  assert.equal(isMissionObjective('reach'), true);
  assert.equal(isMissionObjective('escort'), false);
  assert.equal(isMissionObjective(undefined), false);
});

test('createMission applies defaults and normalises its spec', () => {
  const mission = createMission();
  assert.equal(mission.objective, 'eliminate');
  assert.equal(mission.status, MISSION_STATUS.INACTIVE);
  assert.equal(mission.targetCount, 1);
  assert.equal(mission.remaining, 1);
  assert.equal(mission.kills, 0);
  assert.equal(mission.reward, MISSION_DEFAULT_REWARD);
  assert.equal(mission.radius, MISSION_REACH_RADIUS);
  assert.equal(mission.targetType, null);
  assert.equal(mission.rewarded, false);
});

test('createMission clamps bad values and defaults unknown objectives', () => {
  const mission = createMission({
    objective: 'teleport',
    targetCount: -4,
    reward: -10,
    radius: 0,
    x: Number.NaN,
    y: 'nope',
    targetType: '',
  });
  assert.equal(mission.objective, 'eliminate');
  assert.equal(mission.targetCount, 1);
  assert.equal(mission.reward, 0);
  assert.equal(mission.radius, MISSION_REACH_RADIUS);
  assert.equal(mission.x, 0);
  assert.equal(mission.y, 0);
  assert.equal(mission.targetType, null);
});

test('createMission never floors a positive fractional targetCount to zero', () => {
  for (const targetCount of [0.5, 0.999, 0.1]) {
    const mission = createMission({ objective: 'eliminate', targetCount, reward: 500 });
    assert.equal(mission.targetCount, 1, `targetCount ${targetCount} clamps up to 1`);
    assert.equal(mission.remaining, 1, 'so the mission is not already satisfied');

    activateMission(mission);
    const result = updateMission(mission);
    assert.equal(result.completed, false, `targetCount ${targetCount} does not auto-complete`);
    assert.equal(result.reward, 0, 'and pays no reward with zero kills');
    assert.equal(mission.kills, 0);
  }
});

test('activateMission only moves an inactive mission forward', () => {
  const mission = createMission();
  assert.equal(activateMission(mission), true);
  assert.equal(isMissionActive(mission), true);
  assert.equal(activateMission(mission), false, 'a second activation is a no-op');
  assert.equal(mission.status, MISSION_STATUS.ACTIVE);
});

test('recordElimination counts kills down to zero and never past it', () => {
  const mission = createMission({ objective: 'eliminate', targetCount: 2 });
  activateMission(mission);

  assert.equal(recordElimination(mission, { type: 'thug' }), 1);
  assert.equal(recordElimination(mission, { type: 'shooter' }), 0);
  assert.equal(recordElimination(mission, { type: 'brute' }), 0, 'extra kills are ignored');
  assert.equal(mission.kills, 2);
});

test('recordElimination ignores police unless they are the target', () => {
  const anyHostile = createMission({ objective: 'eliminate', targetCount: 1 });
  activateMission(anyHostile);
  assert.equal(recordElimination(anyHostile, { type: 'cop', police: true }), 1, 'police do not count');
  assert.equal(anyHostile.kills, 0);
  assert.equal(recordElimination(anyHostile, { type: 'thug' }), 0);

  const policeTarget = createMission({ objective: 'eliminate', targetCount: 1, targetType: 'swat' });
  activateMission(policeTarget);
  assert.equal(recordElimination(policeTarget, { type: 'cop', police: true }), 1, 'a type filter wins');
  assert.equal(recordElimination(policeTarget, { type: 'swat', police: true }), 0);
});

test('recordElimination returns 0 for every non-applicable mission', () => {
  assert.equal(recordElimination(null, { type: 'thug' }), 0, 'no mission');

  const inactive = createMission({ targetCount: 1 });
  assert.equal(recordElimination(inactive, { type: 'thug' }), 0, 'inactive');

  const reach = createMission({ objective: 'reach' });
  activateMission(reach);
  assert.equal(recordElimination(reach, { type: 'thug' }), 0, 'wrong objective');

  const done = createMission({ targetCount: 1 });
  activateMission(done);
  recordElimination(done, { type: 'thug' });
  completeMission(done);
  assert.equal(recordElimination(done, { type: 'thug' }), 0, 'already complete');
});

test('missionObjectiveMet understands both objective types', () => {
  const eliminate = createMission({ objective: 'eliminate', targetCount: 1 });
  activateMission(eliminate);
  assert.equal(missionObjectiveMet(eliminate), false);
  recordElimination(eliminate, { type: 'thug' });
  assert.equal(missionObjectiveMet(eliminate), true);

  const reach = createMission({ objective: 'reach', x: 100, y: 100, radius: 40 });
  activateMission(reach);
  assert.equal(missionObjectiveMet(reach, { x: 100, y: 100 }), true, 'inside the radius');
  assert.equal(missionObjectiveMet(reach, { x: 139, y: 100 }), true, 'on the edge');
  assert.equal(missionObjectiveMet(reach, { x: 141, y: 100 }), false, 'outside the radius');
  assert.equal(missionObjectiveMet(reach, {}), false, 'needs a position');
  assert.equal(missionObjectiveMet(reach, { x: Number.NaN, y: 100 }), false);
});

test('a mission completes exactly once and pays its reward once', () => {
  const mission = createMission({ objective: 'eliminate', targetCount: 1, reward: 400 });
  activateMission(mission);
  recordElimination(mission, { type: 'thug' });

  const first = updateMission(mission);
  assert.deepEqual(first, { status: MISSION_STATUS.COMPLETE, completed: true, reward: 400 });
  assert.equal(isMissionComplete(mission), true);
  assert.equal(mission.rewarded, true);

  const second = updateMission(mission);
  assert.equal(second.completed, false);
  assert.equal(second.reward, 0, 'the reward is not paid twice');
});

test('completeMission only fires from the active state', () => {
  const mission = createMission({ reward: 100 });
  assert.deepEqual(completeMission(mission), { completed: false, reward: 0 }, 'inactive');
  activateMission(mission);
  assert.deepEqual(completeMission(mission), { completed: true, reward: 100 });
  assert.deepEqual(completeMission(mission), { completed: false, reward: 0 }, 'already complete');
});

test('updateMission reports the unchanged status when not yet met', () => {
  const reach = createMission({ objective: 'reach', x: 10, y: 10 });
  activateMission(reach);
  const result = updateMission(reach, { x: 999, y: 999 });
  assert.equal(result.status, MISSION_STATUS.ACTIVE);
  assert.equal(result.completed, false);
  assert.equal(result.reward, 0);
});

test('missionProgress exposes a flat, HUD-friendly snapshot', () => {
  const mission = createMission({ id: 'm1', objective: 'eliminate', targetCount: 3, reward: 250 });
  activateMission(mission);
  recordElimination(mission, { type: 'thug' });

  assert.deepEqual(missionProgress(mission), {
    id: 'm1',
    name: '',
    objective: 'eliminate',
    status: MISSION_STATUS.ACTIVE,
    reward: 250,
    targetCount: 3,
    remaining: 2,
    kills: 1,
    done: false,
    rewarded: false,
    x: 0,
    y: 0,
    radius: MISSION_REACH_RADIUS,
  });

  const empty = missionProgress(null);
  assert.equal(empty.id, null);
  assert.equal(empty.done, false);
  assert.equal(empty.rewarded, false);
});

test('a completed reach mission reports nothing remaining and a paid reward', () => {
  const mission = createMission({ objective: 'reach', x: 10, y: 10, reward: 120 });
  activateMission(mission);
  completeMission(mission);

  const snapshot = missionProgress(mission);
  assert.equal(snapshot.done, true);
  assert.equal(snapshot.remaining, 0, 'no stale eliminate-only remaining');
  assert.equal(snapshot.kills, 0);
  assert.equal(snapshot.rewarded, true, 'the paid flag is surfaced');
});

test('missionLabel describes eliminate and reach objectives', () => {
  const eliminate = createMission({ objective: 'eliminate', targetCount: 3 });
  activateMission(eliminate);
  assert.equal(missionLabel(eliminate), 'Eliminate hostiles (0/3)');
  recordElimination(eliminate, { type: 'thug' });
  assert.equal(missionLabel(eliminate), 'Eliminate hostiles (1/3)');

  const reach = createMission({ objective: 'reach', x: 120.4, y: 340.6 });
  assert.equal(missionLabel(reach), 'Reach the marker (120, 341)');
  assert.equal(missionLabel(null), '');
});
