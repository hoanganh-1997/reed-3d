// Screenshot helper (dev only): node scripts/shots.cjs <url> <outdir> [width height]
const { chromium } = require('playwright');
(async () => {
  const [url, out, w = 1440, h = 810] = process.argv.slice(2);
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: +w, height: +h } });
  const logs = [];
  page.on('console', (m) => logs.push(m.type() + ': ' + m.text()));
  page.on('pageerror', (e) => logs.push('pageerror: ' + e.message));
  await page.goto(url);
  await page.waitForTimeout(2500);
  // Tiers are previewed through the shop (sizes moved out of the HUD).
  const tiers = process.env.TIERS ? process.env.TIERS.split(',') : ['cube30', 'cube35', 'cube40', 'cube45', 'cube50', 'cube55', 'cube60', 'big200'];
  for (const id of tiers) {
    await page.click('[data-act=shop]');
    const btn = await page.$(`[data-act=preview][data-tier=${id}]`);
    if (btn) await btn.click(); else await page.click('[data-act=shop-close]');
    await page.waitForTimeout(2600);
    if (process.env.ZOOM) { await page.mouse.move(720, 380); for (let i = 0; i < +process.env.ZOOM; i++) { await page.mouse.wheel(0, -200); await page.waitForTimeout(150); } await page.waitForTimeout(2500); }
    await page.screenshot({ path: `${out}/${w}x${h}-${id}.png` });
  }
  console.log(logs.join('\n'));
  await browser.close();
})();
