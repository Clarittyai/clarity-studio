/**
 * Proof that a schedule actually fires.
 *
 * Studio listed triggers and showed a next-run time while nothing fired them:
 * the Dispatcher was only ever constructed by the CLI's `serve`. This is the
 * gate on that never being true again, and it deliberately uses the REAL
 * pieces — a real SQLite store, a real HTTP listener standing in for the
 * automation — because the bug was never in the dispatcher's logic. It was that
 * nothing called it.
 *
 * Run: node scripts/schedule-proof.mjs
 */

import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { Store } = await import(join(ROOT, 'packages/db/dist/index.js'));
const { Dispatcher } = await import(join(ROOT, 'packages/scheduler/dist/index.js'));

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};

const home = mkdtempSync(join(tmpdir(), 'studio-schedule-'));
const store = new Store(join(home, 'proof.db'));

// The automation, as far as the scheduler is concerned.
const received = [];
const server = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    received.push({ url: req.url, secret: req.headers['x-claritty-internal'], body: JSON.parse(body || '{}') });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ executed: 1, results: [{ success: true, status: 'success' }] }));
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const baseUrl = `http://127.0.0.1:${server.address().port}`;

store.upsertProject({
  id: 'p1',
  name: 'Invoice digest',
  slug: 'invoice-digest',
  path: join(home, 'p1'),
  runtime: 'native',
  // Stopped, which is the normal state of an automation in a desktop app and
  // the exact condition that made every schedule skip.
  status: 'stopped',
});

const dueAt = Date.parse('2026-06-15T09:00:00Z');
const now = dueAt + 1000;
store.triggers.add({
  projectId: 'p1',
  recipeTriggerId: 'every-weekday-morning',
  workflowId: 'daily-digest',
  type: 'SCHEDULE',
  enabled: true,
  schedule: { mode: 'DAILY', time: '09:00', timezone: 'UTC' },
  timezone: 'UTC',
  nextRunAt: dueAt,
  missedPolicy: 'run-once',
});

console.log('\nA due trigger on a STOPPED automation:');

let started = [];
let running = false;
const dispatcher = new Dispatcher({
  store,
  now: () => now,
  ensureRunning: async (projectId) => {
    started.push(projectId);
    running = true;
  },
  resolveTarget: (projectId) =>
    running && projectId === 'p1' ? { baseUrl, internalSecret: 'the-secret' } : undefined,
});

const results = await dispatcher.tick();

check('the automation is started first', started.length === 1 && started[0] === 'p1');
check('the trigger fires', results[0]?.fired === true, results[0]?.error ?? results[0]?.skipped ?? '');
check('the automation was actually called', received.length === 1, `${received.length} request(s)`);
check('on the endpoint it expects', received[0]?.url === '/internal/run-due-triggers', received[0]?.url);
check('with the internal secret', received[0]?.secret === 'the-secret');
check(
  'carrying a run id, so the run has a timeline',
  Boolean(received[0]?.body?.instances?.[0]?.workflowRunId),
);

const run = store.listRuns('p1')[0];
check('a run row exists', Boolean(run), run?.id);
check('attributed to the schedule, not to a person', run?.triggeredBy === 'schedule', run?.triggeredBy);

const after = store.triggers.list('p1')[0];
check('and it is rescheduled', after?.nextRunAt > now, new Date(after?.nextRunAt).toISOString());

console.log('\nWhen the automation cannot be started:');
received.length = 0;
started = [];
store.triggers.setNextRun(after.id, dueAt);

const failing = await new Dispatcher({
  store,
  now: () => now,
  ensureRunning: async () => {
    throw new Error('Docker is not running');
  },
  resolveTarget: () => undefined,
}).tick();

check('it does not call anything', received.length === 0);
check('it reports a failure', failing[0]?.error?.includes('Docker is not running'), failing[0]?.error);
// "skipped" reads like a decision. This was not a decision.
check('and does not call it a skip', failing[0]?.skipped === undefined, failing[0]?.skipped);
check(
  'the trigger still moves on',
  store.triggers.list('p1')[0]?.nextRunAt > now,
  'otherwise one bad morning leaves it due forever',
);

server.close();
store.close();
rmSync(home, { recursive: true, force: true });

console.log(failures === 0 ? '\nOK — schedules fire.\n' : `\n${failures} failed.\n`);
process.exit(failures === 0 ? 0 : 1);
