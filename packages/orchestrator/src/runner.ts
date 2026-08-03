/**
 * Running an automation.
 *
 * Two backends behind one interface:
 *
 * - **docker** — the real thing. The automation runs in the same container it
 *   would run in anywhere else, so what works here works on a server.
 * - **native** — a Python virtualenv and uvicorn on the host.
 *
 * The native backend exists because "install Docker Desktop first" is where
 * most people stop. Studio should be useful within a minute of download, on a
 * laptop that has Python and nothing else. Docker is the right default and the
 * only one we'd ship a schedule on, but it should not be the price of entry.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { buildComposeOverride, composeArgs } from './compose.js';

export interface RunnerOptions {
  projectId: string;
  /** Directory holding intelligence.yaml. */
  projectPath: string;
  hostPort: number;
  /** From ControlPlane.environmentFor(). */
  environment: Record<string, string>;
  /** Called for every line of automation output. */
  onLog?: (line: string, stream: 'stdout' | 'stderr') => void;
}

export interface Health {
  status: string;
  automation?: string;
  version?: string;
  workflows?: string[];
  triggers?: string[];
}

export interface Runner {
  readonly kind: 'docker' | 'native';
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Resolves once the automation answers /health, or throws with the last
   *  output — a boot failure should show you the traceback, not a timeout. */
  waitUntilHealthy(timeoutMs?: number): Promise<Health>;
  get baseUrl(): string;
}

const STUDIO_DIR = '.studio';

abstract class BaseRunner implements Runner {
  abstract readonly kind: 'docker' | 'native';
  protected readonly tail: string[] = [];

  constructor(protected readonly opts: RunnerOptions) {}

  abstract start(): Promise<void>;
  abstract stop(): Promise<void>;

  get baseUrl(): string {
    return `http://127.0.0.1:${this.opts.hostPort}`;
  }

  protected record(line: string, stream: 'stdout' | 'stderr'): void {
    for (const l of line.split('\n')) {
      if (!l.trim()) continue;
      this.tail.push(l);
      // Bounded: an automation in a crash loop must not eat the machine's RAM
      // while nobody is looking at it.
      if (this.tail.length > 500) this.tail.shift();
      this.opts.onLog?.(l, stream);
    }
  }

  protected get recentOutput(): string {
    return this.tail.slice(-40).join('\n');
  }

  async waitUntilHealthy(timeoutMs = 180_000): Promise<Health> {
    const deadline = Date.now() + timeoutMs;
    let lastError = '';
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`${this.baseUrl}/health`, { signal: AbortSignal.timeout(3000) });
        if (res.ok) return (await res.json()) as Health;
        lastError = `HTTP ${res.status}`;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
      }
      if (await this.hasExited()) {
        throw new Error(
          `The automation stopped while starting up.\n\n${this.recentOutput}`,
        );
      }
      await sleep(400);
    }
    throw new Error(
      `The automation never answered ${this.baseUrl}/health (last: ${lastError}).\n\n${this.recentOutput}`,
    );
  }

  protected async hasExited(): Promise<boolean> {
    return false;
  }

  protected studioDir(): string {
    const dir = join(this.opts.projectPath, STUDIO_DIR);
    mkdirSync(dir, { recursive: true });
    return dir;
  }
}

// ── docker ───────────────────────────────────────────────────────────────────

export class DockerRunner extends BaseRunner {
  readonly kind = 'docker' as const;
  private logProc?: ChildProcess;

  private args(): string[] {
    return composeArgs({
      projectId: this.opts.projectId,
      composeFile: join(this.opts.projectPath, 'docker-compose.yml'),
      overrideFile: join(this.studioDir(), 'compose.override.yml'),
    });
  }

  async start(): Promise<void> {
    writeFileSync(
      join(this.studioDir(), 'compose.override.yml'),
      buildComposeOverride({
        projectId: this.opts.projectId,
        hostPort: this.opts.hostPort,
        environment: this.opts.environment,
        memory: '2g',
      }),
      'utf8',
    );

    const { code, output } = await run('docker', [...this.args(), 'up', '-d', '--build'], {
      cwd: this.opts.projectPath,
      onLine: (l, s) => this.record(l, s),
    });
    if (code !== 0) {
      throw new Error(`docker compose up failed (exit ${code}).\n\n${output.slice(-4000)}`);
    }
    this.streamLogs();
  }

  private streamLogs(): void {
    this.logProc = spawn('docker', [...this.args(), 'logs', '-f', '--tail', '50'], {
      cwd: this.opts.projectPath,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.logProc.stdout?.on('data', (d) => this.record(String(d), 'stdout'));
    this.logProc.stderr?.on('data', (d) => this.record(String(d), 'stderr'));
  }

  async stop(): Promise<void> {
    this.logProc?.kill('SIGTERM');
    await run('docker', [...this.args(), 'down', '--remove-orphans'], {
      cwd: this.opts.projectPath,
    });
  }
}

// ── native ───────────────────────────────────────────────────────────────────

export class NativeRunner extends BaseRunner {
  readonly kind = 'native' as const;
  private proc?: ChildProcess;

  private get venv(): string {
    return join(this.studioDir(), 'venv');
  }

  private get python(): string {
    return process.platform === 'win32'
      ? join(this.venv, 'Scripts', 'python.exe')
      : join(this.venv, 'bin', 'python');
  }

  /** Create the venv and install requirements. Skipped when the venv already
   *  exists, so a second start is instant. */
  async prepare(onProgress?: (msg: string) => void): Promise<void> {
    if (!existsSync(this.python)) {
      onProgress?.('creating a Python environment…');
      const { code, output } = await run(pythonExe(), ['-m', 'venv', this.venv], {
        cwd: this.opts.projectPath,
      });
      if (code !== 0) throw new Error(`could not create a virtualenv:\n${output}`);
    }

    const requirements = join(this.opts.projectPath, 'backend', 'requirements.txt');
    if (existsSync(requirements)) {
      onProgress?.('installing dependencies…');
      const { code, output } = await run(
        this.python,
        ['-m', 'pip', 'install', '--quiet', '--disable-pip-version-check', '-r', requirements],
        { cwd: this.opts.projectPath },
      );
      if (code !== 0) throw new Error(`pip install failed:\n${output.slice(-3000)}`);
    }
  }

  async start(): Promise<void> {
    await this.prepare();
    this.proc = spawn(
      this.python,
      [
        '-m', 'uvicorn', 'backend.main:app',
        '--host', '127.0.0.1',
        '--port', String(this.opts.hostPort),
        '--log-level', 'info',
      ],
      {
        cwd: this.opts.projectPath,
        env: {
          ...process.env,
          ...this.opts.environment,
          PYTHONPATH: this.opts.projectPath,
          PYTHONUNBUFFERED: '1',
          APP_DATA_DIR: join(this.studioDir(), 'data'),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    this.proc.stdout?.on('data', (d) => this.record(String(d), 'stdout'));
    this.proc.stderr?.on('data', (d) => this.record(String(d), 'stderr'));
  }

  protected override async hasExited(): Promise<boolean> {
    return this.proc?.exitCode !== null && this.proc?.exitCode !== undefined;
  }

  async stop(): Promise<void> {
    if (!this.proc || this.proc.exitCode !== null) return;
    this.proc.kill('SIGTERM');
    // Give uvicorn a moment to close listeners, then insist. Leaving a stray
    // process holding the port is worse than a hard kill.
    await Promise.race([once(this.proc, 'exit'), sleep(4000)]);
    if (this.proc.exitCode === null) this.proc.kill('SIGKILL');
  }
}

// ── firing a workflow ────────────────────────────────────────────────────────

export interface WorkflowResult {
  success: boolean;
  status: string;
  workflowId: string;
  outputs?: Record<string, unknown>;
  error?: string | null;
  steps: Array<{ id: string; status: string; error?: string | null }>;
}

export async function fireWorkflow(
  baseUrl: string,
  workflowId: string,
  opts: { inputs?: Record<string, unknown>; runId?: string; userId?: string; timeoutMs?: number } = {},
): Promise<WorkflowResult> {
  const res = await fetch(`${baseUrl}/api/workflows/${workflowId}/execute`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-User-ID': opts.userId ?? 'local' },
    body: JSON.stringify({
      inputs: opts.inputs ?? {},
      user_id: opts.userId ?? 'local',
      // Without a run id the engine runs without checkpointing, which means no
      // timeline. Studio always supplies one.
      workflow_run_id: opts.runId,
    }),
    signal: AbortSignal.timeout(opts.timeoutMs ?? 600_000),
  });
  const body = (await res.json()) as WorkflowResult & { detail?: unknown };
  if (!res.ok) {
    throw new Error(`the automation returned HTTP ${res.status}: ${JSON.stringify(body).slice(0, 500)}`);
  }
  return body;
}

// ── small helpers ────────────────────────────────────────────────────────────

function pythonExe(): string {
  return process.env.STUDIO_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function once(proc: ChildProcess, event: string): Promise<void> {
  return new Promise((r) => proc.once(event, () => r()));
}

export function run(
  cmd: string,
  args: string[],
  opts: { cwd?: string; onLine?: (line: string, stream: 'stdout' | 'stderr') => void } = {},
): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, { cwd: opts.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const collect = (stream: 'stdout' | 'stderr') => (d: Buffer) => {
      const text = String(d);
      output += text;
      opts.onLine?.(text, stream);
    };
    proc.stdout?.on('data', collect('stdout'));
    proc.stderr?.on('data', collect('stderr'));
    proc.on('error', (err) => resolve({ code: 127, output: output + '\n' + err.message }));
    proc.on('close', (code) => resolve({ code: code ?? 1, output }));
  });
}
