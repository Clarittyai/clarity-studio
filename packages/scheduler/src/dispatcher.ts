/**
 * The tick.
 *
 * Every 15 seconds: find the instances that are due, tell their automation to
 * run them, write down what happened, and work out when each fires next.
 *
 * The design decisions worth knowing:
 *
 * - **Dedupe here, not in the automation.** The SDK's own idempotency lookup is
 *   a permanent stub that always returns "no cached run", so the only thing
 *   standing between a retried dispatch and a duplicate outbound email is the
 *   unique index on `runs.idempotency_key`. The key is derived from the trigger
 *   and its scheduled instant, so the same window can only ever run once.
 *
 * - **Missed windows are recorded, not swallowed.** A laptop sleeps. When it
 *   wakes, an automation that should have run at 09:00 has a decision to make,
 *   and the honest thing is to let the user decide it in advance rather than
 *   guess. Default is `skip`: do not run, but count it, so the UI can say
 *   "3 runs missed while your machine was asleep" instead of nothing.
 *
 * - **One failure never stops the tick.** Instances are fired independently and
 *   errors are recorded per instance. A crashed automation must not take the
 *   scheduler down with it.
 */

import type { Store, TriggerInstanceRow } from '@clarity-studio/db';

import { nextRunAt, type Schedule } from './schedule.js';

export const DEFAULT_TICK_MS = 15_000;

/**
 * How stale a due instance has to be before it counts as "missed" rather than
 * "we are a few seconds behind". Two ticks of slack: a tick that lands slightly
 * late is normal, an hour late means the machine was asleep.
 */
export const MISSED_THRESHOLD_MS = 2 * DEFAULT_TICK_MS;

export interface DispatchTarget {
  /** Where the automation is listening, e.g. http://127.0.0.1:33001 */
  baseUrl: string;
  /** The project's CLARITY_INTERNAL_SECRET. */
  internalSecret: string;
}

export interface DispatchResult {
  instanceId: string;
  fired: boolean;
  skipped?: 'missed-window' | 'no-target' | 'deduped';
  runId?: string;
  error?: string;
}

export interface DispatcherOptions {
  store: Store;
  /** Resolve where a project's automation is reachable, or undefined when it
   *  is not currently running. */
  resolveTarget: (projectId: string) => DispatchTarget | undefined;
  /**
   * Bring a project up before firing, when the host can.
   *
   * `resolveTarget` answers "where is it"; this answers "make it be there". In
   * a desktop app the automations are normally stopped — you open the window,
   * you do not leave every automation running — so without this every schedule
   * resolves to no target and skips, silently, forever. The CLI's `serve` has
   * exactly one automation and it is already up, so it passes nothing.
   *
   * Throwing here is reported as a failed dispatch rather than a skip: an
   * automation that cannot start at its scheduled time is the thing you most
   * need telling about, and "skipped" reads like a decision.
   */
  ensureRunning?: (projectId: string) => Promise<void>;
  /**
   * The REQUIRED services this project still has no credential for.
   *
   * Firing without them is not a cheaper version of firing — it is more
   * expensive than not firing at all. `client-summary` was run by hand with
   * Gmail unconnected and reached its agent anyway: two model calls, 2.3k
   * tokens, no possible answer, and a run that recorded success with every
   * output null. On a schedule that repeats every morning until somebody reads
   * the timeline closely enough to notice.
   *
   * Checked before `ensureRunning`, so a project that cannot work is not even
   * booted for it.
   */
  blockedBy?: (projectId: string) => Promise<string[]>;
  tickMs?: number;
  now?: () => number;
  onEvent?: (event: DispatchResult & { at: number }) => void;
}

export class Dispatcher {
  private timer?: NodeJS.Timeout;
  private ticking = false;
  private readonly now: () => number;

  constructor(private readonly opts: DispatcherOptions) {
    this.now = opts.now ?? (() => Date.now());
  }

  /** Give every enabled schedule a next-fire time, so a freshly started
   *  Studio doesn't sit idle waiting for instances that have none. */
  primeAll(): void {
    for (const instance of this.opts.store.triggers.list()) {
      if (!instance.enabled || instance.nextRunAt != null) continue;
      const schedule = instance.schedule as Schedule | undefined;
      if (!schedule) continue;
      this.opts.store.triggers.setNextRun(instance.id, nextRunAt(schedule, this.now()));
    }
  }

  start(): void {
    if (this.timer) return;
    this.primeAll();
    const period = this.opts.tickMs ?? DEFAULT_TICK_MS;
    this.timer = setInterval(() => {
      void this.tick();
    }, period);
    // Don't hold the process open just to keep ticking — the CLI's `serve`
    // command owns the lifetime, not this timer.
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Run one pass. Exposed so tests can drive it without waiting on wall time. */
  async tick(): Promise<DispatchResult[]> {
    // Overlap protection: a slow automation must not have two ticks firing the
    // same instance concurrently.
    if (this.ticking) return [];
    this.ticking = true;
    try {
      const now = this.now();
      const results: DispatchResult[] = [];
      for (const instance of this.opts.store.triggers.due(now)) {
        const result = await this.fire(instance, now);
        results.push(result);
        this.opts.onEvent?.({ ...result, at: now });
      }
      return results;
    } finally {
      this.ticking = false;
    }
  }

  private async fire(instance: TriggerInstanceRow, now: number): Promise<DispatchResult> {
    const { store } = this.opts;
    const schedule = instance.schedule as Schedule | undefined;
    const scheduledFor = instance.nextRunAt ?? now;
    const lateBy = now - scheduledFor;

    // Reschedule first, whatever happens below. If firing throws, the instance
    // must still have a future next_run_at — otherwise a single bad run leaves
    // it stuck, due forever, retrying every tick.
    const advance = () => {
      const next = schedule ? nextRunAt(schedule, now) : null;
      store.triggers.setNextRun(instance.id, next);
    };

    if (lateBy > MISSED_THRESHOLD_MS) {
      const missed = schedule ? countMissedWindows(schedule, scheduledFor, now) : 1;
      store.triggers.countMissed(instance.id, missed);
      if (instance.missedPolicy === 'skip') {
        advance();
        return { instanceId: instance.id, fired: false, skipped: 'missed-window' };
      }
      // 'run-once' and 'catch-up' both run now. Catching up properly — replaying
      // every missed window in order — is deferred rather than faked: for most
      // automations, running eight backdated digests at once is worse than
      // running one, so pretending otherwise would be a trap.
    }

    if (this.opts.blockedBy) {
      // FAIL OPEN when the check itself cannot answer. A vault that is briefly
      // unreadable must not silently stop a working automation from firing —
      // that would be a worse fault than the one this guards against, and a
      // quieter one.
      const missing = await this.opts.blockedBy(instance.projectId).catch(() => []);
      if (missing.length > 0) {
        // `failed`, not `skipped`, for the reason `ensureRunning` gives below:
        // an automation that cannot run at its scheduled time is the thing you
        // most need telling about, and "skipped" reads like a decision somebody
        // made on purpose.
        const message = `Did not run — ${missing.join(' and ')} ${
          missing.length === 1 ? 'is' : 'are'
        } not connected. Connect in Settings; running would have spent tokens and finished with nothing.`;
        store.triggers.recordRun(instance.id, now, 'failed', message);
        advance();
        return { instanceId: instance.id, fired: false, error: message };
      }
    }

    if (this.opts.ensureRunning) {
      try {
        await this.opts.ensureRunning(instance.projectId);
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        store.triggers.recordRun(instance.id, now, 'failed', message);
        advance();
        return { instanceId: instance.id, fired: false, error: message };
      }
    }

    const target = this.opts.resolveTarget(instance.projectId);
    if (!target) {
      advance();
      return { instanceId: instance.id, fired: false, skipped: 'no-target' };
    }

    // Derived from the scheduled instant, not from `now`: two ticks racing on
    // the same window produce the same key, and the unique index rejects the
    // second.
    const idempotencyKey = `${instance.id}:${new Date(scheduledFor).toISOString()}`;
    // Distinctive part first. A run id whose leading characters are identical
    // across every run of the same trigger is unreadable in any list that
    // truncates — which is every list.
    const stamp = new Date(scheduledFor).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
    const runId = `wfr_${instance.id.slice(0, 8)}_${stamp}`;

    const { deduped } = store.openRun({
      id: runId,
      projectId: instance.projectId,
      workflowId: instance.workflowId ?? undefined,
      triggeredBy: 'schedule',
      idempotencyKey,
    });
    if (deduped) {
      advance();
      return { instanceId: instance.id, fired: false, skipped: 'deduped', runId };
    }

    const deliveryId = store.triggers.startDelivery({ instanceId: instance.id });

    try {
      const res = await fetch(`${target.baseUrl}/internal/run-due-triggers`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'X-Claritty-Internal': target.internalSecret,
        },
        body: JSON.stringify({
          instances: [
            {
              instanceId: instance.id,
              recipeTriggerId: instance.recipeTriggerId,
              workflowId: instance.workflowId,
              config: instance.config ?? {},
              lastRunAt: instance.lastRunAt ? new Date(instance.lastRunAt).toISOString() : null,
              workflowRunId: runId,
              idempotencyKey,
            },
          ],
        }),
        signal: AbortSignal.timeout(10 * 60_000),
      });

      const body = (await res.json().catch(() => ({}))) as {
        results?: Array<{ success?: boolean; status?: string; error?: string }>;
      };
      const outcome = body.results?.[0];
      const success = res.ok && outcome?.success === true;

      store.triggers.finishDelivery(deliveryId, {
        success,
        httpStatus: res.status,
        error: success ? null : outcome?.error ?? `HTTP ${res.status}`,
        runId,
      });
      store.triggers.recordRun(
        instance.id, now,
        success ? 'success' : 'failed',
        success ? null : outcome?.error ?? `HTTP ${res.status}`,
      );

      advance();
      return {
        instanceId: instance.id,
        fired: true,
        runId,
        ...(success ? {} : { error: outcome?.error ?? `HTTP ${res.status}` }),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      store.triggers.finishDelivery(deliveryId, { success: false, error: message, runId });
      store.triggers.recordRun(instance.id, now, 'failed', message);
      // The run row would otherwise sit at "running" forever, and a timeline
      // that never resolves is worse than one that says it failed.
      store.completeRun({ runId, status: 'failed', error: message });
      advance();
      // runId is reported even though nothing ran: a run row exists and is now
      // marked failed, and without the id the caller cannot link the two.
      return { instanceId: instance.id, fired: false, runId, error: message };
    }
  }
}

/**
 * How many windows went by between a due time and now.
 *
 * Only used for the counter the UI shows, so it is capped: the difference
 * between 200 and 500 missed runs is not information anyone acts on, and
 * walking a year of minute-intervals to find out would cost more than it says.
 */
export function countMissedWindows(schedule: Schedule, from: number, until: number, cap = 100): number {
  let count = 0;
  let cursor = from;
  while (count < cap) {
    const next = nextRunAt(schedule, cursor);
    if (next === null || next > until) break;
    count++;
    cursor = next;
  }
  return Math.max(1, count);
}
