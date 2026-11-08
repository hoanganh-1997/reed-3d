import * as THREE from 'three';
import type { Species } from '../game/types';

/**
 * Bottom-dwelling invertebrates (starfish). They don't swim: each one rests on
 * a rock or the sand, aligned to the surface it sits on.
 *
 * Local frame: origin at the underside centre, +Y away from the surface,
 * diameter 1 (scaled by the tank). A GLB from species.model_url replaces the
 * procedural placeholder once it has loaded (see models.ts → loadInvertModel).
 */
export class Starfish {
  readonly group = new THREE.Group();
  private disposables: { dispose(): void }[] = [];

  constructor(public species: Species, public diameter: number, model: THREE.Object3D | null, seed: number) {
    const rng = mulberry32(seed);
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
    this.group.userData.spin = rng() * Math.PI * 2;
  }

  /** Rest on a surface point with the given (world-aligned, tank-local) normal. */
  placeOn(point: THREE.Vector3, normal: THREE.Vector3) {
    this.group.position.copy(point);
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), normal);
    const spin = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), this.group.userData.spin);
    this.group.quaternion.copy(q.multiply(spin));
  }

  private track<T extends { dispose(): void }>(d: T): T {
    this.disposables.push(d);
    return d;
  }

  dispose() {
    for (const d of this.disposables) d.dispose();
  }
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
