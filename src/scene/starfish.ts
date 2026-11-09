import * as THREE from 'three';
import type { Species } from '../game/types';

/** What a crawling starfish needs to know about its tank (all tank-local, metres). */
export interface Seabed {
  /** Top surface (rock or sand) under x,z, or null outside the bed. */
  ground(x: number, z: number): { point: THREE.Vector3; normal: THREE.Vector3 } | null;
  halfX: number;
  halfZ: number;
  floorY: number;
  waterY: number;
}

type Wall = { axis: 'x' | 'z'; sign: 1 | -1 };

const UP = new THREE.Vector3(0, 1, 0);
const tmpM = new THREE.Matrix4();
const tmpQ = new THREE.Quaternion();
const tmpF = new THREE.Vector3();
const tmpR = new THREE.Vector3();
const tmpU = new THREE.Vector3();

/**
 * Bottom-dwelling invertebrates (starfish). They crawl very slowly over the
 * sand and rock tops, now and then climb a glass pane, rest there, and come
 * back down. Movement is client-side display only (not saved).
 *
 * Local frame: origin at the underside centre, +Y away from the surface,
 * +X = leading arm, diameter 1 (scaled by the tank). A GLB from
 * species.model_url replaces the procedural placeholder once it has loaded.
 */
export class Starfish {
  readonly group = new THREE.Group();
  private disposables: { dispose(): void }[] = [];
  private rng: () => number;

  // Crawl state (tank-local).
  private pos = new THREE.Vector3();
  private surfY = 0; // ground height under pos (ground mode)
  private normal = new THREE.Vector3(0, 1, 0); // smoothed surface normal
  private targetNormal = new THREE.Vector3(0, 1, 0);
  private heading = new THREE.Vector3(1, 0, 0); // moving direction (in the surface plane)
  private wall: Wall | null = null;
  private goal = new THREE.Vector3();
  private goalWall: Wall | null = null;
  private rest = 0;
  private sinceProbe = Infinity;
  private placed = false;

  constructor(public species: Species, public diameter: number, model: THREE.Object3D | null, seed: number, private speed = 0.12) {
    const rng = (this.rng = mulberry32(seed));
    if (model) {
      const m = model.clone();
      m.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.isMesh) mesh.castShadow = mesh.receiveShadow = true;
      });
      this.group.add(m);
    } else {
      const geo = this.track(starGeometry(rng, species));
      const mat = this.track(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.62, metalness: 0 }));
      const mesh = new THREE.Mesh(geo, mat);
      mesh.castShadow = mesh.receiveShadow = true;
      this.group.add(mesh);
    }
    this.group.scale.setScalar(diameter);
    const a = rng() * Math.PI * 2;
    this.heading.set(Math.cos(a), 0, Math.sin(a));
    this.rest = 1 + rng() * 6; // don't all start moving at once
  }

  /** Rest on a surface point with the given (tank-local) normal. Resets crawling. */
  placeOn(point: THREE.Vector3, normal: THREE.Vector3) {
    this.pos.copy(point);
    this.surfY = point.y;
    this.normal.copy(normal);
    this.targetNormal.copy(normal);
    this.wall = null;
    this.goalWall = null;
    this.goal.copy(point);
    this.placed = true;
    this.applyTransform(1);
  }

  update(dt: number, bed: Seabed) {
    if (!this.placed || !this.group.visible) return;
    const r = this.diameter / 2;
    if (this.rest > 0) {
      this.rest -= dt;
      if (this.rest <= 0) this.pickGoal(bed);
    } else if (this.wall) {
      this.crawlWall(dt, bed, r);
    } else {
      this.crawlGround(dt, bed, r);
    }
    this.applyTransform(1 - Math.exp(-dt * 2.5));
  }

  // ---------------------------------------------------------------- ground
  private crawlGround(dt: number, bed: Seabed, r: number) {
    const to = tmpF.set(this.goal.x - this.pos.x, 0, this.goal.z - this.pos.z);
    const dist = to.length();
    // Reached the foot of a wall: climb on.
    if (this.goalWall && this.distToWall(this.goalWall, bed) < r * 0.75) return this.attach(this.goalWall, bed, r);
    if (dist < r * 0.25) return this.arrive(4, 14);
    this.turnToward(to.normalize(), dt, 0.7);
    const step = this.speed * this.diameter * dt;
    const nx = this.pos.x + this.heading.x * step;
    const nz = this.pos.z + this.heading.z * step;
    const lim = (h: number) => h - r * 0.55;
    if (Math.abs(nx) > lim(bed.halfX) || Math.abs(nz) > lim(bed.halfZ)) {
      if (!this.goalWall) return this.blocked(bed);
    }
    this.sinceProbe += step;
    if (this.sinceProbe > r * 0.08) {
      // Probe a little ahead so a ledge is seen before the body reaches it.
      // Rest on whichever is higher, so the body never sinks into a rock edge.
      const ahead = bed.ground(nx + this.heading.x * r * 0.35, nz + this.heading.z * r * 0.35);
      const here = bed.ground(nx, nz);
      const hit = ahead && here && here.point.y > ahead.point.y ? here : ahead;
      if (!hit || hit.normal.y < 0.4 || hit.point.y - this.surfY > r * 0.9) return this.blocked(bed);
      this.surfY = hit.point.y;
      this.targetNormal.copy(hit.normal);
      this.sinceProbe = 0;
    }
    // Ledge ahead: haul up onto it before moving on (never sink into the rock).
    if (this.surfY - this.pos.y > r * 0.06) {
      this.pos.y = Math.min(this.surfY, this.pos.y + step * 1.5);
      return;
    }
    this.pos.x = THREE.MathUtils.clamp(nx, -lim(bed.halfX), lim(bed.halfX));
    this.pos.z = THREE.MathUtils.clamp(nz, -lim(bed.halfZ), lim(bed.halfZ));
    this.pos.y += (this.surfY - this.pos.y) * Math.min(1, dt * 3);
  }

  private blocked(bed: Seabed) {
    // Steep rock face or a wall it didn't mean to climb: turn away and pick a new goal.
    this.heading.multiplyScalar(-1);
    this.goalWall = null;
    this.rest = 0.5 + this.rng() * 1.5;
    this.sinceProbe = Infinity;
    void bed;
  }

  // ---------------------------------------------------------------- wall
  private attach(w: Wall, bed: Seabed, r: number) {
    this.wall = w;
    this.goalWall = null;
    const n = wallNormal(w);
    this.targetNormal.copy(n);
    // Underside on the glass, lowest arm just above the bed at this spot.
    const u = this.wallU(w);
    this.setWallPos(w, bed, u, Math.max(this.pos.y, this.footY(w, u, bed)) + r * 0.9);
    // Climb: pick a spot higher up the pane.
    const v = bed.floorY + r * 2 + this.rng() * Math.max(0, bed.waterY - bed.floorY - r * 3.5);
    this.setWallGoal(w, bed, u + (this.rng() - 0.5) * r * 6, v, r);
    this.sinceProbe = Infinity;
  }

  private crawlWall(dt: number, bed: Seabed, r: number) {
    const w = this.wall!;
    const u = this.wallU(w);
    const to = tmpF.set(0, this.goal.y - this.pos.y, 0);
    if (w.axis === 'x') to.z = this.goal.z - this.pos.z; else to.x = this.goal.x - this.pos.x;
    const dist = to.length();
    if (dist < r * 0.25) {
      // Back at the bottom: step off onto the bed.
      if (this.goal.y <= this.footY(w, u, bed) + r * 1.05) return this.detach(w, bed, r);
      return this.arrive(15, 45);
    }
    this.turnToward(to.normalize(), dt, 0.9);
    const step = this.speed * this.diameter * dt;
    const span = (w.axis === 'x' ? bed.halfZ : bed.halfX) - r * 1.1;
    const nu = THREE.MathUtils.clamp(u + (w.axis === 'x' ? this.heading.z : this.heading.x) * step, -span, span);
    const minV = this.footY(w, nu, bed) + r * 0.9;
    const nv = Math.max(minV, Math.min(bed.waterY - r * 1.1, this.pos.y + this.heading.y * step));
    this.setWallPos(w, bed, nu, nv);
  }

  private detach(w: Wall, bed: Seabed, r: number) {
    this.wall = null;
    const n = wallNormal(w);
    const p = this.pos.clone().addScaledVector(n, r * 0.9);
    const hit = bed.ground(p.x, p.z);
    if (hit) {
      this.pos.set(p.x, hit.point.y, p.z);
      this.surfY = hit.point.y;
      this.targetNormal.copy(hit.normal);
    }
    this.heading.copy(n);
    this.sinceProbe = Infinity;
    this.pickGroundGoal(bed, r);
  }

  private setWallGoal(w: Wall, bed: Seabed, u: number, v: number, r: number) {
    const span = (w.axis === 'x' ? bed.halfZ : bed.halfX) - r * 1.1;
    const cu = THREE.MathUtils.clamp(u, -span, span);
    const cv = Math.max(this.footY(w, cu, bed) + r * 0.9, Math.min(bed.waterY - r * 1.1, v));
    this.goal.copy(wallPoint(w, bed, cu, cv));
  }

  private setWallPos(w: Wall, bed: Seabed, u: number, v: number) {
    this.pos.copy(wallPoint(w, bed, u, v));
  }

  private wallU(w: Wall) {
    return w.axis === 'x' ? this.pos.z : this.pos.x;
  }

  /** Bed height right at the foot of the pane (rocks may lean on it). */
  private footY(w: Wall, u: number, bed: Seabed) {
    const p = wallPoint(w, bed, u, 0).addScaledVector(wallNormal(w), this.diameter * 0.3);
    return bed.ground(p.x, p.z)?.point.y ?? bed.floorY;
  }

  private distToWall(w: Wall, bed: Seabed) {
    return w.axis === 'x' ? bed.halfX - w.sign * this.pos.x : bed.halfZ - w.sign * this.pos.z;
  }

  // ---------------------------------------------------------------- goals
  private arrive(minRest: number, maxRest: number) {
    this.rest = minRest + this.rng() * (maxRest - minRest);
  }

  private pickGoal(bed: Seabed) {
    const r = this.diameter / 2;
    if (this.wall) {
      // On the glass: wander a bit more, or head back down.
      if (this.rng() < 0.4) {
        this.setWallGoal(this.wall, bed, this.wallU(this.wall) + (this.rng() - 0.5) * r * 8, this.pos.y + (this.rng() - 0.5) * r * 6, r);
      } else {
        const u = this.wallU(this.wall) + (this.rng() - 0.5) * r * 6;
        this.setWallGoal(this.wall, bed, u, 0, r); // clamps to the foot of the pane
      }
      return;
    }
    if (this.rng() < 0.35) {
      // Head for a pane: the nearest one usually, sometimes any.
      const walls: Wall[] = [{ axis: 'x', sign: 1 }, { axis: 'x', sign: -1 }, { axis: 'z', sign: 1 }, { axis: 'z', sign: -1 }];
      walls.sort((a, b) => this.distToWall(a, bed) - this.distToWall(b, bed));
      const w = this.rng() < 0.7 ? walls[0] : walls[Math.floor(this.rng() * 4)];
      const span = (w.axis === 'x' ? bed.halfZ : bed.halfX) - r * 1.5;
      const u = THREE.MathUtils.clamp(this.wallU(w) + (this.rng() - 0.5) * span, -span, span);
      const foot = wallPoint(w, bed, u, 0).addScaledVector(wallNormal(w), r * 0.6);
      this.goal.set(foot.x, 0, foot.z);
      this.goalWall = w;
      return;
    }
    this.pickGroundGoal(bed, r);
  }

  private pickGroundGoal(bed: Seabed, r: number) {
    const reach = r * (4 + this.rng() * 10);
    const a = Math.atan2(this.heading.z, this.heading.x) + (this.rng() - 0.5) * 2.4;
    this.goal.set(
      THREE.MathUtils.clamp(this.pos.x + Math.cos(a) * reach, -bed.halfX + r, bed.halfX - r),
      0,
      THREE.MathUtils.clamp(this.pos.z + Math.sin(a) * reach, -bed.halfZ + r, bed.halfZ - r),
    );
    this.goalWall = null;
  }

  /** Turn the heading toward `dir` (unit) at most `rate` rad/s, staying in the surface plane. */
  private turnToward(dir: THREE.Vector3, dt: number, rate: number) {
    const ang = this.heading.angleTo(dir);
    if (ang < 1e-4) return;
    const t = Math.min(1, (rate * dt) / ang);
    this.heading.lerp(dir, t).normalize();
  }

  private applyTransform(k: number) {
    this.normal.lerp(this.targetNormal, k).normalize();
    this.group.position.copy(this.pos);
    // Basis: +Y = surface normal, +X = heading projected into the surface.
    const up = tmpU.copy(this.normal);
    const fwd = tmpF.copy(this.heading).addScaledVector(up, -this.heading.dot(up));
    if (fwd.lengthSq() < 1e-6) fwd.copy(Math.abs(up.y) < 0.9 ? UP : new THREE.Vector3(1, 0, 0)).addScaledVector(up, -up.y);
    fwd.normalize();
    const side = tmpR.crossVectors(fwd, up).normalize();
    tmpM.makeBasis(fwd, up, side);
    tmpQ.setFromRotationMatrix(tmpM);
    if (k >= 1) this.group.quaternion.copy(tmpQ);
    else this.group.quaternion.slerp(tmpQ, k);
  }

  private track<T extends { dispose(): void }>(d: T): T {
    this.disposables.push(d);
    return d;
  }

  dispose() {
    for (const d of this.disposables) d.dispose();
  }
}

function wallNormal(w: Wall) {
  return w.axis === 'x' ? new THREE.Vector3(-w.sign, 0, 0) : new THREE.Vector3(0, 0, -w.sign);
}

/** Point on the inside of a pane: u runs along the pane, v is height. */
function wallPoint(w: Wall, bed: Seabed, u: number, v: number) {
  const inset = 0.0015;
  return w.axis === 'x'
    ? new THREE.Vector3(w.sign * (bed.halfX - inset), v, u)
    : new THREE.Vector3(u, v, w.sign * (bed.halfZ - inset));
}

/** Diameter in metres: real size, but never more than a fifth of the tank's short side. */
export function starfishDiameterM(species: Species, tankMinCm: number) {
  return Math.min(species.adult_length_cm, tankMinCm * 0.2) / 100;
}

/**
 * Five tapering, rounded arms with a domed, granular top and a flat underside.
 * Colours: body_color on top, darker accent at the arm tips and in the pores.
 */
function starGeometry(rng: () => number, sp: Species) {
  const ARMS = 5;
  const NT = 120; // around
  const NR = 20; // centre → edge
  const R = 0.5; // arm tip radius (diameter 1)
  const disc = 0.15 + rng() * 0.03; // central disc radius
  const H = 0.075; // dome height at the centre
  const armLen = Array.from({ length: ARMS }, () => 0.9 + rng() * 0.12);
  const armBend = Array.from({ length: ARMS }, () => (rng() - 0.5) * 0.18);

  const body = new THREE.Color(sp.body_color);
  const tip = new THREE.Color(sp.fin_color);
  const pore = new THREE.Color(sp.accent_color);

  // Outline radius for a polar angle: arms are narrow lobes between a round disc.
  const outline = (a: number) => {
    const k = (a / (Math.PI * 2)) * ARMS;
    const i = ((Math.round(k) % ARMS) + ARMS) % ARMS;
    const d = k - Math.round(k); // -0.5..0.5 around arm centre
    const lobe = Math.pow(Math.max(0, Math.cos(d * Math.PI)), 4.4);
    return disc + (R * armLen[i] - disc) * lobe;
  };

  const pos: number[] = [];
  const col: number[] = [];
  const idx: number[] = [];
  const c = new THREE.Color();

  // Top surface: rings from centre to edge.
  for (let r = 0; r <= NR; r++) {
    const t = r / NR;
    for (let j = 0; j < NT; j++) {
      const a = (j / NT) * Math.PI * 2;
      const k = (a / (Math.PI * 2)) * ARMS;
      const i = ((Math.round(k) % ARMS) + ARMS) % ARMS;
      const rad = outline(a) * t;
      const aa = a + armBend[i] * t * t; // slight curl along the arm
      const x = Math.cos(aa) * rad;
      const z = Math.sin(aa) * rad;
      // Rounded cross-section: thick at the disc, thinner toward the tips, round edge.
      const along = rad / R;
      const thick = H * (1 - 0.62 * Math.min(1, along)) + 0.012;
      const edge = Math.sqrt(Math.max(0, 1 - Math.pow(t, 4)));
      // Granules: small bumps that read as the skin texture.
      const g = 0.5 + 0.5 * Math.sin(x * 140 + Math.sin(z * 90) * 2) * Math.sin(z * 150 + Math.sin(x * 80) * 2);
      const y = thick * edge * (1 + 0.06 * g) + 0.002;
      pos.push(x, y, z);
      // Colour: body, darker toward the tips, scattered dark pores, lighter bumps.
      c.copy(body).lerp(tip, Math.min(1, Math.pow(along, 1.6)));
      const poreN = Math.sin(x * 260 + z * 37) * Math.sin(z * 240 - x * 53);
      if (poreN > 0.82 && t > 0.15) c.lerp(pore, 0.55);
      c.offsetHSL(0, 0, (g - 0.5) * 0.05);
      col.push(c.r, c.g, c.b);
    }
  }
  for (let r = 0; r < NR; r++) {
    for (let j = 0; j < NT; j++) {
      const a = r * NT + j;
      const b = r * NT + ((j + 1) % NT);
      const c2 = (r + 1) * NT + j;
      const d = (r + 1) * NT + ((j + 1) % NT);
      idx.push(a, b, c2, b, d, c2);
    }
  }
  // Flat underside: a fan under the outline, slightly darker.
  const base = pos.length / 3;
  pos.push(0, 0, 0);
  c.copy(body).multiplyScalar(0.7);
  col.push(c.r, c.g, c.b);
  const rim = NR * NT;
  for (let j = 0; j < NT; j++) {
    pos.push(pos[(rim + j) * 3], 0, pos[(rim + j) * 3 + 2]);
    col.push(c.r, c.g, c.b);
  }
  for (let j = 0; j < NT; j++) idx.push(base, base + 1 + ((j + 1) % NT), base + 1 + j);

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

function mulberry32(a: number) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
