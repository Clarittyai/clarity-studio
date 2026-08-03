import { _electron as electron } from 'playwright';

// --no-sandbox is needed only because this harness runs as root in a
// container. The app itself keeps Chromium's sandbox on for real users.
const app = await electron.launch({
  args: ['.', '--no-sandbox'],
  cwd: '/home/user/claritty-studio/apps/desktop',
  env: { ...process.env, STUDIO_HOME: '/tmp/studio-desktop' },
});

const win = await app.firstWindow();
await win.waitForSelector('text=Claritty Studio');
await win.waitForTimeout(1500);
await win.screenshot({ path: '/tmp/electron-app.png' });

console.log('title            :', await win.title());
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
