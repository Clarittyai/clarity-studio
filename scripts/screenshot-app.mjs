import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { _electron as electron } from 'playwright';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// --no-sandbox is needed only because this harness runs as root in a
// container. The app itself keeps Chromium's sandbox on for real users.
// STUDIO_HOME is overridable so this can be pointed at a real store to
// reproduce "it looks wrong with my data", not only at an empty one.
const app = await electron.launch({
  args: ['.', '--no-sandbox'],
  cwd: join(ROOT, 'apps/desktop'),
  env: { ...process.env, STUDIO_HOME: process.env.STUDIO_HOME ?? '/tmp/studio-desktop' },
});

const win = await app.firstWindow();
// Wait on the lockup wrapper, not on the SVGs inside it: the light and dark
// colorways both exist in the DOM and one is always `display:none`, so an
// aria-label selector resolves to a hidden element and never becomes visible.
await win.waitForSelector('[data-brand]');
await win.waitForTimeout(2000);
await win.screenshot({ path: process.env.OUT ?? '/tmp/electron-app.png' });

console.log('title            :', await win.title());
console.log('brand lockup     :', await win.locator('[data-brand]').count());
console.log('live scene       :', await win.locator('text=runs on its own').count(), '(1 = animated empty state present)');
console.log('projects in list :', await win.locator('aside button').count());
console.log('sample-data badge:', await win.locator('text=sample data').count(), '(0 means real store data)');
console.log('run rows         :', await win.locator('text=chase-overdue').count());

// The security posture, asserted rather than assumed.
const exposed = await win.evaluate(() => ({
  hasStudioBridge: typeof window.studio !== 'undefined',
  hasRequire: typeof window.require !== 'undefined',
  hasProcess: typeof window.process !== 'undefined',
}));
console.log('bridge exposed   :', exposed.hasStudioBridge);
console.log('node leaked      :', exposed.hasRequire || exposed.hasProcess);

await app.close();
