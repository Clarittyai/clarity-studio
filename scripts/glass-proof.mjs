/**
 * Prove Studio's modal really renders the ten-layer material AND animates.
 *
 * Adapted from scripts/screenshot-app.mjs. It launches the real Electron app,
 * opens the New automation modal, and asserts the things that a screenshot
 * alone cannot: that ten material layers exist, that the backdrop filter is
 * live, that the fill is translucent enough for the blur to show, and that the
 * panel actually moved during its entrance.
 */
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = process.env.OUT_DIR ?? '/tmp';

const app = await electron.launch({
  args: ['.', '--no-sandbox'],
  cwd: join(ROOT, 'apps/desktop'),
  env: { ...process.env, STUDIO_HOME: process.env.STUDIO_HOME ?? '/tmp/studio-glass-proof' },
});

const win = await app.firstWindow();
await win.waitForSelector('[data-brand]');
await win.waitForTimeout(2500);
await win.screenshot({ path: `${OUT_DIR}/studio-before.png` });

// Open "New automation". The button label is the one stable handle.
const trigger = win.locator('button', { hasText: /new automation/i }).first();
const found = (await trigger.count()) > 0;
console.log('new-automation trigger:', found);
if (!found) {
  console.log('buttons seen:', (await win.locator('button').allInnerTexts()).slice(0, 14));
  await app.close();
  process.exit(1);
}

await trigger.click();

// Sample the panel mid-entrance to prove it is actually travelling.
await win.waitForSelector('.liquid-glass', { timeout: 5000 });
const early = await win.evaluate(() => {
  const el = document.querySelector('.liquid-glass');
  if (!el) return null;
  const p = el.parentElement; // the motion.div that carries the transform
  return { transform: p ? getComputedStyle(p).transform : 'none', opacity: p ? getComputedStyle(p).opacity : '1' };
});

await win.waitForTimeout(700); // well past the 220ms curve
const settled = await win.evaluate(() => {
  const el = document.querySelector('.liquid-glass');
  const content = el?.querySelector('.liquid-glass__content');
  const edge = el?.querySelector('.lg-edge-reflection');
  const p = el?.parentElement;
  const scrim = document.querySelector('.fixed.inset-0.z-50');
  return {
    layers: el ? el.querySelectorAll('.liquid-glass__material > div').length : 0,
    edgeBackdrop: edge ? getComputedStyle(edge).backdropFilter : 'n/a',
    contentBg: content ? getComputedStyle(content).backgroundColor : 'n/a',
    contentRadius: content ? getComputedStyle(content).borderRadius : 'n/a',
    hostPointerEvents: el ? getComputedStyle(el).pointerEvents : 'n/a',
    panelTransform: p ? getComputedStyle(p).transform : 'n/a',
    panelOpacity: p ? getComputedStyle(p).opacity : 'n/a',
    scrimBackdrop: scrim ? getComputedStyle(scrim).backdropFilter : 'n/a',
    glassBackdropToken: getComputedStyle(document.documentElement)
      .getPropertyValue('--glass-backdrop')
      .trim(),
  };
});

await win.screenshot({ path: `${OUT_DIR}/studio-modal.png` });

const alpha = /rgba?\([^)]*?,\s*([0-9.]+)\s*\)/.exec(settled.contentBg)?.[1];

console.log('\n--- entrance ---');
console.log('  mid-flight transform :', early?.transform);
console.log('  mid-flight opacity   :', early?.opacity);
console.log('  settled transform    :', settled.panelTransform);
console.log('  settled opacity      :', settled.panelOpacity);
console.log('\n--- material ---');
console.log('  layers               :', settled.layers, '(expect 10)');
console.log('  edge backdrop-filter :', settled.edgeBackdrop);
console.log('  --glass-backdrop     :', settled.glassBackdropToken);
console.log('  content fill         :', settled.contentBg, alpha ? `(alpha ${alpha})` : '');
console.log('  content radius       :', settled.contentRadius);
console.log('  host pointer-events  :', settled.hostPointerEvents, '(expect none)');
console.log('  scrim backdrop-filter:', settled.scrimBackdrop, '(expect none — the panel blurs)');

const problems = [];
if (settled.layers !== 10) problems.push(`expected 10 material layers, saw ${settled.layers}`);
if (!/blur/.test(settled.edgeBackdrop)) problems.push('edge reflection has no backdrop blur');
if (!settled.glassBackdropToken) problems.push('--glass-backdrop token missing');
if (alpha && Number(alpha) > 0.8) problems.push(`fill alpha ${alpha} > 0.80 — the blur is hidden`);
if (settled.hostPointerEvents !== 'none') problems.push('host should be pointer-events:none');
if (early && early.transform === settled.panelTransform && early.opacity === settled.panelOpacity)
  problems.push('panel never moved — the entrance is not animating');

console.log(problems.length ? `\n✘ ${problems.length} problem(s):` : '\n✓ all checks passed');
problems.forEach((p) => console.log('   -', p));

await app.close();
process.exit(problems.length ? 1 : 0);
