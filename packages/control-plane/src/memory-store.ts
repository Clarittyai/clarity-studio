/**
 * In-memory {@link RunStore}. Used by the CLI spike and by tests; the desktop
 * app swaps in the SQLite-backed one with the same interface.
 */

import type { LlmCallRecord, RunCompletion, RunStore, StepCheckpoint } from './types.js';

export class MemoryRunStore implements RunStore {
  private steps = new Map<string, StepCheckpoint[]>();
  private runs = new Map<string, { status: string; outputs?: unknown; error?: string | null }>();
  private calls = new Map<string, LlmCallRecord[]>();

  checkpointStep(cp: StepCheckpoint): void {
    const list = this.steps.get(cp.runId) ?? [];
    // A step checkpoints more than once — running, then terminal. Replace in
    // place so the timeline shows one row per step, not a duplicate per state.
    const idx = list.findIndex((s) => s.stepId === cp.stepId);
    if (idx >= 0) list[idx] = { ...list[idx], ...cp };
    else list.push(cp);
    this.steps.set(cp.runId, list);
  }

  completeRun(rc: RunCompletion): void {
    this.runs.set(rc.runId, { status: rc.status, outputs: rc.outputs, error: rc.error ?? null });
  }

  recordLlmCall(rec: LlmCallRecord): void {
    const key = rec.runId ?? '<none>';
    const list = this.calls.get(key) ?? [];
    list.push(rec);
    this.calls.set(key, list);
  }

  getRun(runId: string) {
    return this.runs.get(runId);
  }

  getSteps(runId: string): StepCheckpoint[] {
    return [...(this.steps.get(runId) ?? [])].sort((a, b) => a.startedAt - b.startedAt);
  }

  getLlmCalls(runId: string): LlmCallRecord[] {
    return [...(this.calls.get(runId) ?? [])];
  }

  /** Every run id seen, newest first. */
  runIds(): string[] {
    return [...new Set([...this.steps.keys(), ...this.runs.keys()])];
  }
}
