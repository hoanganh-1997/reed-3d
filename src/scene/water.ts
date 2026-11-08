import * as THREE from 'three';
import type { Look } from './look';

/**
 * Cues that make the tank read as full of water:
 * - blue depth gradient on the back pane,
 * - bright waterline (meniscus) on every pane,
 * - animated caustics on the sand,
 * - faint light shafts from the lid,
 * - drifting particles and a bubble stream.
 * Local space matches Tank: origin at the centre of the bottom face.
 */
export class WaterFx {
  readonly group = new THREE.Group();
  private disposables: { dispose(): void }[] = [];
  private causticMats: THREE.MeshBasicMaterial[] = [];
  private shafts: THREE.Mesh[] = [];
  private backMat: THREE.MeshBasicMaterial;
  private sideMat: THREE.MeshBasicMaterial;
  private lineMat: THREE.MeshBasicMaterial;
  private shaftMat: THREE.MeshBasicMaterial;
  private particles: THREE.Points;
  private particleBase: Float32Array;
  private bubbles: THREE.Points;
  private bubbleSeed: Float32Array;

  constructor(private L: number, private D: number, sandH: number, private waterH: number) {
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
      const m = new THREE.Mesh(this.track(new THREE.PlaneGeometry(w, band)), this.lineMat);
      m.position.set(x, waterH - band / 2, z);
      m.rotation.y = ry;
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

    // Suspended particles.
    const vol = L * D * waterH;
    const n = Math.round(THREE.MathUtils.clamp(vol * 6000, 120, 900));
    this.particleBase = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      this.particleBase[i * 3] = (Math.random() - 0.5) * L * 0.96;
      this.particleBase[i * 3 + 1] = sandH + Math.random() * (waterH - sandH);
      this.particleBase[i * 3 + 2] = (Math.random() - 0.5) * D * 0.94;
    }
    const pg = this.track(new THREE.BufferGeometry());
    pg.setAttribute('position', new THREE.BufferAttribute(this.particleBase.slice(), 3));
    const dot = this.track(dotTex());
    const pm = this.track(new THREE.PointsMaterial({ map: dot, color: '#e8f2ff', size: Math.max(0.002, L * 0.006), transparent: true, opacity: 0.45, depthWrite: false, blending: THREE.AdditiveBlending }));
    this.particles = new THREE.Points(pg, pm);
    this.particles.renderOrder = 4;

    // Bubble stream from a back corner (pump / airstone).
    const bn = 40;
    this.bubbleSeed = new Float32Array(bn * 2);
    for (let i = 0; i < bn; i++) {
      this.bubbleSeed[i * 2] = Math.random();
      this.bubbleSeed[i * 2 + 1] = Math.random() * 10;
    }
    const bg = this.track(new THREE.BufferGeometry());
    bg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(bn * 3), 3));
    const bm = this.track(new THREE.PointsMaterial({ map: this.track(bubbleTex()), color: '#ffffff', size: Math.max(0.005, Math.min(0.014, L * 0.02)), transparent: true, opacity: 0.8, depthWrite: false }));
    this.bubbles = new THREE.Points(bg, bm);
    this.bubbles.position.set(L * 0.38, 0, -D * 0.32);
    this.bubbles.userData.base = sandH;
    this.bubbles.renderOrder = 4;

    this.group.add(back, ...sides, lines, caustics, ...this.shafts, this.particles, this.bubbles);
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

    // Particles drift slowly on a gentle current.
    const pos = this.particles.geometry.attributes.position as THREE.BufferAttribute;
    const arr = pos.array as Float32Array;
    const base = this.particleBase;
    for (let i = 0; i < arr.length; i += 3) {
      const k = i * 0.37;
      arr[i] = base[i] + Math.sin(time * 0.15 + k) * this.L * 0.02;
      arr[i + 1] = base[i + 1] + Math.sin(time * 0.21 + k * 1.7) * 0.006;
      arr[i + 2] = base[i + 2] + Math.cos(time * 0.13 + k) * this.D * 0.02;
    }
    pos.needsUpdate = true;

    // Bubbles rise, wobble, and restart at the bottom.
    const bpos = this.bubbles.geometry.attributes.position as THREE.BufferAttribute;
    const barr = bpos.array as Float32Array;
    const y0 = this.bubbles.userData.base as number;
    const span = this.waterH - y0;
    const speed = 0.11;
    for (let i = 0; i < barr.length / 3; i++) {
      const t = (this.bubbleSeed[i * 2] + (time * speed) / span) % 1;
      const ph = this.bubbleSeed[i * 2 + 1];
      barr[i * 3] = Math.sin(time * 3 + ph) * 0.004 + (this.bubbleSeed[i * 2] - 0.5) * 0.01;
      barr[i * 3 + 1] = y0 + t * span;
      barr[i * 3 + 2] = Math.cos(time * 2.4 + ph) * 0.004;
    }
    bpos.needsUpdate = true;
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

function dotTex() {
  return canvas(32, 32, (g) => {
    const r = g.createRadialGradient(16, 16, 0, 16, 16, 16);
    r.addColorStop(0, 'rgba(255,255,255,1)');
    r.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = r;
    g.fillRect(0, 0, 32, 32);
  });
}

function bubbleTex() {
  return canvas(32, 32, (g) => {
    g.strokeStyle = 'rgba(255,255,255,0.9)';
    g.lineWidth = 2;
    g.beginPath();
    g.arc(16, 16, 12, 0, Math.PI * 2);
    g.stroke();
    g.fillStyle = 'rgba(255,255,255,0.25)';
    g.fill();
    g.fillStyle = 'rgba(255,255,255,0.95)';
    g.beginPath();
    g.arc(11, 11, 3, 0, Math.PI * 2);
    g.fill();
  });
}
