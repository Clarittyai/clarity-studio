#!/usr/bin/env node
/**
 * M0 spike — the load-bearing proof.
 *
 * Claritty Studio rests on one claim: a Claritty automation's dependency on the
 * hosted platform is a small, stable HTTP contract, so a local server that
 * speaks that contract can run an automation unmodified, with your keys, on
 * your machine.
 *
 * This script tries to falsify that. It:
 *
 *   1. starts the local control plane on a free port;
 *   2. mints a project identity and the container environment for it;
 *   3. boots the seed automation with `claritty-sdk` straight from PyPI —
 *      no patches, no forks, no shims;
 *   4. runs a workflow whose only step is an LLM agent with two tools;
 *   5. rebuilds the run timeline purely from the checkpoints the automation
 *      sent back, and asserts every step reached `success`.
 *
 * If this fails, the architecture is wrong and the plan needs revisiting.
 * Run it with `pnpm spike`.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ControlPlane, formatUsd } from '../packages/control-plane/dist/index.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SEED = join(ROOT, 'packages/automation-seed');
const PYTHON = join(ROOT, '.venv-probe/bin/python');
const PROJECT_ID = 'spike-project';
const WORKFLOW = 'daily-digest';
const RUN_ID = `wfr_spike_${Date.now().toString(36)}`;

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
};

const step = (msg) => console.log(`${c.cyan('→')} ${msg}`);
const ok = (msg) => console.log(`${c.green('✓')} ${msg}`);
const bad = (msg) => console.log(`${c.red('✘')} ${msg}`);

async function main() {
  if (!existsSync(PYTHON)) {
    throw new Error(
      `No Python environment at ${PYTHON}.\n` +
        `  python3 -m venv .venv-probe && ./.venv-probe/bin/pip install "claritty-sdk>=2.11,<3" fastapi uvicorn`,
    );
  }

  console.log();
  console.log(c.bold('M0 spike — can an unmodified automation run against a local control plane?'));
  console.log();

  // ── 1. the control plane ──────────────────────────────────────────────────
  // Port 0 lets the OS pick, so a stale process from a previous run can't make
  // this look like a contract failure.
  const plane = new ControlPlane({
    port: 0,
    // Force the simulator. The seed's manifest asks for claude-sonnet-4-6 (the
    // SDK's default when an agent declares no model), and this spike must run
    // on a machine with no provider key at all. The simulator exercises the
    // whole loop for free — which is what we want to test here: the wiring,
    // not the prompt.
    forceModel: 'simulator',
  });
  const { url } = await plane.listen();
  ok(`control plane listening on ${url}`);

  const identity = plane.register(PROJECT_ID);
  const env = plane.environmentFor(PROJECT_ID, { platformUrl: url });
  ok(`project registered — container gets ${Object.keys(env).length} env vars, 0 provider keys`);

  // The claim that matters most for the security model, checked rather than
  // asserted in prose.
  const leaked = Object.entries(env).filter(([, v]) => /^sk-|^sk-ant-|^AIza/.test(v));
  if (leaked.length > 0) throw new Error(`provider key leaked into container env: ${leaked.map(([k]) => k)}`);

  // ── 2. boot the automation ────────────────────────────────────────────────
  step('booting the seed automation (claritty-sdk from PyPI, unmodified) …');
  const appPort = 3299;
  const proc = spawn(
    PYTHON,
    ['-m', 'uvicorn', 'backend.main:app', '--host', '127.0.0.1', '--port', String(appPort), '--log-level', 'warning'],
    {
      cwd: SEED,
      env: { ...process.env, ...env, APP_DATA_DIR: join(SEED, '.spike-data'), PYTHONPATH: SEED },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  const appLog = [];
  proc.stdout.on('data', (d) => appLog.push(String(d)));
  proc.stderr.on('data', (d) => appLog.push(String(d)));

  const cleanup = async () => {
    proc.kill('SIGTERM');
    await plane.close();
  };

  try {
    const base = `http://127.0.0.1:${appPort}`;
    const health = await waitForHealth(`${base}/health`, proc, appLog);
    ok(`automation booted — ${health.automation} v${health.version}, workflows: ${health.workflows.join(', ')}`);

    // ── 3. run the workflow ─────────────────────────────────────────────────
    step(`running workflow ${c.bold(WORKFLOW)} (run id ${RUN_ID}) …`);
    const res = await fetch(`${base}/api/workflows/${WORKFLOW}/execute`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-User-ID': 'local' },
      body: JSON.stringify({ inputs: {}, workflow_run_id: RUN_ID, user_id: 'local' }),
    });
    const result = await res.json();

    if (!res.ok) throw new Error(`execute returned HTTP ${res.status}: ${JSON.stringify(result)}`);

    // ── 4. rebuild the timeline from checkpoints alone ──────────────────────
    // Deliberately NOT from the HTTP response: the point is that the
    // automation reported its own progress to the control plane as it went,
    // which is where a run timeline comes from when nobody is watching.
    const steps = plane.store.getSteps(RUN_ID);
    const calls = plane.store.getLlmCalls(RUN_ID);
    const run = plane.store.getRun(RUN_ID);

    console.log();
    console.log(c.bold('  Run timeline — reconstructed from checkpoints the automation sent'));
    console.log(c.dim('  ' + '─'.repeat(72)));
    if (steps.length === 0) {
      console.log(c.dim('  (no checkpoints received)'));
    }
    for (const s of steps) {
      // The SDK checkpoints epoch MILLISECONDS (`int(started_at * 1000)`), so
      // the difference is already a duration in ms.
      const ms = s.endedAt && s.startedAt ? Math.round(s.endedAt - s.startedAt) : null;
      const mark = s.status === 'success' ? c.green('●') : c.red('●');
      console.log(`  ${mark} ${s.stepId.padEnd(18)} ${s.status.padEnd(9)} ${ms !== null ? c.dim(`${ms}ms`) : ''}`);
      if (s.error) console.log(`    ${c.red(s.error)}`);
    }
    console.log(c.dim('  ' + '─'.repeat(72)));

    const totalMicros = calls.reduce((a, b) => a + b.costMicros, 0);
    const promptTokens = calls.reduce((a, b) => a + b.promptTokens, 0);
    const completionTokens = calls.reduce((a, b) => a + b.completionTokens, 0);
    console.log(
      `  ${calls.length} model call(s) · ${promptTokens} in / ${completionTokens} out · ${formatUsd(totalMicros)}`,
    );
    console.log(`  run status: ${run?.status ?? '(not finalised)'}`);
    console.log(`  outputs: ${JSON.stringify(run?.outputs ?? result.outputs)}`);
    console.log();

    // ── 5. verdict ──────────────────────────────────────────────────────────
    const failures = [];
    if (result.status !== 'success') failures.push(`workflow status is ${result.status}: ${result.error ?? ''}`);
    if (steps.length === 0) failures.push('no step checkpoints reached the control plane');
    if (steps.some((s) => s.status !== 'success')) failures.push('a step did not succeed');
    if (calls.length === 0) failures.push('the agent never called a model through the control plane');
    if (!run) failures.push('the run was never finalised via /internal/workflow-runs/:id/complete');

    if (failures.length > 0) {
      for (const f of failures) bad(f);
      console.log();
      console.log(c.dim(appLog.join('').split('\n').slice(-25).join('\n')));
      await cleanup();
      process.exit(1);
    }

    ok('the automation ran unmodified against the local control plane');
    ok('every step checkpointed back; the timeline is reconstructable with nobody watching');
    ok('the model call was routed by the control plane, metered, and costed');
    console.log();
    console.log(c.green(c.bold('  M0 GATE PASSED — the architecture holds.')));
    console.log();
    await cleanup();
  } catch (err) {
    bad(err instanceof Error ? err.message : String(err));
    console.log(c.dim(appLog.join('').split('\n').slice(-30).join('\n')));
    await cleanup();
    process.exit(1);
  }
}

async function waitForHealth(url, proc, log, attempts = 60) {
  for (let i = 0; i < attempts; i++) {
    if (proc.exitCode !== null) {
      throw new Error(`the automation exited during boot (code ${proc.exitCode})\n${log.join('')}`);
    }
    try {
      const res = await fetch(url);
      if (res.ok) return await res.json();
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`the automation never answered ${url}\n${log.join('')}`);
}

main().catch((err) => {
  bad(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
