/**
 * The local store — projects, runs, steps, model calls, triggers.
 *
 * Implements the control plane's `RunStore` so the same server code backs both
 * a throwaway spike (memory) and the real app (this).
 */

import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';

import { MIGRATIONS } from './schema.js';
import { TriggerStore } from './triggers.js';

// Loaded through createRequire rather than a static import: bundlers that
// don't yet know `node:sqlite` (Vite 5 among them) try to resolve it as a file
// and fail. A type-only import keeps full typing; the require happens at
// runtime, where the module genuinely exists. This also survives Electron's
// packaging, which is where a static import would bite later.
const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire('node:sqlite') as typeof import('node:sqlite');

export interface ProjectRow {
  id: string;
  name: string;
  slug: string;
  path: string;
  manifestPath?: string | null;
  hostPort?: number | null;
  runtime: 'docker' | 'native';
  status: string;
  lastError?: string | null;
  createdAt: number;
}

export interface RunRow {
  id: string;
  projectId: string;
  workflowId?: string | null;
  triggeredBy: string;
  status: string;
  startedAt: number;
  endedAt?: number | null;
  outputs?: unknown;
  error?: string | null;
  promptTokens: number;
  completionTokens: number;
  costMicros: number;
}

export interface StepRow {
  runId: string;
  stepId: string;
  status: string;
  startedAt: number;
  endedAt?: number | null;
  output?: unknown;
  error?: string | null;
}

export class Store {
  private db: DatabaseSyncType;
  /** Trigger instances and their delivery history. */
  readonly triggers: TriggerStore;

  constructor(readonly file: string) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    // WAL keeps the UI's reads from blocking on a run's writes, which matters
    // the moment a workflow is checkpointing while you scroll its timeline.
    if (file !== ':memory:') this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA foreign_keys = ON');
    for (const migration of MIGRATIONS) this.db.exec(migration);
    this.triggers = new TriggerStore(this.db);
  }

  close(): void {
    this.db.close();
  }

  // ── projects ───────────────────────────────────────────────────────────────

  upsertProject(p: Omit<ProjectRow, 'createdAt'> & { createdAt?: number }): ProjectRow {
    const createdAt = p.createdAt ?? Date.now();
    this.db
      .prepare(
        `INSERT INTO projects (id, name, slug, path, manifest_path, host_port, runtime, status, last_error, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name=excluded.name, path=excluded.path, manifest_path=excluded.manifest_path,
           host_port=excluded.host_port, runtime=excluded.runtime,
           status=excluded.status, last_error=excluded.last_error`,
      )
      .run(
        p.id, p.name, p.slug, p.path, p.manifestPath ?? null, p.hostPort ?? null,
        p.runtime, p.status, p.lastError ?? null, createdAt,
      );
    return this.getProject(p.id)!;
  }

  getProject(id: string): ProjectRow | undefined {
    const row = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? toProject(row) : undefined;
  }

  getProjectBySlug(slug: string): ProjectRow | undefined {
    const row = this.db.prepare('SELECT * FROM projects WHERE slug = ?').get(slug) as
      | Record<string, unknown>
      | undefined;
    return row ? toProject(row) : undefined;
  }

  listProjects(): ProjectRow[] {
    const rows = this.db
      .prepare('SELECT * FROM projects WHERE archived_at IS NULL ORDER BY created_at DESC')
      .all() as Record<string, unknown>[];
    return rows.map(toProject);
  }

  setProjectStatus(id: string, status: string, lastError?: string | null): void {
    this.db
      .prepare('UPDATE projects SET status = ?, last_error = ? WHERE id = ?')
      .run(status, lastError ?? null, id);
  }

  deleteProject(id: string): void {
    this.db.prepare('DELETE FROM projects WHERE id = ?').run(id);
  }

  // ── ports ──────────────────────────────────────────────────────────────────

  portFor(projectId: string): number | undefined {
    const row = this.db.prepare('SELECT host_port FROM ports WHERE project_id = ?').get(projectId) as
      | { host_port: number }
      | undefined;
    return row?.host_port;
  }

  takenPorts(): Set<number> {
    const rows = this.db.prepare('SELECT host_port FROM ports').all() as { host_port: number }[];
    return new Set(rows.map((r) => r.host_port));
  }

  claimPort(projectId: string, port: number): void {
    this.db.prepare('DELETE FROM ports WHERE project_id = ?').run(projectId);
    this.db
      .prepare('INSERT OR REPLACE INTO ports (host_port, project_id, allocated_at) VALUES (?, ?, ?)')
      .run(port, projectId, Date.now());
    this.db.prepare('UPDATE projects SET host_port = ? WHERE id = ?').run(port, projectId);
  }

  releasePort(projectId: string): void {
    this.db.prepare('DELETE FROM ports WHERE project_id = ?').run(projectId);
  }

  // ── runs ───────────────────────────────────────────────────────────────────

  /**
   * Open a run. Returns the existing one when the idempotency key repeats,
   * which is how a double-fired webhook or a retried dispatch is prevented from
   * running the automation twice.
   */
  openRun(run: {
    id: string;
    projectId: string;
    workflowId?: string;
    triggeredBy?: string;
    idempotencyKey?: string;
    inputs?: unknown;
  }): { run: RunRow; deduped: boolean } {
    if (run.idempotencyKey) {
      const existing = this.db
        .prepare('SELECT * FROM runs WHERE idempotency_key = ?')
        .get(run.idempotencyKey) as Record<string, unknown> | undefined;
      if (existing) return { run: toRun(existing), deduped: true };
    }
    this.db
      .prepare(
        `INSERT INTO runs (id, project_id, workflow_id, triggered_by, idempotency_key, status, started_at, inputs)
         VALUES (?, ?, ?, ?, ?, 'running', ?, ?)`,
      )
      .run(
        run.id, run.projectId, run.workflowId ?? null, run.triggeredBy ?? 'manual',
        run.idempotencyKey ?? null, Date.now(), json(run.inputs),
      );
    return { run: this.getRun(run.id)!, deduped: false };
  }

  getRun(id: string): RunRow | undefined {
    const row = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? toRun(row) : undefined;
  }

  listRuns(projectId: string, limit = 50): RunRow[] {
    const rows = this.db
      // rowid breaks ties: two runs started in the same millisecond would
      // otherwise come back in arbitrary order, which makes a run list appear
      // to shuffle itself between refreshes.
      .prepare('SELECT * FROM runs WHERE project_id = ? ORDER BY started_at DESC, rowid DESC LIMIT ?')
      .all(projectId, limit) as Record<string, unknown>[];
    return rows.map(toRun);
  }

  // ── RunStore surface, called by the control plane ──────────────────────────

  checkpointStep(cp: {
    runId: string;
    stepId: string;
    status: string;
    output?: unknown;
    error?: string | null;
    startedAt: number;
    endedAt?: number | null;
  }): void {
    this.db
      .prepare(
        `INSERT INTO run_steps (run_id, step_id, status, started_at, ended_at, output, error)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(run_id, step_id) DO UPDATE SET
           status=excluded.status, ended_at=excluded.ended_at,
           output=excluded.output, error=excluded.error`,
      )
      .run(
        cp.runId, cp.stepId, cp.status, cp.startedAt, cp.endedAt ?? null,
        json(cp.output), cp.error ?? null,
      );
  }

  completeRun(rc: { runId: string; status: string; outputs?: unknown; error?: string | null }): void {
    // Roll the run's token and cost totals up from its model calls, so the
    // number on the run row and the number in the ledger can never disagree.
    const totals = this.db
      .prepare(
        `SELECT COALESCE(SUM(prompt_tokens),0) p, COALESCE(SUM(completion_tokens),0) c,
                COALESCE(SUM(cost_micros),0) m FROM llm_calls WHERE run_id = ?`,
      )
      .get(rc.runId) as { p: number; c: number; m: number };

    this.db
      .prepare(
        `UPDATE runs SET status=?, outputs=?, error=?, ended_at=?,
                         prompt_tokens=?, completion_tokens=?, cost_micros=?
         WHERE id = ?`,
      )
      .run(
        rc.status, json(rc.outputs), rc.error ?? null, Date.now(),
        totals.p, totals.c, totals.m, rc.runId,
      );
  }

  recordLlmCall(rec: {
    runId?: string;
    agentId?: string;
    provider: string;
    model: string;
    promptTokens: number;
    completionTokens: number;
    costMicros: number;
    latencyMs: number;
    at: number;
  }): void {
    this.db
      .prepare(
        `INSERT INTO llm_calls (id, run_id, agent_id, provider, model, prompt_tokens,
                                completion_tokens, cost_micros, latency_ms, at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(), rec.runId ?? null, rec.agentId ?? null, rec.provider, rec.model,
        rec.promptTokens, rec.completionTokens, rec.costMicros, rec.latencyMs, rec.at,
      );
  }

  getSteps(runId: string): StepRow[] {
    const rows = this.db
      .prepare('SELECT * FROM run_steps WHERE run_id = ? ORDER BY started_at')
      .all(runId) as Record<string, unknown>[];
    return rows.map((r) => ({
      runId: String(r.run_id),
      stepId: String(r.step_id),
      status: String(r.status),
      startedAt: Number(r.started_at),
      endedAt: r.ended_at === null ? null : Number(r.ended_at),
      output: parse(r.output),
      error: r.error === null ? null : String(r.error),
    }));
  }

  getLlmCalls(runId: string) {
    const rows = this.db
      .prepare('SELECT * FROM llm_calls WHERE run_id = ? ORDER BY at')
      .all(runId) as Record<string, unknown>[];
    return rows.map((r) => ({
      runId,
      agentId: r.agent_id === null ? undefined : String(r.agent_id),
      provider: String(r.provider),
      model: String(r.model),
      promptTokens: Number(r.prompt_tokens),
      completionTokens: Number(r.completion_tokens),
      costMicros: Number(r.cost_micros),
      latencyMs: Number(r.latency_ms),
      at: Number(r.at),
    }));
  }

  /** Spend over a window, for the "what is this costing me" panel. */
  spendSince(projectId: string, since: number): { costMicros: number; calls: number } {
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(l.cost_micros),0) m, COUNT(*) n
         FROM llm_calls l JOIN runs r ON r.id = l.run_id
         WHERE r.project_id = ? AND l.at >= ?`,
      )
      .get(projectId, since) as { m: number; n: number };
    return { costMicros: row.m, calls: row.n };
  }

  // ── vault storage ──────────────────────────────────────────────────────────

  /**
   * Ciphertext only. The Store never sees a plaintext secret and has no way to
   * decrypt one — that lives entirely in @claritty-studio/vault, so a bug here
   * cannot turn into a disclosure.
   */
  putSecret(key: string, ciphertext: Buffer, last4: string): void {
    const parts = key.split(':');
    this.db
      .prepare(
        `INSERT INTO secrets (id, scope, project_id, kind, provider_id, field, ciphertext, last4, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET ciphertext=excluded.ciphertext, last4=excluded.last4, updated_at=excluded.updated_at`,
      )
      .run(
        key, parts[1] ?? '*', parts[1] === '*' ? null : (parts[1] ?? null), parts[0] ?? '',
        parts[2] ?? '', parts.slice(3).join(':'), ciphertext, last4, Date.now(), Date.now(),
      );
  }

  getSecret(key: string): Buffer | undefined {
    const row = this.db.prepare('SELECT ciphertext FROM secrets WHERE id = ?').get(key) as
      | { ciphertext: Uint8Array }
      | undefined;
    return row ? Buffer.from(row.ciphertext) : undefined;
  }

  removeSecret(key: string): void {
    this.db.prepare('DELETE FROM secrets WHERE id = ?').run(key);
  }

  listSecrets(): Array<{ key: string; last4: string; createdAt: number; updatedAt: number }> {
    const rows = this.db
      .prepare('SELECT id, last4, created_at, updated_at FROM secrets ORDER BY id')
      .all() as Record<string, unknown>[];
    return rows.map((r) => ({
      key: String(r.id),
      last4: String(r.last4 ?? ''),
      createdAt: Number(r.created_at),
      updatedAt: Number(r.updated_at),
    }));
  }

  // ── settings ───────────────────────────────────────────────────────────────

  get<T>(key: string): T | undefined {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row ? (JSON.parse(row.value) as T) : undefined;
  }

  set(key: string, value: unknown): void {
    this.db
      .prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
      .run(key, JSON.stringify(value));
  }
}

function toProject(r: Record<string, unknown>): ProjectRow {
  return {
    id: String(r.id),
    name: String(r.name),
    slug: String(r.slug),
    path: String(r.path),
    manifestPath: r.manifest_path === null ? null : String(r.manifest_path),
    hostPort: r.host_port === null ? null : Number(r.host_port),
    runtime: (r.runtime === 'native' ? 'native' : 'docker') as 'docker' | 'native',
    status: String(r.status),
    lastError: r.last_error === null ? null : String(r.last_error),
    createdAt: Number(r.created_at),
  };
}

function toRun(r: Record<string, unknown>): RunRow {
  return {
    id: String(r.id),
    projectId: String(r.project_id),
    workflowId: r.workflow_id === null ? null : String(r.workflow_id),
    triggeredBy: String(r.triggered_by),
    status: String(r.status),
    startedAt: Number(r.started_at),
    endedAt: r.ended_at === null ? null : Number(r.ended_at),
    outputs: parse(r.outputs),
    error: r.error === null ? null : String(r.error),
    promptTokens: Number(r.prompt_tokens),
    completionTokens: Number(r.completion_tokens),
    costMicros: Number(r.cost_micros),
  };
}

function json(v: unknown): string | null {
  return v === undefined ? null : JSON.stringify(v);
}

function parse(v: unknown): unknown {
  if (v === null || v === undefined) return undefined;
  try {
    return JSON.parse(String(v));
  } catch {
    return String(v);
  }
}
