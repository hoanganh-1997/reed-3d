import * as THREE from 'three';
import type { Species, TankTier } from '../game/types';
import { Room, ROOM } from './room';
import { Tank, standHeightFor } from './tank';

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

export class World {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(BASE_FOV, 1, 0.02, 30);
  readonly room = new Room();
  private tank: Tank | null = null;
  private tier: TankTier | null = null;
  private goal: Framing | null = null;
  private lookAt = new THREE.Vector3();
  private timer = new THREE.Timer();
  private reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

  constructor(private container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.95;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    container.appendChild(this.renderer.domElement);
    this.renderer.domElement.setAttribute('aria-hidden', 'true');

    this.scene.background = new THREE.Color('#16242f');
    this.scene.fog = new THREE.Fog('#1b1612', 6, 12);
    this.scene.add(this.room.group);

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
      this.tank = new Tank(tier);
      this.tank.group.position.set(0, standHeightFor(tier), this.room.standCentreZ(Math.max(0.42, tier.depth_cm / 100 + 0.08)));
      this.scene.add(this.tank.group);
      this.tier = tier;
    }
    if (!sameTier || !ghost) this.tank!.setFish(ghost ? [] : fish);
    this.tank!.setGhost(ghost);
    this.room.setStand(tier.length_cm / 100, tier.depth_cm / 100, standHeightFor(tier), instant);
    this.goal = framingFor(tier, this.camera.aspect);
    if (instant || this.reducedMotion) this.snapCamera();
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

  private resize() {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    if (this.tier) {
      this.goal = framingFor(this.tier, this.camera.aspect);
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
    }
    this.renderer.render(this.scene, this.camera);
  }
}
