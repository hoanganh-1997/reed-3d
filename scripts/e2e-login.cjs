// E2E against the real backend: sign in, act, reload, verify persistence.
// Env: APP_URL, TEST_EMAIL_A, TEST_PASSWORD_A. Dev tool; screenshots to OUT_DIR.
const { chromium } = require('playwright');
(async () => {
  const proxy = process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY, bypass: 'localhost,127.0.0.1' } : undefined;
  const browser = await chromium.launch({ proxy, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, ignoreHTTPSErrors: !!proxy });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const out = process.env.OUT_DIR || '.';
  const fail = (m) => { console.log('FAIL', m); process.exitCode = 1; };

  await page.goto(process.env.APP_URL);
  await page.waitForSelector('form.card', { timeout: 30000 });
  console.log('PASS sign-in card shown when logged out');
  await page.fill('input[name=email]', process.env.TEST_EMAIL_A);
  await page.fill('input[name=password]', 'wrong-password');
  await page.click('button[data-mode=in]');
  await page.waitForSelector('.msg.error', { timeout: 15000 });
  console.log('PASS wrong password rejected:', await page.textContent('.msg.error'));
  await page.fill('input[name=password]', process.env.TEST_PASSWORD_A);
  await page.click('button[data-mode=in]');
  await page.waitForSelector('.tank-title', { timeout: 30000 });
  await page.waitForTimeout(1500);
  const before = await page.evaluate(() => window.__reef.state);
  console.log(`PASS signed in: level ${before.profile.level}, coins ${before.profile.coins}, tanks ${before.tanks.length}`);

  // Locked tier: should preview, not unlock
  await page.click('.tier[data-tier=big200]');
  await page.waitForTimeout(800);
  const lockText = await page.textContent('[data-ref=lockmsg]');
  if (await page.isVisible('[data-ref=lockbar]')) console.log('PASS locked tank preview:', lockText);
  else fail('lock bar not shown');
  await page.screenshot({ path: `${out}/e2e-locked-preview.png` });
  await page.click('[data-act=back]');

  await page.click('[data-act=feed]');
  await page.waitForTimeout(2500);
  const afterAct = await page.evaluate(() => window.__reef.state);
  await page.screenshot({ path: `${out}/e2e-signed-in.png` });

  await page.reload();
  await page.waitForSelector('.tank-title', { timeout: 30000 });
  await page.waitForTimeout(1500);
  if (await page.isVisible('form.card')) fail('sign-in card shown again after reload');
  const afterReload = await page.evaluate(() => window.__reef.state);
  const same = afterReload.profile.user_id === afterAct.profile.user_id &&
    afterReload.profile.xp === afterAct.profile.xp && afterReload.profile.coins === afterAct.profile.coins &&
    afterReload.tanks.map((t) => t.id).join() === afterAct.tanks.map((t) => t.id).join() &&
    Math.round(afterReload.tanks[0].food) === Math.round(afterAct.tanks[0].food) && afterAct.profile.xp > before.profile.xp;
  if (same) console.log(`PASS reload keeps session + progress (xp ${afterReload.profile.xp}, coins ${afterReload.profile.coins}, food ${Math.round(afterReload.tanks[0].food)}, xp before ${before.profile.xp})`);
  else fail('state differs after reload ' + JSON.stringify({ afterAct: afterAct.profile, afterReload: afterReload.profile }));
  if (errors.length) fail('page errors: ' + errors.join(' | '));
  await browser.close();
})();
