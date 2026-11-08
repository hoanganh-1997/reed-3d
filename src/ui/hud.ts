import { volumeLiters, type PlayerState, type StaticData, type Tank, type TankTier } from '../game/types';

const svg = (path: string) =>
  `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;

export const ICONS = {
  coin: `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="#f7c93b"/><circle cx="12" cy="12" r="6" fill="none" stroke="#c99a12" stroke-width="2"/></svg>`,
  gem: `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 4h12l4 6-10 11L2 10z" fill="#6fd4e6"/><path d="M2 10h20M12 21 8 10l4-6 4 6z" fill="none" stroke="#2b8ea3" stroke-width="1.4"/></svg>`,
  gear: svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>'),
  feed: svg('<path d="M12 3c3 3 4 6 4 9a4 4 0 0 1-8 0c0-3 1-6 4-9z"/><circle cx="7" cy="19" r="1"/><circle cx="12" cy="20" r="1"/><circle cx="17" cy="19" r="1"/>'),
  water: svg('<path d="M3 15c2 0 2-1.5 4.5-1.5S10 15 12 15s2-1.5 4.5-1.5S19 15 21 15"/><path d="M3 19c2 0 2-1.5 4.5-1.5S10 19 12 19s2-1.5 4.5-1.5S19 19 21 19"/><path d="M12 3v8m-3-3 3 3 3-3"/>'),
  decor: svg('<path d="M12 21V11"/><path d="M12 11c0-4 3-7 7-7 0 4-3 7-7 7z"/><path d="M12 14c0-3-2.5-5.5-6-5.5 0 3 2.5 5.5 6 5.5z"/><path d="M7 21h10"/>'),
  book: svg('<path d="M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2z"/><path d="M4 19V5"/><path d="M9 7h6"/>'),
  eye: svg('<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>'),
  shop: svg('<path d="M4 9h16l-1.2 10.2a2 2 0 0 1-2 1.8H7.2a2 2 0 0 1-2-1.8z"/><path d="M8.5 9V7a3.5 3.5 0 0 1 7 0v2"/>'),
  close: svg('<path d="M6 6l12 12M18 6 6 18"/>'),
  lock: `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>`,
};

export interface HudHandlers {
  onShop(): void;
  onBuy(tier: TankTier): void;
  onPreview(tier: TankTier): void;
  onBack(): void;
  onFeed(): void;
  onWater(): void;
  onDecor(): void;
  onCollection(): void;
  onSettings(): void;
  onView(on: boolean): void;
}

const fmt = new Intl.NumberFormat('vi-VN');

export class Hud {
  private el: HTMLElement;
  private $ = <T extends HTMLElement = HTMLElement>(sel: string) => this.el.querySelector(sel) as T;
  private toastTimer = 0;
  private previewTier: TankTier | null = null;

  constructor(root: HTMLElement, private data: StaticData, private h: HudHandlers) {
    this.el = document.createElement('div');
    this.el.className = 'hud';
    this.el.innerHTML = `
      <header class="top">
        <div class="level panel" aria-label="Cấp độ">
          <div class="level-badge" data-ref="level">1</div>
          <div class="level-text">
            <strong>Cấp <span data-ref="level2">1</span></strong>
            <div class="xp-bar" role="progressbar" aria-label="Kinh nghiệm" data-ref="xpbar"><span data-ref="xpfill" style="width:0%"></span></div>
            <span class="xp-text" data-ref="xptext">0 / 100 XP</span>
          </div>
        </div>
        <div class="tank-title panel">
          <h1 data-ref="tankname">Bể</h1>
          <p data-ref="tankmeta"></p>
        </div>
        <div class="wallet">
          <div class="pill panel" aria-label="Xu">${ICONS.coin}<span data-ref="coins">0</span></div>
          <div class="pill panel" aria-label="Ngọc">${ICONS.gem}<span data-ref="gems">0</span></div>
          <button class="icon-btn panel" data-act="view" aria-label="Chế độ ngắm bể" title="Chế độ ngắm bể">${ICONS.eye}</button>
          <button class="icon-btn panel" data-act="settings" aria-label="Cài đặt">${ICONS.gear}</button>
        </div>
      </header>
      <section class="stats panel" aria-label="Chỉ số bể">
        ${this.meterHtml('food', 'Thức ăn', 'var(--food)')}
        ${this.meterHtml('clean', 'Độ sạch', 'var(--clean)')}
        ${this.meterHtml('health', 'Sức khỏe cá', 'var(--health)')}
      </section>
      <nav class="actions" aria-label="Hành động">
        <button class="action primary" data-act="feed">${ICONS.feed}Cho ăn</button>
        <button class="action" data-act="water">${ICONS.water}Thay nước</button>
        <button class="action" data-act="decor">${ICONS.decor}Trang trí</button>
        <button class="action" data-act="collection">${ICONS.book}Bộ sưu tập</button>
        <button class="action" data-act="shop">${ICONS.shop}Cửa hàng</button>
      </nav>
      <div class="lock-bar" data-ref="lockbar" hidden role="status">
        <p data-ref="lockmsg"></p>
        <button data-act="buy-preview" data-ref="buypreview" hidden>Mua</button>
        <button data-act="back" class="secondary">Về bể hiện tại</button>
      </div>
      <div class="overlay shop" data-ref="shop" hidden>
        <section class="card shop-card" role="dialog" aria-modal="true" aria-labelledby="shop-title">
          <header class="shop-head">
            <h2 id="shop-title">Cửa hàng</h2>
            <span class="pill">${ICONS.coin}<span data-ref="shopcoins">0</span></span>
            <button class="icon-btn" data-act="shop-close" aria-label="Đóng cửa hàng">${ICONS.close}</button>
          </header>
          <h3>Nâng cấp bể</h3>
          <p>Bể mới thay bể hiện tại, cá được chuyển sang.</p>
          <div class="shop-list" data-ref="shoplist"></div>
        </section>
      </div>
      <button class="view-exit panel" data-act="unview">${ICONS.close}Thoát chế độ ngắm</button>
      <div class="toast panel" data-ref="toast" role="status" aria-live="polite"></div>
    `;
    root.appendChild(this.el);

    this.el.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).dataset.ref === 'shop') return this.closeShop(); // backdrop
      const btn = (e.target as HTMLElement).closest('button');
      if (!btn) return;
      const tierId = btn.dataset.tier;
      const tier = tierId ? data.tiers.find((t) => t.id === tierId) : undefined;
      switch (btn.dataset.act) {
        case 'shop': return this.h.onShop();
        case 'shop-close': return this.closeShop();
        case 'buy': return tier && this.h.onBuy(tier);
        case 'preview': return tier && this.h.onPreview(tier);
        case 'buy-preview': return this.previewTier && this.h.onBuy(this.previewTier);
        case 'feed': return this.h.onFeed();
        case 'water': return this.h.onWater();
        case 'decor': return this.h.onDecor();
        case 'collection': return this.h.onCollection();
        case 'settings': return this.h.onSettings();
        case 'back': return this.h.onBack();
        case 'view': return this.h.onView(true);
        case 'unview': return this.h.onView(false);
      }
    });
  }

  private meterHtml(key: string, label: string, color: string) {
    return `<div class="meter" data-meter="${key}">
      <div class="meter-head"><span>${label}</span><span data-val>0%</span></div>
      <div class="meter-track" role="progressbar" aria-label="${label}" aria-valuemin="0" aria-valuemax="100"><span style="width:0%;background:${color}"></span></div>
    </div>`;
  }

  render(state: PlayerState, shownTier: TankTier, preview: boolean, tank: Tank | null, fishCount: number) {
    const p = state.profile;
    this.$('[data-ref=level]').textContent = String(p.level);
    this.$('[data-ref=level2]').textContent = String(p.level);
    const pct = Math.min(100, (p.xp / p.xp_to_next) * 100);
    this.$('[data-ref=xpfill]').style.width = pct + '%';
    this.$('[data-ref=xpbar]').setAttribute('aria-valuenow', String(Math.round(pct)));
    this.$('[data-ref=xptext]').textContent = `${fmt.format(p.xp)} / ${fmt.format(p.xp_to_next)} XP`;
    this.$('[data-ref=coins]').textContent = fmt.format(p.coins);
    this.$('[data-ref=gems]').textContent = fmt.format(p.gems);

    this.$('[data-ref=tankname]').textContent = `Bể ${shownTier.name}`;
    this.$('[data-ref=tankmeta]').textContent = preview
      ? `Xem trước · ${fmt.format(volumeLiters(shownTier))} lít`
      : `${fmt.format(volumeLiters(shownTier))} lít · ${fishCount} cá`;

    const meters: [string, number][] = tank
      ? [['food', tank.food], ['clean', tank.cleanliness], ['health', tank.health]]
      : [['food', 0], ['clean', 0], ['health', 0]];
    for (const [key, v] of meters) {
      const m = this.$(`[data-meter=${key}]`);
      const val = Math.round(v);
      m.querySelector<HTMLElement>('[data-val]')!.textContent = preview ? '–' : val + '%';
      m.querySelector<HTMLElement>('.meter-track > span')!.style.width = (preview ? 0 : val) + '%';
      m.querySelector('.meter-track')!.setAttribute('aria-valuenow', String(val));
      m.classList.toggle('low', !preview && val < 30);
    }
    this.el.querySelectorAll<HTMLButtonElement>('.action').forEach((b) => (b.disabled = preview));

    this.previewTier = preview ? shownTier : null;
    const currentTier = this.data.tiers.find((t) => t.id === tank?.tier_id) ?? shownTier;
    const lockbar = this.$('[data-ref=lockbar]');
    lockbar.hidden = !preview;
    if (preview) {
      const s = this.offer(shownTier, currentTier, state);
      this.$('[data-ref=lockmsg]').textContent = `Bể ${shownTier.name} · ${s.text}`;
      const buy = this.$<HTMLButtonElement>('[data-ref=buypreview]');
      buy.hidden = s.kind !== 'buy';
      buy.textContent = `Mua · ${fmt.format(shownTier.unlock_cost_coins)} xu`;
    }
    this.renderShop(state, currentTier);
  }

  /** What the shop can offer for `tier` given the player's current tank, level and coins. */
  private offer(tier: TankTier, current: TankTier, state: PlayerState) {
    const p = state.profile;
    if (tier.id === current.id) return { kind: 'current' as const, text: 'Đang dùng' };
    if (tier.sort_order < current.sort_order) return { kind: 'smaller' as const, text: 'Nhỏ hơn bể hiện tại' };
    if (p.level < tier.unlock_level) return { kind: 'level' as const, text: `Cần cấp ${tier.unlock_level} (còn ${tier.unlock_level - p.level} cấp)` };
    if (p.coins < tier.unlock_cost_coins) return { kind: 'coins' as const, text: `Thiếu ${fmt.format(tier.unlock_cost_coins - p.coins)} xu` };
    return { kind: 'buy' as const, text: `${fmt.format(tier.unlock_cost_coins)} xu` };
  }

  private renderShop(state: PlayerState, current: TankTier) {
    this.$('[data-ref=shopcoins]').textContent = fmt.format(state.profile.coins);
    const rows = this.data.tiers
      .filter((t) => t.sort_order >= current.sort_order)
      .map((t) => {
        const o = this.offer(t, current, state);
        const price = o.kind === 'current' ? '' : `<span class="price">${ICONS.coin}${fmt.format(t.unlock_cost_coins)}</span>`;
        const req = o.kind === 'current' ? 'Bể của bạn' : `Cấp ${t.unlock_level}`;
        const action =
          o.kind === 'current' ? '<span class="tag">Đang dùng</span>'
          : o.kind === 'buy' ? `<button class="btn buy" data-act="buy" data-tier="${t.id}">Mua</button>`
          : `<span class="tag ${o.kind === 'level' ? 'locked' : ''}">${o.kind === 'level' ? ICONS.lock + ' ' : ''}${o.text}</span>`;
        const preview = o.kind === 'current' ? '' : `<button class="link" data-act="preview" data-tier="${t.id}">Xem trước</button>`;
        return `<div class="shop-row ${o.kind}">
          <div class="shop-size"><b>${t.label}</b><small>${fmt.format(volumeLiters(t))} lít</small></div>
          <div class="shop-meta"><span>${req}</span>${price}</div>
          <div class="shop-act">${action}${preview}</div>
        </div>`;
      });
    this.$('[data-ref=shoplist]').innerHTML = rows.join('');
  }

  openShop() {
    this.$('[data-ref=shop]').hidden = false;
    this.$<HTMLButtonElement>('[data-act=shop-close]').focus();
  }

  closeShop() {
    this.$('[data-ref=shop]').hidden = true;
  }

  toast(text: string, error = false) {
    const t = this.$('[data-ref=toast]');
    t.textContent = text;
    t.classList.toggle('error', error);
    t.classList.add('show');
    clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => t.classList.remove('show'), 2600);
  }

  setBusy(busy: boolean) {
    this.el.querySelectorAll<HTMLButtonElement>('.action[data-act=feed], .action[data-act=water]').forEach((b) => {
      if (busy) b.disabled = true;
    });
  }
}
