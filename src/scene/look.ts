import * as THREE from 'three';
import gameConfig from '../../config/game.json';

/**
 * Tank lighting blended between a white "day" look (fish keep true colours)
 * and a blue actinic "night" look. mix 0 = white, 1 = blue. Values live in
 * config/game.json → visual.day / visual.night.
 */
type Palette = typeof gameConfig.visual.day;
export type Look = { [K in keyof Palette]: Palette[K] extends string ? THREE.Color : number };

const STORE_KEY = 'reef.lightMix';

export function lookFor(mix: number): Look {
  const { day, night } = gameConfig.visual;
  const t = THREE.MathUtils.clamp(mix, 0, 1);
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(day) as (keyof Palette)[]) {
    const a = day[k];
    const b = night[k];
    out[k] = typeof a === 'string' ? new THREE.Color(a).lerp(new THREE.Color(b as string), t) : (a as number) + ((b as number) - (a as number)) * t;
  }
  return out as Look;
}

/** Per-viewer preference; falls back to the config default when storage is unavailable. */
export function loadLightMix(): number {
  try {
    const v = localStorage.getItem(STORE_KEY);
    if (v !== null && !Number.isNaN(+v)) return THREE.MathUtils.clamp(+v, 0, 1);
  } catch { /* storage blocked */ }
  return gameConfig.visual.light_mix_default;
}

export function saveLightMix(mix: number) {
  try {
    localStorage.setItem(STORE_KEY, String(mix));
  } catch { /* storage blocked */ }
}
