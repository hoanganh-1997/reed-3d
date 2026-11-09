import * as THREE from 'three';
import type { Fish } from './fish';

/**
 * Fish-to-fish spacing. Each fish is treated as a capsule along its heading
 * (see Fish.radius / Fish.halfSpan), so long bodies can pass close side by side
 * but never through each other.
 *
 * Two layers:
 *  - `avoidance`: soft steering. Looks a little ahead (predicted positions) and
 *    returns a per-fish push away from neighbours, so fish turn early and
 *    smoothly instead of bumping.
 *  - `resolveOverlaps`: hard constraint run after moving. Any capsules that
 *    still intersect (crowding at food, walls) are pushed apart and their
 *    closing speed is removed, so bodies never visibly overlap.
 *
 * All positions are in the same frame (tank swim-volume local).
 */

const LOOK_AHEAD_S = 0.45;
/** Extra clearance (in body lengths) inside which fish start to steer away. */
const COMFORT_LEN = 0.7;

const _a0 = new THREE.Vector3();
const _a1 = new THREE.Vector3();
const _b0 = new THREE.Vector3();
const _b1 = new THREE.Vector3();
const _ca = new THREE.Vector3();
const _cb = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _pa = new THREE.Vector3();
const _pb = new THREE.Vector3();
const _ha = new THREE.Vector3();
const _hb = new THREE.Vector3();
const _n = new THREE.Vector3();
const _rel = new THREE.Vector3();

function heading(f: Fish, out: THREE.Vector3) {
  return out.set(1, 0, 0).applyQuaternion(f.group.quaternion);
}

/** Closest points between segments p0-p1 and q0-q1 (Ericson, RTCD 5.1.9). */
export function closestSegmentPoints(
  p0: THREE.Vector3, p1: THREE.Vector3, q0: THREE.Vector3, q1: THREE.Vector3,
  outP: THREE.Vector3, outQ: THREE.Vector3,
) {
  const d1 = _dir.subVectors(p1, p0);
  const d1x = d1.x, d1y = d1.y, d1z = d1.z;
  const d2x = q1.x - q0.x, d2y = q1.y - q0.y, d2z = q1.z - q0.z;
  const rx = p0.x - q0.x, ry = p0.y - q0.y, rz = p0.z - q0.z;
  const a = d1x * d1x + d1y * d1y + d1z * d1z;
  const e = d2x * d2x + d2y * d2y + d2z * d2z;
  const f = d2x * rx + d2y * ry + d2z * rz;
  let s = 0;
  let t = 0;
  const EPS = 1e-10;
  if (a <= EPS && e <= EPS) {
    s = t = 0;
  } else if (a <= EPS) {
    t = THREE.MathUtils.clamp(f / e, 0, 1);
  } else {
    const c = d1x * rx + d1y * ry + d1z * rz;
    if (e <= EPS) {
      s = THREE.MathUtils.clamp(-c / a, 0, 1);
    } else {
      const b = d1x * d2x + d1y * d2y + d1z * d2z;
      const denom = a * e - b * b;
      s = denom > EPS ? THREE.MathUtils.clamp((b * f - c * e) / denom, 0, 1) : 0;
      t = (b * s + f) / e;
      if (t < 0) {
        t = 0;
        s = THREE.MathUtils.clamp(-c / a, 0, 1);
      } else if (t > 1) {
        t = 1;
        s = THREE.MathUtils.clamp((b - c) / a, 0, 1);
      }
    }
  }
  outP.set(p0.x + d1x * s, p0.y + d1y * s, p0.z + d1z * s);
  outQ.set(q0.x + d2x * t, q0.y + d2y * t, q0.z + d2z * t);
}

function segment(f: Fish, centre: THREE.Vector3, h: THREE.Vector3, o0: THREE.Vector3, o1: THREE.Vector3) {
  o0.copy(centre).addScaledVector(h, f.halfSpan);
  o1.copy(centre).addScaledVector(h, -f.halfSpan);
}

/** Gap between two fish bodies (negative = overlapping). Also fills `_n` (b → a). */
function gap(a: Fish, pa: THREE.Vector3, b: Fish, pb: THREE.Vector3) {
  segment(a, pa, heading(a, _ha), _a0, _a1);
  segment(b, pb, heading(b, _hb), _b0, _b1);
  closestSegmentPoints(_a0, _a1, _b0, _b1, _ca, _cb);
  _n.subVectors(_ca, _cb);
  let d = _n.length();
  if (d < 1e-6) {
    // Exactly coincident: separate sideways along a stable direction.
    _n.set(0, 0, a.group.id < b.group.id ? 1 : -1);
    d = 0;
  } else {
    _n.multiplyScalar(1 / d);
  }
  return d - a.radius - b.radius;
}

/**
 * Soft steering. Fills `out[i]` with a unitless push (≈0 far away, ≈1 at
 * contact, larger when predicted to overlap); Fish.update scales it by speed.
 */
export function avoidance(fish: Fish[], out: THREE.Vector3[]) {
  for (let i = 0; i < fish.length; i++) out[i].set(0, 0, 0);
  for (let i = 0; i < fish.length; i++) {
    const a = fish[i];
    _pa.copy(a.group.position).addScaledVector(a.velocity, LOOK_AHEAD_S);
    for (let j = i + 1; j < fish.length; j++) {
      const b = fish[j];
      _pb.copy(b.group.position).addScaledVector(b.velocity, LOOK_AHEAD_S);
      const comfort = COMFORT_LEN * Math.max(a.length, b.length);
      const g = gap(a, _pa, b, _pb);
      if (g >= comfort) continue;
      const w = Math.pow(1 - Math.max(g, -comfort) / comfort, 2) * 0.5; // 0.5 at contact, 2 deep inside
      // Bigger fish give way less: share the push by the other fish's size.
      const total = a.length + b.length;
      out[i].addScaledVector(_n, w * (b.length / total) * 2);
      out[j].addScaledVector(_n, -w * (a.length / total) * 2);
    }
  }
}

/** Hard constraint: push intersecting bodies apart and cancel closing speed. */
export function resolveOverlaps(fish: Fish[], half: THREE.Vector3, iterations = 3) {
  for (let it = 0; it < iterations; it++) {
    let any = false;
    for (let i = 0; i < fish.length; i++) {
      const a = fish[i];
      for (let j = i + 1; j < fish.length; j++) {
        const b = fish[j];
        const g = gap(a, a.group.position, b, b.group.position);
        if (g >= 0) continue;
        any = true;
        const total = a.length + b.length;
        const push = -g + 1e-4;
        a.group.position.addScaledVector(_n, push * (b.length / total));
        b.group.position.addScaledVector(_n, -push * (a.length / total));
        // Remove the part of the relative velocity that drives them together.
        const closing = _rel.subVectors(a.velocity, b.velocity).dot(_n);
        if (closing < 0) {
          a.velocity.addScaledVector(_n, -closing * (b.length / total));
          b.velocity.addScaledVector(_n, closing * (a.length / total));
        }
      }
    }
    for (const f of fish) f.clampInside(half);
    if (!any) break;
  }
}

/** Smallest body gap among all pairs (debug / tests). */
export function minGap(fish: Fish[]) {
  let best = Infinity;
  for (let i = 0; i < fish.length; i++) {
    for (let j = i + 1; j < fish.length; j++) {
      best = Math.min(best, gap(fish[i], fish[i].group.position, fish[j], fish[j].group.position));
    }
  }
  return best;
}

/**
 * Rocks. Fish are kept above the rock height map (RockField): soft steering
 * lifts them early when the path ahead rises, and a hard pass after moving
 * raises any body point (head, centre, tail) that would dip into a rock.
 * `yOff` converts tank-local heights into the swim frame (fish y + yOff = tank y).
 */
export interface Ground {
  heightNear(x: number, z: number, r: number): number;
}

const _pt = new THREE.Vector3();

/** Highest ground (swim frame) under the fish body placed at `centre`. */
function floorUnder(f: Fish, centre: THREE.Vector3, h: THREE.Vector3, ground: Ground, yOff: number) {
  let need = -Infinity;
  for (const s of [1, 0, -1]) {
    _pt.copy(centre).addScaledVector(h, f.halfSpan * s);
    const top = ground.heightNear(_pt.x, _pt.z, f.radius * 0.8) - yOff;
    // How far this body point must rise so its capsule clears the rock.
    need = Math.max(need, top + f.radius - _pt.y);
  }
  return need;
}

export function rockAvoidance(fish: Fish[], ground: Ground, yOff: number, out: THREE.Vector3[]) {
  fish.forEach((f, i) => {
    heading(f, _ha);
    _pa.copy(f.group.position).addScaledVector(f.velocity, 0.6);
    const clearance = f.length * 0.35;
    const need = floorUnder(f, _pa, _ha, ground, yOff) + clearance;
    if (need > 0) out[i].y += Math.min(2, need / (f.length * 0.5));
  });
}

export function resolveRocks(fish: Fish[], ground: Ground, yOff: number) {
  for (const f of fish) {
    const need = floorUnder(f, f.group.position, heading(f, _ha), ground, yOff);
    if (need > 0) {
      f.group.position.y += need;
      if (f.velocity.y < 0) f.velocity.y = 0;
    }
  }
}

/** Deepest rock penetration among all fish (metres, ≤0 = clear). Debug / tests. */
export function maxRockDepth(fish: Fish[], ground: Ground, yOff: number) {
  let worst = -Infinity;
  for (const f of fish) worst = Math.max(worst, floorUnder(f, f.group.position, heading(f, _ha), ground, yOff));
  return worst;
}
