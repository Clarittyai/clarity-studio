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

import { basename } from 'node:path';
import { randomUUID } from 'node:crypto';

import { ControlPlane, EnvSecretSource, type SecretSource } from '@clarity-studio/control-plane';
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
  constructor(
    private readonly store: () => Store,
    private readonly onRunComplete: (runId: string) => void = () => {},
  ) {}

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
      const environment = plane.environmentFor(projectId, { platformUrl });

      const runner: Runner = native
        ? new NativeRunner({ projectId, projectPath: project.path, hostPort, environment })
        : new DockerRunner({ projectId, projectPath: project.path, hostPort, environment });

      try {
        if (runner instanceof NativeRunner) await runner.prepare();
        await runner.start();
        await runner.waitUntilHealthy();
        store.setProjectStatus(projectId, 'running');
        this.live.set(projectId, { runner, baseUrl: runner.baseUrl });
        return { baseUrl: runner.baseUrl };
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        store.setProjectStatus(projectId, 'crashed', message);
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
   * Fire a workflow, starting the automation first if it is not already up —
   * "Run now" should not require knowing that Start exists.
   */
  async runWorkflow(
    projectId: string,
    workflowId?: string,
    inputs?: Record<string, unknown>,
  ): Promise<{ runId: string }> {
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
    if (!(await this.hasModelKey())) {
      throw new Error(
        'No model provider key, so the agent steps have nothing to call. ' +
          'Add one with: clarity-studio keys set anthropic — or set ANTHROPIC_API_KEY / OPENAI_API_KEY.',
      );
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
    for (const provider of ['anthropic', 'openai']) {
      if (await this.secrets.providerKey(provider)) return true;
      if (this.vault?.get({ kind: 'provider', id: provider, field: 'base_url' })) return true;
    }
    return false;
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
