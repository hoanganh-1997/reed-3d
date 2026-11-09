import * as THREE from 'three';
import type { Resident, Species, TankTier } from '../game/types';
import { Fish, fishLengthM } from './fish';
import { avoidance, resolveOverlaps, resolveRocks, rockAvoidance } from './avoid';
import { RockField } from './rockfield';
import { cachedFishModel, cachedInvertModel, loadRockModel, type Axis } from './models';
import { Starfish, starfishDiameterM, type Seabed } from './starfish';
import gameConfig from '../../config/game.json';
import type { Look } from './look';
import { WaterFx, waveAmplitude, waveHeight } from './water';
import { Anemone } from './anemone';

const ROCK_MODELS: string[] = gameConfig.visual.rock_models ?? [];
/** Starfish crawl speed in body diameters per second. */
const STARFISH_SPEED: number = (gameConfig.visual as { starfish_speed?: number }).starfish_speed ?? 0.12;

/** Height of the stand top for a tier (metres). Large tanks sit on a lower stand. */
export function standHeightFor(tier: TankTier) {
  return tier.length_cm > 100 ? 0.62 : 0.76;
}

const GLASS = 0.006;

/**
 * One aquarium: glass, water, sand, rocks, lid light, fish.
 * The group origin is the centre of the tank's bottom face.
 */
export class Tank {
  readonly group = new THREE.Group();
  readonly size: THREE.Vector3; // inner size in metres (x=length, y=height, z=depth)
  readonly fish: Fish[] = [];
  private residentKeys = '';
  readonly inverts: Starfish[] = [];
  private avoid: THREE.Vector3[] = [];
  /** Rock height map for fish; rebuilt lazily whenever the rock layout changes. */
  private rockField!: RockField;
  private rockFieldDirty = true;
  private invertGroup = new THREE.Group();
  private rocks = new THREE.Group();
  private sand!: THREE.Mesh;
  private waterGroup = new THREE.Group();
  private ghostGroup = new THREE.Group();
  private surface: THREE.Mesh;
  private pellets: { mesh: THREE.Mesh; vy: number }[] = [];
  private disposables: { dispose(): void }[] = [];
  readonly light: THREE.PointLight;
  readonly spot: THREE.SpotLight;
  private waterMat: THREE.MeshPhysicalMaterial;
  private surfMat: THREE.MeshPhysicalMaterial;
  private waveAmp: number;
  private lidMat: THREE.MeshStandardMaterial;
  private look: Look;
  private waterFx: WaterFx;
  private spotScale: number;
  private glowBase = 1;
  private anemone: Anemone;

  constructor(public tier: TankTier, look: Look) {
    this.look = look;
    const L = tier.length_cm / 100;
    const H = tier.height_cm / 100;
    const D = tier.depth_cm / 100;
    this.size = new THREE.Vector3(L, H, D);
    this.bed = {
      ground: (x, z) => this.groundAt(x, z),
      halfX: L / 2 - 0.001,
      halfZ: D / 2 - 0.001,
      floorY: Math.max(0.015, H * 0.08),
      waterY: H * 0.93,
    };
    this.rockField = new RockField(L / 2, D / 2, Math.max(0.006, Math.min(L, D) / 40), this.bed.floorY);

    // Glass panes
    const glassMat = this.track(new THREE.MeshPhysicalMaterial({
      color: '#d8f3f6',
      transparent: true,
      opacity: 0.12,
      roughness: 0.05,
      metalness: 0,
      depthWrite: false,
      side: THREE.DoubleSide,
    }));
    const glassGeo = this.track(new THREE.BoxGeometry(L + GLASS * 2, H + GLASS, D + GLASS * 2));
    const glass = new THREE.Mesh(glassGeo, glassMat);
    glass.position.y = (H + GLASS) / 2;
    glass.renderOrder = 3;

    // Silicone edges
    const edgeGeo = this.track(new THREE.EdgesGeometry(glassGeo));
    const edges = new THREE.LineSegments(edgeGeo, this.track(new THREE.LineBasicMaterial({ color: '#1d2b33', transparent: true, opacity: 0.8 })));
    edges.position.copy(glass.position);

    // Water volume (slightly below rim)
    const waterH = H * 0.93;
    const waterMat = (this.waterMat = this.track(new THREE.MeshPhysicalMaterial({
      transparent: true,
      roughness: 0.1,
      depthWrite: false,
    })));
    const water = new THREE.Mesh(this.track(new THREE.BoxGeometry(L - 0.002, waterH, D - 0.002)), waterMat);
    water.position.y = waterH / 2;
    water.renderOrder = 2;

    // Rippling, glossy water surface (normals recomputed each frame so highlights move).
    const surfMat = (this.surfMat = this.track(new THREE.MeshPhysicalMaterial({
      color: '#e2eeff', emissiveIntensity: 0.12, roughness: 0.06, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.05,
      transparent: true, opacity: 0.42, depthWrite: false, side: THREE.DoubleSide,
    })));
    this.waveAmp = waveAmplitude(waterH);
    this.surface = new THREE.Mesh(
      this.track(new THREE.PlaneGeometry(L, D, Math.min(96, Math.max(24, Math.round(L / 0.012))), Math.min(48, Math.max(12, Math.round(D / 0.012))))),
      surfMat,
    );
    this.surface.rotation.x = -Math.PI / 2;
    this.surface.position.y = waterH;
    this.surface.renderOrder = 2;

    // Sand bed + rocks
    const sandH = Math.max(0.015, H * 0.08);
    const sand = new THREE.Mesh(
      this.track(new THREE.BoxGeometry(L - 0.002, sandH, D - 0.002)),
      this.track(new THREE.MeshStandardMaterial({ color: '#d6d2c4', roughness: 0.95 })),
    );
    sand.position.y = sandH / 2;
    sand.receiveShadow = true;
    this.sand = sand;

    const rockMat = this.track(new THREE.MeshStandardMaterial({ color: '#8a7a78', roughness: 0.95 }));
    const rocks = this.rocks;
    const rng = mulberry32(tier.sort_order * 977);
    const rockCount = tier.length_cm > 100 ? 7 : 3;
    for (let i = 0; i < rockCount; i++) {
      const r = Math.min(L, D) * (0.09 + rng() * 0.08);
      const g = this.track(rockGeometry(r, rng));
      const m = new THREE.Mesh(g, rockMat);
      m.scale.set(1.2, 0.7 + rng() * 0.5, 1);
      m.position.set((rng() - 0.5) * L * 0.75, sandH + r * 0.4, -D * 0.25 + (rng() - 0.5) * D * 0.3);
      m.rotation.set(rng() * 3, rng() * 3, rng() * 3);
      m.castShadow = true;
      rocks.add(m);
      // Swap the procedural placeholder for a real rock model once it has loaded.
      if (ROCK_MODELS.length) {
        const url = ROCK_MODELS[Math.floor(rng() * ROCK_MODELS.length)];
        const size = Math.min(L, D) * (0.3 + rng() * 0.2);
        const yaw = rng() * Math.PI * 2;
        const at = m.position.clone();
        loadRockModel(url).then((src) => {
          if (this.disposed) return;
          const rock = src.clone();
          rock.scale.setScalar(size);
          rock.rotation.y = yaw;
          rock.position.set(at.x, sandH - size * 0.04, at.z);
          rocks.remove(m);
          rocks.add(rock);
          this.rockFieldDirty = true;
          this.placeInverts();
        }, () => {});
      }
    }

    // Lid light bar
    const lid = new THREE.Mesh(
      this.track(new THREE.BoxGeometry(L * 0.9, 0.012, Math.min(0.08, D * 0.3))),
      (this.lidMat = this.track(new THREE.MeshStandardMaterial({ emissiveIntensity: 2.4 }))),
    );
    lid.position.y = H + GLASS + 0.008;

    // Tank is the brightest light in the room.
    this.spotScale = 1 / Math.pow(H * 0.6, 1.4);
    // Wide cone with no distance falloff. The soft penumbra edge is pushed outside the
    // tank (inner cone already covers every corner), so the centre is not brighter than the sides.
    const PENUMBRA = 0.1;
    const cover = Math.atan(Math.hypot(L, D) / 2 / (H * 0.95)) * 1.02;
    this.spot = new THREE.SpotLight('#ffffff', 1, 0, Math.min(Math.PI / 2.05, cover / (1 - PENUMBRA)), PENUMBRA, 0);
    this.spot.position.set(0, H + 0.05, 0);
    this.spot.target.position.set(0, 0, 0);
    this.spot.castShadow = true;
    this.spot.shadow.mapSize.set(512, 512);
    // Front fill: far in front of the glass and with no distance decay, so it reaches every
    // fish with the same strength (a close light with falloff made a white hotspot in the middle).
    // Placed high above the viewer so its glossy reflection does not sit mid-tank.
    const fillZ = D / 2 + Math.max(0.5, L * 0.8);
    this.light = new THREE.PointLight('#ffffff', 1, Math.hypot(fillZ + D, H * 2) + 0.3, 0);
    this.light.position.set(0, H * 2, fillZ);

    // Bubble-tip anemone on the sand, front right, clear of the back-row rocks.
    this.anemone = new Anemone(THREE.MathUtils.clamp(Math.min(L, D) * 0.36, 0.1, 0.24), tier.sort_order);
    this.anemone.group.position.set(L * 0.24, sandH * 0.85, D * 0.12);
    this.anemone.group.rotation.y = rng() * Math.PI * 2;

    this.waterFx = new WaterFx(L, D, sandH, waterH);
    this.waterGroup.add(water, this.surface, sand, rocks, this.anemone.group, this.waterFx.group, this.invertGroup, this.spot, this.spot.target, this.light, lid);
    this.setLook(look);
    this.group.add(this.waterGroup, glass, edges);

    // Ghost: shown when previewing a locked tier
    const ghostMat = this.track(new THREE.LineDashedMaterial({ color: '#f7c93b', dashSize: 0.03, gapSize: 0.02 }));
    const ghostEdges = new THREE.LineSegments(edgeGeo, ghostMat);
    ghostEdges.computeLineDistances();
    ghostEdges.position.copy(glass.position);
    const ghostFill = new THREE.Mesh(glassGeo, this.track(new THREE.MeshBasicMaterial({ color: '#f7c93b', transparent: true, opacity: 0.06, depthWrite: false })));
    ghostFill.position.copy(glass.position);
    this.ghostGroup.add(ghostEdges, ghostFill);
    this.ghostGroup.visible = false;
    this.group.add(this.ghostGroup);
  }

  setGhost(ghost: boolean) {
    this.ghostGroup.visible = ghost;
    this.waterGroup.visible = !ghost;
    for (const f of this.fish) f.group.visible = !ghost;
    this.group.children.forEach((c) => {
      if (c !== this.ghostGroup && c !== this.waterGroup && !this.fish.some((f) => f.group === c)) c.visible = !ghost;
    });
  }

  /** Apply a blended white/actinic look to lights, water and fish. */
  setLook(look: Look) {
    this.look = look;
    this.spot.color.copy(look.tank_light);
    this.spot.intensity = look.tank_light_intensity * this.spotScale;
    this.light.color.copy(look.tank_glow);
    this.glowBase = look.tank_glow_intensity;
    this.light.intensity = this.glowBase;
    this.waterMat.color.copy(look.water_color);
    this.waterMat.emissive.copy(look.water_emissive);
    this.waterMat.emissiveIntensity = look.water_emissive_intensity;
    this.waterMat.opacity = look.water_opacity;
    this.surfMat.emissive.copy(look.lid_light);
    this.lidMat.color.copy(look.lid_light);
    this.lidMat.emissive.copy(look.lid_light);
    for (const f of this.fish) f.setGlow(look);
    this.anemone.setGlow(look);
    this.waterFx.setLook(look);
  }

  /**
   * Show these residents. When the same fish are already swimming (e.g. after feeding) they
   * keep their places and only ease to their new size; `rebuild` forces fresh meshes
   * (a GLB just loaded).
   */
  setFish(all: Resident[], rebuild = false) {
    const minCm = Math.min(this.tier.length_cm, this.tier.depth_cm, this.tier.height_cm);
    const swimmers = all.filter((r) => r.species.kind !== 'invert');
    const keys = all.map((r) => r.key).join('|');
    if (!rebuild && keys === this.residentKeys && swimmers.length === this.fish.length) {
      swimmers.forEach((r, i) => this.fish[i].setLength(fishLengthM(r.species, minCm, r.lengthCm)));
      return;
    }
    this.residentKeys = keys;
    for (const f of this.fish) {
      this.group.remove(f.group);
      f.dispose();
    }
    this.fish.length = 0;
    this.setInverts(all.filter((r) => r.species.kind === 'invert').map((r) => r.species), minCm);
    for (const r of swimmers) {
      const s = r.species;
      const model = s.model_url ? cachedFishModel(s.model_url, s.model_forward as Axis) : null;
      const f = new Fish(s, fishLengthM(s, minCm, r.lengthCm), model);
      f.floorAt = (x, z, r) => this.rockField.heightNear(x, z, r) - this.swimCentreY();
      f.setGlow(this.look);
      const half = this.halfInner();
      // Spawn away from fish already placed (best of a few random tries).
      const spot = new THREE.Vector3();
      let bestGap = -Infinity;
      for (let k = 0; k < 24; k++) {
        f.pickTarget(half.clone().multiplyScalar(0.6));
        const gapNow = Math.min(Infinity, ...this.fish.map((o) => o.group.position.clone().setY(o.group.position.y - this.swimCentreY()).distanceTo(f.target) - o.radius - f.radius - Math.max(o.halfSpan, f.halfSpan)));
        if (gapNow > bestGap) { bestGap = gapNow; spot.copy(f.target); }
        if (gapNow > f.length) break;
      }
      f.group.position.copy(spot).setY(spot.y + this.swimCentreY());
      f.pickTarget(half.clone().multiplyScalar(0.6));
      this.fish.push(f);
      this.group.add(f.group);
    }
  }

  private setInverts(list: Species[], minCm: number) {
    for (const s of this.inverts) {
      this.invertGroup.remove(s.group);
      s.dispose();
    }
    this.inverts.length = 0;
    const seen = new Map<string, number>();
    for (const sp of list) {
      const n = seen.get(sp.id) ?? 0;
      seen.set(sp.id, n + 1);
      const model = sp.model_url ? cachedInvertModel(sp.model_url) : null;
      const star = new Starfish(sp, starfishDiameterM(sp, minCm), model, hashSeed(sp.id) + n * 7919, STARFISH_SPEED);
      star.group.userData.slot = this.inverts.length;
      this.inverts.push(star);
      this.invertGroup.add(star.group);
    }
    this.placeInverts();
  }

  /**
   * Rest each invertebrate on a rock top or on the sand. Spots are seeded by the
   * tier and slot so they stay put between visits; re-run when rock models load.
   */
  private placeInverts() {
    if (!this.inverts.length) return;
    this.group.updateMatrixWorld(true);
    const ray = new THREE.Raycaster();
    const down = new THREE.Vector3(0, -1, 0);
    const targets = [this.rocks, this.sand];
    // Sorted so spots don't depend on which rock model finished loading first.
    const boxes = this.rocks.children.map((r) => new THREE.Box3().setFromObject(r)).sort((a, b) => a.min.x - b.min.x || a.min.z - b.min.z);
    const L = this.size.x;
    const D = this.size.z;
    const taken: THREE.Vector3[] = [];
    for (const star of this.inverts) {
      const rng = mulberry32(this.tier.sort_order * 131 + star.group.userData.slot * 7907 + 17);
      let placed = false;
      for (let attempt = 0; attempt < 24 && !placed; attempt++) {
        // Two out of three on a rock (if any), the rest on the sand toward the front.
        const onRock = boxes.length > 0 && (star.group.userData.slot % 3 !== 2 || attempt > 12);
        const p = new THREE.Vector3();
        if (onRock) {
          const b = boxes[Math.floor(rng() * boxes.length)];
          const c = b.getCenter(new THREE.Vector3());
          const s = b.getSize(new THREE.Vector3());
          p.set(c.x + (rng() - 0.5) * s.x * 0.6, 0, c.z + (rng() - 0.5) * s.z * 0.6);
          this.group.worldToLocal(p.setY(c.y));
        } else {
          p.set((rng() - 0.5) * L * 0.8, 0, (rng() * 0.6 - 0.1) * D * 0.8);
        }
        const from = this.group.localToWorld(new THREE.Vector3(p.x, this.size.y, p.z));
        ray.set(from, down);
        const hit = ray.intersectObjects(targets, true)[0];
        if (!hit || !hit.face) continue;
        const normal = hit.face.normal.clone().transformDirection(hit.object.matrixWorld);
        if (normal.y < 0.55) continue; // too steep to rest on
        const local = this.group.worldToLocal(hit.point.clone());
        if (Math.abs(local.x) > L / 2 - star.diameter / 2 || Math.abs(local.z) > D / 2 - star.diameter / 2) continue;
        if (taken.some((t) => t.distanceTo(local) < star.diameter * 1.1)) continue;
        taken.push(local);
        star.placeOn(local, normal);
        placed = true;
      }
      star.group.visible = placed;
    }
  }

  private bedRay = new THREE.Raycaster();
  private bed!: Seabed;

  /** Top of the rock work at (x, z), tank-local; null over bare sand. */
  private rockTopAt(x: number, z: number) {
    const from = this.group.localToWorld(new THREE.Vector3(x, this.size.y, z));
    this.bedRay.set(from, new THREE.Vector3(0, -1, 0));
    const hit = this.bedRay.intersectObject(this.rocks, true)[0];
    return hit ? this.group.worldToLocal(hit.point.clone()).y : null;
  }

  /** Sinking food comes to rest on the sand or on top of a rock. */
  private pelletFloor(m: THREE.Mesh) {
    return Math.max(this.size.y * 0.09, this.rockField.heightNear(m.position.x, m.position.z, 0) + this.size.x * 0.008);
  }

  private groundAt(x: number, z: number) {
    const from = this.group.localToWorld(new THREE.Vector3(x, this.size.y, z));
    this.bedRay.set(from, new THREE.Vector3(0, -1, 0));
    const hit = this.bedRay.intersectObjects([this.rocks, this.sand], true)[0];
    if (!hit || !hit.face) return null;
    return {
      point: this.group.worldToLocal(hit.point.clone()),
      normal: hit.face.normal.clone().transformDirection(hit.object.matrixWorld),
    };
  }

  /** Half extents of the swimmable volume, relative to its centre. */
  private halfInner() {
    const sandH = Math.max(0.015, this.size.y * 0.08);
    const waterH = this.size.y * 0.93;
    return new THREE.Vector3(this.size.x / 2, (waterH - sandH) / 2, this.size.z / 2);
  }

  private swimCentreY() {
    const sandH = Math.max(0.015, this.size.y * 0.08);
    return sandH + (this.size.y * 0.93 - sandH) / 2;
  }

  dropFood() {
    const mat = this.track(new THREE.MeshStandardMaterial({ color: '#c8743a', roughness: 0.8 }));
    const geo = this.track(new THREE.SphereGeometry(Math.max(0.0025, this.size.x * 0.008), 6, 4));
    for (let i = 0; i < 8; i++) {
      const m = new THREE.Mesh(geo, mat);
      m.position.set((Math.random() - 0.5) * this.size.x * 0.5, this.size.y * 0.92, (Math.random() - 0.5) * this.size.z * 0.5);
      this.group.add(m);
      this.pellets.push({ mesh: m, vy: 0 });
    }
  }

  update(dt: number, time: number) {
    const half = this.halfInner();
    const cy = this.swimCentreY();

    // Pellets sink slowly
    for (const p of this.pellets) {
      p.vy = Math.max(-0.035, p.vy - dt * 0.05);
      p.mesh.position.y = Math.max(this.pelletFloor(p.mesh), p.mesh.position.y + p.vy * dt);
    }

    if (this.rockFieldDirty) {
      this.rockFieldDirty = false;
      this.group.updateMatrixWorld(true);
      this.rockField.build((x, z) => this.rockTopAt(x, z));
      for (const p of this.pellets) p.mesh.position.y = Math.max(p.mesh.position.y, this.pelletFloor(p.mesh));
    }

    // Fish positions are kept relative to the swim-volume centre while simulating.
    for (const f of this.fish) f.group.position.y -= cy;
    while (this.avoid.length < this.fish.length) this.avoid.push(new THREE.Vector3());
    avoidance(this.fish, this.avoid);
    rockAvoidance(this.fish, this.rockField, cy, this.avoid);
    this.fish.forEach((f, i) => {
      let foodLocal: THREE.Vector3 | null = null;
      let nearest: { mesh: THREE.Mesh } | null = null;
      let best = Infinity;
      for (const p of this.pellets) {
        const d = p.mesh.position.distanceToSquared(f.group.position.clone().setY(f.group.position.y + cy));
        if (d < best) { best = d; nearest = p; }
      }
      if (nearest) foodLocal = nearest.mesh.position.clone().setY(nearest.mesh.position.y - cy);
      f.update(dt, time, half, foodLocal, this.avoid[i]);
      if (nearest && foodLocal && f.group.position.distanceTo(foodLocal) < f.length * 0.35 + f.radius) {
        this.group.remove(nearest.mesh);
        this.pellets = this.pellets.filter((p) => p !== nearest);
      }
    });
    // Bodies never pass through each other, even when crowding at food.
    // ...and never through rocks. Lifting a fish off a rock can push it into a
    // neighbour, so alternate the two constraints; rocks get the last word.
    for (let k = 0; k < 3; k++) {
      resolveOverlaps(this.fish, half);
      resolveRocks(this.fish, this.rockField, cy);
    }
    for (const f of this.fish) f.group.position.y += cy;

    if (this.inverts.length) {
      this.group.updateMatrixWorld();
      for (const star of this.inverts) star.update(dt, this.bed);
    }

    // Surface ripples (plane local y maps to tank -z after the -90° X rotation).
    const pos = this.surface.geometry.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      pos.setZ(i, waveHeight(pos.getX(i), -pos.getY(i), time, this.waveAmp));
    }
    pos.needsUpdate = true;
    this.surface.geometry.computeVertexNormals();
    this.waterFx.update(time);
    this.anemone.update(time);
    this.light.intensity = this.glowBase * (0.92 + Math.sin(time * 1.1) * 0.08);
  }

  private track<T extends { dispose(): void }>(d: T): T {
    this.disposables.push(d);
    return d;
  }

  private disposed = false;

  dispose() {
    this.disposed = true;
    for (const f of this.fish) f.dispose();
    for (const s of this.inverts) s.dispose();
    for (const d of this.disposables) d.dispose();
    this.waterFx.dispose();
    this.anemone.dispose();
    this.spot.shadow.map?.dispose();
  }
}

function hashSeed(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
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

/** Smooth, lumpy rock: subdivided icosahedron with seeded radial noise. */
function rockGeometry(r: number, rng: () => number) {
  const g = new THREE.IcosahedronGeometry(r, 3);
  const pos = g.attributes.position as THREE.BufferAttribute;
  const k = [rng() * 6, rng() * 6, rng() * 6];
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).normalize();
    const n = 1 + 0.18 * Math.sin(v.x * 3 + k[0]) * Math.cos(v.y * 4 + k[1]) + 0.1 * Math.sin(v.z * 5 + k[2]);
    v.multiplyScalar(r * n);
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  g.computeVertexNormals();
  return g;
}
