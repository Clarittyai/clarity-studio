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
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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

/**
 * A credential-free automation that writes a file, which is all this proof
 * needs of one.
 *
 * It used to be `~/Automations/downloads-report` and nothing else — a folder
 * the developer had made by hand. That is why this proof had never once run in
 * CI: the step died with "no automation at /home/runner/Automations/…" before
 * testing anything, on a runner that has no such folder and never will. A gate
 * that can only pass on one laptop is not a gate.
 *
 * So use the real folder when it is there — it is the closest thing to what a
 * user actually has — and otherwise build an equivalent from the seed, whose
 * `main.py` is entirely manifest-driven. Only two things need writing: a tool
 * that produces a file, and a manifest that calls it.
 */
function fixtureFromSeed() {
  const dir = '/tmp/sched-run-fixture';
  rmSync(dir, { recursive: true, force: true });
  cpSync(join(ROOT, 'packages/automation-seed'), dir, {
    recursive: true,
    filter: (s) =>
      !s.includes('__pycache__') && !s.includes('/.studio') && !s.includes('/.spike-data'),
  });

  writeFileSync(
    join(dir, 'backend', 'tools', 'write_report.py'),
    `"""app.write_report — the whole job, in one tool.

No model and no credential, deliberately: this exists so a proof can ask
whether a SCHEDULE ran an automation without also depending on a key being
present. The file it leaves behind is the evidence.
"""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict

from claritty_sdk import tool
from claritty_sdk.context import ToolCtx

APP_ROOT = Path(__file__).resolve().parent.parent.parent


@tool(id="app.write_report")
def run(input: Dict[str, Any], ctx: ToolCtx) -> Dict[str, Any]:
    at = datetime.now(timezone.utc)
    reports = APP_ROOT / "reports"
    reports.mkdir(parents=True, exist_ok=True)
    path = reports / f"report-{at.strftime('%Y%m%dT%H%M%S%f')}.md"
    path.write_text(f"# Report\\n\\nWritten at {at.isoformat()} by a schedule.\\n", encoding="utf-8")
    ctx.log("info", f"wrote {path.name}")
    return {"report_path": str(path)}
`,
    'utf8',
  );

  // `triggers:` MUST stay last: the proof rewrites that section with a regex
  // that runs to end-of-file.
  writeFileSync(
    join(dir, 'intelligence.yaml'),
    `schemaVersion: 2
id: downloads-report
version: 1.0.0

integrations: []

tools:
  - id: app.write_report
    handler: backend.tools.write_report:run
    output:
      report_path:
        type: string
        required: true

agents: []

workflows:
  - id: downloads-report
    steps:
      - id: write
        tool: app.write_report
    outputs:
      report_path: "\${steps.write.output.report_path}"

triggers:
  - id: placeholder
    type: SCHEDULE
    name: Placeholder
    workflow: downloads-report
    supportedSchedules: [DAILY]
    maxInstancesPerUser: 1
    configFields:
      - { key: time, type: time, required: true, label: "Run at", default: "09:00" }
      - { key: timezone, type: timezone, required: true, label: "Timezone" }
`,
    'utf8',
  );
  return dir;
}

const LOCAL =
  process.env.SCHED_PROOF_PROJECT ?? join(process.env.HOME ?? '', 'Automations/downloads-report');
const SOURCE = existsSync(join(LOCAL, 'intelligence.yaml')) ? LOCAL : fixtureFromSeed();
console.log(
  `\nAgainst ${SOURCE === LOCAL ? 'your own downloads-report' : 'a fixture built from the seed'}\n`,
);

const HOME = '/tmp/sched-run-home';
const PROJECT = '/tmp/sched-run-project';
for (const dir of [HOME, PROJECT]) rmSync(dir, { recursive: true, force: true });
mkdirSync(HOME, { recursive: true });
cpSync(SOURCE, PROJECT, {
  recursive: true,
  filter: (s) => !s.includes('__pycache__') && !s.includes('/.studio') && !s.includes('/reports'),
});

// Declare every schedule mode IN THE COPY, so the ids are real.
//
// The first attempt seeded trigger rows the manifest knew nothing about and
// nothing fired — the automation looks a trigger up by its recipe id, and
// syncTriggers deletes instances with no declaration behind them. A fixture no
// user could produce tests nothing, which is how three checks today turned out
// to be the bug rather than find one.
const manifestPath = join(PROJECT, 'intelligence.yaml');
const MODES = [
  { id: 'mode-daily', schedule: { mode: 'DAILY', time: '18:00', timezone: 'UTC' }, repeats: true },
  { id: 'mode-interval', schedule: { mode: 'INTERVAL', everyMinutes: 30 }, repeats: true },
  { id: 'mode-weekly', schedule: { mode: 'WEEKLY', time: '09:00', timezone: 'UTC', daysOfWeek: [1, 3, 5] }, repeats: true },
  { id: 'mode-monthly', schedule: { mode: 'MONTHLY', time: '09:00', timezone: 'UTC', dayOfMonth: 1 }, repeats: true },
  // Must fire once and STOP. If it rescheduled it would run every tick forever.
  { id: 'mode-one-time', schedule: { mode: 'ONE_TIME', at: new Date(Date.now() - 60_000).toISOString() }, repeats: false },
];
writeFileSync(
  manifestPath,
  readFileSync(manifestPath, 'utf8').replace(
    /^triggers:[\s\S]*$/m,
    ['triggers:', ...MODES.map((m) => [
      `  - id: ${m.id}`,
      '    type: SCHEDULE',
      `    name: ${m.schedule.mode}`,
      '    workflow: downloads-report',
      '    supportedSchedules: [DAILY, INTERVAL, WEEKLY, MONTHLY, ONE_TIME]',
      '    maxInstancesPerUser: 1',
      '    configFields:',
      '      - { key: time, type: time, required: true, label: "Run at", default: "09:00" }',
      '      - { key: timezone, type: timezone, required: true, label: "Timezone" }',
    ].join('\n'))].join('\n') + '\n',
  ),
);

const store = new Store(join(HOME, 'studio.db'));
const projectId = randomUUID();
store.upsertProject({
  id: projectId, name: 'downloads-report', slug: 'downloads-report',
  path: PROJECT, runtime: 'native', status: 'stopped',
});

// Armed, and already due. This is the state the switch in the Triggers band
// produces — enabled with a next run — brought forward so the proof does not
// wait until tomorrow morning to find out whether schedules work.
const seeded = MODES.map((m) =>
  Object.assign(
    store.triggers.add({
      projectId,
      recipeTriggerId: m.id,
      workflowId: 'downloads-report',
      type: 'SCHEDULE',
      enabled: true,
      schedule: m.schedule,
      timezone: 'UTC',
      nextRunAt: Date.now() - 1000,
      missedPolicy: 'run-once',
    }),
    { mode: m.schedule.mode, repeats: m.repeats },
  ),
);
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

const deadline = Date.now() + 10 * 60_000;
let run;
while (Date.now() < deadline) {
  const probe = new Store(join(HOME, 'studio.db'));
  const found = probe.listRuns(projectId)[0];
  probe.close();
  if (found && found.status !== 'running') { run = found; break; }
  await win.waitForTimeout(3000);
}

// All five, not just the first: a dispatcher that fired one and stopped would
// pass a one-trigger proof perfectly.
const allDeadline = Date.now() + 10 * 60_000;
let done = [];
while (Date.now() < allDeadline) {
  const probe = new Store(join(HOME, 'studio.db'));
  done = probe.listRuns(projectId).filter((r) => r.status !== 'running');
  probe.close();
  if (done.length >= MODES.length) break;
  await win.waitForTimeout(3000);
}
check('every schedule mode fired, with nobody pressing anything', done.length === MODES.length,
  `${done.length}/${MODES.length} ran`);

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

// Each mode reschedules on its own terms, and one deliberately does not.
const rows = after.triggers.list(projectId);
for (const t of seeded) {
  const row = rows.find((r) => r.id === t.id);
  const next = row?.nextRunAt;
  if (t.repeats) {
    check(`  ${t.mode} is due again`, Boolean(next) && next > Date.now(),
      next ? new Date(next).toISOString() : 'no next run — it would never fire again');
  } else {
    check(`  ${t.mode} is finished, not due again`, !next, next ? new Date(next).toISOString() : '');
  }
  check(`  ${t.mode} recorded its outcome`, row?.lastStatus === 'success', row?.lastStatus ?? 'none');
}

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
