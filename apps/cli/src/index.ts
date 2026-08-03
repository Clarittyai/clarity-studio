#!/usr/bin/env node
/**
 * `clarity-studio` — Clarity Studio without the window.
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

import { ControlPlane, EnvSecretSource, formatUsd } from '@clarity-studio/control-plane';
import { Store } from '@clarity-studio/db';
import {
  allocatePort,
  isFree,
  DockerRunner,
  fireWorkflow,
  NativeRunner,
  run as spawnRun,
  type Runner,
} from '@clarity-studio/orchestrator';
import { Dispatcher, WebhookIngress, type DispatchTarget } from '@clarity-studio/scheduler';

import { CATALOG, findIntegration } from '@clarity-studio/connectors';
import { VaultUnavailableError } from '@clarity-studio/vault';

import { addTrigger, formatTrigger, parseScheduleFlags, readRecipes } from './triggers.js';
import { openVault, VaultSecretSource } from './secrets.js';

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
    return join(homedir(), 'Library', 'Application Support', 'ClarityStudio');
  }
  if (process.platform === 'win32') {
    return join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'ClarityStudio');
  }
  return join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'clarity-studio');
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

/** Where webhooks arrive. Fixed so the URLs you hand out keep working. */
export const CONTROL_PLANE_PORT = 4319;

function slugOf(dir: string): string {
  return basename(dir).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '') || 'automation';
}

// ── commands ─────────────────────────────────────────────────────────────────

async function cmdDoctor(): Promise<void> {
  info();
  info(c.bold('Clarity Studio — environment check'));
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
  if (!name) fail('usage: clarity-studio new <name>');
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
      ['-c', 'user.name=Clarity Studio', '-c', 'user.email=studio@localhost', 'commit', '-qm', 'New automation from the Clarity seed'],
      { cwd: target },
    );
  }

  info();
  ok(`created ${c.bold(name!)}`);
  info();
  info(c.bold('Next:'));
  info(`  cd ${name}`);
  info(`  claude                                ${c.dim('# or codex — CLAUDE.md and AGENTS.md are already there')}`);
  info(`  clarity-studio run daily-digest --simulate   ${c.dim('# check the wiring, no key needed')}`);
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
  body: (ctx: {
    plane: ControlPlane;
    runner: Runner;
    store: Store;
    projectId: string;
    baseUrl: string;
    internalSecret: string;
  }) => Promise<T>,
  hooks: { onPlaneReady?: (ctx: { plane: ControlPlane; store: Store; projectId: string }) => void } = {},
): Promise<T> {
  const dir = resolve(flags.dir);
  const manifest = manifestIn(dir);
  if (!manifest) {
    fail(
      `no intelligence.yaml in ${dir}.\n` +
        `  Create one with: clarity-studio new my-automation\n` +
        `  Or point an agent at an existing repo and run /clarity-convert.`,
    );
  }

  const store = openStore();
  const slug = slugOf(dir);
  const existing = store.getProjectBySlug(slug);
  const projectId = existing?.id ?? randomUUID();

  // The control plane wants a STABLE port, unlike the automation: a webhook URL
  // you hand to GitHub must survive a restart, and an ephemeral port would mean
  // reconfiguring the sender every time. Fall back only if something else has
  // 4319, in which case webhook URLs move and we say so.
  const planePort = (await isFree(CONTROL_PLANE_PORT)) ? CONTROL_PLANE_PORT : 0;

  const plane = new ControlPlane({
    port: planePort,
    secrets: new VaultSecretSource(openVault(store)),
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
  const identity = plane.register(projectId);
  const environment = plane.environmentFor(projectId, { platformUrl });

  // Before the automation boots, so a webhook arriving during startup is
  // recorded and answered honestly rather than 404'd away.
  hooks.onPlaneReady?.({ plane, store, projectId });

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
    return await body({
      plane, runner, store, projectId,
      baseUrl: runner.baseUrl,
      internalSecret: identity.internalSecret,
    });
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
    info(c.dim('No automations yet. Create one with: clarity-studio new my-automation'));
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
      `  ${mark} ${r.id.slice(0, 28).padEnd(30)} ${String(r.workflowId ?? '').padEnd(16)} ` +
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


// ── triggers ─────────────────────────────────────────────────────────────────

interface TriggerFlags extends RunFlags {
  every?: string;
  daily?: string;
  weekly?: string;
  monthly?: string;
  once?: string;
  timezone?: string;
  missed?: 'skip' | 'run-once' | 'catch-up';
  trigger?: string;
}

function projectFor(store: Store, dir: string) {
  const project = store.getProjectBySlug(slugOf(resolve(dir)));
  if (!project) {
    fail(
      `Studio does not know this automation yet.\n` +
        `  Run it once first: clarity-studio run --simulate`,
    );
  }
  return project!;
}

function cmdTriggerAdd(positional: string[], flags: TriggerFlags): void {
  const store = openStore();
  try {
    const dir = resolve(flags.dir);
    const project = projectFor(store, dir);
    const recipeId = flags.trigger ?? positional[0];
    const recipes = readRecipes(dir);
    const recipe = recipeId ? recipes.find((r) => r.id === recipeId) : recipes[0];

    const instance = addTrigger(store, {
      projectId: project.id,
      projectPath: dir,
      recipeId: recipe?.id,
      // A webhook trigger needs no schedule, so only parse the flags when the
      // recipe actually wants one — otherwise every webhook would demand a time.
      schedule: recipe?.type === 'WEBHOOK' ? undefined : parseScheduleFlags(flags),
      missedPolicy: flags.missed ?? 'skip',
    });

    info();
    ok(`trigger added — ${formatTrigger(instance, c)}`);
    if (instance.type === 'WEBHOOK') {
      info(`  ${c.dim('URL, once `serve` is running:')} http://127.0.0.1:${CONTROL_PLANE_PORT}/webhooks/${instance.id}`);
    }
    info();
    info(c.dim('  Schedules only fire while Studio is running: clarity-studio serve'));
    info();
  } finally {
    store.close();
  }
}

function cmdTriggerList(flags: RunFlags): void {
  const store = openStore();
  try {
    const project = projectFor(store, flags.dir);
    const instances = store.triggers.list(project.id);
    info();
    if (instances.length === 0) {
      const recipes = readRecipes(resolve(flags.dir));
      info(c.dim('  No triggers configured.'));
      if (recipes.length) {
        info(c.dim(`  This automation supports: ${recipes.map((r) => r.id).join(', ')}`));
        info(c.dim('  Add one: clarity-studio trigger add --daily 09:00'));
      }
    }
    for (const instance of instances) info(`  ${formatTrigger(instance, c)}`);
    info();
  } finally {
    store.close();
  }
}

function cmdTriggerRemove(positional: string[], flags: RunFlags): void {
  const id = positional[0];
  if (!id) fail('usage: clarity-studio trigger rm <id>');
  const store = openStore();
  try {
    const project = projectFor(store, flags.dir);
    const match = store.triggers.list(project.id).find((t) => t.id.startsWith(id!));
    if (!match) fail(`no trigger starting with "${id}".`);
    store.triggers.remove(match!.id);
    ok(`removed ${match!.recipeTriggerId}`);
  } finally {
    store.close();
  }
}

function cmdDeliveries(flags: RunFlags): void {
  const store = openStore();
  try {
    const deliveries = store.triggers.recentDeliveries(25);
    info();
    if (deliveries.length === 0) info(c.dim('  No deliveries yet.'));
    for (const d of deliveries) {
      const mark = d.success ? c.green('●') : d.success === false ? c.red('●') : c.yellow('●');
      info(
        `  ${mark} ${d.id.slice(0, 8)}  ${timeAgo(d.startedAt).padEnd(10)}` +
          ` ${String(d.httpStatus ?? '—').padEnd(5)} ${c.dim(d.error ?? d.runId ?? '')}`,
      );
    }
    info();
    info(c.dim('  Replay any of them: clarity-studio replay <id>'));
    info();
  } finally {
    store.close();
  }
}

async function cmdReplay(positional: string[], flags: RunFlags): Promise<void> {
  const id = positional[0];
  if (!id) fail('usage: clarity-studio replay <delivery-id>');

  await withRuntime({ ...flags, keep: false }, async ({ store, internalSecret, baseUrl }) => {
    const match = store.triggers.recentDeliveries(200).find((d) => d.id.startsWith(id!));
    if (!match) fail(`no delivery starting with "${id}".`);

    const ingress = new WebhookIngress({
      store,
      resolveTarget: () => ({ baseUrl, internalSecret }),
    });
    step(`replaying delivery ${match!.id.slice(0, 8)}…`);
    const result = await ingress.replay(match!.id);
    if (result.runId) printTimeline(store, result.runId, 0, result.status === 200 ? 'success' : 'failed');
    else info(JSON.stringify(result.body));
  });
}

/**
 * Hold everything up: the automation, the control plane, the dispatch tick and
 * webhook ingress. This is the mode in which a schedule actually fires.
 */
async function cmdServe(flags: RunFlags): Promise<void> {
  // Filled in once the automation is healthy. The webhook handler is installed
  // before that happens, and simply reports "not running" until this is set.
  let webhookTarget: DispatchTarget | undefined;

  await withRuntime({ ...flags, keep: true }, async ({ baseUrl, plane, runner, store, projectId, internalSecret }) => {
    const target: DispatchTarget = { baseUrl, internalSecret };
    webhookTarget = target;

    const dispatcher = new Dispatcher({
      store,
      resolveTarget: () => target,
      onEvent: (event) => {
        if (event.fired) ok(`fired ${event.instanceId.slice(0, 8)} → ${event.runId}`);
        else if (event.skipped === 'missed-window') {
          warn(`${event.instanceId.slice(0, 8)}: window missed while Studio was not running`);
        } else if (event.error) {
          console.error(`${c.red('✘')} ${event.instanceId.slice(0, 8)}: ${event.error}`);
        }
      },
    });

    dispatcher.start();

    const instances = store.triggers.list(projectId);
    info();
    info(`  ${c.bold('automation')}     ${baseUrl}`);
    info(`  ${c.bold('control plane')}  ${plane.url}`);
    info();
    if (instances.length === 0) {
      info(c.dim('  No triggers configured — add one: clarity-studio trigger add --daily 09:00'));
    }
    for (const instance of instances) {
      info(`  ${formatTrigger(instance, c)}`);
      if (instance.type === 'WEBHOOK') {
        info(`    ${c.dim(`${plane.url}/webhooks/${instance.id}`)}`);
      }
    }
    if (!plane.url.endsWith(`:${CONTROL_PLANE_PORT}`)) {
      warn(
        `port ${CONTROL_PLANE_PORT} was busy, so webhook URLs are on ${plane.url} this session. ` +
          `Stop whatever holds ${CONTROL_PLANE_PORT} to keep them stable.`,
      );
    }
    info();
    info(c.dim('  Watching for due triggers. Press Ctrl-C to stop.'));
    info();

    await new Promise<void>((resolveWait) => {
      process.on('SIGINT', () => resolveWait());
      process.on('SIGTERM', () => resolveWait());
    });

    step('stopping…');
    dispatcher.stop();
    await runner.stop();
  }, {
    onPlaneReady: ({ plane, store, projectId }) => {
      // Registered before boot. Until the automation is healthy the ingress
      // answers 503 and stores the delivery, so nothing is lost and it can be
      // replayed once things are up.
      const ingress = new WebhookIngress({
        store,
        resolveTarget: () => webhookTarget,
      });
      plane.onAnyWebhook(async (instanceId, payload, headers) => {
        const result = await ingress.deliver(instanceId, payload, headers);
        info(`${c.cyan('→')} webhook ${instanceId.slice(0, 8)} → ${result.status}`);
        return { status: result.status, body: result.body };
      });
      void projectId;
    },
  });
}


// ── secrets ──────────────────────────────────────────────────────────────────

function cmdKeys(positional: string[], flags: RunFlags): void {
  const store = openStore();
  try {
    const vault = openVault(store);
    const [action, id, value] = positional;

    if (!action || action === 'ls' || action === 'list') {
      const stored = vault.list();
      info();
      info(c.dim(`  vault: ${vault.backendId}${vault.canStore ? '' : ' (read-only)'}`));
      if (stored.length === 0) {
        info(c.dim('  Nothing stored yet.'));
        info(c.dim('  clarity-studio keys set anthropic sk-ant-…'));
      }
      for (const entry of stored) {
        const scope = entry.ref.projectId ? ` (${entry.ref.projectId.slice(0, 8)})` : '';
        // Only the last four, ever. There is no command that prints a secret.
        info(`  ${entry.ref.kind.padEnd(12)} ${entry.ref.id.padEnd(16)} ${entry.ref.field.padEnd(14)} ····${entry.last4}${scope}`);
      }
      info();
      return;
    }

    if (action === 'set') {
      if (!id || !value) fail('usage: clarity-studio keys set <provider> <key>');
      try {
        vault.set({ kind: 'provider', id: id!, field: 'api_key' }, value!);
      } catch (err) {
        if (err instanceof VaultUnavailableError) fail(err.message);
        throw err;
      }
      ok(`stored a key for ${id} (····${value!.slice(-4)})`);
      return;
    }

    if (action === 'rm' || action === 'remove') {
      if (!id) fail('usage: clarity-studio keys rm <provider>');
      vault.remove({ kind: 'provider', id: id!, field: 'api_key' });
      ok(`removed the key for ${id}`);
      return;
    }

    fail(`unknown: keys ${action}. Try set, ls or rm.`);
  } finally {
    store.close();
  }
}

function cmdIntegrations(positional: string[], flags: RunFlags): void {
  const store = openStore();
  try {
    const vault = openVault(store);
    const project = store.getProjectBySlug(slugOf(resolve(flags.dir)));

    info();
    for (const integration of CATALOG) {
      const bundle = vault.bundle(integration.id, project?.id);
      const connected = integration.fields.length === 0 || Boolean(bundle);
      const mark = connected ? c.green('●') : c.dim('○');
      const note = integration.fields.length === 0 ? c.dim('no credential needed') : connected ? '' : c.dim('not connected');
      info(`  ${mark} ${integration.id.padEnd(20)} ${integration.name.padEnd(16)} ${note}`);
      for (const tool of integration.tools) {
        info(`      ${c.dim(tool.id.padEnd(28))} ${c.dim(tool.summary ?? '')}`);
      }
    }
    info();
    info(c.dim('  Connect one: clarity-studio connect <id> <field>=<value>'));
    info();
  } finally {
    store.close();
  }
}

function cmdConnect(positional: string[], flags: RunFlags): void {
  const [id, ...pairs] = positional;
  if (!id) fail('usage: clarity-studio connect <integration> <field>=<value> …');

  const integration = findIntegration(id!);
  if (!integration) {
    fail(`no connector called "${id}". See: clarity-studio integrations`);
  }

  if (pairs.length === 0) {
    // Show what is needed rather than erroring — the user almost certainly
    // does not know the field names yet.
    info();
    info(c.bold(integration!.name));
    info(`  ${integration!.howToConnect}`);
    info();
    if (integration!.fields.length === 0) {
      info(c.dim('  This one needs no credential.'));
    } else {
      info(c.bold('  Then:'));
      const example = integration!.fields.map((f) => `${f.key}=<${f.placeholder ?? f.label}>`).join(' ');
      info(`  clarity-studio connect ${id} ${example}`);
    }
    info();
    return;
  }

  const store = openStore();
  try {
    const vault = openVault(store);
    const project = store.getProjectBySlug(slugOf(resolve(flags.dir)));

    for (const pair of pairs) {
      const at = pair.indexOf('=');
      if (at === -1) fail(`"${pair}" should look like field=value`);
      const field = pair.slice(0, at);
      const value = pair.slice(at + 1);
      if (!integration!.fields.some((f) => f.key === field)) {
        fail(
          `${integration!.name} has no "${field}" field. It expects: ` +
            integration!.fields.map((f) => f.key).join(', '),
        );
      }
      try {
        vault.set(
          {
            kind: 'integration',
            id: integration!.id,
            field,
            // Scoped to this project when run inside one, so two automations
            // can use different accounts for the same service.
            ...(project ? { projectId: project.id } : {}),
          },
          value,
        );
      } catch (err) {
        if (err instanceof VaultUnavailableError) fail(err.message);
        throw err;
      }
    }

    ok(`connected ${integration!.name}${project ? ` for ${project.name}` : ' (all automations)'}`);
    info(c.dim(`  tools: ${integration!.tools.map((t) => t.id).join(', ')}`));
  } finally {
    store.close();
  }
}

function help(): void {
  info(`
${c.bold('clarity-studio')} — build, run and observe agentic automations locally

${c.bold('Usage')}
  clarity-studio new <name>              create an automation from the seed
  clarity-studio run [workflow]          run a workflow and print its timeline
  clarity-studio up                      start the automation and leave it running
  clarity-studio serve                   run it for real: schedules fire, webhooks land
  clarity-studio trigger add             configure when it runs
  clarity-studio trigger ls | rm <id>    list or remove triggers
  clarity-studio deliveries              recent webhook deliveries
  clarity-studio replay <id>             send a past delivery through again
  clarity-studio keys set <provider> <k> store a model provider key
  clarity-studio keys ls | rm <provider>
  clarity-studio integrations            what Studio can connect to
  clarity-studio connect <id> f=v …      connect an integration
  clarity-studio ps                      list your automations
  clarity-studio runs                    recent runs for this directory
  clarity-studio doctor                  check this machine

${c.bold('Options')}
  --dir <path>     the automation directory (default: current directory)
  --native         run with a local Python venv instead of Docker
  --simulate       exercise the wiring with no model, no key and no spend
  --keep           leave the automation running after the command finishes

${c.bold('Scheduling')} ${c.dim('(for `trigger add`)')}
  --every 30m      every 30 minutes (also 2h, 1d)
  --daily 09:00    every day at 09:00
  --weekly mon,fri@09:00
  --monthly 1@06:00
  --once <iso>     a single run at a given instant
  --timezone <tz>  defaults to this machine's timezone
  --missed skip|run-once   what to do about windows missed while Studio was off

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
    case 'serve':
      return cmdServe(flags);
    case 'trigger': {
      const sub = positional[1];
      const rest2 = positional.slice(2);
      const tf: TriggerFlags = {
        ...flags,
        every: valueOf('--every'),
        daily: valueOf('--daily'),
        weekly: valueOf('--weekly'),
        monthly: valueOf('--monthly'),
        once: valueOf('--once'),
        timezone: valueOf('--timezone'),
        missed: valueOf('--missed') as TriggerFlags['missed'],
        trigger: valueOf('--trigger'),
      };
      if (sub === 'add') return cmdTriggerAdd(rest2, tf);
      if (sub === 'ls' || sub === 'list' || sub === undefined) return cmdTriggerList(flags);
      if (sub === 'rm' || sub === 'remove') return cmdTriggerRemove(rest2, flags);
      return fail(`unknown: trigger ${sub}. Try add, ls or rm.`);
    }
    case 'keys':
      return cmdKeys(positional.slice(1), flags);
    case 'integrations':
      return cmdIntegrations(positional.slice(1), flags);
    case 'connect':
      return cmdConnect(positional.slice(1), flags);
    case 'deliveries':
      return cmdDeliveries(flags);
    case 'replay':
      return cmdReplay(positional.slice(1), flags);
    case 'doctor':
      return cmdDoctor();
    default:
      fail(`unknown command "${command}". Try: clarity-studio help`);
  }
}

main().catch((err) => {
  fail(err instanceof Error ? err.message : String(err));
});
