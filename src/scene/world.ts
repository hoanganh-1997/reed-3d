import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { Species, TankTier } from '../game/types';
import { Room, ROOM } from './room';
import { Tank, standHeightFor } from './tank';
import { lookFor, loadLightMix, saveLightMix } from './look';
import gameConfig from '../../config/game.json';
import { loadFishModel, type Axis } from './models';

interface Framing {
  pos: THREE.Vector3;
  target: THREE.Vector3;
  fov: number;
}

const BASE_FOV = 40;
const MAX_FOV = 72;

/**
 * Camera framing for a tier. Small tanks: close-up on the stand top.
 * Bigger tanks: the camera backs off until floor, chair and plant appear.
 * Everything derives from the tier's dimensions, so new tiers just work.
 */
export function framingFor(tier: TankTier, aspect: number): Framing {
  const L = tier.length_cm / 100;
  const H = tier.height_cm / 100;
  const standH = standHeightFor(tier);
  const z = ROOM.backZ + 0.04 + Math.max(0.42, tier.depth_cm / 100 + 0.08) / 2;
  const big = L > 1;

  // How much of the room around the tank should be visible.
  const frameW = L * (big ? 2.6 : 2.2) + (big ? 0.6 : 0.9);
  const frameH = H * 2.4 + 0.3 + (big ? standH : 0);
  const centreY = big ? (standH + H) * 0.55 : standH + H * 0.5;

  const fitDist = (fov: number) => {
    const v = THREE.MathUtils.degToRad(fov) / 2;
    const h = Math.atan(Math.tan(v) * aspect);
    return Math.max(frameH / 2 / Math.tan(v), frameW / 2 / Math.tan(h));
  };

  let fov = BASE_FOV;
  let dist = fitDist(fov);
  const maxDist = ROOM.frontZ - 0.15 - z;
  while (dist > maxDist && fov < MAX_FOV) {
    fov += 1;
    dist = fitDist(fov);
  }
  dist = Math.min(dist, maxDist);

  const target = new THREE.Vector3(0, centreY - frameH * 0.05, z);
  const pos = new THREE.Vector3(0, centreY + dist * 0.14, z + dist);
  return { pos, target, fov };
}

/** Viewing mode: the tank alone fills the screen. */
export function focusFramingFor(tier: TankTier, aspect: number): Framing {
  const L = tier.length_cm / 100;
  const H = tier.height_cm / 100;
  const D = tier.depth_cm / 100;
  const standH = standHeightFor(tier);
  const z = ROOM.backZ + 0.04 + Math.max(0.42, D + 0.08) / 2;
  const v = THREE.MathUtils.degToRad(BASE_FOV) / 2;
  const h = Math.atan(Math.tan(v) * aspect);
  const dist = Math.max((H * 0.95) / 2 / Math.tan(v), (L * 0.88) / 2 / Math.tan(h)) + D * 0.15;
  const target = new THREE.Vector3(0, standH + H * 0.5, z);
  const pos = new THREE.Vector3(0, target.y + dist * 0.08, z + dist);
  return { pos, target, fov: BASE_FOV };
}

export class World {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(BASE_FOV, 1, 0.02, 30);
  readonly room = new Room();
  private tank: Tank | null = null;
  private tier: TankTier | null = null;
  private shownFish: Species[] = [];
  private ghost = false;
  private goal: Framing | null = null;
  private lookAt = new THREE.Vector3();
  private timer = new THREE.Timer();
  private reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  private controls: OrbitControls;
  private baseDist = 1;
  private lightMix = loadLightMix();
  private focus = false;
  private roomFog = new THREE.Fog('#1b1612', 6, 12);
  private roomBackground = new THREE.Color('#16242f');
  private focusBackground = new THREE.Color('#04070c');
  /** Soft fill so the tank is not dull once the room lights are gone. */
  private focusFill = new THREE.HemisphereLight('#dfe9ff', '#1a2230', 0.9);

  constructor(private container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = gameConfig.visual.tone_mapping === 'aces' ? THREE.ACESFilmicToneMapping : THREE.NeutralToneMapping;
    this.renderer.toneMappingExposure = gameConfig.visual.exposure;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    container.appendChild(this.renderer.domElement);
    this.renderer.domElement.setAttribute('aria-hidden', 'true');

    this.scene.background = this.roomBackground;
    this.scene.fog = this.roomFog;
    this.scene.add(this.room.group);
    this.focusFill.intensity = 0;
    this.scene.add(this.focusFill);

    // Orbit around the tank: front and both sides (azimuth ±90°), no panning.
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enablePan = false;
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minAzimuthAngle = -Math.PI / 2;
    this.controls.maxAzimuthAngle = Math.PI / 2;
    this.controls.minPolarAngle = Math.PI * 0.22;
    this.controls.maxPolarAngle = Math.PI * 0.56;
    this.controls.rotateSpeed = 0.6;
    this.controls.addEventListener('start', () => {
      this.goal = null; // user takes over; stop the framing tween
    });
    this.renderer.domElement.addEventListener('dblclick', () => this.resetView());
    this.renderer.domElement.style.touchAction = 'none';

    addEventListener('resize', () => this.resize());
    this.resize();
    this.renderer.setAnimationLoop(() => this.frame());
  }

  /** Show a tier. `ghost` = locked preview (outline only, no water or fish). */
  show(tier: TankTier, fish: Species[], ghost: boolean, instant = false) {
    const sameTier = this.tier?.id === tier.id;
    if (!sameTier) {
      if (this.tank) {
        this.scene.remove(this.tank.group);
        this.tank.dispose();
      }
      this.tank = new Tank(tier, lookFor(this.lightMix));
      this.tank.group.position.set(0, standHeightFor(tier), this.room.standCentreZ(Math.max(0.42, tier.depth_cm / 100 + 0.08)));
      this.scene.add(this.tank.group);
      this.tier = tier;
    }
    this.shownFish = fish;
    this.ghost = ghost;
    if (!sameTier || !ghost) this.tank!.setFish(ghost ? [] : fish);
    this.tank!.setGhost(ghost);
    this.room.setStand(tier.length_cm / 100, tier.depth_cm / 100, standHeightFor(tier), instant);
    this.resetView();
    if (instant || this.reducedMotion) this.snapCamera();
  }

  /** Tank light: 0 = white (true colours), 1 = blue actinic. Saved per viewer. */
  get lightMixValue() {
    return this.lightMix;
  }

  setLightMix(mix: number) {
    this.lightMix = THREE.MathUtils.clamp(mix, 0, 1);
    this.tank?.setLook(lookFor(this.lightMix));
    saveLightMix(this.lightMix);
  }

  /** Viewing mode: hide the room and frame only the tank. */
  setFocus(on: boolean) {
    if (this.focus === on) return;
    this.focus = on;
    this.room.setFocus(on);
    this.focusFill.intensity = on ? 0.9 : 0;
    this.scene.background = on ? this.focusBackground : this.roomBackground;
    this.scene.fog = on ? null : this.roomFog;
    this.resetView();
  }

  /** Tween back to the default front framing for the current tier. */
  resetView() {
    if (!this.tier) return;
    this.goal = (this.focus ? focusFramingFor : framingFor)(this.tier, this.camera.aspect);
    this.baseDist = this.goal.pos.distanceTo(this.goal.target);
    this.controls.minDistance = this.baseDist * 0.45;
    this.controls.maxDistance = this.baseDist * (this.focus ? 1.6 : 1.1);
  }

  /** Start loading GLB fish; swap them in for placeholders as they arrive. */
  preloadFishModels(species: Species[]) {
    for (const s of species) {
      if (!s.model_url) continue;
      loadFishModel(s.model_url, s.model_forward as Axis).then(() => {
        if (this.tank && !this.ghost && this.shownFish.some((f) => f.id === s.id)) this.tank.setFish(this.shownFish);
      }, () => {});
    }
  }

  dropFood() {
    this.tank?.dropFood();
  }

  private snapCamera() {
    if (!this.goal) return;
    this.camera.position.copy(this.goal.pos);
    this.camera.fov = this.goal.fov;
    this.lookAt.copy(this.goal.target);
    this.camera.lookAt(this.lookAt);
    this.camera.updateProjectionMatrix();
  }

  /** Side views of big tanks would put the camera through a wall: pull it closer instead. */
  private keepInsideRoom() {
    const c = this.camera.position;
    const t = this.controls.target;
    const maxX = ROOM.halfWidth - 0.1;
    const maxZ = ROOM.frontZ - 0.15;
    let s = 1;
    if (Math.abs(c.x) > maxX) s = Math.min(s, (maxX - Math.abs(t.x)) / Math.abs(c.x - t.x));
    if (c.z > maxZ) s = Math.min(s, (maxZ - t.z) / (c.z - t.z));
    if (c.y < 0.15) s = Math.min(s, (t.y - 0.15) / (t.y - c.y));
    if (s < 1) c.copy(t).addScaledVector(c.clone().sub(t), Math.max(0.1, s));
  }

  private resize() {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    if (this.tier) {
      this.resetView();
      this.snapCamera();
    }
  }

  private frame() {
    this.timer.update();
    const dt = Math.min(0.05, this.timer.getDelta());
    const t = this.timer.getElapsed();
    this.room.update(this.reducedMotion ? 1 : dt);
    if (this.tank && this.tank.group.position.y !== standHeightFor(this.tank.tier)) {
      this.tank.group.position.y = standHeightFor(this.tank.tier);
    }
    this.tank?.update(dt, t);
    if (this.goal) {
      const k = 1 - Math.exp(-dt * 3.2);
      this.camera.position.lerp(this.goal.pos, k);
      this.lookAt.lerp(this.goal.target, k);
      this.camera.fov += (this.goal.fov - this.camera.fov) * k;
      this.camera.updateProjectionMatrix();
      this.camera.lookAt(this.lookAt);
      this.controls.target.copy(this.lookAt);
      if (this.camera.position.distanceTo(this.goal.pos) < 1e-3) this.goal = null;
    } else {
      // Side views must stay inside the room: the further away, the less we can swing.
      const d = this.camera.position.distanceTo(this.controls.target);
      const maxAz = this.focus ? Math.PI / 2 : Math.asin(Math.min(1, (ROOM.halfWidth - 0.15) / d));
      this.controls.minAzimuthAngle = -maxAz;
      this.controls.maxAzimuthAngle = maxAz;
      this.controls.update(dt);
      this.lookAt.copy(this.controls.target);
      if (!this.focus) this.keepInsideRoom();
    }
    if (this.tank && !this.focus) {
      const base = this.tank.group.position;
      const h = this.tank.size.y;
      this.room.fadeOccluders(this.camera.position, [
        base.clone().setY(base.y + h * 0.5),
        base.clone().setY(base.y + h * 0.15),
        base.clone().setY(base.y + h * 0.85),
      ], dt);
    }
    this.renderer.render(this.scene, this.camera);
  }
}
