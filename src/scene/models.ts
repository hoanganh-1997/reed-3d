import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';

/**
 * Fish GLB loading. Models are normalised once so every fish shares the same
 * local frame as the procedural placeholder: +X = head, +Y = up, length 1,
 * centred on the origin. That frame is what the swim-wave shader expects.
 *
 * `forward` says which model axis the head points along (per species, in
 * config/game.json → species[].model_forward). glTF's own convention is +Z.
 */
export type Axis = '+x' | '-x' | '+z' | '-z';

const loader = new GLTFLoader();
const draco = new DRACOLoader();
draco.setDecoderPath('/draco/');
loader.setDRACOLoader(draco);
loader.setMeshoptDecoder(MeshoptDecoder);

const cache = new Map<string, Promise<THREE.Group>>();
const ready = new Map<string, THREE.Group>();

const yawFor: Record<Axis, number> = { '+x': 0, '-x': Math.PI, '+z': Math.PI / 2, '-z': -Math.PI / 2 };

export function loadFishModel(url: string, forward: Axis = '+z'): Promise<THREE.Group> {
  const key = url + '|' + forward;
  let p = cache.get(key);
  if (!p) {
    p = loader.loadAsync(url).then((gltf) => {
      const normalised = normalise(gltf.scene, forward);
      ready.set(key, normalised);
      return normalised;
    });
    p.catch((e) => console.warn('fish model failed, keeping placeholder', url, e));
    cache.set(key, p);
  }
  return p;
}

/** Synchronous lookup; null until the model has finished loading. */
export function cachedFishModel(url: string, forward: Axis = '+z') {
  return ready.get(url + '|' + forward) ?? null;
}

function normalise(scene: THREE.Object3D, forward: Axis): THREE.Group {
  scene.updateMatrixWorld(true);
  // Rotate so the head points to +X.
  const rot = new THREE.Matrix4().makeRotationY(yawFor[forward]);
  const box = new THREE.Box3();
  const tmp = new THREE.Box3();
  const meshes: THREE.Mesh[] = [];
  scene.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh);
  });
  for (const m of meshes) {
    const g = m.geometry.clone();
    g.applyMatrix4(new THREE.Matrix4().multiplyMatrices(rot, m.matrixWorld));
    g.computeBoundingBox();
    tmp.copy(g.boundingBox!);
    box.union(tmp);
    m.userData.baked = g;
  }
  const size = box.getSize(new THREE.Vector3());
  const centre = box.getCenter(new THREE.Vector3());
  const s = 1 / Math.max(1e-6, size.x);
  const fit = new THREE.Matrix4().makeScale(s, s, s).multiply(new THREE.Matrix4().makeTranslation(-centre.x, -centre.y, -centre.z));
  const out = new THREE.Group();
  for (const m of meshes) {
    const g = m.userData.baked as THREE.BufferGeometry;
    g.applyMatrix4(fit);
    g.computeBoundingSphere();
    const mesh = new THREE.Mesh(g, m.material);
    out.add(mesh);
  }
  return out;
}

/**
 * Decor rock GLBs (CC0, Poly Haven): longest side 1 unit, origin bottom-centre.
 * Loaded once and shared; tanks clone the meshes (geometry/material shared).
 */
const rockCache = new Map<string, Promise<THREE.Object3D>>();
export function loadRockModel(url: string): Promise<THREE.Object3D> {
  let p = rockCache.get(url);
  if (!p) {
    p = loader.loadAsync(url).then((gltf) => {
      gltf.scene.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh) m.castShadow = m.receiveShadow = true;
      });
      return gltf.scene;
    });
    p.catch((e) => console.warn('rock model failed, keeping placeholder', url, e));
    rockCache.set(url, p);
  }
  return p;
}
