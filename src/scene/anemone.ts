import * as THREE from 'three';
import type { Look } from './look';

/**
 * Bubble-tip anemone (Entacmaea quadricolor), fully procedural.
 *
 * Image-to-3D cannot rebuild dozens of separate tentacles, and a static
 * anemone looks dead, so the shape is built here: a lathed column, a domed
 * oral disc and one instanced tentacle mesh. Tentacles sway in the vertex
 * shader (like `applySwimWave` for fish), so the cost is one draw call for
 * all of them. Colours follow the Gemini reference (rose-pink tentacles with a
 * white ring on the bulb and a darker tip, green-brown disc, orange column).
 *
 * Group origin = centre of the foot, sitting on the sand. `diameter` is the
 * width of the open crown in metres.
 */

const COLORS = {
  column: '#c8743c',
  columnTop: '#b9653a',
  disc: '#7a7f4c',
  mouth: '#3e3424',
  stalk: '#a7825f',
  bulb: '#f4806f',
  ring: '#fbe3dc',
  tip: '#b8394c',
};

/** Tentacle profile: [radius, y] along a unit-length tentacle. */
const PROFILE: [number, number][] = [
  [0.0, 0.0],
  [0.075, 0.0],
  [0.06, 0.12],
  [0.055, 0.32],
  [0.075, 0.46],
  [0.115, 0.58],
  [0.128, 0.655],
  [0.13, 0.675],
  [0.13, 0.705],
  [0.127, 0.745],
  [0.12, 0.78],
  [0.08, 0.87],
  [0.035, 0.94],
  [0.012, 0.99],
  [0.0, 1.0],
];

export class Anemone {
  readonly group = new THREE.Group();
  private uniforms = { uTime: { value: 0 }, uSway: { value: 0.18 } };
  private glowMats: THREE.MeshStandardMaterial[] = [];
  private disposables: { dispose(): void }[] = [];

  constructor(diameter: number, seed = 1) {
    const rng = mulberry32(seed * 7919 + 13);
    const discR = diameter * 0.2;
    const colR = diameter * 0.16;
    const colH = diameter * 0.42;
    const tentLen = diameter * 0.36;

    // Column: flared foot, slightly waisted trunk, flared top.
    const colPts = [
      new THREE.Vector2(0, 0),
      new THREE.Vector2(colR * 1.25, 0),
      new THREE.Vector2(colR * 1.12, colH * 0.06),
      new THREE.Vector2(colR * 0.98, colH * 0.3),
      new THREE.Vector2(colR * 0.95, colH * 0.6),
      new THREE.Vector2(colR * 1.05, colH * 0.88),
      new THREE.Vector2(discR * 1.02, colH),
      new THREE.Vector2(0, colH),
    ];
    const colGeo = this.track(new THREE.LatheGeometry(colPts, 32));
    paintByHeight(colGeo, (y) => mix(COLORS.column, COLORS.columnTop, y / colH));
    addFolds(colGeo, colR * 0.035, 9);
    const colMat = this.track(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55 }));
    const column = new THREE.Mesh(colGeo, colMat);
    column.castShadow = true;
    column.receiveShadow = true;

    // Oral disc: shallow dome with a dark mouth in the middle.
    const discGeo = this.track(new THREE.CircleGeometry(discR, 40, 0, Math.PI * 2));
    discGeo.rotateX(-Math.PI / 2);
    const dp = discGeo.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < dp.count; i++) {
      const r = Math.hypot(dp.getX(i), dp.getZ(i)) / discR;
      // Raised rim, sunken mouth.
      dp.setY(i, colH + diameter * 0.02 * (Math.sin(r * Math.PI) * 0.6 - (r < 0.12 ? 0.5 : 0)));
    }
    discGeo.computeVertexNormals();
    paintByRadius(discGeo, (r) => (r < 0.1 * discR ? COLORS.mouth : mix(COLORS.disc, COLORS.stalk, r / discR)));
    const discMat = this.track(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5 }));
    const disc = new THREE.Mesh(discGeo, discMat);

    // Tentacles: one lathed tentacle, instanced in a sunflower pattern over the disc.
    const tGeo = this.track(new THREE.LatheGeometry(PROFILE.map(([r, y]) => new THREE.Vector2(r, y)), 14, 0, Math.PI * 2));
    paintByHeight(tGeo, tentacleColor);
    const count = Math.round(THREE.MathUtils.clamp(diameter * 320, 34, 64));
    const phase = new Float32Array(count);
    const tMat = this.track(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.38, emissive: COLORS.bulb, emissiveIntensity: 0 }));
    this.glowMats.push(tMat);
    tMat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.uniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>
attribute float aPhase;
uniform float uTime; uniform float uSway;`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>
float t = position.y;
float bend = t * t * uSway;
// Slow swell of the bulbs, plus a two-axis sway driven by a shared current.
transformed.xz *= 1.0 + 0.08 * sin(uTime * 0.9 + aPhase * 2.0) * smoothstep(0.4, 0.7, t);
transformed.x += sin(uTime * 1.1 + aPhase) * bend;
transformed.z += cos(uTime * 0.8 + aPhase * 1.3) * bend * 0.7;
transformed.y -= bend * bend * 0.6;`);
    };
    tMat.customProgramCacheKey = () => 'anemone-sway';

    const tentacles = new THREE.InstancedMesh(tGeo, tMat, count);
    tentacles.castShadow = true;
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    const golden = Math.PI * (3 - Math.sqrt(5));
    const tint = new THREE.Color();
    for (let i = 0; i < count; i++) {
      const f = (i + 0.5) / count;
      const r = Math.sqrt(f) * discR * 0.92;
      const a = i * golden + rng() * 0.2;
      // Inner tentacles stand up, outer ones splay out and droop over the column.
      const tilt = THREE.MathUtils.lerp(0.15, 1.75, Math.pow(f, 0.8)) + (rng() - 0.5) * 0.25;
      e.set(0, -a, 0, 'YXZ');
      q.setFromEuler(e);
      const out = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, -1), tilt);
      q.multiply(out);
      const len = tentLen * (0.85 + rng() * 0.3) * THREE.MathUtils.lerp(0.8, 1, f);
      const thick = len * (1.2 + rng() * 0.2);
      const pos = new THREE.Vector3(Math.cos(a) * r, colH + diameter * 0.01, Math.sin(a) * r);
      m.compose(pos, q, new THREE.Vector3(thick, len, thick));
      tentacles.setMatrixAt(i, m);
      // Neighbouring tentacles move almost together, like a real current.
      phase[i] = pos.x * 9 + pos.z * 6 + rng() * 0.6;
      tint.setHSL(0, 0, 0.92 + rng() * 0.16);
      tentacles.setColorAt(i, tint);
    }
    tGeo.setAttribute('aPhase', new THREE.InstancedBufferAttribute(phase, 1));
    tentacles.instanceMatrix.needsUpdate = true;
    // Sway moves tips outside the static bounds; skip culling (it is always in the tank view).
    tentacles.frustumCulled = false;

    this.group.add(column, disc, tentacles);
    this.uniforms.uSway.value = 0.16;
  }

  /** Bubble tips fluoresce under actinic light, like the fish. */
  setGlow(look: Look) {
    for (const mat of this.glowMats) mat.emissiveIntensity = look.fish_glow * 0.5;
  }

  update(time: number) {
    this.uniforms.uTime.value = time;
  }

  private track<T extends { dispose(): void }>(d: T): T {
    this.disposables.push(d);
    return d;
  }

  dispose() {
    for (const d of this.disposables) d.dispose();
  }
}

function tentacleColor(t: number) {
  if (t < 0.4) return mix(COLORS.stalk, COLORS.bulb, t / 0.4);
  if (t > 0.665 && t < 0.735) return COLORS.ring;
  if (t > 0.86) return mix(COLORS.bulb, COLORS.tip, (t - 0.86) / 0.14);
  return COLORS.bulb;
}

function mix(a: string, b: string, t: number) {
  return '#' + new THREE.Color(a).lerp(new THREE.Color(b), THREE.MathUtils.clamp(t, 0, 1)).getHexString();
}

function paintByHeight(g: THREE.BufferGeometry, color: (y: number) => string) {
  const p = g.attributes.position as THREE.BufferAttribute;
  const c = new Float32Array(p.count * 3);
  const tmp = new THREE.Color();
  for (let i = 0; i < p.count; i++) {
    tmp.set(color(p.getY(i))).toArray(c, i * 3);
  }
  g.setAttribute('color', new THREE.BufferAttribute(c, 3));
}

function paintByRadius(g: THREE.BufferGeometry, color: (r: number) => string) {
  const p = g.attributes.position as THREE.BufferAttribute;
  const c = new Float32Array(p.count * 3);
  const tmp = new THREE.Color();
  for (let i = 0; i < p.count; i++) {
    tmp.set(color(Math.hypot(p.getX(i), p.getZ(i)))).toArray(c, i * 3);
  }
  g.setAttribute('color', new THREE.BufferAttribute(c, 3));
}

/** Soft vertical folds on the column so it reads as soft tissue, not a pipe. */
function addFolds(g: THREE.BufferGeometry, depth: number, folds: number) {
  const p = g.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const z = p.getZ(i);
    const r = Math.hypot(x, z);
    if (r < 1e-6) continue;
    const k = 1 + (depth / r) * Math.sin(Math.atan2(z, x) * folds + p.getY(i) * 20);
    p.setX(i, x * k);
    p.setZ(i, z * k);
  }
  g.computeVertexNormals();
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
