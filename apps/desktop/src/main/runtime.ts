/**
 * Hosting an automation from inside the desktop app.
 *
 * The CLI's `withRuntime` boots a control plane and a runner, does one thing,
 * and tears both down. The window needs the opposite: a runtime that stays up
 * across many actions, so Start really means "running until I say stop".
 *
 * One control plane is shared by every project — it is the thing automations
 * call back into, and its port must be STABLE, because a webhook URL handed to
 * GitHub has to survive a restart. Runners are per project.
 *
 * Everything here runs in the main process. The renderer never sees a runner, a
 * port or a secret — only the plain status the store already exposes.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { parse as parseYaml } from 'yaml';

import {
  ControlPlane,
  EnvSecretSource,
  modelNeedsKey,
  providerIdForModel,
  type SecretSource,
} from '@clarity-studio/control-plane';
import { Dispatcher } from '@clarity-studio/scheduler';
import type { Store } from '@clarity-studio/db';
import {
  allocatePort,
  DockerRunner,
  fireWorkflow,
  isFree,
  NativeRunner,
  type Runner,
} from '@clarity-studio/orchestrator';
import { SafeStorageBackend, Vault, type VaultStorage } from '@clarity-studio/vault';
import { safeStorage } from 'electron';

/** Where webhooks arrive. Fixed so the URLs you hand out keep working. */
const CONTROL_PLANE_PORT = 4319;

function vaultStorage(store: Store): VaultStorage {
  return {
    put: (key, ciphertext, last4) => store.putSecret(key, ciphertext, last4),
    get: (key) => store.getSecret(key),
    remove: (key) => store.removeSecret(key),
    list: () => store.listSecrets(),
  };
}

/**
 * The vault, then the environment. That order matters: a key you deliberately
 * stored should not be silently overridden by a stale shell export.
 *
 * The desktop app uses the OS keyring (`safeStorage`) rather than a passphrase —
 * there is a real user present, so there is no reason to make them type one.
 */
class VaultSecretSource implements SecretSource {
  private readonly env = new EnvSecretSource();

  constructor(private readonly vault: Vault) {}

  async providerKey(providerId: string): Promise<string | undefined> {
    return (
      this.vault.get({ kind: 'provider', id: providerId, field: 'api_key' }) ??
      (await this.env.providerKey(providerId))
    );
  }

  /** A stored endpoint wins over the environment, same order as keys. */
  async providerBaseUrl(providerId: string): Promise<string | undefined> {
    return (
      this.vault.get({ kind: 'provider', id: providerId, field: 'base_url' }) ??
      (await this.env.providerBaseUrl?.(providerId))
    );
  }

  async integrationCredentials(
    projectId: string,
    integrationId: string,
  ): Promise<Record<string, unknown> | undefined> {
    return (
      this.vault.bundle(integrationId, projectId) ??
      (await this.env.integrationCredentials(projectId, integrationId))
    );
  }

  async allSecretValues(): Promise<string[]> {
    // Both sources: the redactor must know every secret that could appear in
    // output, including ones it cannot itself write.
    return [...this.vault.allValues(), ...(await this.env.allSecretValues())];
  }
}

interface Live {
  runner: Runner;
  baseUrl: string;
  /** The automation's own manifest, read once at start. Used to decide whether
   *  a run needs a model key at all. */
  manifest?: { agents?: unknown[]; workflows?: Array<{ steps?: Array<{ agent?: string }> }> };
  /** The project's CLARITY_INTERNAL_SECRET, which the scheduler must present
   *  when it asks the automation to run a due trigger. */
  internalSecret: string;
}

/** Does anything in this automation call a model? A workflow of pure tools does
 *  not, and must not be blocked for want of a key it will never use. */
/**
 * Give a model running on this machine longer to answer than a hosted one.
 *
 * The SDK's request ceiling is tuned for an API that replies in seconds. A
 * local model can spend longer than that simply loading before its first
 * token, and the run dies as a read timeout that names nothing useful — the
 * model is fine, the wait was too short. Since choosing `ollama/…` is an
 * explicit statement that inference is happening here, the longer wait comes
 * with it rather than being a setting to discover after the first failure.
 *
 * Only ever raises the ceiling, and only when nothing else has spoken: a value
 * already in the environment is somebody's decision and is left alone. Needs
 * claritty-sdk 2.12.1+ to have any effect; older ones ignore it, which is the
 * right way for this to fail.
 */
function localModelTimeout(override?: string): Record<string, string> {
  if (!override || modelNeedsKey(override)) return {};
  if (process.env.CLARITTY_LLM_TIMEOUT_S) return {};
  return { CLARITTY_LLM_TIMEOUT_S: '600' };
}

/** Where a failed start leaves its full output. Inside `.studio/` so it sits
 *  with the venv and the generated compose file rather than in the automation's
 *  own tree, and gets ignored by the same rules. */
export function bootLogPath(projectPath: string): string {
  return join(projectPath, '.studio', 'boot.log');
}

/**
 * Keep the whole boot output, because the panel only shows its tail.
 *
 * Overwrites rather than appends: the question this answers is always "why did
 * it not start just now", and a growing file would bury that under every
 * previous attempt. Failing to write is not worth surfacing — the run already
 * failed for a different reason, and a second error about logging would bury
 * the first.
 */
function writeBootLog(projectPath: string, message: string, output: string): void {
  try {
    const dir = join(projectPath, '.studio');
    mkdirSync(dir, { recursive: true });
    const at = new Date().toISOString();
    const body = [
      `# ${basename(projectPath)} failed to start at ${at}`,
      '',
      '## What the app reported',
      message,
      '',
      '## Everything the runtime printed',
      output.trim() || '(the process produced no output before it failed)',
      '',
    ].join('\n');
    writeFileSync(bootLogPath(projectPath), body, 'utf8');
  } catch {
    /* best effort — see above */
  }
}

function needsModel(manifest?: {
  agents?: unknown[];
  workflows?: Array<{ steps?: Array<{ agent?: string }> }>;
}): boolean {
  if (!manifest) return true; // unknown shape: keep the old, cautious answer
  const declares = Array.isArray(manifest.agents) && manifest.agents.length > 0;
  const calls = (manifest.workflows ?? []).some((w) => (w.steps ?? []).some((s) => Boolean(s.agent)));
  return declares || calls;
}

const MISSING_MODEL_KEY =
  'No model provider key, so the agent steps have nothing to call. ' +
  'Add one in Settings → Model — or set ANTHROPIC_API_KEY / OPENAI_API_KEY.';

/**
 * Say which key is missing, not which keys exist.
 *
 * With an override set, the generic message sends someone to add an Anthropic
 * key when they have deliberately chosen a different provider — advice for a
 * decision they already made differently.
 */
function missingModelKeyMessage(override?: string): string {
  if (!override) return MISSING_MODEL_KEY;
  const providerId = providerIdForModel(override) ?? 'that provider';
  return (
    `Settings → Model is set to run everything on "${override}", which needs a ` +
    `${providerId} key, and none is configured. Add one under Settings → Model, ` +
    `or clear the override to let each automation use the model it declares.`
  );
}

export class RuntimeHost {
  private plane?: ControlPlane;
  private planeUrl?: string;
  private secrets?: VaultSecretSource;
  private vault?: Vault;
  private readonly live = new Map<string, Live>();
  /** Serialises start/stop per project so a double-click cannot race itself. */
  private readonly pending = new Map<string, Promise<unknown>>();

  /**
   * `onRunComplete` fires for every finished run, whichever way it finished —
   * fired from the UI, fired by a schedule, or failed before it ever reached the
   * automation. Both call sites below funnel through here, which is why the hook
   * lives at `completeRun` rather than next to one of them.
   */
  private dispatcher?: Dispatcher;

  constructor(
    private readonly store: () => Store,
    private readonly onRunComplete: (runId: string) => void = () => {},
    /** How a scheduled run that failed before it began gets reported. The
     *  dispatcher's own failure path writes straight to the store, so it never
     *  passes through the control plane's completeRun where `onRunComplete`
     *  lives — the runs you most need telling about would be the silent ones. */
    private readonly onScheduleEvent: (event: { runId?: string; error: string }) => void = () => {},
    /** The model to run everything on, whatever the manifest asked for, or
     *  undefined to honour the manifest. Read fresh on every model call rather
     *  than captured, so changing it in Settings takes effect on the next run
     *  instead of the next launch. */
    private readonly modelOverride: () => string | undefined = () => undefined,
  ) {}

  /**
   * Run the schedules while the window is open.
   *
   * Studio listed triggers and showed a next-run time, and nothing fired them:
   * the Dispatcher was only ever constructed by the CLI's `serve`. A desktop app
   * whose own copy says an automation "runs on its schedule" has to be the thing
   * that runs it.
   *
   * `ensureRunning` is what makes this work here rather than in the CLI: the
   * CLI has one automation and it is already up, whereas Studio's are normally
   * stopped, so every schedule would resolve to no target and skip.
   */
  startScheduling(): void {
    if (this.dispatcher) return;
    this.dispatcher = new Dispatcher({
      store: this.store(),
      ensureRunning: async (projectId) => {
        await this.start(projectId);
      },
      resolveTarget: (projectId) => {
        const entry = this.live.get(projectId);
        return entry ? { baseUrl: entry.baseUrl, internalSecret: entry.internalSecret } : undefined;
      },
      onEvent: (event) => {
        if (event.error) this.onScheduleEvent({ runId: event.runId, error: event.error });
        else if (event.fired && event.runId) this.onRunComplete(event.runId);
      },
    });
    this.dispatcher.start();
  }

  stopScheduling(): void {
    this.dispatcher?.stop();
    this.dispatcher = undefined;
  }

  private async ensurePlane(): Promise<ControlPlane> {
    if (this.plane) return this.plane;

    const vault = new Vault(new SafeStorageBackend(safeStorage), vaultStorage(this.store()));
    this.vault = vault;
    // Prefer the stable port; fall back only if something else holds it, in
    // which case webhook URLs move and the UI says so.
    const port = (await isFree(CONTROL_PLANE_PORT)) ? CONTROL_PLANE_PORT : 0;

    const store = this.store();
    this.secrets = new VaultSecretSource(vault);
    const plane = new ControlPlane({
      port,
      secrets: this.secrets,
      // A function, not a value: this plane is built once and kept for the life
      // of the window, so a string would pin whatever the setting said when the
      // first automation started.
      forceModel: () => this.modelOverride(),
      store: {
        checkpointStep: (cp) => store.checkpointStep(cp),
        completeRun: (rc) => {
          store.completeRun(rc);
          this.onRunComplete(rc.runId);
        },
        recordLlmCall: (r) => store.recordLlmCall(r),
        getRun: (id) => store.getRun(id),
        getSteps: (id) => store.getSteps(id) as never,
        getLlmCalls: (id) => store.getLlmCalls(id) as never,
      },
    });
    const { url } = await plane.listen();
    this.plane = plane;
    this.planeUrl = url;
    return plane;
  }

  /** Run `body` with no other start/stop for this project in flight. */
  private serialise<T>(projectId: string, body: () => Promise<T>): Promise<T> {
    const next = (this.pending.get(projectId) ?? Promise.resolve()).then(body, body);
    // Keep the chain alive but never let a rejection poison the next action.
    this.pending.set(
      projectId,
      next.catch(() => undefined),
    );
    return next;
  }

  isRunning(projectId: string): boolean {
    return this.live.has(projectId);
  }

  async start(projectId: string): Promise<{ baseUrl: string }> {
    return this.serialise(projectId, async () => {
      const existing = this.live.get(projectId);
      if (existing) return { baseUrl: existing.baseUrl };

      const store = this.store();
      const project = store.getProject(projectId);
      if (!project) throw new Error('That automation is no longer in the library.');

      const plane = await this.ensurePlane();
      store.setProjectStatus(projectId, 'starting');

      const hostPort = await allocatePort(projectId, {
        get: () => store.portFor(projectId),
        set: (id, port) => store.claimPort(id, port),
        release: (id) => store.releasePort(id),
        taken: () => store.takenPorts(),
      });

      const native = project.runtime !== 'docker';
      // A container reaches the host by a different name than the host uses
      // for itself.
      const platformUrl = native
        ? this.planeUrl!
        : this.planeUrl!.replace('127.0.0.1', 'host.docker.internal');
      plane.register(projectId);
      const environment = {
        ...plane.environmentFor(projectId, { platformUrl }),
        ...localModelTimeout(this.modelOverride()),
      };

      const runner: Runner = native
        ? new NativeRunner({ projectId, projectPath: project.path, hostPort, environment })
        : new DockerRunner({ projectId, projectPath: project.path, hostPort, environment });

      try {
        if (runner instanceof NativeRunner) await runner.prepare();
        await runner.start();
        await runner.waitUntilHealthy();
        store.setProjectStatus(projectId, 'running');
        const internalSecret = environment.CLARITY_INTERNAL_SECRET;
        // An empty secret would not fail here — it would fail later, as a 401
        // on a scheduled trigger at 6am, reported as "the automation refused".
        if (!internalSecret) throw new Error('The control plane issued no internal secret.');
        // Read once, here, rather than per run: it decides whether a run needs
        // a model key, and re-parsing the manifest on every Run press would be
        // work for an answer that cannot change while the runtime is up.
        let manifest: Live['manifest'];
        try {
          const file = join(project.path, 'intelligence.yaml');
          if (existsSync(file)) manifest = parseYaml(readFileSync(file, 'utf8')) as Live['manifest'];
        } catch {
          // Unreadable or mid-edit: leave it undefined, which keeps the old
          // cautious answer of "assume it needs a model".
        }
        this.live.set(projectId, { runner, baseUrl: runner.baseUrl, internalSecret, manifest });
        return { baseUrl: runner.baseUrl };
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        store.setProjectStatus(projectId, 'crashed', message);
        // Before `runner` goes out of scope and takes its buffer with it. The
        // panel shows the last 40 lines, which is usually the traceback's tail
        // and not its cause; this is the only copy of the rest.
        writeBootLog(project.path, message, runner.output);
        // Leave nothing half-up: a runner that failed its health check may still
        // have a process or a container behind it.
        await runner.stop().catch(() => undefined);
        throw cause;
      }
    });
  }

  async stop(projectId: string): Promise<void> {
    return this.serialise(projectId, async () => {
      const entry = this.live.get(projectId);
      if (!entry) return;
      this.live.delete(projectId);
      await entry.runner.stop();
      const store = this.store();
      // Only overwrite a healthy status — a recorded crash must survive
      // teardown, or the UI would report "stopped" for something that fell over.
      if (store.getProject(projectId)?.status === 'running') {
        store.setProjectStatus(projectId, 'stopped');
      }
    });
  }

  /**
   * Throw away the Python environment and start again.
   *
   * `prepare()` skips creating the venv when one is already there, which is
   * what makes a second start instant — and what makes a half-installed
   * environment permanent. Nothing else in the app can get you out of that,
   * because every later start takes the same shortcut. Deleting the venv is
   * the whole point of the button, not an implementation detail of it.
   *
   * Only the environment goes. The automation's own files are never touched:
   * a boot failure is usually a manifest that names a file nobody wrote, and
   * deleting code to fix that would be a catastrophe wearing a helpful label.
   */
  async rebuild(projectId: string): Promise<{ baseUrl: string }> {
    const project = this.store().getProject(projectId);
    if (!project) throw new Error('That automation is not in the library.');

    await this.stop(projectId).catch(() => undefined);
    const venv = join(project.path, '.studio', 'venv');
    if (existsSync(venv)) {
      try {
        rmSync(venv, { recursive: true, force: true });
      } catch (cause) {
        const why = cause instanceof Error ? cause.message : String(cause);
        throw new Error(`Could not remove the Python environment at ${venv}: ${why}`);
      }
    }
    return this.start(projectId);
  }

  /**
   * Fire a workflow, starting the automation first if it is not already up —
   * "Run now" should not require knowing that Start exists.
   */
  async runWorkflow(
    projectId: string,
    workflowId?: string,
    inputs?: Record<string, unknown>,
  ): Promise<{ runId: string }> {
    // Before starting anything. Starting builds a Python venv the first time,
    // so checking the key afterwards meant pressing Run now and waiting a
    // minute or more to be told you needed one — an expensive answer to a
    // question answerable from a file. The manifest on disk says whether any
    // step calls a model; it does not need a running runtime to say so.
    if (!this.live.has(projectId)) {
      const project = this.store().getProject(projectId);
      const file = project ? join(project.path, 'intelligence.yaml') : undefined;
      if (file && existsSync(file)) {
        let onDisk: Live['manifest'];
        try {
          onDisk = parseYaml(readFileSync(file, 'utf8')) as Live['manifest'];
        } catch {
          // Mid-edit. Fall through and let the usual boot error explain it.
        }
        if (onDisk && needsModel(onDisk) && !(await this.hasModelKey())) {
          throw new Error(missingModelKeyMessage(this.modelOverride()));
        }
      }
    }

    if (!this.live.has(projectId)) await this.start(projectId);
    const entry = this.live.get(projectId);
    if (!entry) throw new Error('The automation is not running.');

    const target = workflowId ?? (await firstWorkflow(entry.baseUrl));
    if (!target) {
      throw new Error('No workflow to run — does intelligence.yaml declare one?');
    }

    // Checked before opening a run, not after it fails. Without a key every
    // agent step fails and the engine reports only "all workflow steps failed
    // or were skipped", which names neither the cause nor the fix.
    //
    // Only when there are agent steps to call one. A workflow of pure tools
    // needs no model, and demanding a key for it turned the one automation
    // anybody can run with zero setup — no key, no connection, no account —
    // into one that refuses at the button. A guard that blocks work it was
    // never protecting is worse than no guard: it is wrong AND it is trusted.
    // Still checked here: an automation already running was started before the
    // key was removed, and the pre-check above only runs on a cold start.
    if (needsModel(entry.manifest) && !(await this.hasModelKey())) {
      throw new Error(MISSING_MODEL_KEY);
    }

    const store = this.store();
    const runId = `wfr_${randomUUID().replace(/-/g, '').slice(0, 8)}_manual`;
    // No idempotency key: a manual run is deliberate, and pressing Run twice
    // should give two runs rather than silently returning the first.
    store.openRun({ id: runId, projectId, workflowId: target, triggeredBy: 'manual' });

    // The engine checkpoints back into the same store through the control
    // plane, so the timeline fills in as it goes. Errors are recorded rather
    // than thrown away, then re-thrown so the window can say what happened.
    try {
      // The inputs are how a person tells a running automation anything at all —
      // the engine binds them to `${inputs.x}` in the first step.
      await fireWorkflow(entry.baseUrl, target, { runId, inputs });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      store.completeRun({ runId, status: 'failed', error: message });
      this.onRunComplete(runId);
      throw cause;
    }
    return { runId };
  }

  /**
   * True when a run has somewhere to send model calls: a stored provider key,
   * or a base URL pointing at the user's own OpenAI-compatible endpoint (a local
   * model, or their gateway). A self-hosted endpoint may need no key at all,
   * so requiring one would lock out exactly the people who brought their own.
   */
  private async hasModelKey(): Promise<boolean> {
    if (!this.secrets) return true;

    // An override decides which provider serves every step, so it — not the
    // manifest, and not "any key at all" — is what the question is about. This
    // is the whole reason `ollama/…` was being refused a run it could have
    // completed: the check predates there being a way to choose a model that
    // needs no key.
    const override = this.modelOverride();
    if (override) return this.canServe(override);

    for (const provider of ['anthropic', 'openai']) {
      if (await this.secrets.providerKey(provider)) return true;
      if (this.vault?.get({ kind: 'provider', id: provider, field: 'base_url' })) return true;
    }
    return false;
  }

  /** Whether this exact model could be served right now, by the same rule the
   *  control plane applies when the call actually happens. */
  private async canServe(model: string): Promise<boolean> {
    if (!modelNeedsKey(model)) return true;
    const providerId = providerIdForModel(model);
    // Nothing claims it. Not runnable either, but "no provider handles this
    // model" is the plane's error to give and a truer one than ours.
    if (!providerId) return true;
    if (await this.secrets?.providerKey(providerId)) return true;
    return Boolean(this.vault?.get({ kind: 'provider', id: providerId, field: 'base_url' }));
  }

  /** Stop everything. Called on quit so nothing is left holding a port. */
  async shutdown(): Promise<void> {
    await Promise.allSettled([...this.live.keys()].map((id) => this.stop(id)));
    await this.plane?.close().catch(() => undefined);
    this.plane = undefined;
    this.planeUrl = undefined;
  }
}

/** The automation's own list, so "Run now" works without a manifest parse. */
async function firstWorkflow(baseUrl: string): Promise<string | undefined> {
  try {
    const res = await fetch(`${baseUrl}/api/workflows`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return undefined;
    const body = (await res.json()) as { workflows?: Array<{ id?: string }> } | Array<{ id?: string }>;
    const list = Array.isArray(body) ? body : (body.workflows ?? []);
    return list[0]?.id;
  } catch {
    return undefined;
  }
}
