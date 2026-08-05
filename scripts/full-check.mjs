import { randomUUID } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { _electron as electron } from 'playwright';
import { Store } from '../packages/db/dist/index.js';

const ROOT = new URL('..', import.meta.url).pathname;

// The check builds its own fixture rather than depending on a folder somebody
// scaffolded earlier — a harness that only passes on the machine that set it up
// is not a check.
const PROJECT = process.env.PROJECT_DIR ?? '/tmp/studio-full-project';
if (!process.env.PROJECT_DIR) {
  rmSync(PROJECT, { recursive: true, force: true });
  cpSync(join(ROOT, 'packages/automation-seed'), PROJECT, {
    recursive: true,
    filter: (src) => !src.includes('/.studio') && !src.includes('__pycache__'),
  });
}
if (!existsSync(join(PROJECT, 'intelligence.yaml'))) {
  throw new Error(`no manifest in ${PROJECT} — the fixture is wrong, not the app`);
}

const HOME = '/tmp/studio-full';
rmSync(HOME, { recursive: true, force: true });
mkdirSync(HOME, { recursive: true });
const s = new Store(join(HOME, 'studio.db'));
const id = randomUUID();
s.upsertProject({ id, name: 'fresh-auto', slug: 'fresh-auto', path: PROJECT, runtime: 'native', status: 'stopped' });
s.close();

const app = await electron.launch({ args: ['.'], cwd: join(ROOT, 'apps/desktop'), env: { ...process.env, STUDIO_HOME: HOME } });
const win = await app.firstWindow();
const errs = [];
win.on('pageerror', (e) => errs.push(e.message));
win.on('console', (m) => { if (m.type() === 'error') errs.push(`console: ${m.text()}`); });

const pass = [], fail = [];
const check = (name, ok, detail = '') => (ok ? pass : fail).push(`${name}${detail ? ` — ${detail}` : ''}`);

await win.waitForSelector('[data-brand]');
await win.waitForTimeout(4000);
const t = () => win.locator('body').innerText();

// Home is the launch screen now, so these checks belong here — and then the
// project checks below need the project actually opened first. The suite used
// to assume a project was auto-selected, which is the very bug that made Home
// unreachable, so it was asserting the broken behaviour.
{
  const home = await t();
  check('lands on Home', /Your automations/.test(home));
  check('showcase present', (await win.locator('[class*="rounded-3xl"] h2').count()) > 0);
  check('aggregate tiles', /Tokens, 7 days/.test(home) && /Next run/.test(home));
  check('contribute + issues', /come and read it/.test(home) && /report an issue/.test(home));
  check('sidebar Home row', (await win.locator('aside button:has-text("Home")').count()) === 1);
}

// Open the automation; everything below is the project screen.
// By name, not by position: the sidebar's `+` is also a text-less button, so
// "the first one that isn't Home" opened the create dialog instead.
await win.locator('aside button', { hasText: 'fresh-auto' }).first().click();
// The pty starts on mount, so wait for the terminal rather than a fixed sleep —
// a timing guess is how a suite goes red on a slower machine.
await win.waitForSelector('.xterm', { timeout: 60_000 }).catch(() => undefined);
// The manifest is read from disk after mount, so the flow and the agents band
// arrive later than the terminal. Waiting for the content beats sleeping past
// it: this check failed once on a busy machine and passed on a re-run, which
// is the least useful kind of red.
await win
  .waitForSelector('text=digest-writer', { timeout: 30_000 })
  .catch(() => undefined);
await win.waitForTimeout(1500);

// Brand in the sidebar, not the title bar.
const brandBox = await win.locator('[data-brand]').boundingBox();
check('brand in sidebar under traffic lights', brandBox.y > 40 && brandBox.x < 260, `x=${Math.round(brandBox.x)} y=${Math.round(brandBox.y)}`);
check('brand is platform-size', brandBox.height >= 28, `h=${Math.round(brandBox.height)}`);

let body = await t();
check('flow renders from manifest', /Flow/.test(body) && /write|Trigger/.test(body));
check('agents band', /digest-writer/.test(body));
check('triggers band', /Triggers/.test(body));
check('terminal dock present', /Build it/.test(body));
check('xterm mounted', (await win.locator('.xterm').count()) === 1);
check('no pty error', !/posix_spawnp|Error invoking/.test(body));

// Two columns: the aside must sit to the RIGHT of the flow, not under it.
const flow = await win.locator('h2:has-text("Flow")').boundingBox().catch(() => null);
const agents = await win.locator('h2:has-text("Agents")').boundingBox().catch(() => null);
check('two-column layout', Boolean(flow && agents && agents.x > flow.x + 100), flow && agents ? `flow.x=${Math.round(flow.x)} agents.x=${Math.round(agents.x)}` : 'missing');

// Terminal spans wide (full-bleed, not a narrow card).
const term = await win.locator('.xterm').boundingBox();
const winSize = await win.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
check('terminal is full-bleed', term.width > winSize.w * 0.55, `${Math.round(term.width)}px of ${winSize.w}px`);

// Executions tab switches.
await win.locator('button:has-text("Executions")').click();
await win.waitForTimeout(600);
check('Executions tab switches', /Every run|No runs yet/.test(await t()));
await win.locator('button:has-text("Flow")').first().click();
await win.waitForTimeout(400);

// Drag the dock taller.
const before = (await win.locator('.xterm').boundingBox()).height;
const grip = await win.locator('div[title*="Drag to resize"]').boundingBox();
await win.mouse.move(grip.x + grip.width / 2, grip.y + 1);
await win.mouse.down();
await win.mouse.move(grip.x + grip.width / 2, grip.y - 120, { steps: 8 });
await win.mouse.up();
await win.waitForTimeout(600);
const after = (await win.locator('.xterm').boundingBox()).height;
check('drag resizes the dock', after > before + 40, `${Math.round(before)} → ${Math.round(after)}`);

// Collapse keeps the session alive (element hidden, not unmounted).
await win.locator('button:has-text("Build it")').click();
await win.waitForTimeout(500);
check('collapse hides but keeps session', (await win.locator('.xterm').count()) === 1 && !(await win.locator('.xterm').isVisible()));
await win.locator('button:has-text("Build it")').click();
await win.waitForTimeout(500);

// Settings.
await win.locator('button[title="Settings"]').click();
await win.waitForTimeout(800);
body = await t();
check('settings: library folder', /Library/.test(body) && /Automations/.test(body));
check('settings: model providers', /Anthropic/i.test(body) && /Openai/i.test(body));
check('settings: local model examples', /11434|Ollama/.test(body) && /chat\/completions/.test(body));
await win.locator('button[title="Settings"]').click();
await win.waitForTimeout(500);

// New-automation dialog is in-app (no native panel).
await win.locator('aside button[title="New automation"]').click();
await win.waitForTimeout(600);
body = await t();
check('in-app new dialog', /What should it do/.test(body) && /Create/.test(body));
check('dialog shows destination', /Automations\//.test(body));
await win.keyboard.press('Escape');
await win.waitForTimeout(400);

check('no renderer errors', errs.length === 0, errs.slice(0, 2).join(' | '));

console.log(`\nPASS (${pass.length}):`);
for (const p of pass) console.log('  ✓', p);
if (fail.length) { console.log(`\nFAIL (${fail.length}):`); for (const f of fail) console.log('  ✗', f); }
await win.screenshot({ path: '/tmp/full-check.png' });
await app.close();
process.exit(fail.length ? 1 : 0);
