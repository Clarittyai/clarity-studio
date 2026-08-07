/**
 * Regenerate the README screenshots from the current build.
 *
 * A script rather than a habit: the last set went stale in a day because it was
 * taken by hand. Uses the invoice-digest fixture, not the seed example, so the
 * flow shows a fan-out, a WRITE step and a real integration row.
 */
import { randomUUID } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { _electron as electron } from 'playwright';

import { Store } from '../packages/db/dist/index.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = process.env.SHOTS_PROJECT ?? '/tmp/invoice-digest';
if (!existsSync(join(FIXTURE, 'intelligence.yaml'))) {
  throw new Error(`no automation at ${FIXTURE} — set SHOTS_PROJECT to one`);
}

// Under the home directory on purpose: the UI renders it as
// `~/Automations/invoice-digest`, which is both what a real install looks like
// and free of anybody's username. A /tmp path in a README screenshot tells the
// reader nothing and looks like a test artefact.
const PROJECT = join(process.env.HOME ?? '/tmp', 'Automations', 'invoice-digest');
rmSync(PROJECT, { recursive: true, force: true });
mkdirSync(dirname(PROJECT), { recursive: true });
cpSync(FIXTURE, PROJECT, {
  recursive: true,
  filter: (s) => !s.includes('__pycache__') && !s.includes('/.venv'),
});

const HOME = '/tmp/shots-home';
rmSync(HOME, { recursive: true, force: true });
mkdirSync(HOME, { recursive: true });
const store = new Store(join(HOME, 'studio.db'));
store.upsertProject({
  id: randomUUID(),
  name: 'invoice-digest',
  slug: 'invoice-digest',
  path: PROJECT,
  runtime: 'native',
  status: 'stopped',
});
store.close();

// Pre-trust the fixture, exactly as Studio does for a folder it creates. Without
// this the terminal shows Claude Code's "is this a project you trust?" prompt —
// a security dialog filling two thirds of the frame, which is neither the
// product nor a good first impression of it.
try {
  const claudeConfig = join(process.env.HOME ?? '', '.claude.json');
  if (existsSync(claudeConfig)) {
    const cfg = JSON.parse(readFileSync(claudeConfig, 'utf8'));
    cfg.projects ??= {};
    cfg.projects[PROJECT] ??= { hasTrustDialogAccepted: true };
    writeFileSync(claudeConfig, JSON.stringify(cfg, null, 2));
  }
} catch {
  // Not fatal: the shot just shows the prompt, which is what it did before.
}

mkdirSync(join(ROOT, 'docs/img'), { recursive: true });
const app = await electron.launch({
  args: ['.'],
  cwd: join(ROOT, 'apps/desktop'),
  env: { ...process.env, STUDIO_HOME: HOME },
});
const win = await app.firstWindow();
await win.waitForSelector('[data-brand]');
await win.waitForTimeout(4000);
await win.screenshot({ path: join(ROOT, 'docs/img/home.png') });

// Where it starts: saying what it should do, in a sentence.
await win.locator('aside button[title="New automation"]').click();
await win.waitForTimeout(700);
const say = win.locator('textarea').first();
if (await say.count()) {
  await say.fill(
    'Every weekday morning, read the invoices that arrived overnight, work out which are genuinely new, and send me one summary.',
  );
}
await win.locator('input[type="text"], input:not([type])').first().fill('invoice digest');
await win.waitForTimeout(500);
await win.screenshot({ path: join(ROOT, 'docs/img/create.png') });
await win.keyboard.press('Escape');
await win.waitForTimeout(600);

await win.locator('aside button', { hasText: 'invoice-digest' }).first().click();
await win.waitForSelector('text=invoice-reader', { timeout: 30_000 }).catch(() => undefined);
await win.waitForSelector('.xterm', { timeout: 60_000 }).catch(() => undefined);
await win.waitForTimeout(2500);
// The terminal stays OPEN. Collapsing it made the flow the subject, which
// missed the point: the agent writing the automation in the same window as the
// diagram it is changing IS the product. A screenshot of the diagram alone
// could be any workflow tool.
await win.waitForTimeout(1500);
await win.screenshot({ path: join(ROOT, 'docs/img/automation.png') });

// The channels and the trigger switch, which the default window cuts off. A
// taller window rather than scrolling: three attempts to scroll that column
// produced an identical frame, and resizing shows the whole thing at once
// anyway — which is what the picture is for.
await win.setViewportSize({ width: 1180, height: 1500 });
await win.waitForTimeout(1500);
await win.screenshot({ path: join(ROOT, 'docs/img/controls.png') });
await win.setViewportSize({ width: 1180, height: 820 });
await win.waitForTimeout(800);

await win.locator('button[title="Settings"]').click();
await win.waitForTimeout(1200);
await win.screenshot({ path: join(ROOT, 'docs/img/settings.png') });

console.log('screenshots written to docs/img');
await app.close();
