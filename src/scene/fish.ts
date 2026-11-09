import * as THREE from 'three';
import type { Species } from '../game/types';
import type { Look } from './look';

/**
 * Placeholder fish built procedurally until the GLB models exist.
 * Local space: +X is the head, Y up, Z is the lateral axis.
 * Swimming is a vertex-shader body wave (no skeleton), applied identically to
 * body and fins so they stay attached. A GLB loaded later can reuse
 * `applySwimWave` on its materials as long as it uses the same axes.
 */

export interface SwimUniforms {
  uTime: { value: number };
  uAmp: { value: number };
  uFreq: { value: number };
  uSpeed: { value: number };
  uHeadX: { value: number };
  uLen: { value: number };
}

export function applySwimWave(material: THREE.Material, u: SwimUniforms) {
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, u);
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
uniform float uTime; uniform float uAmp; uniform float uFreq; uniform float uSpeed; uniform float uHeadX; uniform float uLen;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
float swimT = clamp((uHeadX - position.x) / uLen, 0.0, 1.0);
float swimEnv = 0.12 + swimT * swimT;
// uTime is the integrated wave phase (see Fish.update), so speed changes never jump the phase.
transformed.z += sin(position.x * uFreq + uTime) * uAmp * swimEnv;`,
      );
  };
  material.customProgramCacheKey = () => 'swim-wave';
}

function finTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const grad = g.createLinearGradient(0, 0, 64, 0);
  grad.addColorStop(0, 'rgba(255,255,255,0.95)');
  grad.addColorStop(0.75, 'rgba(255,255,255,0.8)');
  grad.addColorStop(1, 'rgba(255,255,255,0.25)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  // fin rays
  g.strokeStyle = 'rgba(0,0,0,0.18)';
  for (let x = 4; x < 64; x += 6) {
    g.beginPath();
    g.moveTo(x, 0);
    g.lineTo(x, 64);
    g.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function shapeGeometry(points: [number, number][]) {
  const s = new THREE.Shape();
  s.moveTo(points[0][0], points[0][1]);
  for (const p of points.slice(1)) s.lineTo(p[0], p[1]);
  s.closePath();
  const geo = new THREE.ShapeGeometry(s, 6);
  // planar UVs from bounds
  geo.computeBoundingBox();
  const bb = geo.boundingBox!;
  const pos = geo.attributes.position;
  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    uv[i * 2] = (pos.getX(i) - bb.min.x) / (bb.max.x - bb.min.x || 1);
    uv[i * 2 + 1] = (pos.getY(i) - bb.min.y) / (bb.max.y - bb.min.y || 1);
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return geo;
}

export class Fish {
  readonly group = new THREE.Group();
  readonly uniforms: SwimUniforms;
  /** Body length in metres; eases towards `targetLength` when the fish grows. */
  length: number;
  private targetLength: number;
  velocity = new THREE.Vector3();
  target = new THREE.Vector3();
  /** Body capsule used for fish-to-fish spacing (metres, see avoid.ts). */
  radius = 0;
  /** Half length of the capsule's core segment along the heading (metres). */
  halfSpan = 0;
  private wavePhase = Math.random() * 100;
  private materials: THREE.Material[] = [];
  /** Materials that self-glow so colours stay readable under blue light. */
  private glowMats: THREE.MeshStandardMaterial[] = [];
  private isModel = false;

  constructor(public species: Species, lengthM: number, model?: THREE.Object3D | null) {
    this.length = lengthM;
    this.targetLength = lengthM;
    const L = 1; // build at unit length, scale the group
    this.uniforms = {
      uTime: { value: 0 },
      uAmp: { value: 0.06 },
      uFreq: { value: 6.0 },
      uSpeed: { value: 7.0 },
      uHeadX: { value: 0.5 * L },
      uLen: { value: 1.0 * L },
    };

    if (model) {
      this.isModel = true;
      this.buildFromModel(model);
      this.fitCapsule();
      this.group.scale.setScalar(lengthM);
      return;
    }

    const bodyMat = new THREE.MeshStandardMaterial({ color: species.body_color, emissive: species.body_color, emissiveIntensity: 0, roughness: 0.45, metalness: 0.05 });
    const finMat = new THREE.MeshStandardMaterial({
      color: species.fin_color,
      map: finTexture(),
      transparent: true,
      alphaTest: 0.05,
      side: THREE.DoubleSide,
      roughness: 0.6,
    });
    const accentMat = new THREE.MeshStandardMaterial({ color: species.accent_color, roughness: 0.5 });
    const eyeMat = new THREE.MeshStandardMaterial({ color: '#0b0f14', roughness: 0.2 });
    this.materials = [bodyMat, finMat, accentMat, eyeMat];
    this.glowMats = [bodyMat];
    for (const m of this.materials) applySwimWave(m, this.uniforms);

    // Tang silhouette: tall, laterally compressed oval body.
    const body = new THREE.SphereGeometry(1, 40, 24);
    body.scale(0.4 * L, 0.27 * L, 0.075 * L);
    body.translate(0.1 * L, 0, 0);
    const bodyMesh = new THREE.Mesh(body, bodyMat);
    bodyMesh.castShadow = true;

    // Snout
    const snout = new THREE.SphereGeometry(1, 20, 12);
    snout.scale(0.08 * L, 0.05 * L, 0.035 * L);
    snout.translate(0.48 * L, -0.03 * L, 0);
    const snoutMesh = new THREE.Mesh(snout, bodyMat);

    // Flat fins with alpha
    const tail = shapeGeometry([[-0.27, 0], [-0.5, 0.2], [-0.44, 0], [-0.5, -0.2]]);
    const dorsal = shapeGeometry([[-0.26, 0.17], [0.32, 0.2], [0.18, 0.37], [-0.12, 0.33], [-0.3, 0.2]]);
    const anal = shapeGeometry([[-0.26, -0.17], [0.22, -0.2], [0.1, -0.33], [-0.12, -0.31], [-0.3, -0.2]]);
    const pectoral = shapeGeometry([[0.2, -0.02], [0.04, 0.05], [0.0, -0.06]]);
    const finMeshes = [tail, dorsal, anal].map((g) => new THREE.Mesh(g, finMat));
    const pecL = new THREE.Mesh(pectoral, finMat);
    pecL.position.z = 0.072;
    const pecR = new THREE.Mesh(pectoral.clone(), finMat);
    pecR.position.z = -0.072;

    // Eyes
    const eyeGeo = new THREE.SphereGeometry(0.03, 12, 8);
    const eyeL = new THREE.Mesh(eyeGeo, eyeMat);
    eyeL.position.set(0.36, 0.06, 0.05);
    const eyeR = eyeL.clone();
    eyeR.position.z = -0.05;

    // Species accent (e.g. tail-spine marking)
    const accentGeo = new THREE.SphereGeometry(1, 16, 10);
    accentGeo.scale(0.06, 0.03, 0.078);
    accentGeo.translate(-0.24, 0, 0);
    const accent = new THREE.Mesh(accentGeo, accentMat);

    this.group.add(bodyMesh, snoutMesh, ...finMeshes, pecL, pecR, eyeL, eyeR, accent);
    this.fitCapsule();
    this.group.scale.setScalar(lengthM);
  }

  /**
   * Fit the spacing capsule to the unit-length body (before scaling). Radius
   * covers the body height (thin fin tips may graze) and the swim-wave sway.
   */
  private fitCapsule() {
    const box = new THREE.Box3().setFromObject(this.group);
    const size = box.getSize(new THREE.Vector3());
    const r = THREE.MathUtils.clamp(Math.max(size.y * 0.42, size.z * 0.5 + 0.06), 0.18, 0.42);
    this.radius = r * this.length;
    this.halfSpan = Math.max(0, size.x / 2 - r) * this.length;
  }

  /** Grow (or shrink) smoothly to a new body length in metres. */
  setLength(lengthM: number) {
    this.targetLength = lengthM;
  }

  private easeLength(dt: number) {
    if (this.length === this.targetLength) return;
    let next = this.length + (this.targetLength - this.length) * (1 - Math.exp(-dt * 1.5));
    if (Math.abs(next - this.targetLength) < 1e-4) next = this.targetLength;
    const k = next / this.length;
    this.radius *= k;
    this.halfSpan *= k;
    this.length = next;
    this.group.scale.setScalar(next);
  }

  /** Keep the fish inside the swim volume (half extents, metres). */
  clampInside(half: THREE.Vector3) {
    const m = this.length * 0.6;
    const p = this.group.position;
    p.x = THREE.MathUtils.clamp(p.x, -Math.max(0.01, half.x - m), Math.max(0.01, half.x - m));
    p.y = THREE.MathUtils.clamp(p.y, -Math.max(0.01, half.y - m), Math.max(0.01, half.y - m));
    p.z = THREE.MathUtils.clamp(p.z, -Math.max(0.01, half.z - m * 0.7), Math.max(0.01, half.z - m * 0.7));
  }

  /** Use a normalised GLB (see models.ts): clone meshes, give each its own swim-wave material. */
  private buildFromModel(model: THREE.Object3D) {
    model.traverse((o) => {
      const src = o as THREE.Mesh;
      if (!src.isMesh) return;
      const mats = (Array.isArray(src.material) ? src.material : [src.material]).map((m) => {
        const mat = (m as THREE.MeshStandardMaterial).clone();
        // Keep colours readable under blue actinic light (texture-driven self glow).
        if (mat.map && 'emissiveMap' in mat) {
          mat.emissive = new THREE.Color('#ffffff');
          mat.emissiveMap = mat.map;
          mat.emissiveIntensity = 0;
          this.glowMats.push(mat as THREE.MeshStandardMaterial);
        }
        applySwimWave(mat, this.uniforms);
        this.materials.push(mat);
        return mat;
      });
      const mesh = new THREE.Mesh(src.geometry, Array.isArray(src.material) ? mats : mats[0]);
      mesh.castShadow = true;
      this.group.add(mesh);
    });
    this.sharedGeometry = true;
  }

  private sharedGeometry = false;

  setGlow(look: Look) {
    const v = this.isModel ? look.model_fish_glow : look.fish_glow;
    for (const m of this.glowMats) m.emissiveIntensity = v;
  }

  /**
   * Called every frame with tank-local bounds (half extents, metres) and the
   * neighbour avoidance push from avoid.ts (unitless, ~1 at body contact).
   */
  update(dt: number, time: number, half: THREE.Vector3, food: THREE.Vector3 | null, avoid?: THREE.Vector3) {
    this.easeLength(dt);
    const p = this.group.position;
    const margin = this.length * 0.6;
    const limit = new THREE.Vector3(
      Math.max(0.01, half.x - margin),
      Math.max(0.01, half.y - margin),
      Math.max(0.01, half.z - margin * 0.7),
    );

    const goal = food ?? this.target;
    if (!food && p.distanceTo(this.target) < this.length * 0.8) this.pickTarget(limit);

    const cruise = this.length * (food ? 1.6 : 0.7);
    const desired = goal.clone().sub(p);
    const dist = desired.length();
    if (dist > 1e-4) desired.multiplyScalar(cruise / dist);
    if (avoid && avoid.lengthSq() > 1e-8) {
      // Turn away from neighbours. Mostly sideways/vertical, so fish veer and
      // pass rather than stopping dead; strength rises sharply near contact.
      desired.addScaledVector(avoid, this.length * 2.2);
      // A wander target that sits behind a neighbour would keep them pressing together.
      if (!food && avoid.length() > 0.35 && goal.clone().sub(p).dot(avoid) < 0) this.pickTarget(limit);
    }
    const steer = desired.sub(this.velocity).multiplyScalar(Math.min(1, dt * 1.6));
    this.velocity.add(steer);
    this.velocity.y *= 0.96; // fish prefer level swimming
    p.addScaledVector(this.velocity, dt);
    this.clampInside(half);

    const speed = this.velocity.length();
    if (speed > 1e-4) {
      const yaw = Math.atan2(-this.velocity.z, this.velocity.x);
      const pitch = Math.atan2(this.velocity.y, Math.hypot(this.velocity.x, this.velocity.z));
      const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, yaw, pitch * 0.6, 'YZX'));
      this.group.quaternion.slerp(q, Math.min(1, dt * 3));
    }

    // Integrate the tail-beat phase. Using time * speed directly made the phase
    // jump whenever speed changed (time is large), which looked like a jerking tail.
    const rel = speed / Math.max(1e-4, this.length);
    const k = 1 - Math.exp(-dt * 2.5); // ease beat rate and amplitude
    this.uniforms.uSpeed.value += (5 + rel * 6 - this.uniforms.uSpeed.value) * k;
    this.uniforms.uAmp.value += (0.04 + Math.min(0.06, rel * 0.03) - this.uniforms.uAmp.value) * k;
    this.wavePhase = (this.wavePhase + this.uniforms.uSpeed.value * dt) % (Math.PI * 2000);
    this.uniforms.uTime.value = this.wavePhase;
    void time;
  }

  pickTarget(limit: THREE.Vector3) {
    this.target.set(
      THREE.MathUtils.randFloatSpread(2 * limit.x),
      THREE.MathUtils.randFloatSpread(2 * limit.y),
      THREE.MathUtils.randFloatSpread(2 * limit.z),
    );
    // Never aim into a rock: lift the target above the rock top under it.
    if (this.floorAt) {
      const floor = this.floorAt(this.target.x, this.target.z, this.radius + this.halfSpan) + this.radius + this.length * 0.35;
      this.target.y = Math.min(limit.y, Math.max(this.target.y, floor));
    }
  }

  /** Ground height in the swim frame (rock tops), set by the tank. */
  floorAt: ((x: number, z: number, r: number) => number) | null = null;

  dispose() {
    if (!this.sharedGeometry) {
      this.group.traverse((o) => {
        if (o instanceof THREE.Mesh) o.geometry.dispose();
      });
    }
    for (const m of this.materials) {
      // Model textures are shared through the cache; only placeholder textures are owned.
      if (!this.sharedGeometry) (m as THREE.MeshStandardMaterial).map?.dispose();
      m.dispose();
    }
  }
}

/**
 * Display length: the fish's own size (fingers × finger_cm) when known, else the real adult
 * size; always clamped so it fits the tank.
 */
export function fishLengthM(species: Species, tankMinCm: number, lengthCm: number | null = null) {
  return Math.min(lengthCm ?? species.adult_length_cm, species.adult_length_cm, tankMinCm * 0.36) / 100;
}
