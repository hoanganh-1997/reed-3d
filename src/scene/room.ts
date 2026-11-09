import * as THREE from 'three';
import gameConfig from '../../config/game.json';
import { loadRoomModel } from './models';

/**
 * Placeholder living room built from simple primitives. The room never moves;
 * only the stand under the tank (and the props on it) adapt to the tank size.
 * Swap pieces for CC0 models later (credit them in ASSETS_CREDITS.md).
 */

export const ROOM = {
  backZ: -2.0,
  halfWidth: 3.6,
  frontZ: 3.5,
  height: 2.7,
};

function canvasTex(w: number, h: number, draw: (g: CanvasRenderingContext2D) => void, repeat?: [number, number]) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d')!);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  if (repeat) {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(...repeat);
  }
  return t;
}

const woodFloor = () =>
  canvasTex(512, 512, (g) => {
    const colors = ['#7a5640', '#6d4b37', '#83604a', '#654432', '#755240'];
    const plankH = 64;
    for (let row = 0; row < 8; row++) {
      let x = -((row * 97) % 200);
      let i = row;
      while (x < 512) {
        const w = 180 + ((i * 53) % 120);
        g.fillStyle = colors[(i * 7 + row) % colors.length];
        g.fillRect(x, row * plankH, w, plankH);
        g.fillStyle = 'rgba(30,18,10,0.35)';
        g.fillRect(x, row * plankH, 2, plankH);
        for (let k = 0; k < 6; k++) {
          g.fillStyle = `rgba(0,0,0,${0.04 + (k % 3) * 0.02})`;
          g.fillRect(x, row * plankH + 8 + k * 9, w, 1);
        }
        x += w;
        i++;
      }
      g.fillStyle = 'rgba(25,15,8,0.5)';
      g.fillRect(0, row * plankH, 512, 2);
    }
  }, [3, 3]);

const sunsetSky = () =>
  canvasTex(64, 256, (g) => {
    const grad = g.createLinearGradient(0, 0, 0, 256);
    grad.addColorStop(0, '#49508a');
    grad.addColorStop(0.42, '#9a6b95');
    grad.addColorStop(0.76, '#e79a6c');
    grad.addColorStop(1, '#f7c78a');
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 256);
    g.fillStyle = '#343a5c';
    g.fillRect(0, 225, 64, 31);
  });

export class Room {
  readonly group = new THREE.Group();
  private stand = new THREE.Group();
  private standBody: THREE.Mesh;
  private standTop: THREE.Mesh;
  private handles: THREE.Mesh[] = [];
  private lamp = new THREE.Group();
  private books = new THREE.Group();
  private smallPlant = new THREE.Group();
  readonly sun: THREE.DirectionalLight;
  readonly lampLight: THREE.PointLight;

  /** Props that fade out when they block the view of the tank while orbiting. */
  private occluders: THREE.Object3D[] = [];
  private fade = new Map<THREE.Object3D, number>();

  private cur = { w: 1.1, d: 0.45, h: 0.76, tankW: 0.3 };
  private goal = { ...this.cur };

  constructor() {
    const g = this.group;
    const wallMat = new THREE.MeshStandardMaterial({ color: '#a8927d', roughness: 0.95 });
    const floorMat = new THREE.MeshStandardMaterial({ map: woodFloor(), roughness: 0.75 });

    const W = ROOM.halfWidth * 2;
    const Dp = ROOM.frontZ - ROOM.backZ;
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(W, Dp), floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.position.z = ROOM.backZ + Dp / 2;
    floor.receiveShadow = true;

    const back = new THREE.Mesh(new THREE.PlaneGeometry(W, ROOM.height), wallMat);
    back.position.set(0, ROOM.height / 2, ROOM.backZ);
    back.receiveShadow = true;
    const left = new THREE.Mesh(new THREE.PlaneGeometry(Dp, ROOM.height), wallMat);
    left.rotation.y = Math.PI / 2;
    left.position.set(-ROOM.halfWidth, ROOM.height / 2, ROOM.backZ + Dp / 2);
    left.receiveShadow = true;
    const right = left.clone();
    right.rotation.y = -Math.PI / 2;
    right.position.x = ROOM.halfWidth;
    const ceiling = new THREE.Mesh(new THREE.PlaneGeometry(W, Dp), new THREE.MeshStandardMaterial({ color: '#8f7f70' }));
    ceiling.rotation.x = Math.PI / 2;
    ceiling.position.set(0, ROOM.height, ROOM.backZ + Dp / 2);

    const baseMat = new THREE.MeshStandardMaterial({ color: '#6a5a4e', roughness: 0.7 });
    const baseboard = new THREE.Mesh(new THREE.BoxGeometry(W, 0.09, 0.015), baseMat);
    baseboard.position.set(0, 0.045, ROOM.backZ + 0.008);

    g.add(floor, back, left, right, ceiling, baseboard);

    // Rug
    const rug = new THREE.Mesh(
      new THREE.PlaneGeometry(3.2, 1.9),
      new THREE.MeshStandardMaterial({
        map: canvasTex(256, 160, (c) => {
          c.fillStyle = '#7b4a3a';
          c.fillRect(0, 0, 256, 160);
          c.strokeStyle = '#d8b48a';
          c.lineWidth = 6;
          c.strokeRect(12, 12, 232, 136);
          c.strokeStyle = '#a5684d';
          c.lineWidth = 3;
          c.strokeRect(26, 26, 204, 108);
        }),
        roughness: 1,
      }),
    );
    rug.rotation.x = -Math.PI / 2;
    rug.position.set(0, 0.004, -0.2);
    rug.receiveShadow = true;
    g.add(rug);

    this.buildWindow();
    this.buildShelf();
    this.buildChair();
    this.buildBigPlant();

    // Stand / cabinet under the tank (unit geometry scaled by tween)
    const woodMat = new THREE.MeshStandardMaterial({ color: '#5a3d2c', roughness: 0.6 });
    const topMat = new THREE.MeshStandardMaterial({ color: '#a87a58', roughness: 0.5 });
    this.standBody = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), woodMat);
    this.standBody.castShadow = this.standBody.receiveShadow = true;
    this.standTop = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), topMat);
    this.standTop.receiveShadow = true;
    const handleMat = new THREE.MeshStandardMaterial({ color: '#c9a86a', metalness: 0.7, roughness: 0.3 });
    for (let i = 0; i < 4; i++) {
      const h = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.12, 0.012), handleMat);
      this.handles.push(h);
      this.stand.add(h);
    }
    this.stand.add(this.standBody, this.standTop);
    g.add(this.stand);

    // Props on the stand
    this.buildLamp();
    this.buildBooks();
    this.buildSmallPlant();
    g.add(this.lamp, this.books, this.smallPlant);
    this.occluders.push(this.lamp, this.books, this.smallPlant);

    // Lighting: warm low sun through the window, dim ambient, desk lamp.
    const hemi = new THREE.HemisphereLight('#ffd7b0', '#2a1c14', 0.2);
    this.sun = new THREE.DirectionalLight('#ff9f5e', 0.9);
    this.sun.position.set(-3.2, 2.4, 2.5);
    this.sun.target.position.set(0.5, 0.4, -1.6);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(1024, 1024);
    const cam = this.sun.shadow.camera;
    cam.left = -3.5; cam.right = 3.5; cam.top = 3; cam.bottom = -2; cam.near = 0.5; cam.far = 10;
    this.sun.shadow.bias = -0.0008;
    this.lampLight = new THREE.PointLight('#ffcf82', 0.7, 1.6, 1.8);
    this.lamp.add(this.lampLight);
    this.lampLight.position.set(0, 0.24, 0.02);
    g.add(hemi, this.sun, this.sun.target);

    this.applyStand();
  }

  /** Viewing mode: hide every prop and wall, keep the lights. */
  setFocus(on: boolean) {
    for (const c of this.group.children) {
      if (!(c instanceof THREE.Light) && c !== this.sun.target) c.visible = !on;
    }
  }

  /** Request a new stand size; it animates in `update`. */
  setStand(tankLengthM: number, tankDepthM: number, standHeightM: number, instant = false) {
    this.goal = { w: tankLengthM + 0.8, d: Math.max(0.42, tankDepthM + 0.08), h: standHeightM, tankW: tankLengthM };
    if (instant) {
      this.cur = { ...this.goal };
      this.applyStand();
    }
  }

  standCentreZ(depth = this.goal.d) {
    return ROOM.backZ + 0.04 + depth / 2;
  }

  update(dt: number) {
    const k = 1 - Math.exp(-dt * 5);
    let moved = false;
    for (const key of ['w', 'd', 'h', 'tankW'] as const) {
      const diff = this.goal[key] - this.cur[key];
      if (Math.abs(diff) > 1e-4) {
        this.cur[key] += diff * k;
        moved = true;
      }
    }
    if (moved) this.applyStand();
  }

  /** Fade props whose bounds cross the line of sight from camera to tank. */
  fadeOccluders(camera: THREE.Vector3, targets: THREE.Vector3[], dt: number) {
    const box = new THREE.Box3();
    const hit = new THREE.Vector3();
    const rays = targets.map((t) => ({ ray: new THREE.Ray(camera.clone(), t.clone().sub(camera).normalize()), max: camera.distanceTo(t) }));
    for (const o of this.occluders) {
      box.setFromObject(o).expandByScalar(0.02);
      const blocking = rays.some(({ ray, max }) => {
        const p = ray.intersectBox(box, hit);
        return !!p && camera.distanceTo(p) < max - 0.05;
      });
      const cur = this.fade.get(o) ?? 1;
      const goal = blocking ? 0.12 : 1;
      if (Math.abs(cur - goal) < 1e-3) continue;
      const next = cur + (goal - cur) * (1 - Math.exp(-dt * 8));
      this.fade.set(o, next);
      o.traverse((m) => {
        if (!(m instanceof THREE.Mesh)) return;
        const mat = m.material as THREE.MeshStandardMaterial;
        mat.transparent = next < 0.999;
        mat.opacity = next;
        mat.depthWrite = next > 0.5;
        m.castShadow = next > 0.5;
      });
    }
  }

  private applyStand() {
    const { w, d, h, tankW } = this.cur;
    const z = this.standCentreZ(d);
    const topT = 0.03;
    this.standBody.scale.set(w, h - topT - 0.06, d - 0.02);
    this.standBody.position.set(0, 0.06 + (h - topT - 0.06) / 2, z);
    this.standTop.scale.set(w + 0.03, topT, d + 0.02);
    this.standTop.position.set(0, h - topT / 2, z);
    const doors = w > 2 ? 4 : 2;
    this.handles.forEach((m, i) => {
      m.visible = i < doors;
      const seg = w / doors;
      const x = -w / 2 + seg * (i + 0.5) + (i % 2 === 0 ? seg * 0.38 : -seg * 0.38);
      m.position.set(x, h * 0.62, z + d / 2);
    });
    const edgeL = -tankW / 2;
    const edgeR = tankW / 2;
    this.lamp.position.set(edgeL - 0.17, h, z - d * 0.1);
    this.books.position.set(Math.max(-w / 2 + 0.1, edgeL - 0.34), h, z + d * 0.15);
    this.smallPlant.position.set(edgeR + 0.17, h, z);
  }

  private buildWindow() {
    const x = -2.45;
    const y = 1.55;
    const w = 0.95;
    const h = 1.15;
    const sky = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: sunsetSky() }));
    sky.position.set(x, y, ROOM.backZ + 0.005);
    const frameMat = new THREE.MeshStandardMaterial({ color: '#e0d5c4', roughness: 0.6 });
    const bars = [
      [w + 0.08, 0.05, 0, h / 2],
      [w + 0.08, 0.05, 0, -h / 2],
      [0.05, h, -w / 2, 0],
      [0.05, h, w / 2, 0],
      [0.03, h, 0, 0],
      [w, 0.03, 0, h * 0.12],
    ];
    const frame = new THREE.Group();
    for (const [bw, bh, bx, by] of bars) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(bw, bh, 0.05), frameMat);
      m.position.set(bx, by, 0);
      frame.add(m);
    }
    const sill = new THREE.Mesh(new THREE.BoxGeometry(w + 0.2, 0.035, 0.16), frameMat);
    sill.position.set(0, -h / 2 - 0.03, 0.06);
    frame.add(sill);
    frame.position.set(x, y, ROOM.backZ + 0.02);

    const curtainMat = new THREE.MeshStandardMaterial({ color: '#bfa694', roughness: 1, side: THREE.DoubleSide });
    for (const side of [-1, 1]) {
      const c = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.14, h + 0.45, 12, 1, true, 0, Math.PI), curtainMat);
      c.rotation.y = Math.PI;
      c.position.set(x + side * (w / 2 + 0.12), y - 0.1, ROOM.backZ + 0.12);
      c.castShadow = true;
      this.group.add(c);
    }
    const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, w + 0.7), new THREE.MeshStandardMaterial({ color: '#34281f' }));
    rod.rotation.z = Math.PI / 2;
    rod.position.set(x, y + h / 2 + 0.17, ROOM.backZ + 0.12);

    // Warm light spilling from the window onto the floor/wall
    const glow = new THREE.SpotLight('#ff9d5c', 3, 6, Math.PI / 5, 0.8, 1.5);
    glow.position.set(x, y + 0.3, ROOM.backZ + 0.3);
    glow.target.position.set(x + 1.2, 0, 0.6);
    this.group.add(sky, frame, rod, glow, glow.target);
  }

  private buildShelf() {
    const shelf = new THREE.Group();
    const wood = new THREE.MeshStandardMaterial({ color: '#a87a58', roughness: 0.6 });
    const board = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.028, 0.2), wood);
    board.castShadow = true;
    shelf.add(board);
    const colors = ['#7e4a3e', '#c9b48f', '#3e5f6e', '#8a8458', '#b16e50', '#5d6f62'];
    let x = -0.4;
    colors.forEach((c, i) => {
      const bw = 0.035 + (i % 3) * 0.012;
      const bh = 0.2 + ((i * 37) % 7) * 0.012;
      const b = new THREE.Mesh(new THREE.BoxGeometry(bw, bh, 0.15), new THREE.MeshStandardMaterial({ color: c, roughness: 0.8 }));
      b.position.set(x + bw / 2, bh / 2 + 0.014, 0);
      if (i === 4) b.rotation.z = -0.25;
      b.castShadow = true;
      shelf.add(b);
      x += bw + 0.004;
    });
    const pot = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.04, 0.09, 12), new THREE.MeshStandardMaterial({ color: '#e6dccb' }));
    pot.position.set(0.32, 0.06, 0);
    const leaves = new THREE.Mesh(new THREE.IcosahedronGeometry(0.08, 1), new THREE.MeshStandardMaterial({ color: '#3f8560', flatShading: true }));
    leaves.position.set(0.32, 0.15, 0);
    leaves.scale.set(1, 0.8, 1);
    shelf.add(pot, leaves);
    shelf.position.set(2.0, 1.55, ROOM.backZ + 0.1);
    this.group.add(shelf);
  }

  /**
   * Seat by the window. A CC0 Poly Haven leather Chesterfield sofa
   * (`visual.room_sofa_model`) replaces the procedural armchair once loaded.
   */
  private buildChair() {
    const seat = new THREE.Group();
    const placeholder = this.buildPlaceholderChair();
    seat.add(placeholder);
    seat.position.set(-2.1, 0, -0.8);
    seat.rotation.y = 0.65;
    this.group.add(seat);
    this.occluders.push(seat);
    const visual = gameConfig.visual as { room_sofa_model?: string; room_sofa_height?: number; room_sofa_pos?: number[]; room_sofa_yaw?: number };
    if (!visual.room_sofa_model) return;
    loadRoomModel(visual.room_sofa_model, visual.room_sofa_height ?? 0.78)
      .then((model) => {
        seat.remove(placeholder);
        const [x, z] = visual.room_sofa_pos ?? [-2.4, -1.1];
        seat.position.set(x, 0, z);
        seat.rotation.y = visual.room_sofa_yaw ?? 0.55;
        seat.add(model);
        this.fade.delete(seat);
      })
      .catch(() => {});
  }

  private buildPlaceholderChair() {
    const chair = new THREE.Group();
    const fabric = new THREE.MeshStandardMaterial({ color: '#a36a4e', roughness: 0.95 });
    const dark = new THREE.MeshStandardMaterial({ color: '#3b2a1e', roughness: 0.6 });
    const seat = new THREE.Mesh(new THREE.BoxGeometry(0.75, 0.16, 0.7), fabric);
    seat.position.y = 0.4;
    const cushion = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.08, 0.6), new THREE.MeshStandardMaterial({ color: '#c48868', roughness: 1 }));
    cushion.position.set(0, 0.51, 0.03);
    const backrest = new THREE.Mesh(new THREE.BoxGeometry(0.75, 0.6, 0.16), fabric);
    backrest.position.set(0, 0.72, -0.3);
    backrest.rotation.x = -0.12;
    const armL = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.28, 0.7), fabric);
    armL.position.set(-0.37, 0.55, 0);
    const armR = armL.clone();
    armR.position.x = 0.37;
    chair.add(seat, cushion, backrest, armL, armR);
    for (const [lx, lz] of [[-0.32, -0.28], [0.32, -0.28], [-0.32, 0.28], [0.32, 0.28]]) {
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.015, 0.32), dark);
      leg.position.set(lx, 0.16, lz);
      chair.add(leg);
    }
    const pillow = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.3, 0.1), new THREE.MeshStandardMaterial({ color: '#dcc094', roughness: 1 }));
    pillow.position.set(0, 0.68, -0.2);
    pillow.rotation.set(-0.3, 0, 0.1);
    chair.add(pillow);
    chair.traverse((o) => { if (o instanceof THREE.Mesh) o.castShadow = o.receiveShadow = true; });
    return chair;
  }

  /**
   * Big floor plant next to the stand. A CC0 Poly Haven model
   * (`visual.room_plant_model`) replaces the procedural placeholder once loaded.
   */
  private buildBigPlant() {
    const plant = new THREE.Group();
    const placeholder = this.buildPlaceholderPlant();
    plant.add(placeholder);
    plant.position.set(2.35, 0, -1.4);
    this.group.add(plant);
    this.occluders.push(plant);
    const visual = gameConfig.visual as { room_plant_model?: string; room_plant_height?: number };
    if (!visual.room_plant_model) return;
    loadRoomModel(visual.room_plant_model, visual.room_plant_height ?? 1.5)
      .then((model) => {
        plant.remove(placeholder);
        model.rotation.y = 0.6;
        plant.add(model);
        this.fade.delete(plant);
      })
      .catch(() => {});
  }

  private buildPlaceholderPlant() {
    const plant = new THREE.Group();
    const pot = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.15, 0.42, 16), new THREE.MeshStandardMaterial({ color: '#b99a6b', roughness: 0.9 }));
    pot.position.y = 0.21;
    plant.add(pot);
    const leafMat = new THREE.MeshStandardMaterial({ color: '#2f6b4c', roughness: 0.7, side: THREE.DoubleSide });
    const leafMat2 = new THREE.MeshStandardMaterial({ color: '#4e9a6e', roughness: 0.7, side: THREE.DoubleSide });
    const stemMat = new THREE.MeshStandardMaterial({ color: '#44704f' });
    for (let i = 0; i < 9; i++) {
      const a = (i / 9) * Math.PI * 2;
      const tilt = 0.25 + (i % 3) * 0.18;
      const len = 0.9 + (i % 4) * 0.22;
      const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.012, len), stemMat);
      const pivot = new THREE.Group();
      pivot.position.y = 0.42;
      pivot.rotation.set(Math.sin(a) * tilt, 0, Math.cos(a) * tilt);
      stem.position.y = len / 2;
      const leaf = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 8), i % 2 ? leafMat : leafMat2);
      leaf.scale.set(0.13, 0.32, 0.02);
      leaf.position.y = len;
      leaf.rotation.y = a;
      pivot.add(stem, leaf);
      plant.add(pivot);
    }
    plant.traverse((o) => { if (o instanceof THREE.Mesh) o.castShadow = true; });
    return plant;
  }

  private buildLamp() {
    const base = new THREE.Mesh(new THREE.SphereGeometry(0.055, 16, 12), new THREE.MeshStandardMaterial({ color: '#3e6e73', roughness: 0.55 }));
    base.scale.set(1, 1.3, 1);
    base.position.y = 0.07;
    const shade = new THREE.Mesh(
      new THREE.CylinderGeometry(0.05, 0.1, 0.13, 20, 1, true),
      new THREE.MeshStandardMaterial({ color: '#f3dfb6', emissive: '#ffcf82', emissiveIntensity: 0.6, side: THREE.DoubleSide }),
    );
    shade.position.y = 0.21;
    this.lamp.add(base, shade);
  }

  private buildBooks() {
    const colors = ['#5d6f62', '#b16e50', '#cdbb99'];
    colors.forEach((c, i) => {
      const b = new THREE.Mesh(new THREE.BoxGeometry(0.2 - i * 0.025, 0.035, 0.15 - i * 0.01), new THREE.MeshStandardMaterial({ color: c, roughness: 0.8 }));
      b.position.y = 0.018 + i * 0.035;
      b.rotation.y = (i - 1) * 0.12;
      b.castShadow = true;
      this.books.add(b);
    });
  }

  private buildSmallPlant() {
    const pot = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.045, 0.1, 14), new THREE.MeshStandardMaterial({ color: '#b5623f', roughness: 0.8 }));
    pot.position.y = 0.05;
    const leafMat = new THREE.MeshStandardMaterial({ color: '#3f8560', roughness: 0.7, side: THREE.DoubleSide });
    this.smallPlant.add(pot);
    for (let i = 0; i < 7; i++) {
      const leaf = new THREE.Mesh(new THREE.SphereGeometry(1, 10, 6), leafMat);
      leaf.scale.set(0.02, 0.08, 0.006);
      const a = (i / 7) * Math.PI * 2;
      leaf.position.set(Math.cos(a) * 0.035, 0.16, Math.sin(a) * 0.035);
      leaf.rotation.set(Math.sin(a) * 0.6, a, Math.cos(a) * 0.6);
      this.smallPlant.add(leaf);
    }
    this.smallPlant.traverse((o) => { if (o instanceof THREE.Mesh) o.castShadow = true; });
  }
}
