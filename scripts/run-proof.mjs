/**
 * Proof that Studio runs an automation — through the app, not around it.
 *
 * Everything else is verified in pieces: the dispatcher fires against a stub
 * listener, the connector engine against a mock fetch, the manifest against the
 * published SDK. Nothing had ever gone the whole way — press the button in the
 * window, boot a real venv, execute a workflow, record a run, write a file.
 *
 * Uses `downloads-report` because it needs no credential of any kind: no model
 * key, no connection, no account. If this passes, the machine works and every
 * later failure is about a credential rather than the runtime.
 *
 * Slow on the first run — it builds a venv and installs from PyPI.
 *
 * Run: node scripts/run-proof.mjs
 */

import { randomUUID } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { _electron as electron } from 'playwright';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { Store } = await import(join(ROOT, 'packages/db/dist/index.js'));

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};

const SOURCE = process.env.RUN_PROOF_PROJECT ?? join(process.env.HOME ?? '', 'Automations/downloads-report');
if (!existsSync(join(SOURCE, 'intelligence.yaml'))) {
  throw new Error(`no automation at ${SOURCE}`);
}

// A copy, so the proof never runs against — or writes into — the real one.
const HOME = '/tmp/run-proof-home';
const PROJECT = '/tmp/run-proof-project';
for (const dir of [HOME, PROJECT]) rmSync(dir, { recursive: true, force: true });
mkdirSync(HOME, { recursive: true });
cpSync(SOURCE, PROJECT, {
  recursive: true,
  filter: (s) => !s.includes('__pycache__') && !s.includes('/.studio') && !s.includes('/reports'),
});

const store = new Store(join(HOME, 'studio.db'));
const projectId = randomUUID();
store.upsertProject({
  id: projectId, name: 'downloads-report', slug: 'downloads-report',
  path: PROJECT, runtime: 'native', status: 'stopped',
});
store.close();

const PACKAGED = join(ROOT, 'apps/desktop/release/mac-arm64/Claritty Studio.app/Contents/MacOS/Claritty Studio');
const packaged = existsSync(PACKAGED);
console.log(`\nAgainst ${packaged ? 'the packaged app' : 'the dev build'}, on a copy of ${SOURCE}\n`);

const app = await electron.launch(
  packaged
    ? { executablePath: PACKAGED, args: [], env: { ...process.env, STUDIO_HOME: HOME } }
    : { args: ['.'], cwd: join(ROOT, 'apps/desktop'), env: { ...process.env, STUDIO_HOME: HOME } },
);
const win = await app.firstWindow();
const errors = [];
win.on('pageerror', (e) => errors.push(String(e)));
await win.waitForSelector('[data-brand]');
await win.waitForTimeout(2000);

await win.locator('aside button', { hasText: 'downloads-report' }).first().click();
await win.waitForSelector('text=What runs, in order', { timeout: 20_000 });
check('the automation opens and draws its flow', true);
check(
  'and it is not the example',
  !(await win.locator('body').innerText()).includes('still the example'),
);

console.log('\nPressing Run now — this builds a venv the first time:\n');
await win.locator('button:has-text("Run now")').click();

// Poll the STORE, not the screen. The first version waited for status text in
// the DOM and timed out while the run had in fact completed perfectly — the
// Executions tab was not open, so there was nothing to match. The run either
// exists as a row or it does not; that is the fact, and the window is a view of
// it. The venv install dominates the wall clock on a cold machine.
const deadline = Date.now() + 8 * 60_000;
let ran = false;
while (Date.now() < deadline) {
  const probe = new Store(join(HOME, 'studio.db'));
  const found = probe.listRuns(projectId)[0];
  probe.close();
  if (found && found.status !== 'running') { ran = true; break; }
  await win.waitForTimeout(3000);
}
await win.waitForTimeout(1500);

const body = await win.locator('body').innerText();
const blocked = /model provider key/i.test(body);
check(
  'a run without agents needs no model key',
  !blocked,
  blocked ? 'refused for a key it does not need' : '',
);
check('the run completed', ran, ran ? '' : 'no run row appeared in eight minutes');

// The store is the authority, not the screen.
const after = new Store(join(HOME, 'studio.db'));
const runs = after.listRuns(projectId);
check('a run was recorded', runs.length > 0, `${runs.length} run(s)`);
const run = runs[0];
if (run) {
  const steps = after.getSteps(run.id);
  check('with a step timeline', steps.length > 0, steps.map((s) => `${s.stepId}:${s.status}`).join(' '));
  const succeeded = steps.filter((s) => s.status === 'success').length;
  // A run whose steps all skipped is not a success whatever the engine says.
  check('every step actually ran', succeeded === steps.length && succeeded > 0, `${succeeded}/${steps.length} succeeded`);
  check('the run says success', run.status === 'success', run.status + (run.error ? ` — ${run.error}` : ''));
}
after.close();

// The point of the whole thing: a file on disk that was not there before.
const reports = existsSync(join(PROJECT, 'reports')) ? readdirSync(join(PROJECT, 'reports')) : [];
check('and it produced real output', reports.length > 0, reports.join(', ') || 'no report written');
check('no renderer errors', errors.length === 0, errors[0] ?? '');

await app.close();
console.log(failures === 0 ? '\nOK — Studio runs an automation.\n' : `\n${failures} failed.\n`);
process.exit(failures === 0 ? 0 : 1);
