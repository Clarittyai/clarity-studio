/**
 * Trigger instances and their delivery history.
 *
 * A *recipe* is what the automation declares it supports (in `app-config.json`
 * and `intelligence.yaml`). An *instance* is the user saying "yes, that one,
 * at 9am, in my timezone". Recipes live in the repo; instances live here,
 * because they are a property of this machine and this person.
 */

import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import { randomUUID } from 'node:crypto';

export type MissedPolicy = 'skip' | 'run-once' | 'catch-up';

export interface TriggerInstanceRow {
  id: string;
  projectId: string;
  recipeTriggerId: string;
  workflowId?: string | null;
  type: string;
  enabled: boolean;
  schedule?: unknown;
  config?: Record<string, unknown>;
  timezone?: string | null;
  nextRunAt?: number | null;
  lastRunAt?: number | null;
  lastStatus?: string | null;
  lastError?: string | null;
  missedCount: number;
  missedPolicy: MissedPolicy;
}

export interface DeliveryRow {
  id: string;
  instanceId: string;
  startedAt: number;
  endedAt?: number | null;
  success?: boolean | null;
  httpStatus?: number | null;
  error?: string | null;
  runId?: string | null;
  requestHeaders?: Record<string, string>;
  requestBody?: unknown;
}

export class TriggerStore {
  constructor(private readonly db: DatabaseSyncType) {}

  add(instance: Omit<TriggerInstanceRow, 'id' | 'missedCount'> & { id?: string }): TriggerInstanceRow {
    const id = instance.id ?? randomUUID();
    this.db
      .prepare(
        `INSERT INTO trigger_instances
           (id, project_id, recipe_trigger_id, workflow_id, type, enabled, schedule,
            config, timezone, next_run_at, missed_policy)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id, instance.projectId, instance.recipeTriggerId, instance.workflowId ?? null,
        instance.type, instance.enabled ? 1 : 0, json(instance.schedule), json(instance.config),
        instance.timezone ?? null, instance.nextRunAt ?? null, instance.missedPolicy ?? 'skip',
      );
    return this.get(id)!;
  }

  get(id: string): TriggerInstanceRow | undefined {
    const row = this.db.prepare('SELECT * FROM trigger_instances WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? toInstance(row) : undefined;
  }

  list(projectId?: string): TriggerInstanceRow[] {
    const rows = (
      projectId
        ? this.db.prepare('SELECT * FROM trigger_instances WHERE project_id = ?').all(projectId)
        : this.db.prepare('SELECT * FROM trigger_instances').all()
    ) as Record<string, unknown>[];
    return rows.map(toInstance);
  }

  /**
   * Instances whose next fire has arrived.
   *
   * Disabled instances are excluded here rather than filtered later, so a
   * paused automation cannot fire through a bug in the caller.
   */
  due(now: number): TriggerInstanceRow[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM trigger_instances
         WHERE enabled = 1 AND type = 'SCHEDULE'
           AND next_run_at IS NOT NULL AND next_run_at <= ?
         ORDER BY next_run_at`,
      )
      .all(now) as Record<string, unknown>[];
    return rows.map(toInstance);
  }

  setNextRun(id: string, nextRunAt: number | null): void {
    this.db.prepare('UPDATE trigger_instances SET next_run_at = ? WHERE id = ?').run(nextRunAt, id);
  }

  recordRun(id: string, at: number, status: string, error?: string | null): void {
    this.db
      .prepare('UPDATE trigger_instances SET last_run_at = ?, last_status = ?, last_error = ? WHERE id = ?')
      .run(at, status, error ?? null, id);
  }

  countMissed(id: string, n: number): void {
    this.db
      .prepare('UPDATE trigger_instances SET missed_count = missed_count + ? WHERE id = ?')
      .run(n, id);
  }

  setEnabled(id: string, enabled: boolean): void {
    this.db.prepare('UPDATE trigger_instances SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id);
  }

  remove(id: string): void {
    this.db.prepare('DELETE FROM trigger_instances WHERE id = ?').run(id);
  }

  // ── deliveries ─────────────────────────────────────────────────────────────

  /**
   * Record an inbound delivery, whole.
   *
   * Headers and body are kept verbatim so the delivery can be replayed later.
   * A webhook you cannot replay is a webhook you debug by asking the sender to
   * please do it again, which is not always possible and never pleasant.
   */
  startDelivery(d: {
    instanceId: string;
    requestHeaders?: Record<string, string>;
    requestBody?: unknown;
  }): string {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO trigger_executions (id, instance_id, started_at, request_headers, request_body)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(id, d.instanceId, Date.now(), json(d.requestHeaders), json(d.requestBody));
    return id;
  }

  finishDelivery(
    id: string,
    outcome: { success: boolean; httpStatus?: number; error?: string | null; runId?: string | null },
  ): void {
    this.db
      .prepare(
        `UPDATE trigger_executions
         SET ended_at = ?, success = ?, http_status = ?, error = ?, run_id = ?
         WHERE id = ?`,
      )
      .run(
        Date.now(), outcome.success ? 1 : 0, outcome.httpStatus ?? null,
        outcome.error ?? null, outcome.runId ?? null, id,
      );
  }

  deliveries(instanceId: string, limit = 50): DeliveryRow[] {
    const rows = this.db
      .prepare('SELECT * FROM trigger_executions WHERE instance_id = ? ORDER BY started_at DESC, rowid DESC LIMIT ?')
      .all(instanceId, limit) as Record<string, unknown>[];
    return rows.map(toDelivery);
  }

  recentDeliveries(limit = 50): DeliveryRow[] {
    const rows = this.db
      .prepare('SELECT * FROM trigger_executions ORDER BY started_at DESC, rowid DESC LIMIT ?')
      .all(limit) as Record<string, unknown>[];
    return rows.map(toDelivery);
  }

  delivery(id: string): DeliveryRow | undefined {
    const row = this.db.prepare('SELECT * FROM trigger_executions WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? toDelivery(row) : undefined;
  }
}

function toInstance(r: Record<string, unknown>): TriggerInstanceRow {
  return {
    id: String(r.id),
    projectId: String(r.project_id),
    recipeTriggerId: String(r.recipe_trigger_id),
    workflowId: r.workflow_id === null ? null : String(r.workflow_id),
    type: String(r.type),
    enabled: Number(r.enabled) === 1,
    schedule: parse(r.schedule),
    config: parse(r.config) as Record<string, unknown> | undefined,
    timezone: r.timezone === null ? null : String(r.timezone),
    nextRunAt: r.next_run_at === null ? null : Number(r.next_run_at),
    lastRunAt: r.last_run_at === null ? null : Number(r.last_run_at),
    lastStatus: r.last_status === null ? null : String(r.last_status),
    lastError: r.last_error === null ? null : String(r.last_error),
    missedCount: Number(r.missed_count ?? 0),
    missedPolicy: (String(r.missed_policy ?? 'skip') as MissedPolicy),
  };
}

function toDelivery(r: Record<string, unknown>): DeliveryRow {
  return {
    id: String(r.id),
    instanceId: String(r.instance_id),
    startedAt: Number(r.started_at),
    endedAt: r.ended_at === null ? null : Number(r.ended_at),
    success: r.success === null ? null : Number(r.success) === 1,
    httpStatus: r.http_status === null ? null : Number(r.http_status),
    error: r.error === null ? null : String(r.error),
    runId: r.run_id === null ? null : String(r.run_id),
    requestHeaders: parse(r.request_headers) as Record<string, string> | undefined,
    requestBody: parse(r.request_body),
  };
}

function json(v: unknown): string | null {
  return v === undefined || v === null ? null : JSON.stringify(v);
}

function parse(v: unknown): unknown {
  if (v === null || v === undefined) return undefined;
  try {
    return JSON.parse(String(v));
  } catch {
    return String(v);
  }
}
