import { createClient, type SupabaseClient, type Session } from '@supabase/supabase-js';
import { bundledStatic, feedsToGrow, maxFishSize, type PlayerState, type StaticData, type TankTier } from './types';

/**
 * All game mutations go through server RPCs. The client never writes tables.
 * When Supabase env vars are missing (local preview), a clearly-labelled
 * in-memory demo backend is used instead; it is NOT a source of truth.
 */
export interface Backend {
  readonly mode: 'supabase' | 'demo';
  loadStatic(): Promise<StaticData>;
  getSession(): Promise<{ email: string | null } | null>;
  onAuthChange(cb: (signedIn: boolean) => void): void;
  signIn(email: string, password: string): Promise<void>;
  signUp(email: string, password: string): Promise<{ needsConfirm: boolean }>;
  signOut(): Promise<void>;
  getState(): Promise<PlayerState>;
  /** Shop: upgrade the player's single tank to a bigger tier (server checks level + coins). */
  upgradeTank(tierId: string): Promise<PlayerState>;
  /** Shop: add one fish to the player's tank (server checks level, tank size, space, coins). */
  buyFish(speciesId: string): Promise<PlayerState>;
  feedTank(tankId: string): Promise<PlayerState>;
  changeWater(tankId: string): Promise<PlayerState>;
}

export class GameError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

function toGameError(err: { message: string; code?: string }): GameError {
  const code = err.message.split(':')[0].trim();
  return new GameError(code, err.message);
}

class SupabaseBackend implements Backend {
  readonly mode = 'supabase' as const;
  private sb: SupabaseClient;

  constructor(url: string, key: string) {
    this.sb = createClient(url, key, { auth: { persistSession: true, autoRefreshToken: true } });
  }

  async loadStatic(): Promise<StaticData> {
    const [settings, tiers, species] = await Promise.all([
      this.sb.from('game_settings').select('data').eq('id', 1).single(),
      this.sb.from('tank_tiers').select('*').order('sort_order'),
      this.sb.from('species').select('*'),
    ]);
    if (settings.error || tiers.error || species.error) {
      console.warn('Falling back to bundled static data', settings.error ?? tiers.error ?? species.error);
      return bundledStatic;
    }
    return { settings: settings.data.data, tiers: tiers.data as TankTier[], species: species.data };
  }

  async getSession() {
    const { data } = await this.sb.auth.getSession();
    const s: Session | null = data.session;
    return s ? { email: s.user.email ?? null } : null;
  }

  onAuthChange(cb: (signedIn: boolean) => void) {
    this.sb.auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_IN' || event === 'SIGNED_OUT') cb(!!session);
    });
  }

  async signIn(email: string, password: string) {
    const { error } = await this.sb.auth.signInWithPassword({ email, password });
    if (error) throw new GameError('auth', error.message);
  }

  async signUp(email: string, password: string) {
    const { data, error } = await this.sb.auth.signUp({ email, password, options: { emailRedirectTo: location.origin } });
    if (error) throw new GameError('auth', error.message);
    return { needsConfirm: !data.session };
  }

  async signOut() {
    await this.sb.auth.signOut();
  }

  private async rpc(fn: string, args?: Record<string, unknown>): Promise<PlayerState> {
    const { data, error } = await this.sb.rpc(fn, args);
    if (error) throw toGameError(error);
    return data as PlayerState;
  }

  getState() { return this.rpc('get_state'); }
  upgradeTank(tierId: string) { return this.rpc('upgrade_tank', { p_tier_id: tierId }); }
  buyFish(speciesId: string) { return this.rpc('buy_fish', { p_species_id: speciesId }); }
  feedTank(tankId: string) { return this.rpc('feed_tank', { p_tank_id: tankId }); }
  changeWater(tankId: string) { return this.rpc('change_water', { p_tank_id: tankId }); }
}

/** Offline preview only. Mirrors the server rules loosely so the UI can be exercised. */
class DemoBackend implements Backend {
  readonly mode = 'demo' as const;
  private state: PlayerState;

  constructor(private data: StaticData, level: number) {
    const now = new Date().toISOString();
    const tankId = 'demo-tank-' + data.settings.starter_tier;
    this.state = {
      profile: { user_id: 'demo', level, xp: 0, xp_to_next: 100, coins: Number(new URLSearchParams(location.search).get('demoCoins') ?? 100), gems: 5, active_tank_id: tankId },
      tanks: [{ id: tankId, tier_id: data.settings.starter_tier, food: 62, cleanliness: 81, health: 92, last_tick_at: now }],
      fish: data.species.filter((s) => s.starter).map((s, i) => ({ id: 'demo-fish-' + i, tank_id: tankId, species_id: s.id, size_fingers: 1, growth: 0 })),
      server_time: now,
    };
  }

  private snap() {
    this.state.server_time = new Date().toISOString();
    return Promise.resolve(structuredClone(this.state));
  }

  loadStatic() { return Promise.resolve(this.data); }
  getSession() { return Promise.resolve({ email: null }); }
  onAuthChange() {}
  signIn(): Promise<void> { return Promise.reject(new GameError('demo', 'Demo mode has no accounts')); }
  signUp(): Promise<{ needsConfirm: boolean }> { return Promise.reject(new GameError('demo', 'Demo mode has no accounts')); }
  signOut() { return Promise.resolve(); }
  getState() { return this.snap(); }

  upgradeTank(tierId: string) {
    const tier = this.data.tiers.find((t) => t.id === tierId);
    if (!tier) return Promise.reject(new GameError('unknown_tier', 'unknown_tier'));
    const tank = this.state.tanks.find((t) => t.id === this.state.profile.active_tank_id)!;
    const cur = this.data.tiers.find((t) => t.id === tank.tier_id)!;
    if (tier.sort_order <= cur.sort_order) return Promise.reject(new GameError('not_an_upgrade', 'not_an_upgrade'));
    if (this.state.profile.level < tier.unlock_level) return Promise.reject(new GameError('level_too_low', 'level_too_low'));
    if (this.state.profile.coins < tier.unlock_cost_coins) return Promise.reject(new GameError('not_enough_coins', 'not_enough_coins'));
    this.state.profile.coins -= tier.unlock_cost_coins;
    tank.tier_id = tierId;
    return this.snap();
  }

  buyFish(speciesId: string) {
    const sp = this.data.species.find((s) => s.id === speciesId);
    if (!sp) return Promise.reject(new GameError('unknown_species', 'unknown_species'));
    const tank = this.state.tanks.find((t) => t.id === this.state.profile.active_tank_id)!;
    const tier = this.data.tiers.find((t) => t.id === tank.tier_id)!;
    const min = this.data.tiers.find((t) => t.id === sp.min_tier)!;
    const inTank = this.state.fish.filter((f) => f.tank_id === tank.id).map((f) => this.data.species.find((s) => s.id === f.species_id));
    const n = inTank.filter((s) => s && s.kind !== 'invert').length;
    const same = this.state.fish.filter((f) => f.tank_id === tank.id && f.species_id === sp.id).length;
    if (this.state.profile.level < sp.unlock_level) return Promise.reject(new GameError('level_too_low', 'level_too_low'));
    if (tier.sort_order < min.sort_order) return Promise.reject(new GameError('tank_too_small', 'tank_too_small'));
    if (sp.kind !== 'invert' && n >= tier.max_fish) return Promise.reject(new GameError('tank_full', 'tank_full'));
    if ((sp.kind === 'invert' || sp.max_per_tank != null) && same >= (sp.max_per_tank ?? 0)) return Promise.reject(new GameError('species_limit', 'species_limit'));
    if (this.state.profile.coins < sp.price_coins) return Promise.reject(new GameError('not_enough_coins', 'not_enough_coins'));
    this.state.profile.coins -= sp.price_coins;
    this.state.fish.push({ id: 'demo-fish-' + Date.now(), tank_id: tank.id, species_id: speciesId, size_fingers: 1, growth: 0 });
    return this.snap();
  }

  feedTank(tankId: string) {
    const t = this.state.tanks.find((x) => x.id === tankId)!;
    const s = this.data.settings;
    // Demo shortcut: every feed counts as a hungry one so growth can be tried quickly.
    if (t.health >= (s.growth_min_health ?? 50)) {
      const tier = this.data.tiers.find((x) => x.id === t.tier_id)!;
      for (const f of this.state.fish.filter((x) => x.tank_id === tankId)) {
        const sp = this.data.species.find((x) => x.id === f.species_id);
        if (!sp || sp.kind === 'invert' || (f.size_fingers ?? 1) >= maxFishSize(sp, tier, s)) continue;
        f.growth = (f.growth ?? 0) + 1;
        if (f.growth >= feedsToGrow(f.size_fingers ?? 1, s)) {
          f.size_fingers = (f.size_fingers ?? 1) + 1;
          f.growth = 0;
        }
      }
    }
    t.food = Math.min(100, t.food + s.feed_amount);
    return this.snap();
  }

  changeWater(tankId: string) {
    const t = this.state.tanks.find((x) => x.id === tankId)!;
    t.cleanliness = 100;
    return this.snap();
  }
}

export function createBackend(): Backend {
  const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
  const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
  if (url && key) return new SupabaseBackend(url, key);
  const level = Number(new URLSearchParams(location.search).get('demoLevel') ?? 20);
  return new DemoBackend(bundledStatic, Number.isFinite(level) ? Math.max(1, level) : 20);
}
