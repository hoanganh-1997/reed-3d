import * as THREE from 'three';
import type { Species } from '../game/types';
import gameConfig from '../../config/game.json';

/** Slight self-glow so fish colours read under blue actinic light. */
const FISH_GLOW = gameConfig.visual.fish_glow;

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
transformed.z += sin(position.x * uFreq + uTime * uSpeed) * uAmp * swimEnv;`,
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
  readonly length: number;
  velocity = new THREE.Vector3();
  target = new THREE.Vector3();
  private phase = Math.random() * 100;
  private materials: THREE.Material[] = [];

  constructor(public species: Species, lengthM: number, model?: THREE.Object3D | null) {
    this.length = lengthM;
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
      this.buildFromModel(model);
      this.group.scale.setScalar(lengthM);
      return;
    }

    const bodyMat = new THREE.MeshStandardMaterial({ color: species.body_color, emissive: species.body_color, emissiveIntensity: FISH_GLOW, roughness: 0.45, metalness: 0.05 });
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
    this.group.scale.setScalar(lengthM);
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
          mat.emissiveIntensity = gameConfig.visual.model_fish_glow;
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

  /** Called every frame with tank-local bounds (half extents, metres). */
  update(dt: number, time: number, half: THREE.Vector3, food: THREE.Vector3 | null) {
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
    const steer = desired.sub(this.velocity).multiplyScalar(Math.min(1, dt * 1.6));
    this.velocity.add(steer);
    this.velocity.y *= 0.96; // fish prefer level swimming
    p.addScaledVector(this.velocity, dt);
    p.x = THREE.MathUtils.clamp(p.x, -limit.x, limit.x);
    p.y = THREE.MathUtils.clamp(p.y, -limit.y, limit.y);
    p.z = THREE.MathUtils.clamp(p.z, -limit.z, limit.z);

    const speed = this.velocity.length();
    if (speed > 1e-4) {
      const yaw = Math.atan2(-this.velocity.z, this.velocity.x);
      const pitch = Math.atan2(this.velocity.y, Math.hypot(this.velocity.x, this.velocity.z));
      const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, yaw, pitch * 0.6, 'YZX'));
      this.group.quaternion.slerp(q, Math.min(1, dt * 3));
    }

    const rel = speed / Math.max(1e-4, this.length);
    this.uniforms.uSpeed.value = 5 + rel * 6;
    this.uniforms.uAmp.value = 0.04 + Math.min(0.06, rel * 0.03);
    this.uniforms.uTime.value = time + this.phase;
  }

  pickTarget(limit: THREE.Vector3) {
    this.target.set(
      THREE.MathUtils.randFloatSpread(2 * limit.x),
      THREE.MathUtils.randFloatSpread(2 * limit.y),
      THREE.MathUtils.randFloatSpread(2 * limit.z),
    );
  }

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

/** Display length: real adult size, clamped so it fits the tank. */
export function fishLengthM(species: Species, tankMinCm: number) {
  return Math.min(species.adult_length_cm, tankMinCm * 0.36) / 100;
}
