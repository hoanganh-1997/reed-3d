import * as THREE from 'three';
import type { Look } from './look';

/**
 * Cues that make the tank read as full of water:
 * - blue depth gradient on the back pane,
 * - bright waterline (meniscus) on every pane, rippling with the surface,
 * - animated caustics on the sand,
 * - faint light shafts from the lid,
 * Local space matches Tank: origin at the centre of the bottom face.
 */
/** Surface ripple amplitude for a tank of this water height (metres). */
export function waveAmplitude(waterH: number) {
  return THREE.MathUtils.clamp(waterH * 0.012, 0.002, 0.007);
}

/** Height of the water surface at tank-local (x, z): a few crossing ripple trains. */
export function waveHeight(x: number, z: number, t: number, amp: number) {
  return amp * (
    0.45 * Math.sin(x * 9 + t * 1.6) +
    0.3 * Math.sin(z * 11 - t * 1.25 + x * 3) +
    0.25 * Math.sin((x + z) * 23 + t * 2.4)
  );
}

export class WaterFx {
  readonly group = new THREE.Group();
  private disposables: { dispose(): void }[] = [];
  private causticMats: THREE.MeshBasicMaterial[] = [];
  private shafts: THREE.Mesh[] = [];
  private backMat: THREE.MeshBasicMaterial;
  private sideMat: THREE.MeshBasicMaterial;
  private lineMat: THREE.MeshBasicMaterial;
  private shaftMat: THREE.MeshBasicMaterial;
  private lineMeshes: THREE.Mesh[] = [];
  private amp: number;

  constructor(L: number, D: number, sandH: number, waterH: number) {
    this.amp = waveAmplitude(waterH);
    // Back pane: blue gradient, lighter at the top like light fading with depth.
    this.backMat = this.track(new THREE.MeshBasicMaterial({ map: this.track(gradientTex()), transparent: true, opacity: 0.85, depthWrite: false }));
    const back = new THREE.Mesh(this.track(new THREE.PlaneGeometry(L - 0.004, waterH - sandH * 0.5)), this.backMat);
    back.position.set(0, sandH * 0.5 + (waterH - sandH * 0.5) / 2, -D / 2 + 0.002);
    back.renderOrder = 1;
    // Side panes get a fainter copy so the corners do not read as empty glass.
    this.sideMat = this.track(this.backMat.clone());
    this.sideMat.opacity = 0.45;
    const sides = [-1, 1].map((sx) => {
      const m = new THREE.Mesh(this.track(new THREE.PlaneGeometry(D - 0.006, waterH - sandH * 0.5)), this.sideMat);
      m.position.set(sx * (L / 2 - 0.002), back.position.y, 0);
      m.rotation.y = -sx * Math.PI / 2;
      m.renderOrder = 1;
      return m;
    });

    // Waterline: thin bright band just under the surface on all four panes.
    this.lineMat = this.track(new THREE.MeshBasicMaterial({ color: '#cfe6ff', transparent: true, opacity: 0.55, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending }));
    const band = Math.max(0.004, waterH * 0.018);
    const lines = new THREE.Group();
    for (const [w, x, z, ry] of [
      [L, 0, D / 2 - 0.002, 0],
      [L, 0, -D / 2 + 0.003, 0],
      [D, L / 2 - 0.002, 0, Math.PI / 2],
      [D, -L / 2 + 0.002, 0, Math.PI / 2],
    ] as const) {
      const geo = this.track(new THREE.PlaneGeometry(w, band, Math.max(8, Math.round(w / 0.01)), 1));
      const m = new THREE.Mesh(geo, this.lineMat);
      m.position.set(x, waterH - band / 2, z);
      m.rotation.y = ry;
      m.userData.alongX = ry === 0;
      m.userData.base = (geo.attributes.position.array as Float32Array).slice();
      this.lineMeshes.push(m);
      m.renderOrder = 4;
      lines.add(m);
    }

    // Caustics: two scrolling layers of the same pattern, added on top of the sand.
    const causticTex = this.track(causticTexture());
    causticTex.wrapS = causticTex.wrapT = THREE.RepeatWrapping;
    const caustics = new THREE.Group();
    const rep = Math.max(1, Math.round(L / 0.25));
    for (let i = 0; i < 2; i++) {
      const tex = causticTex.clone();
      this.track(tex);
      tex.repeat.set(rep * (i ? 1.3 : 1), rep * (D / L) * (i ? 1.3 : 1));
      const mat = this.track(new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: 0.32, blending: THREE.AdditiveBlending, depthWrite: false }));
      this.causticMats.push(mat);
      const p = new THREE.Mesh(this.track(new THREE.PlaneGeometry(L - 0.004, D - 0.004)), mat);
      p.rotation.x = -Math.PI / 2;
      p.position.y = sandH + 0.001 + i * 0.0005;
      caustics.add(p);
    }

    // Light shafts from the lid.
    this.shaftMat = this.track(new THREE.MeshBasicMaterial({ map: this.track(shaftTex()), transparent: true, opacity: 0.07, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
    const shaftCount = Math.max(3, Math.round(L / 0.12));
    for (let i = 0; i < shaftCount; i++) {
      const w = L * (0.06 + Math.random() * 0.06);
      const m = new THREE.Mesh(this.track(new THREE.PlaneGeometry(w, waterH - sandH)), this.shaftMat);
      m.position.set((i / (shaftCount - 1) - 0.5) * L * 0.8, sandH + (waterH - sandH) / 2, (Math.random() - 0.5) * D * 0.5);
      m.rotation.z = (Math.random() - 0.5) * 0.25;
      m.userData.phase = Math.random() * 10;
      m.renderOrder = 4;
      this.shafts.push(m);
    }

    this.group.add(back, ...sides, lines, caustics, ...this.shafts);
  }

  setLook(look: Look) {
    this.backMat.color.copy(look.water_back);
    this.sideMat.color.copy(look.water_back);
    const tint = look.tank_light.clone().lerp(new THREE.Color('#ffffff'), 0.5);
    for (const m of this.causticMats) m.color.copy(tint);
    this.shaftMat.color.copy(tint);
  }

  update(time: number) {
    const [a, b] = this.causticMats;
    a.map!.offset.set(time * 0.012, time * 0.008);
    b.map!.offset.set(-time * 0.009, time * 0.011);
    for (const s of this.shafts) {
      const p = s.userData.phase as number;
      s.scale.x = 0.8 + Math.sin(time * 0.6 + p) * 0.25;
    }
    this.shaftMat.opacity = 0.05 + Math.sin(time * 0.4) * 0.015;

    // Waterline follows the surface waves.
    for (const m of this.lineMeshes) {
      const pos = m.geometry.attributes.position as THREE.BufferAttribute;
      const base = m.userData.base as Float32Array;
      for (let i = 0; i < pos.count; i++) {
        const lx = base[i * 3];
        const wx = m.userData.alongX ? lx + m.position.x : m.position.x;
        const wz = m.userData.alongX ? m.position.z : m.position.z - lx;
        pos.setY(i, base[i * 3 + 1] + waveHeight(wx, wz, time, this.amp));
      }
      pos.needsUpdate = true;
    }
  }

  dispose() {
    for (const d of this.disposables) d.dispose();
  }

  private track<T extends { dispose(): void }>(d: T): T {
    this.disposables.push(d);
    return d;
  }
}

function canvas(w: number, h: number, draw: (g: CanvasRenderingContext2D) => void) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d')!);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** White at the top, fading down; tinted by material colour. */
function gradientTex() {
  return canvas(4, 128, (g) => {
    const grad = g.createLinearGradient(0, 0, 0, 128);
    grad.addColorStop(0, 'rgba(255,255,255,0.95)');
    grad.addColorStop(0.5, 'rgba(170,170,170,0.9)');
    grad.addColorStop(1, 'rgba(70,70,70,0.9)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 4, 128);
  });
}

/** Tileable caustic web: bright thin cells, built from a jittered Voronoi edge pattern. */
function causticTexture() {
  const S = 256;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d')!;
  const img = g.createImageData(S, S);
  const cells = 7;
  const pts: [number, number][] = [];
  let seed = 1234;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let y = 0; y < cells; y++) for (let x = 0; x < cells; x++) pts.push([(x + rnd()) / cells, (y + rnd()) / cells]);
  for (let py = 0; py < S; py++) {
    for (let px = 0; px < S; px++) {
      const u = px / S;
      const v = py / S;
      let d1 = 9;
      let d2 = 9;
      for (const [x, y] of pts) {
        for (let ox = -1; ox <= 1; ox++) {
          for (let oy = -1; oy <= 1; oy++) {
            const dx = u - (x + ox);
            const dy = v - (y + oy);
            const d = dx * dx + dy * dy;
            if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) d2 = d;
          }
        }
      }
      const edge = Math.sqrt(d2) - Math.sqrt(d1);
      const val = Math.pow(Math.max(0, 1 - edge * 14), 3);
      const i = (py * S + px) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = 255;
      img.data[i + 3] = Math.round(val * 255);
    }
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function shaftTex() {
  return canvas(64, 128, (g) => {
    const h = g.createLinearGradient(0, 0, 64, 0);
    h.addColorStop(0, 'rgba(255,255,255,0)');
    h.addColorStop(0.5, 'rgba(255,255,255,1)');
    h.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = h;
    g.fillRect(0, 0, 64, 128);
    g.globalCompositeOperation = 'destination-in';
    const v = g.createLinearGradient(0, 0, 0, 128);
    v.addColorStop(0, 'rgba(0,0,0,1)');
    v.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = v;
    g.fillRect(0, 0, 64, 128);
  });
}
