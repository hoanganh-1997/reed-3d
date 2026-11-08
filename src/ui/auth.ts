import type { Backend } from '../game/backend';

const AUTH_ERRORS: Record<string, string> = {
  'Invalid login credentials': 'Email hoặc mật khẩu không đúng.',
  'Email not confirmed': 'Email chưa được xác nhận. Hãy mở link trong hộp thư.',
  'User already registered': 'Email này đã có tài khoản. Hãy đăng nhập.',
};

const viError = (msg: string) =>
  AUTH_ERRORS[msg] ?? (msg.includes('Password should be') ? 'Mật khẩu cần ít nhất 6 ký tự.' : msg);

/** Sign-in card. Resolves once a session exists. */
export function showAuth(root: HTMLElement, backend: Backend): Promise<void> {
  return new Promise((resolve) => {
    const el = document.createElement('div');
    el.className = 'overlay';
    el.innerHTML = `
      <form class="card panel" novalidate>
        <h2>Reef 3D</h2>
        <p>Đăng nhập để lưu bể cá và tiến trình của bạn.</p>
        <label class="field">Email<input name="email" type="email" autocomplete="email" required /></label>
        <label class="field">Mật khẩu<input name="password" type="password" autocomplete="current-password" minlength="6" required /></label>
        <div class="msg" role="alert" data-msg></div>
        <div class="row">
          <button class="btn primary" type="submit" data-mode="in">Đăng nhập</button>
          <button class="btn" type="submit" data-mode="up">Tạo tài khoản</button>
        </div>
      </form>`;
    root.appendChild(el);
    const form = el.querySelector('form')!;
    const msg = el.querySelector<HTMLElement>('[data-msg]')!;
    const setMsg = (text: string, error = false) => {
      msg.textContent = text;
      msg.classList.toggle('error', error);
    };

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const mode = ((e as SubmitEvent).submitter as HTMLButtonElement | null)?.dataset.mode ?? 'in';
      const email = (form.elements.namedItem('email') as HTMLInputElement).value.trim();
      const password = (form.elements.namedItem('password') as HTMLInputElement).value;
      if (!email || password.length < 6) return setMsg('Nhập email và mật khẩu (ít nhất 6 ký tự).', true);
      const buttons = form.querySelectorAll('button');
      buttons.forEach((b) => (b.disabled = true));
      setMsg(mode === 'in' ? 'Đang đăng nhập…' : 'Đang tạo tài khoản…');
      try {
        if (mode === 'in') {
          await backend.signIn(email, password);
        } else {
          const { needsConfirm } = await backend.signUp(email, password);
          if (needsConfirm) {
            setMsg('Đã gửi email xác nhận. Mở link trong email rồi quay lại đăng nhập.');
            buttons.forEach((b) => (b.disabled = false));
            return;
          }
        }
        el.remove();
        resolve();
      } catch (err) {
        setMsg(viError((err as Error).message), true);
        buttons.forEach((b) => (b.disabled = false));
      }
    });
    (form.elements.namedItem('email') as HTMLInputElement).focus();
  });
}
