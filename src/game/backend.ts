import { createClient, type SupabaseClient, type Session } from '@supabase/supabase-js';
import { bundledStatic, type PlayerState, type StaticData, type TankTier } from './types';

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
  unlockTank(tierId: string): Promise<PlayerState>;
  selectTank(tankId: string): Promise<PlayerState>;
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
  unlockTank(tierId: string) { return this.rpc('unlock_tank', { p_tier_id: tierId }); }
  selectTank(tankId: string) { return this.rpc('select_tank', { p_tank_id: tankId }); }
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
      profile: { user_id: 'demo', level, xp: 0, xp_to_next: 100, coins: 100, gems: 5, active_tank_id: tankId },
      tanks: [{ id: tankId, tier_id: data.settings.starter_tier, food: 62, cleanliness: 81, health: 92, last_tick_at: now }],
      fish: data.species.filter((s) => s.starter).map((s, i) => ({ id: 'demo-fish-' + i, tank_id: tankId, species_id: s.id })),
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

  unlockTank(tierId: string) {
    const tier = this.data.tiers.find((t) => t.id === tierId);
    if (!tier) return Promise.reject(new GameError('unknown_tier', 'unknown_tier'));
    if (this.state.profile.level < tier.unlock_level) return Promise.reject(new GameError('level_too_low', 'level_too_low'));
    if (this.state.tanks.some((t) => t.tier_id === tierId)) return Promise.reject(new GameError('already_unlocked', 'already_unlocked'));
    const id = 'demo-tank-' + tierId;
    this.state.tanks.push({ id, tier_id: tierId, food: 80, cleanliness: 100, health: 100, last_tick_at: new Date().toISOString() });
    this.data.species.filter((s) => s.starter).forEach((s, i) => this.state.fish.push({ id: `${id}-fish-${i}`, tank_id: id, species_id: s.id }));
    this.state.profile.active_tank_id = id;
    return this.snap();
  }

  selectTank(tankId: string) {
    this.state.profile.active_tank_id = tankId;
    return this.snap();
  }

  feedTank(tankId: string) {
    const t = this.state.tanks.find((x) => x.id === tankId)!;
    t.food = Math.min(100, t.food + this.data.settings.feed_amount);
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
