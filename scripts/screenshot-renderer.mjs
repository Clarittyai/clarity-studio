import { chromium } from 'playwright';

// The pre-installed browser, rather than downloading one that matches the
// pinned Playwright build.
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
for (const [name, scheme] of [['dark', 'dark'], ['light', 'light']]) {
  const p = await b.newPage({ viewport: { width: 1180, height: 820 }, deviceScaleFactor: 2 });
  await p.goto('http://127.0.0.1:5199/');
  if (scheme === 'light') await p.evaluate(() => document.documentElement.classList.remove('dark'));
  await p.waitForSelector('text=Claritty Studio');
  await p.waitForTimeout(800);
  await p.screenshot({ path: `/tmp/studio-${name}.png` });
  console.log(name, 'ok');
  await p.close();
}
await b.close();
