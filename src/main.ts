import './ui/styles.css';
import { createBackend, GameError } from './game/backend';
import { projectTank, type PlayerState, type StaticData, type TankTier } from './game/types';
import { World } from './scene/world';
import { Hud } from './ui/hud';
import { showAuth } from './ui/auth';

const ERROR_TEXT: Record<string, string> = {
  level_too_low: 'Chưa đủ cấp để mở bể này.',
  already_unlocked: 'Bạn đã mở bể này rồi.',
  not_enough_coins: 'Không đủ xu.',
  tank_not_found: 'Không tìm thấy bể.',
  not_authenticated: 'Phiên đăng nhập đã hết. Hãy đăng nhập lại.',
};

async function main() {
  const app = document.getElementById('app')!;
  const backend = createBackend();
  const world = new World(document.getElementById('scene')!);
  const data: StaticData = await backend.loadStatic();
  world.preloadFishModels(data.species);

  // Show the starter tank behind the sign-in card.
  const starter = data.tiers.find((t) => t.id === data.settings.starter_tier) ?? data.tiers[0];
  world.show(starter, data.species.filter((s) => s.starter), false, true);

  if (backend.mode === 'supabase' && !(await backend.getSession())) {
    await showAuth(app, backend);
  }

  let state: PlayerState = await backend.getState();
  let skewMs = Date.parse(state.server_time) - Date.now();
  let previewTier: TankTier | null = null;
  let busy = false;

  const activeTank = () => state.tanks.find((t) => t.id === state.profile.active_tank_id) ?? state.tanks[0];
  const tierOf = (id: string) => data.tiers.find((t) => t.id === id)!;
  const fishFor = (tankId: string) =>
    state.fish
      .filter((f) => f.tank_id === tankId)
      .map((f) => data.species.find((s) => s.id === f.species_id))
      .filter((s): s is NonNullable<typeof s> => !!s);

  const hud = new Hud(app, data, {
    onTier: (tier) => {
      const owned = state.tanks.find((t) => t.tier_id === tier.id);
      if (owned) {
        previewTier = null;
        if (owned.id !== state.profile.active_tank_id) return act(() => backend.selectTank(owned.id));
        return refreshScene();
      }
      if (state.profile.level >= tier.unlock_level) {
        previewTier = null;
        return act(() => backend.unlockTank(tier.id), `Đã mở bể ${tier.name}!`);
      }
      previewTier = tier;
      refreshScene();
    },
    onBack: () => {
      previewTier = null;
      refreshScene();
    },
    onFeed: () => {
      world.dropFood();
      act(() => backend.feedTank(activeTank().id), 'Cá đã được cho ăn');
    },
    onWater: () => act(() => backend.changeWater(activeTank().id), 'Đã thay nước'),
    onDecor: () => hud.toast('Trang trí sẽ có ở giai đoạn sau'),
    onCollection: () => hud.toast('Bộ sưu tập sẽ có ở giai đoạn sau'),
    onSettings: () => toggleSettings(),
    onView: (on) => setViewing(on),
  });

  if (backend.mode === 'demo') {
    const banner = document.createElement('div');
    banner.className = 'demo-banner panel';
    banner.textContent = 'Chế độ demo: chưa kết nối Supabase, tiến trình không được lưu';
    app.appendChild(banner);
  }

  function setViewing(on: boolean) {
    if (on && previewTier) {
      previewTier = null;
      refreshScene();
    }
    if (on && settingsEl) toggleSettings();
    app.classList.toggle('viewing', on);
    world.setFocus(on);
  }
  addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && app.classList.contains('viewing')) setViewing(false);
  });

  let settingsEl: HTMLElement | null = null;
  async function toggleSettings() {
    if (settingsEl) {
      settingsEl.remove();
      settingsEl = null;
      return;
    }
    const session = await backend.getSession();
    settingsEl = document.createElement('div');
    settingsEl.className = 'settings-menu panel';
    settingsEl.innerHTML = `<strong>Cài đặt</strong><p data-email></p>
      <label class="light-mix">Đèn bể
        <input type="range" min="0" max="100" step="1" data-light aria-label="Đèn bể: trắng đến xanh" />
        <span class="light-mix-ends"><span>Trắng (màu thật)</span><span>Xanh actinic</span></span>
      </label>
      ${backend.mode === 'supabase' ? '<button class="btn" data-signout>Đăng xuất</button>' : ''}`;
    settingsEl.querySelector('[data-email]')!.textContent = session?.email ? `Đăng nhập: ${session.email}` : 'Chế độ demo';
    const light = settingsEl.querySelector<HTMLInputElement>('[data-light]')!;
    light.value = String(Math.round(world.lightMixValue * 100));
    light.addEventListener('input', () => world.setLightMix(+light.value / 100));
    settingsEl.querySelector('[data-signout]')?.addEventListener('click', async () => {
      await backend.signOut();
      location.reload();
    });
    app.appendChild(settingsEl);
  }

  async function act(fn: () => Promise<PlayerState>, okText?: string) {
    if (busy) return;
    busy = true;
    hud.setBusy(true);
    try {
      apply(await fn());
      if (okText) hud.toast(okText);
    } catch (err) {
      const code = err instanceof GameError ? err.code : 'unknown';
      hud.toast(ERROR_TEXT[code] ?? 'Có lỗi xảy ra, thử lại sau.', true);
      console.error(err);
    } finally {
      busy = false;
      renderHud();
    }
  }

  function apply(next: PlayerState) {
    const prevLevel = state.profile.level;
    state = next;
    skewMs = Date.parse(state.server_time) - Date.now();
    refreshScene();
    if (next.profile.level > prevLevel) hud.toast(`Lên cấp ${next.profile.level}!`);
  }

  function refreshScene() {
    const tank = activeTank();
    if (previewTier) world.show(previewTier, [], true);
    else world.show(tierOf(tank.tier_id), fishFor(tank.id), false);
    renderHud();
  }

  function renderHud() {
    const tank = activeTank();
    const shown = previewTier ?? tierOf(tank.tier_id);
    const live = projectTank(tank, data.settings, Date.now(), skewMs);
    hud.render(state, shown, !!previewTier, live, fishFor(tank.id).length);
  }

  refreshScene();
  hud.toast(matchMedia('(pointer: coarse)').matches ? 'Vuốt để xoay xem bể từ 3 phía' : 'Kéo chuột để xoay xem bể từ 3 phía, nhấp đúp để về chính diện');
  // Projection keeps bars moving; a periodic resync keeps the server authoritative.
  setInterval(renderHud, 5_000);
  setInterval(async () => {
    if (busy || document.hidden) return;
    try {
      apply(await backend.getState());
    } catch (e) {
      console.warn('resync failed', e);
    }
  }, 120_000);
  backend.onAuthChange((signedIn) => {
    if (!signedIn) location.reload();
  });
  (window as unknown as { __reef: unknown }).__reef = { get state() { return state; }, world };
}

main().catch((e) => {
  console.error(e);
  const app = document.getElementById('app')!;
  app.innerHTML = '<div class="overlay"><div class="card panel"><h2>Không tải được game</h2><p data-err></p></div></div>';
  app.querySelector('[data-err]')!.textContent = String(e?.message ?? e);
});
