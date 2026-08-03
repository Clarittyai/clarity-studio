#!/usr/bin/env node
/**
 * `claritty-studio` — Claritty Studio without the window.
 *
 * Same core as the desktop app: the local control plane, the runner, the
 * store. It exists so the product is usable over SSH and in CI, and so that
 * every capability the UI has is reachable without one — a desktop app whose
 * behaviour you cannot script is a dead end.
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

// Must be first — see the file for why the placement matters.
import './quiet.js';

import { ControlPlane, EnvSecretSource, formatUsd } from '@claritty-studio/control-plane';
import { Store } from '@claritty-studio/db';
import {
  allocatePort,
  DockerRunner,
  fireWorkflow,
  NativeRunner,
  run as spawnRun,
  type Runner,
} from '@claritty-studio/orchestrator';

// ── output ───────────────────────────────────────────────────────────────────

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: string) => (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const c = {
  dim: paint('2'),
  bold: paint('1'),
  green: paint('32'),
  red: paint('31'),
  yellow: paint('33'),
  cyan: paint('36'),
};

const info = (m = '') => console.log(m);
const step = (m: string) => console.log(`${c.cyan('→')} ${m}`);
const ok = (m: string) => console.log(`${c.green('✓')} ${m}`);
const warn = (m: string) => console.log(`${c.yellow('!')} ${m}`);
const fail = (m: string): never => {
  console.error(`${c.red('✘')} ${m}`);
  process.exit(1);
};

// ── paths ────────────────────────────────────────────────────────────────────

function dataDir(): string {
  const explicit = process.env.STUDIO_HOME;
  if (explicit) return explicit;
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'ClarittyStudio');
  }
  if (process.platform === 'win32') {
    return join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'ClarittyStudio');
  }
  return join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'claritty-studio');
}

function openStore(): Store {
  const dir = dataDir();
  mkdirSync(dir, { recursive: true });
  return new Store(join(dir, 'studio.db'));
}

function seedDir(): string {
  // Resolved relative to this file so it works from a checkout and from a
  // global install alike.
  const fromSource = resolve(new URL('../../../packages/automation-seed', import.meta.url).pathname);
  if (existsSync(join(fromSource, 'intelligence.yaml'))) return fromSource;
  const bundled = resolve(new URL('../seed', import.meta.url).pathname);
  if (existsSync(join(bundled, 'intelligence.yaml'))) return bundled;
  return fail('could not find the automation seed — is the install complete?');
}

function manifestIn(dir: string): string | undefined {
  for (const name of ['intelligence.yaml', 'app.yaml']) {
    if (existsSync(join(dir, name))) return join(dir, name);
  }
  return undefined;
}

function slugOf(dir: string): string {
  return basename(dir).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '') || 'automation';
}

// ── commands ─────────────────────────────────────────────────────────────────

async function cmdDoctor(): Promise<void> {
  info();
  info(c.bold('Claritty Studio — environment check'));
  info();

  const checks: Array<[string, boolean, string]> = [];

  const nodeMajor = Number(process.versions.node.split('.')[0]);
  checks.push([
    `Node ${process.versions.node}`,
    nodeMajor >= 22,
    nodeMajor >= 22 ? '' : 'Studio needs Node 22 or newer (it uses the built-in SQLite).',
  ]);

  const py = await spawnRun(process.env.STUDIO_PYTHON || (process.platform === 'win32' ? 'python' : 'python3'), ['--version']);
  checks.push([
    `Python ${py.output.trim() || '(not found)'}`,
    py.code === 0,
    py.code === 0 ? '' : 'Needed only for the native runtime. Docker does not require it.',
  ]);

  const docker = await spawnRun('docker', ['version', '--format', '{{.Server.Version}}']);
  const dockerOk = docker.code === 0 && !/error|cannot connect/i.test(docker.output);
  checks.push([
    dockerOk ? `Docker ${docker.output.trim()}` : 'Docker (not available)',
    dockerOk,
    dockerOk ? '' : 'Install Docker Desktop for the real runtime, or use --native for now.',
  ]);

  const secrets = new EnvSecretSource();
  const configured: string[] = [];
  for (const id of ['anthropic', 'openai', 'google', 'openrouter']) {
    if (await secrets.providerKey(id)) configured.push(id);
  }
  checks.push([
    configured.length ? `Model provider keys: ${configured.join(', ')}` : 'No model provider keys',
    configured.length > 0,
    configured.length
      ? ''
      : 'Set ANTHROPIC_API_KEY or OPENAI_API_KEY to run for real. Without one, use --simulate.',
  ]);

  for (const [label, good, hint] of checks) {
    info(`  ${good ? c.green('✓') : c.yellow('!')} ${label}`);
    if (hint) info(`    ${c.dim(hint)}`);
  }

  info();
  const blocking = checks[0]![1] === false;
  if (blocking) fail('Node is too old — nothing will work until that is fixed.');
  ok('ready');
  info();
}

async function cmdNew(name: string | undefined): Promise<void> {
  if (!name) fail('usage: claritty-studio new <name>');
  const target = resolve(process.cwd(), name!);
  if (existsSync(target)) fail(`${target} already exists.`);

  step(`creating ${c.bold(name!)} from the automation seed…`);
  const seed = seedDir();
  const { cpSync } = await import('node:fs');
  cpSync(seed, target, {
    recursive: true,
    filter: (src) => !src.includes(`${'/'}.studio`) && !src.includes('__pycache__'),
  });

  const gitInit = await spawnRun('git', ['init', '-q'], { cwd: target });
  if (gitInit.code === 0) {
    await spawnRun('git', ['add', '-A'], { cwd: target });
    await spawnRun(
      'git',
      ['-c', 'user.name=Claritty Studio', '-c', 'user.email=studio@localhost', 'commit', '-qm', 'New automation from the Claritty seed'],
      { cwd: target },
    );
  }

  info();
  ok(`created ${c.bold(name!)}`);
  info();
  info(c.bold('Next:'));
  info(`  cd ${name}`);
  info(`  claude                                ${c.dim('# or codex — CLAUDE.md and AGENTS.md are already there')}`);
  info(`  claritty-studio run daily-digest --simulate   ${c.dim('# check the wiring, no key needed')}`);
  info();
}

interface RunFlags {
  native: boolean;
  simulate: boolean;
  keep: boolean;
  dir: string;
}

async function withRuntime<T>(
  flags: RunFlags,
  body: (ctx: { plane: ControlPlane; runner: Runner; store: Store; projectId: string; baseUrl: string }) => Promise<T>,
): Promise<T> {
  const dir = resolve(flags.dir);
  const manifest = manifestIn(dir);
  if (!manifest) {
    fail(
      `no intelligence.yaml in ${dir}.\n` +
        `  Create one with: claritty-studio new my-automation\n` +
        `  Or point an agent at an existing repo and run /claritty-convert.`,
    );
  }

  const store = openStore();
  const slug = slugOf(dir);
  const existing = store.getProjectBySlug(slug);
  const projectId = existing?.id ?? randomUUID();

  const plane = new ControlPlane({
    port: 0,
    secrets: new EnvSecretSource(),
    store: {
      checkpointStep: (cp) => store.checkpointStep(cp),
      completeRun: (rc) => store.completeRun(rc),
      recordLlmCall: (r) => store.recordLlmCall(r),
      getRun: (id) => store.getRun(id),
      getSteps: (id) => store.getSteps(id) as never,
      getLlmCalls: (id) => store.getLlmCalls(id) as never,
    },
    ...(flags.simulate ? { forceModel: 'simulator' } : {}),
  });
  const { url: planeUrl } = await plane.listen();

  // The project row has to exist before a port can reference it — `ports` is
  // foreign-keyed to `projects`, which is what stops an orphaned reservation
  // from holding a port hostage after the project is gone.
  store.upsertProject({
    id: projectId,
    name: basename(dir),
    slug,
    path: dir,
    manifestPath: manifest!,
    hostPort: existing?.hostPort ?? null,
    runtime: flags.native ? 'native' : 'docker',
    status: 'starting',
  });

  const hostPort = await allocatePort(projectId, {
    get: () => store.portFor(projectId),
    set: (id, port) => store.claimPort(id, port),
    release: (id) => store.releasePort(id),
    taken: () => store.takenPorts(),
  });

  // Containers reach the host by a different name than the host reaches itself.
  const platformUrl = flags.native
    ? planeUrl
    : planeUrl.replace('127.0.0.1', 'host.docker.internal');
  const environment = plane.environmentFor(projectId, { platformUrl });

  const runner: Runner = flags.native
    ? new NativeRunner({ projectId, projectPath: dir, hostPort, environment })
    : new DockerRunner({ projectId, projectPath: dir, hostPort, environment });

  step(`starting the automation (${runner.kind})…`);
  if (runner instanceof NativeRunner) await runner.prepare((m) => step(m));

  try {
    await runner.start();
    const health = await runner.waitUntilHealthy();
    store.setProjectStatus(projectId, 'running');
    ok(`${health.automation} v${health.version} on ${c.bold(runner.baseUrl)}`);
    return await body({ plane, runner, store, projectId, baseUrl: runner.baseUrl });
  } catch (err) {
    store.setProjectStatus(projectId, 'crashed', err instanceof Error ? err.message : String(err));
    throw err;
  } finally {
    if (!flags.keep) {
      await runner.stop();
      // Only overwrite a healthy status. A crash recorded above must survive
      // teardown, or `ps` would quietly report "stopped" for something that
      // actually fell over.
      if (store.getProject(projectId)?.status === 'running') {
        store.setProjectStatus(projectId, 'stopped');
      }
    }
    await plane.close();
    store.close();
  }
}

async function cmdRun(workflowId: string | undefined, flags: RunFlags): Promise<void> {
  await withRuntime(flags, async ({ baseUrl, store, projectId }) => {
    const wf = workflowId ?? (await firstWorkflow(baseUrl));
    if (!wf) fail('no workflow found — does intelligence.yaml declare one?');

    const runId = `wfr_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
    store.openRun({ id: runId, projectId, workflowId: wf!, triggeredBy: 'manual' });

    step(`running ${c.bold(wf!)}…`);
    const started = Date.now();
    const result = await fireWorkflow(baseUrl, wf!, { runId });

    printTimeline(store, runId, Date.now() - started, result.status, result.error);
    if (!result.success) process.exitCode = 1;
  });
}

async function cmdUp(flags: RunFlags): Promise<void> {
  await withRuntime({ ...flags, keep: true }, async ({ baseUrl, runner, plane }) => {
    info();
    info(`  ${c.bold('automation')}     ${baseUrl}`);
    info(`  ${c.bold('control plane')}  ${plane.url}`);
    info();
    info(c.dim('  Press Ctrl-C to stop.'));
    info();
    await new Promise<void>((resolve) => {
      const done = () => resolve();
      process.on('SIGINT', done);
      process.on('SIGTERM', done);
    });
    step('stopping…');
    await runner.stop();
  });
}

function cmdPs(): void {
  const store = openStore();
  const projects = store.listProjects();
  if (projects.length === 0) {
    info(c.dim('No automations yet. Create one with: claritty-studio new my-automation'));
    store.close();
    return;
  }
  info();
  for (const p of projects) {
    const runs = store.listRuns(p.id, 1);
    const last = runs[0];
    const spend = store.spendSince(p.id, Date.now() - 7 * 86_400_000);
    const dot = p.status === 'running' ? c.green('●') : p.status === 'crashed' ? c.red('●') : c.dim('●');
    info(`  ${dot} ${c.bold(p.name.padEnd(22))} ${p.status.padEnd(9)} ${c.dim(p.path)}`);
    info(
      `    ${c.dim(
        `last run: ${last ? `${last.status} ${timeAgo(last.startedAt)}` : 'never'} · ` +
          `7-day spend: ${formatUsd(spend.costMicros)} over ${spend.calls} call(s)`,
      )}`,
    );
  }
  info();
  store.close();
}

function cmdRuns(dir: string): void {
  const store = openStore();
  const project = store.getProjectBySlug(slugOf(resolve(dir)));
  if (!project) fail('no runs for this directory yet.');
  const runs = store.listRuns(project!.id, 20);
  info();
  for (const r of runs) {
    const mark = r.status === 'success' ? c.green('●') : r.status === 'running' ? c.yellow('●') : c.red('●');
    const dur = r.endedAt ? `${((r.endedAt - r.startedAt) / 1000).toFixed(1)}s` : '—';
    info(
      `  ${mark} ${r.id.slice(0, 16).padEnd(18)} ${String(r.workflowId ?? '').padEnd(18)} ` +
        `${r.status.padEnd(9)} ${dur.padStart(7)} ${formatUsd(r.costMicros).padStart(9)} ${c.dim(timeAgo(r.startedAt))}`,
    );
  }
  info();
  store.close();
}

// ── helpers ──────────────────────────────────────────────────────────────────

async function firstWorkflow(baseUrl: string): Promise<string | undefined> {
  const res = await fetch(`${baseUrl}/api/workflows`);
  const body = (await res.json()) as { workflows: Array<{ id: string }> };
  return body.workflows[0]?.id;
}

function printTimeline(
  store: Store,
  runId: string,
  wallMs: number,
  status: string,
  error?: string | null,
): void {
  const steps = store.getSteps(runId);
  const calls = store.getLlmCalls(runId);

  info();
  info(c.bold('  Run timeline'));
  info(c.dim('  ' + '─'.repeat(70)));
  for (const s of steps) {
    // The SDK checkpoints epoch milliseconds, so this is already a duration.
    const ms = s.endedAt && s.startedAt ? Math.round(s.endedAt - s.startedAt) : null;
    const mark = s.status === 'success' ? c.green('●') : s.status === 'skipped' ? c.yellow('●') : c.red('●');
    info(`  ${mark} ${s.stepId.padEnd(20)} ${s.status.padEnd(9)} ${ms !== null ? c.dim(`${ms}ms`) : ''}`);
    if (s.error) info(`    ${c.red(String(s.error))}`);
  }
  if (steps.length === 0) info(c.dim('  (the automation reported no steps)'));
  info(c.dim('  ' + '─'.repeat(70)));

  const cost = calls.reduce((a, b) => a + b.costMicros, 0);
  const pt = calls.reduce((a, b) => a + b.promptTokens, 0);
  const ct = calls.reduce((a, b) => a + b.completionTokens, 0);
  info(
    `  ${calls.length} model call(s) · ${pt} in / ${ct} out · ${formatUsd(cost)} · ${(wallMs / 1000).toFixed(1)}s wall`,
  );

  const run = store.getRun(runId);
  if (status === 'success') {
    ok(`workflow succeeded — ${JSON.stringify(run?.outputs ?? {})}`);
  } else {
    console.error(`${c.red('✘')} workflow ${status}${error ? `: ${error}` : ''}`);
  }
  info();
}

function timeAgo(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

function help(): void {
  info(`
${c.bold('claritty-studio')} — build, run and observe agentic automations locally

${c.bold('Usage')}
  claritty-studio new <name>              create an automation from the seed
  claritty-studio run [workflow]          run a workflow and print its timeline
  claritty-studio up                      start the automation and leave it running
  claritty-studio ps                      list your automations
  claritty-studio runs                    recent runs for this directory
  claritty-studio doctor                  check this machine

${c.bold('Options')}
  --dir <path>     the automation directory (default: current directory)
  --native         run with a local Python venv instead of Docker
  --simulate       exercise the wiring with no model, no key and no spend
  --keep           leave the automation running after the command finishes

${c.bold('Keys')}
  Set ANTHROPIC_API_KEY, OPENAI_API_KEY, GOOGLE_API_KEY or OPENROUTER_API_KEY.
  They are read once, held by the local control plane, and never given to the
  automation's container.

${c.dim('No account, no login, no telemetry. Everything stays on this machine.')}
`);
}

// ── entry ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const flagIndex = argv.findIndex((a) => a.startsWith('-'));
  const positional = flagIndex === -1 ? argv : argv.slice(0, flagIndex);
  const rest = flagIndex === -1 ? [] : argv.slice(flagIndex);

  const has = (name: string) => rest.includes(name);
  const valueOf = (name: string) => {
    const i = rest.indexOf(name);
    return i === -1 ? undefined : rest[i + 1];
  };

  const flags: RunFlags = {
    native: has('--native'),
    simulate: has('--simulate'),
    keep: has('--keep'),
    dir: valueOf('--dir') ?? process.cwd(),
  };

  const command = positional[0];
  if (!command || has('-h') || has('--help') || command === 'help') return help();

  switch (command) {
    case 'new':
      return cmdNew(positional[1]);
    case 'run':
      return cmdRun(positional[1], flags);
    case 'up':
      return cmdUp(flags);
    case 'ps':
      return cmdPs();
    case 'runs':
      return cmdRuns(flags.dir);
    case 'doctor':
      return cmdDoctor();
    default:
      fail(`unknown command "${command}". Try: claritty-studio help`);
  }
}

main().catch((err) => {
  fail(err instanceof Error ? err.message : String(err));
});
