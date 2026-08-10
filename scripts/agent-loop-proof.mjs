#!/usr/bin/env node
/**
 * The agent loop — the one thing every other proof assumes and none of them
 * test.
 *
 * `pnpm spike` runs this exact automation, but forces the simulator, so it
 * proves the wiring and nothing about agents. `pnpm proof:byom` says so in its
 * own header: "asserts the call arrives. No network, no key, no cost." Every
 * proof in this repo runs tool-only Python. So the loop at the centre of the
 * product — a model picks a tool, reads the result, calls `claritty_finish` —
 * had never completed once, while the README argued that judgement is the
 * reason to use Studio rather than cron.
 *
 * This runs `daily-digest` from the seed against a real provider with a real
 * key, and asserts the things only a completed loop can produce:
 *
 *   - out-tokens above zero, which the simulator can never emit;
 *   - a `digest_id` in the run output matching the format `save_digest` mints;
 *   - that same id on disk in `digests.jsonl`.
 *
 * The last one is the proof. The model cannot write that line — only the tool
 * can, and the id only reaches the run output by being passed to
 * `claritty_finish`. An invented id fails the disk check; a prose-only reply
 * produces no id at all.
 *
 * It also asserts something the key-free spike structurally cannot: that the
 * automation's own process never sees the provider key, with a real one
 * present in the parent.
 *
 * Run: pnpm proof:agent-loop   (needs ANTHROPIC_API_KEY or OPENAI_API_KEY)
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ControlPlane, formatUsd, isPriced } from '../packages/control-plane/dist/index.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SEED = join(ROOT, 'packages/automation-seed');
const PYTHON = join(ROOT, '.venv-probe/bin/python');
const PROJECT_ID = 'agent-loop-proof';
const WORKFLOW = 'daily-digest';
const RUN_ID = `wfr_agentloop_${Date.now().toString(36)}`;

/** Every provider key we know how to strip from the automation's environment. */
const PROVIDER_KEY_VARS = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'GOOGLE_API_KEY',
  'GEMINI_API_KEY',
  'OPENROUTER_API_KEY',
];

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
};

const step = (msg) => console.log(`${c.cyan('→')} ${msg}`);
const ok = (msg) => console.log(`${c.green('✓')} ${msg}`);
const bad = (msg) => console.log(`${c.red('✘')} ${msg}`);

/** Which provider owns a key, and the model to force when using it. Haiku is
 *  the default because CI runs this on every push to main and the loop is what
 *  is under test, not the model's depth. Override with AGENT_LOOP_PROOF_MODEL. */
const PROVIDERS = [
  { env: 'ANTHROPIC_API_KEY', id: 'anthropic', model: 'claude-haiku-4-5' },
  { env: 'OPENAI_API_KEY', id: 'openai', model: 'gpt-4o-mini' },
];

function chooseProvider() {
  for (const p of PROVIDERS) {
    const key = process.env[p.env];
    if (key) return { ...p, key, model: process.env.AGENT_LOOP_PROOF_MODEL ?? p.model };
  }
  return undefined;
}

async function main() {
  const chosen = chooseProvider();

  // Skip cleanly for contributors and fork PRs — but never silently. A proof
  // that skips by default becomes a proof that never runs, which is the exact
  // failure this script exists to end.
  if (!chosen) {
    const names = PROVIDERS.map((p) => p.env).join(' or ');
    if (process.env.REQUIRE_AGENT_LOOP_PROOF === '1') {
      console.log();
      bad(`REQUIRE_AGENT_LOOP_PROOF=1 but no provider key is set — need ${names}.`);
      console.log(
        c.dim('  This is the guard on the guard: on main, a skipped agent-loop proof is a failure.'),
      );
      console.log();
      process.exit(1);
    }
    console.log();
    console.log(c.yellow(c.bold('  SKIPPED — the agent loop was not exercised.')));
    console.log();
    console.log(`  This proof needs a real model key (${names}); it spends a fraction of a cent.`);
    console.log(`  Everything else in ${c.bold('pnpm spike')} runs without one and still passes.`);
    console.log();
    process.exit(0);
  }

  if (!existsSync(PYTHON)) {
    throw new Error(
      `No Python environment at ${PYTHON}.\n` +
        `  python3 -m venv .venv-probe && ./.venv-probe/bin/pip install "claritty-sdk>=2.11,<3" fastapi uvicorn`,
    );
  }

  console.log();
  console.log(c.bold('Agent loop — does a model pick a tool, read the result, and finish?'));
  console.log();
  console.log(`  provider: ${chosen.id}   model: ${c.bold(chosen.model)}`);
  if (!isPriced(chosen.model)) {
    console.log(
      c.yellow(`  note: ${chosen.model} has no row in PRICES — this run will report $0.00.`),
    );
  }
  console.log();

  // A directory of its own, so a digest left behind by an earlier run can
  // never satisfy the disk check.
  const dataDir = mkdtempSync(join(tmpdir(), 'agent-loop-proof-'));

  const plane = new ControlPlane({
    port: 0,
    // The seed's agent declares no model, so the SDK defaults it to
    // claude-sonnet-4-6. Forcing one keeps CI cheap and exercises the model
    // override that ROADMAP M0 note 3 says Studio needs — someone holding only
    // an OpenAI key must still be able to run a manifest written against Claude.
    forceModel: chosen.model,
    secrets: {
      async providerKey(id) {
        return id === chosen.id ? chosen.key : undefined;
      },
      async providerBaseUrl() {
        return undefined;
      },
      async integrationCredentials() {
        return undefined;
      },
      async allSecretValues() {
        return [];
      },
    },
  });

  const { url } = await plane.listen();
  ok(`control plane listening on ${url}`);

  const identity = plane.register(PROJECT_ID);
  const env = plane.environmentFor(PROJECT_ID, { platformUrl: url });

  // The parent process is holding a real provider key, so this is the first
  // time the brokering claim can actually be tested rather than asserted.
  const childEnv = { ...process.env, ...env, APP_DATA_DIR: dataDir, PYTHONPATH: SEED };
  for (const name of PROVIDER_KEY_VARS) delete childEnv[name];

  const keyValues = PROVIDER_KEY_VARS.map((n) => process.env[n]).filter(Boolean);
  const leaked = Object.entries(childEnv).filter(([, v]) => keyValues.includes(v));
  ok(`project registered — ${Object.keys(env).length} env vars, 0 provider keys`);

  step('booting the seed automation (claritty-sdk from PyPI, unmodified) …');
  const appPort = 3311;
  const proc = spawn(
    PYTHON,
    [
      '-m',
      'uvicorn',
      'backend.main:app',
      '--host',
      '127.0.0.1',
      '--port',
      String(appPort),
      '--log-level',
      'warning',
    ],
    { cwd: SEED, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] },
  );

  const appLog = [];
  proc.stdout.on('data', (d) => appLog.push(String(d)));
  proc.stderr.on('data', (d) => appLog.push(String(d)));

  const cleanup = async () => {
    proc.kill('SIGTERM');
    await plane.close();
    rmSync(dataDir, { recursive: true, force: true });
  };

  try {
    const base = `http://127.0.0.1:${appPort}`;
    const health = await waitForHealth(`${base}/health`, proc, appLog);
    ok(`automation booted — ${health.automation} v${health.version}`);

    step(`running ${c.bold(WORKFLOW)} against a real model (run id ${RUN_ID}) …`);
    const res = await fetch(`${base}/api/workflows/${WORKFLOW}/execute`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-User-ID': 'local' },
      body: JSON.stringify({ inputs: {}, workflow_run_id: RUN_ID, user_id: 'local' }),
    });
    const result = await res.json();
    if (!res.ok) throw new Error(`execute returned HTTP ${res.status}: ${JSON.stringify(result)}`);

    const steps = plane.store.getSteps(RUN_ID);
    const calls = plane.store.getLlmCalls(RUN_ID);
    const run = plane.store.getRun(RUN_ID);

    const promptTokens = calls.reduce((a, b) => a + b.promptTokens, 0);
    const completionTokens = calls.reduce((a, b) => a + b.completionTokens, 0);
    const totalMicros = calls.reduce((a, b) => a + b.costMicros, 0);

    console.log();
    console.log(c.bold('  Run timeline — reconstructed from checkpoints the automation sent'));
    console.log(c.dim('  ' + '─'.repeat(72)));
    for (const s of steps) {
      const ms = s.endedAt && s.startedAt ? Math.round(s.endedAt - s.startedAt) : null;
      const mark = s.status === 'success' ? c.green('●') : c.red('●');
      console.log(
        `  ${mark} ${s.stepId.padEnd(18)} ${s.status.padEnd(9)} ${ms !== null ? c.dim(`${ms}ms`) : ''}`,
      );
      if (s.error) console.log(`    ${c.red(s.error)}`);
    }
    console.log(c.dim('  ' + '─'.repeat(72)));
    console.log(
      `  ${calls.length} model call(s) · ${promptTokens} in / ${completionTokens} out · ${formatUsd(totalMicros)}`,
    );
    console.log();

    const outputs = run?.outputs ?? result.outputs ?? {};
    const digestId = typeof outputs.digest_id === 'string' ? outputs.digest_id : '';
    const summary = typeof outputs.summary === 'string' ? outputs.summary : '';

    // `save_digest` mints `dg_` + 12 hex and appends the record to
    // digests.jsonl. If the run's id is on disk, the model called
    // collect_items, called save_digest, got a real id back, and passed it to
    // claritty_finish. That is the whole loop.
    const digestFile = join(dataDir, 'digests.jsonl');
    const persisted = existsSync(digestFile)
      ? readFileSync(digestFile, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      : [];
    const onDisk = persisted.find((r) => r.digest_id === digestId);

    const failures = [];
    if (leaked.length > 0) {
      failures.push(`a provider key reached the automation's env: ${leaked.map(([k]) => k)}`);
    }
    if (result.status !== 'success') {
      failures.push(`workflow status is ${result.status}: ${result.error ?? ''}`);
    }
    if (steps.length === 0) failures.push('no step checkpoints reached the control plane');
    if (steps.some((s) => s.status !== 'success')) failures.push('a step did not succeed');
    if (!run) failures.push('the run was never finalised');
    if (calls.length === 0) failures.push('the agent never called a model through the control plane');
    // The simulator emits zero completion tokens. This is the line that
    // separates this proof from `pnpm spike`.
    if (completionTokens === 0) {
      failures.push('0 completion tokens — no real model generated anything');
    }
    if (totalMicros === 0) {
      failures.push(
        isPriced(chosen.model)
          ? 'the run was not costed'
          : `the run was not costed because ${chosen.model} has no row in PRICES (packages/control-plane/src/pricing.ts)`,
      );
    }
    if (!/^dg_[0-9a-f]{12}$/.test(digestId)) {
      failures.push(`no tool-minted digest_id in the run output (got ${JSON.stringify(digestId)})`);
    } else if (!onDisk) {
      failures.push(
        `digest_id ${digestId} is not in digests.jsonl — the model invented it rather than calling app.save_digest`,
      );
    }
    if (!summary.trim()) failures.push('the agent finished with an empty summary');

    if (failures.length > 0) {
      for (const f of failures) bad(f);
      console.log();
      console.log(c.dim(appLog.join('').split('\n').slice(-25).join('\n')));
      await cleanup();
      process.exit(1);
    }

    ok('a real model call was routed by the control plane, metered and costed');
    ok('the provider key never entered the automation, with one present in the parent');
    ok(`the model called app.save_digest — ${digestId} is on disk, not invented`);
    ok('and passed that id to claritty_finish, which is the loop closing');

    console.log();
    console.log(c.bold('  What it decided to write'));
    console.log(c.dim('  ' + '─'.repeat(72)));
    for (const line of summary.split('\n')) console.log(`  ${line}`);
    console.log(c.dim('  ' + '─'.repeat(72)));
    console.log();
    console.log(c.green(c.bold('  AGENT LOOP PROVEN — tool call, result, finish.')));
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
