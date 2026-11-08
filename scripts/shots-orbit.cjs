// Dev only: screenshot front + both sides after dragging. node scripts/shots-orbit.cjs <url> <outdir> <tier>
const { chromium } = require('playwright');
(async () => {
  const [url, out, tier] = process.argv.slice(2);
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 810 } });
  page.on('pageerror', (e) => console.log('pageerror', e.message));
  await page.goto(url);
  await page.waitForTimeout(2500);
  // Demo: buy the size in the shop (use ?demoLevel=45&demoCoins=99999).
  if (tier) { await page.click('[data-act=shop]'); await page.click(`[data-act=buy][data-tier=${tier}]`); await page.waitForTimeout(4000); }
  await page.screenshot({ path: `${out}/orbit-${tier}-front.png` });
  for (const [name, dx] of [['left', 700], ['right', -1400]]) {
    await page.mouse.move(720, 400);
    await page.mouse.down();
    for (let i = 1; i <= 20; i++) await page.mouse.move(720 + (dx * i) / 20, 400);
    await page.mouse.up();
    await page.waitForTimeout(2500);
    await page.screenshot({ path: `${out}/orbit-${tier}-${name}.png` });
  }
  await browser.close();
})();
