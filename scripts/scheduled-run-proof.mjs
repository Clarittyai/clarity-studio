/**
 * Proof that a SCHEDULE actually runs an automation — nobody presses anything.
 *
 * Two proofs already exist and neither covers this. `proof:schedule` drives the
 * dispatcher against a stub HTTP listener, so it proves the dispatch chain and
 * not that a real automation executes. `proof:run` presses Run now, so it proves
 * execution and not that anything fires on its own. The gap between them is the
 * entire promise on the Home screen: "it runs on its schedule, does the work,
 * and tells you what it did."
 *
 * So: arm a trigger that is already due, launch the app, touch nothing, and wait
 * for a run to appear that was triggered BY THE SCHEDULE — then check the same
 * things a person would: every step ran, and a file exists that did not before.
 *
 * Uses `downloads-report` because it needs no credential of any kind.
 * The dispatcher ticks every 15s and the automation cold-starts a venv.
 *
 * Run: node scripts/scheduled-run-proof.mjs
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

const SOURCE = process.env.SCHED_PROOF_PROJECT ?? join(process.env.HOME ?? '', 'Automations/downloads-report');
if (!existsSync(join(SOURCE, 'intelligence.yaml'))) throw new Error(`no automation at ${SOURCE}`);

const HOME = '/tmp/sched-run-home';
const PROJECT = '/tmp/sched-run-project';
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

// Armed, and already due. This is the state the switch in the Triggers band
// produces — enabled with a next run — brought forward so the proof does not
// wait until tomorrow morning to find out whether schedules work.
const trigger = store.triggers.add({
  projectId,
  recipeTriggerId: 'weekday-evening',
  workflowId: 'downloads-report',
  type: 'SCHEDULE',
  enabled: true,
  schedule: { mode: 'DAILY', time: '18:00', timezone: 'UTC' },
  timezone: 'UTC',
  nextRunAt: Date.now() - 1000,
  missedPolicy: 'run-once',
});
store.close();

const PACKAGED = join(ROOT, 'apps/desktop/release/mac-arm64/Claritty Studio.app/Contents/MacOS/Claritty Studio');
const packaged = existsSync(PACKAGED);
console.log(`\nAgainst ${packaged ? 'the packaged app' : 'the dev build'}. One armed trigger, already due.`);
console.log('Nothing will be clicked.\n');

const app = await electron.launch(
  packaged
    ? { executablePath: PACKAGED, args: [], env: { ...process.env, STUDIO_HOME: HOME } }
    : { args: ['.'], cwd: join(ROOT, 'apps/desktop'), env: { ...process.env, STUDIO_HOME: HOME } },
);
const win = await app.firstWindow();
const errors = [];
win.on('pageerror', (e) => errors.push(String(e)));
await win.waitForSelector('[data-brand]');
// Deliberately left on Home: the automation is not even open. A schedule that
// only fires while you are looking at the automation is not a schedule.
check('the app opens without the automation being opened', true);

const deadline = Date.now() + 8 * 60_000;
let run;
while (Date.now() < deadline) {
  const probe = new Store(join(HOME, 'studio.db'));
  const found = probe.listRuns(projectId)[0];
  probe.close();
  if (found && found.status !== 'running') { run = found; break; }
  await win.waitForTimeout(3000);
}

check('a run happened with nobody pressing anything', Boolean(run), run ? '' : 'nothing fired in eight minutes');

const after = new Store(join(HOME, 'studio.db'));
if (run) {
  // The distinction that matters: a schedule fired it, not a person.
  check('and the schedule is what fired it', run.triggeredBy === 'schedule', run.triggeredBy);
  const steps = after.getSteps(run.id);
  check('with a full step timeline', steps.length > 0, steps.map((s) => `${s.stepId}:${s.status}`).join(' '));
  const ok = steps.filter((s) => s.status === 'success').length;
  check('every step actually ran', ok === steps.length && ok > 0, `${ok}/${steps.length} succeeded`);
  check('the run says success', run.status === 'success', run.status + (run.error ? ` — ${run.error}` : ''));
}

// It must not fire again on the next tick, and it must not be left due forever.
const instance = after.triggers.list(projectId).find((t) => t.id === trigger.id);
check('the trigger was rescheduled', Boolean(instance?.nextRunAt) && instance.nextRunAt > Date.now(),
  instance?.nextRunAt ? new Date(instance.nextRunAt).toISOString() : 'no next run');
check('and it recorded the outcome', instance?.lastStatus === 'success', instance?.lastStatus ?? 'none');

const before = after.listRuns(projectId).length;
after.close();
await win.waitForTimeout(20_000); // longer than one tick
const settle = new Store(join(HOME, 'studio.db'));
check('and did not fire twice', settle.listRuns(projectId).length === before, `${settle.listRuns(projectId).length} run(s)`);
settle.close();

const reports = existsSync(join(PROJECT, 'reports')) ? readdirSync(join(PROJECT, 'reports')) : [];
check('the work actually happened', reports.length > 0, reports.join(', ') || 'no output');
check('no renderer errors', errors.length === 0, errors[0] ?? '');

await app.close();
console.log(failures === 0 ? '\nOK — schedules run automations.\n' : `\n${failures} failed.\n`);
process.exit(failures === 0 ? 0 : 1);
