/**
 * Small, pure 2D geometry helpers shared by the game systems.
 *
 * The module deliberately uses plain object shapes rather than classes so the
 * values stay serialisable and cheap to allocate in the hot loop:
 *
 * - `Vec`     - `{ x, y }`
 * - `Aabb`    - `{ x, y, w, h }` (top-left origin, as used by tile maps)
 * - `Circle`  - `{ x, y, r }`
 * - `Segment` - `{ x1, y1, x2, y2 }`
 *
 * @module core/geometry
 */

/**
 * @typedef {{ x: number, y: number }} Vec
 * @typedef {{ x: number, y: number, w: number, h: number }} Aabb
 * @typedef {{ x: number, y: number, r: number }} Circle
 * @typedef {{ x1: number, y1: number, x2: number, y2: number }} Segment
 */

/** @param {number} [x] @param {number} [y] @returns {Vec} */
export function vec(x = 0, y = 0) {
  return { x, y };
}

/** @param {Vec} v @returns {Vec} */
export function clone(v) {
  return { x: v.x, y: v.y };
}

/** @param {Vec} a @param {Vec} b @returns {Vec} */
export function add(a, b) {
  return { x: a.x + b.x, y: a.y + b.y };
}

/** @param {Vec} a @param {Vec} b @returns {Vec} */
export function sub(a, b) {
  return { x: a.x - b.x, y: a.y - b.y };
}

/** @param {Vec} v @param {number} s @returns {Vec} */
export function scale(v, s) {
  return { x: v.x * s, y: v.y * s };
}

/** @param {Vec} a @param {Vec} b @returns {number} */
export function dot(a, b) {
  return a.x * b.x + a.y * b.y;
}

/** @param {Vec} v @returns {number} */
export function lenSq(v) {
  return v.x * v.x + v.y * v.y;
}

/** @param {Vec} v @returns {number} */
export function len(v) {
  return Math.hypot(v.x, v.y);
}

/**
 * Unit vector, or `{0,0}` for a zero-length input.
 * @param {Vec} v @returns {Vec}
 */
export function normalize(v) {
  const l = Math.hypot(v.x, v.y);
  return l > 0 ? { x: v.x / l, y: v.y / l } : { x: 0, y: 0 };
}

/** @param {Vec} a @param {Vec} b @returns {number} */
export function distanceSq(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

/** @param {Vec} a @param {Vec} b @returns {number} */
export function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * Linear interpolation between two vectors; `t` is not clamped.
 * @param {Vec} a @param {Vec} b @param {number} t @returns {Vec}
 */
export function lerp(a, b, t) {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

/**
 * Rotate a vector by `rad` radians around the origin.
 * @param {Vec} v @param {number} rad @returns {Vec}
 */
export function rotate(v, rad) {
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  return { x: v.x * c - v.y * s, y: v.x * s + v.y * c };
}

/**
 * Unit-ish vector pointing at `rad`, scaled by `length`.
 * @param {number} rad @param {number} [length] @returns {Vec}
 */
export function fromAngle(rad, length = 1) {
  return { x: Math.cos(rad) * length, y: Math.sin(rad) * length };
}

/** @param {Vec} v @returns {number} Angle of the vector in radians. */
export function angle(v) {
  return Math.atan2(v.y, v.x);
}

/** @param {number} x @param {number} lo @param {number} hi @returns {number} */
export function clamp(x, lo, hi) {
  return x < lo ? lo : x > hi ? hi : x;
}

/**
 * Create an AABB from its top-left corner and size.
 * @param {number} x @param {number} y @param {number} w @param {number} h
 * @returns {Aabb}
 */
export function aabb(x, y, w, h) {
  return { x, y, w, h };
}

/**
 * Create an AABB from its centre and size.
 * @param {number} cx @param {number} cy @param {number} w @param {number} h
 * @returns {Aabb}
 */
export function aabbFromCenter(cx, cy, w, h) {
  return { x: cx - w / 2, y: cy - h / 2, w, h };
}

/** @param {Aabb} b @returns {Vec} */
export function aabbCenter(b) {
  return { x: b.x + b.w / 2, y: b.y + b.h / 2 };
}

/** @param {Aabb} b @param {Vec} p @returns {boolean} */
export function aabbContainsPoint(b, p) {
  return p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h;
}

/** @param {Aabb} outer @param {Aabb} inner @returns {boolean} */
export function aabbContainsAabb(outer, inner) {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.w <= outer.x + outer.w &&
    inner.y + inner.h <= outer.y + outer.h
  );
}

/** @param {Aabb} a @param {Aabb} b @returns {boolean} */
export function aabbOverlap(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

/**
 * Grow an AABB by `margin` on every side.
 * @param {Aabb} b @param {number} margin @returns {Aabb}
 */
export function aabbExpand(b, margin) {
  return { x: b.x - margin, y: b.y - margin, w: b.w + margin * 2, h: b.h + margin * 2 };
}

/**
 * Closest point inside/on an AABB to `p`.
 * @param {Aabb} b @param {Vec} p @returns {Vec}
 */
export function aabbClosestPoint(b, p) {
  return {
    x: clamp(p.x, b.x, b.x + b.w),
    y: clamp(p.y, b.y, b.y + b.h),
  };
}

/** @param {number} x @param {number} y @param {number} r @returns {Circle} */
export function circle(x, y, r) {
  return { x, y, r };
}

/** @param {Circle} c @param {Vec} p @returns {boolean} */
export function circleContainsPoint(c, p) {
  return distanceSq(c, p) <= c.r * c.r;
}

/** @param {Circle} a @param {Circle} b @returns {boolean} */
export function circlesOverlap(a, b) {
  const r = a.r + b.r;
  return distanceSq(a, b) <= r * r;
}

/** @param {Circle} c @param {Aabb} b @returns {boolean} */
export function circleAabbOverlap(c, b) {
  return distanceSq(c, aabbClosestPoint(b, c)) <= c.r * c.r;
}

/** @param {number} x1 @param {number} y1 @param {number} x2 @param {number} y2 @returns {Segment} */
export function segment(x1, y1, x2, y2) {
  return { x1, y1, x2, y2 };
}

/**
 * Point on `seg` closest to `p` (clamped to the segment endpoints).
 * @param {Segment} seg @param {Vec} p @returns {Vec}
 */
export function segmentClosestPoint(seg, p) {
  const dx = seg.x2 - seg.x1;
  const dy = seg.y2 - seg.y1;
  const l2 = dx * dx + dy * dy;
  if (l2 === 0) {
    return { x: seg.x1, y: seg.y1 };
  }
  const t = clamp(((p.x - seg.x1) * dx + (p.y - seg.y1) * dy) / l2, 0, 1);
  return { x: seg.x1 + t * dx, y: seg.y1 + t * dy };
}

/**
 * Squared distance from `p` to the closest point on `seg`.
 * @param {Segment} seg @param {Vec} p @returns {number}
 */
export function pointSegmentDistanceSq(seg, p) {
  return distanceSq(p, segmentClosestPoint(seg, p));
}

/** @param {Segment} seg @param {Vec} p @returns {number} */
export function pointSegmentDistance(seg, p) {
  return Math.sqrt(pointSegmentDistanceSq(seg, p));
}

const EPSILON = 1e-12;

/**
 * @param {number} px @param {number} py
 * @param {number} qx @param {number} qy
 * @param {number} rx @param {number} ry
 * @returns {number} 0 = collinear, 1 = clockwise, 2 = counter-clockwise.
 */
function orientation(px, py, qx, qy, rx, ry) {
  const v = (qx - px) * (ry - py) - (qy - py) * (rx - px);
  if (Math.abs(v) < EPSILON) return 0;
  return v > 0 ? 1 : 2;
}

function onSegment(ax, ay, bx, by, cx, cy) {
  return (
    Math.min(ax, bx) - EPSILON <= cx &&
    cx <= Math.max(ax, bx) + EPSILON &&
    Math.min(ay, by) - EPSILON <= cy &&
    cy <= Math.max(ay, by) + EPSILON
  );
}

/**
 * Do two line segments touch or cross?
 * @param {Segment} a @param {Segment} b @returns {boolean}
 */
export function segmentsIntersect(a, b) {
  const o1 = orientation(a.x1, a.y1, a.x2, a.y2, b.x1, b.y1);
  const o2 = orientation(a.x1, a.y1, a.x2, a.y2, b.x2, b.y2);
  const o3 = orientation(b.x1, b.y1, b.x2, b.y2, a.x1, a.y1);
  const o4 = orientation(b.x1, b.y1, b.x2, b.y2, a.x2, a.y2);

  if (o1 !== o2 && o3 !== o4) return true;

  if (o1 === 0 && onSegment(a.x1, a.y1, a.x2, a.y2, b.x1, b.y1)) return true;
  if (o2 === 0 && onSegment(a.x1, a.y1, a.x2, a.y2, b.x2, b.y2)) return true;
  if (o3 === 0 && onSegment(b.x1, b.y1, b.x2, b.y2, a.x1, a.y1)) return true;
  if (o4 === 0 && onSegment(b.x1, b.y1, b.x2, b.y2, a.x2, a.y2)) return true;
  return false;
}

/**
 * Cast a ray from `origin` along `dir` and return the distance along `dir` to
 * the first intersection with `box`, or `null` if it misses.
 *
 * `dir` need not be normalised; the returned `t` is in units of `dir`, so the
 * hit point is `origin + dir * t`.
 *
 * @param {Vec} origin @param {Vec} dir @param {Aabb} box
 * @returns {number | null}
 */
export function rayAabbIntersection(origin, dir, box) {
  let tNear = -Infinity;
  let tFar = Infinity;

  if (dir.x === 0) {
    if (origin.x < box.x || origin.x > box.x + box.w) return null;
  } else {
    let t1 = (box.x - origin.x) / dir.x;
    let t2 = (box.x + box.w - origin.x) / dir.x;
    if (t1 > t2) [t1, t2] = [t2, t1];
    tNear = Math.max(tNear, t1);
    tFar = Math.min(tFar, t2);
    if (tNear > tFar) return null;
  }

  if (dir.y === 0) {
    if (origin.y < box.y || origin.y > box.y + box.h) return null;
  } else {
    let t1 = (box.y - origin.y) / dir.y;
    let t2 = (box.y + box.h - origin.y) / dir.y;
    if (t1 > t2) [t1, t2] = [t2, t1];
    tNear = Math.max(tNear, t1);
    tFar = Math.min(tFar, t2);
    if (tNear > tFar) return null;
  }

  if (tFar < 0) return null;
  return tNear >= 0 ? tNear : 0;
}

/**
 * First intersection of a finite segment with an AABB, expressed as the
 * parameter `t` in `[0, 1]` along the segment, or `null` when there is none.
 *
 * @param {Segment} seg @param {Aabb} box
 * @returns {number | null}
 */
export function segmentAabbIntersection(seg, box) {
  const dir = { x: seg.x2 - seg.x1, y: seg.y2 - seg.y1 };
  if (dir.x === 0 && dir.y === 0) {
    return aabbContainsPoint(box, { x: seg.x1, y: seg.y1 }) ? 0 : null;
  }

  let tNear = -Infinity;
  let tFar = Infinity;

  if (dir.x === 0) {
    if (seg.x1 < box.x || seg.x1 > box.x + box.w) return null;
  } else {
    let t1 = (box.x - seg.x1) / dir.x;
    let t2 = (box.x + box.w - seg.x1) / dir.x;
    if (t1 > t2) [t1, t2] = [t2, t1];
    tNear = Math.max(tNear, t1);
    tFar = Math.min(tFar, t2);
    if (tNear > tFar) return null;
  }

  if (dir.y === 0) {
    if (seg.y1 < box.y || seg.y1 > box.y + box.h) return null;
  } else {
    let t1 = (box.y - seg.y1) / dir.y;
    let t2 = (box.y + box.h - seg.y1) / dir.y;
    if (t1 > t2) [t1, t2] = [t2, t1];
    tNear = Math.max(tNear, t1);
    tFar = Math.min(tFar, t2);
    if (tNear > tFar) return null;
  }

  if (tFar < 0 || tNear > 1) return null;
  return tNear >= 0 ? tNear : 0;
}

/**
 * Does a finite segment overlap an AABB?
 * @param {Segment} seg @param {Aabb} box @returns {boolean}
 */
export function segmentAabbIntersect(seg, box) {
  return segmentAabbIntersection(seg, box) !== null;
}

/**
 * First intersection of a ray with a circle, as a `t` along `dir` (ray point is
 * `origin + dir * t`), or `null` if it misses or only hits behind the origin.
 *
 * @param {Vec} origin @param {Vec} dir @param {Circle} c
 * @returns {number | null}
 */
export function rayCircleIntersection(origin, dir, c) {
  const ox = origin.x - c.x;
  const oy = origin.y - c.y;
  const a = dir.x * dir.x + dir.y * dir.y;
  if (a === 0) return null;

  const b = 2 * (ox * dir.x + oy * dir.y);
  const cc = ox * ox + oy * oy - c.r * c.r;
  const disc = b * b - 4 * a * cc;
  if (disc < 0) return null;

  const root = Math.sqrt(disc);
  let t = (-b - root) / (2 * a);
  if (t < 0) t = (-b + root) / (2 * a);
  return t >= 0 ? t : null;
}

/**
 * Does a finite segment overlap a circle?
 * @param {Segment} seg @param {Circle} c @returns {boolean}
 */
export function segmentCircleOverlap(seg, c) {
  return pointSegmentDistanceSq(seg, c) <= c.r * c.r;
}
