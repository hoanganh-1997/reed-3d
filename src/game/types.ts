import gameConfig from '../../config/game.json';

export type GameSettings = typeof gameConfig.settings;

export interface TankTier {
  id: string;
  name: string;
  label: string;
  length_cm: number;
  depth_cm: number;
  height_cm: number;
  unlock_level: number;
  unlock_cost_coins: number;
  max_fish: number;
  sort_order: number;
}

export interface Species {
  id: string;
  common_name: string;
  scientific_name: string;
  adult_length_cm: number;
  min_tier: string;
  starter: boolean;
  body_color: string;
  fin_color: string;
  accent_color: string;
  model_url: string | null;
}

export interface StaticData {
  settings: GameSettings;
  tiers: TankTier[];
  species: Species[];
}

export interface Profile {
  user_id: string;
  level: number;
  xp: number;
  xp_to_next: number;
  coins: number;
  gems: number;
  active_tank_id: string | null;
}

export interface Tank {
  id: string;
  tier_id: string;
  food: number;
  cleanliness: number;
  health: number;
  last_tick_at: string;
}

export interface TankFish {
  id: string;
  tank_id: string;
  species_id: string;
}

export interface PlayerState {
  profile: Profile;
  tanks: Tank[];
  fish: TankFish[];
  server_time: string;
}

export const volumeLiters = (t: TankTier) => Math.round((t.length_cm * t.depth_cm * t.height_cm) / 1000);

export const bundledStatic: StaticData = {
  settings: gameConfig.settings,
  tiers: [...gameConfig.tankTiers].sort((a, b) => a.sort_order - b.sort_order),
  species: gameConfig.species as Species[],
};

/**
 * Client-side projection of the server tick so bars move between syncs.
 * Display only: the server recomputes from last_tick_at on every RPC.
 */
export function projectTank(t: Tank, s: GameSettings, nowMs: number, serverSkewMs: number): Tank {
  const hours = Math.max(0, (nowMs + serverSkewMs - Date.parse(t.last_tick_at)) / 3_600_000);
  const thr = s.health_threshold;
  const tFood = t.food <= thr ? 0 : (t.food - thr) / s.food_decay_per_hour;
  const tClean = t.cleanliness <= thr ? 0 : (t.cleanliness - thr) / s.dirt_per_hour;
  const good = Math.min(hours, tFood, tClean);
  return {
    ...t,
    food: Math.max(0, t.food - s.food_decay_per_hour * hours),
    cleanliness: Math.max(0, t.cleanliness - s.dirt_per_hour * hours),
    health: Math.max(0, Math.min(100, t.health + s.health_gain_per_hour * good) - s.health_loss_per_hour * (hours - good)),
  };
}
