import test from 'node:test';
import assert from 'node:assert/strict';

import {
  vec,
  clone,
  add,
  sub,
  scale,
  dot,
  lenSq,
  len,
  normalize,
  distanceSq,
  distance,
  lerp,
  rotate,
  fromAngle,
  angle,
  clamp,
  aabb,
  aabbFromCenter,
  aabbCenter,
  aabbContainsPoint,
  aabbContainsAabb,
  aabbOverlap,
  aabbExpand,
  aabbClosestPoint,
  circle,
  circleContainsPoint,
  circlesOverlap,
  circleAabbOverlap,
  segment,
  segmentClosestPoint,
  pointSegmentDistanceSq,
  pointSegmentDistance,
  segmentsIntersect,
  rayAabbIntersection,
  segmentAabbIntersection,
  segmentAabbIntersect,
  rayCircleIntersection,
  segmentCircleOverlap,
} from '../src/core/geometry.js';

const close = (a, b, eps = 1e-9) =>
  assert.ok(Math.abs(a - b) <= eps, `expected ${a} ≈ ${b}`);

test('vector constructors and basic arithmetic', () => {
  assert.deepEqual(vec(2, 3), { x: 2, y: 3 });
  assert.deepEqual(vec(), { x: 0, y: 0 });
  const v = vec(1, 2);
  assert.deepEqual(clone(v), v);
  assert.notEqual(clone(v), v);
  assert.deepEqual(add(vec(1, 2), vec(3, 4)), { x: 4, y: 6 });
  assert.deepEqual(sub(vec(1, 2), vec(3, 4)), { x: -2, y: -2 });
  assert.deepEqual(scale(vec(1, 2), 3), { x: 3, y: 6 });
  assert.equal(dot(vec(1, 2), vec(3, 4)), 11);
  assert.equal(lenSq(vec(3, 4)), 25);
  assert.equal(len(vec(3, 4)), 5);
});

test('normalize handles regular and zero vectors', () => {
  const n = normalize(vec(3, 4));
  close(n.x, 0.6);
  close(n.y, 0.8);
  assert.deepEqual(normalize(vec(0, 0)), { x: 0, y: 0 });
});

test('distance and lerp', () => {
  assert.equal(distanceSq(vec(0, 0), vec(3, 4)), 25);
  assert.equal(distance(vec(0, 0), vec(3, 4)), 5);
  assert.deepEqual(lerp(vec(0, 0), vec(10, 20), 0.5), { x: 5, y: 10 });
  assert.deepEqual(lerp(vec(0, 0), vec(10, 20), 2), { x: 20, y: 40 });
});

test('rotate and angle round-trip', () => {
  const rotated = rotate(vec(1, 0), Math.PI / 2);
  close(rotated.x, 0);
  close(rotated.y, 1);
  close(angle(fromAngle(0.75, 2)), 0.75);
  const v = fromAngle(0, 5);
  close(v.x, 5);
  close(v.y, 0);
});

test('clamp limits to the range', () => {
  assert.equal(clamp(5, 0, 10), 5);
  assert.equal(clamp(-1, 0, 10), 0);
  assert.equal(clamp(11, 0, 10), 10);
});

test('AABB overlap, containment and helpers', () => {
  const a = aabb(0, 0, 10, 10);
  const b = aabb(5, 5, 10, 10);
  const far = aabb(20, 20, 2, 2);
  assert.ok(aabbOverlap(a, b));
  assert.ok(!aabbOverlap(a, far));
  assert.ok(aabbContainsPoint(a, vec(0, 0)));
  assert.ok(aabbContainsPoint(a, vec(10, 10)));
  assert.ok(!aabbContainsPoint(a, vec(10.1, 5)));
  assert.ok(aabbContainsAabb(aabb(0, 0, 10, 10), aabb(2, 2, 3, 3)));
  assert.ok(!aabbContainsAabb(a, b));

  const centered = aabbFromCenter(5, 5, 10, 10);
  assert.deepEqual(centered, { x: 0, y: 0, w: 10, h: 10 });
  assert.deepEqual(aabbCenter(centered), { x: 5, y: 5 });
  assert.deepEqual(aabbExpand(aabb(5, 5, 2, 2), 1), { x: 4, y: 4, w: 4, h: 4 });
});

test('aabbClosestPoint clamps inside the box', () => {
  const box = aabb(0, 0, 10, 10);
  assert.deepEqual(aabbClosestPoint(box, vec(-5, 5)), { x: 0, y: 5 });
  assert.deepEqual(aabbClosestPoint(box, vec(15, 15)), { x: 10, y: 10 });
  assert.deepEqual(aabbClosestPoint(box, vec(3, 4)), { x: 3, y: 4 });
});

test('circle overlap and point containment', () => {
  const a = circle(0, 0, 5);
  const b = circle(8, 0, 5);
  const far = circle(100, 0, 1);
  assert.ok(circlesOverlap(a, b));
  assert.ok(!circlesOverlap(a, far));
  assert.ok(circleContainsPoint(a, vec(3, 4)));
  assert.ok(!circleContainsPoint(a, vec(6, 0)));
});

test('circle vs AABB overlap', () => {
  const box = aabb(10, 0, 10, 10);
  assert.ok(circleAabbOverlap(circle(8, 5, 3), box));
  assert.ok(!circleAabbOverlap(circle(0, 5, 3), box));
  assert.ok(circleAabbOverlap(circle(5, 5, 6), box));
});

test('segment closest point and distance', () => {
  const seg = segment(0, 0, 10, 0);
  assert.deepEqual(segmentClosestPoint(seg, vec(5, 5)), { x: 5, y: 0 });
  assert.deepEqual(segmentClosestPoint(seg, vec(-5, 0)), { x: 0, y: 0 });
  assert.deepEqual(segmentClosestPoint(seg, vec(15, 0)), { x: 10, y: 0 });
  assert.equal(pointSegmentDistanceSq(seg, vec(5, 3)), 9);
  assert.equal(pointSegmentDistance(seg, vec(5, 4)), 4);

  const point = segment(3, 3, 3, 3);
  assert.deepEqual(segmentClosestPoint(point, vec(0, 0)), { x: 3, y: 3 });
});

test('segmentsIntersect handles crossing, parallel and collinear cases', () => {
  assert.ok(segmentsIntersect(segment(0, 0, 10, 10), segment(0, 10, 10, 0)));
  assert.ok(!segmentsIntersect(segment(0, 0, 10, 0), segment(0, 5, 10, 5)));
  assert.ok(segmentsIntersect(segment(0, 0, 10, 0), segment(5, 0, 15, 0)));
  assert.ok(!segmentsIntersect(segment(0, 0, 10, 0), segment(20, 0, 30, 0)));
  assert.ok(segmentsIntersect(segment(0, 0, 10, 0), segment(10, 0, 20, 0)));
});

test('rayAabbIntersection returns entry distance and handles edge cases', () => {
  const box = aabb(5, -1, 2, 2);
  assert.equal(rayAabbIntersection(vec(0, 0), vec(1, 0), box), 5);
  assert.equal(rayAabbIntersection(vec(0, 10), vec(1, 0), box), null);
  assert.equal(rayAabbIntersection(vec(6, 0), vec(1, 0), box), 0);
  assert.equal(rayAabbIntersection(vec(10, 0), vec(1, 0), box), null);
  assert.equal(rayAabbIntersection(vec(0, 0), vec(0, 1), aabb(-1, 5, 2, 2)), 5);
});

test('segmentAabbIntersection returns t in [0, 1]', () => {
  const box = aabb(4, -1, 2, 2);
  const hit = segmentAabbIntersection(segment(0, 0, 10, 0), box);
  close(hit, 0.4);
  assert.equal(segmentAabbIntersection(segment(0, 5, 10, 5), box), null);
  assert.equal(segmentAabbIntersection(segment(12, 0, 20, 0), box), null);
  assert.equal(segmentAabbIntersection(segment(5, 0, 6, 0), box), 0);
  assert.equal(segmentAabbIntersect(segment(0, 5, 10, 5), box), false);
});

test('rayCircleIntersection returns nearest forward hit', () => {
  const c = circle(5, 0, 1);
  close(rayCircleIntersection(vec(0, 0), vec(1, 0), c), 4);
  close(rayCircleIntersection(vec(0, 0), vec(1, 0), circle(5, 1, 1)), 5);
  assert.equal(rayCircleIntersection(vec(0, 0), vec(1, 0), circle(5, 3, 1)), null);
  assert.equal(rayCircleIntersection(vec(10, 0), vec(1, 0), c), null);
  assert.equal(rayCircleIntersection(vec(0, 0), vec(0, 0), c), null);
});

test('segmentCircleOverlap detects near misses', () => {
  const c = circle(5, 5, 2);
  assert.ok(segmentCircleOverlap(segment(0, 0, 10, 10), c));
  assert.ok(segmentCircleOverlap(segment(5, 0, 5, 10), c));
  assert.ok(!segmentCircleOverlap(segment(0, 0, 1, 0), c));
});
