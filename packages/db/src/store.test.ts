import { describe, expect, it } from 'vitest';

import { Store } from './store.js';

function db() {
  return new Store(':memory:');
}

function project(s: Store, id = 'p1') {
  return s.upsertProject({
    id,
    name: 'My Automation',
    slug: id,
    path: `/tmp/${id}`,
    runtime: 'docker',
    status: 'stopped',
  });
}

describe('projects', () => {
  it('round-trips and updates in place', () => {
    const s = db();
    project(s);
    s.upsertProject({ id: 'p1', name: 'Renamed', slug: 'p1', path: '/tmp/p1', runtime: 'native', status: 'running' });
    const p = s.getProject('p1')!;
    expect(p.name).toBe('Renamed');
    expect(p.runtime).toBe('native');
    expect(s.listProjects()).toHaveLength(1);
  });
});

describe('ports', () => {
  it('keeps at most one port per project', () => {
    const s = db();
    project(s);
    s.claimPort('p1', 33001);
    s.claimPort('p1', 33002);
    expect(s.portFor('p1')).toBe(33002);
    expect([...s.takenPorts()]).toEqual([33002]);
    expect(s.getProject('p1')!.hostPort).toBe(33002);
  });
});

describe('run idempotency', () => {
  it('returns the existing run instead of starting a second one', () => {
    const s = db();
    project(s);
    const key = 'every-morning:2026-08-03T09:00:00Z';
    const first = s.openRun({ id: 'r1', projectId: 'p1', workflowId: 'w', idempotencyKey: key });
    const second = s.openRun({ id: 'r2', projectId: 'p1', workflowId: 'w', idempotencyKey: key });

    // The SDK's own idempotency lookup is a permanent stub, so this table is
    // the only thing standing between a double-fired webhook and a duplicate
    // outbound email.
    expect(first.deduped).toBe(false);
    expect(second.deduped).toBe(true);
    expect(second.run.id).toBe('r1');
    expect(s.listRuns('p1')).toHaveLength(1);
  });

  it('does not dedupe manual runs, which have no key', () => {
    const s = db();
    project(s);
    s.openRun({ id: 'r1', projectId: 'p1' });
    s.openRun({ id: 'r2', projectId: 'p1' });
    expect(s.listRuns('p1')).toHaveLength(2);
  });
});

describe('steps and cost', () => {
  it('updates a step in place across its checkpoints', () => {
    const s = db();
    project(s);
    s.openRun({ id: 'r1', projectId: 'p1' });
    s.checkpointStep({ runId: 'r1', stepId: 'write', status: 'running', startedAt: 1000 });
    s.checkpointStep({
      runId: 'r1', stepId: 'write', status: 'success', startedAt: 1000, endedAt: 1400,
      output: { digest_id: 'dg_1' },
    });
    const steps = s.getSteps('r1');
    expect(steps).toHaveLength(1);
    expect(steps[0]!.status).toBe('success');
    expect(steps[0]!.output).toEqual({ digest_id: 'dg_1' });
  });

  it('rolls run totals up from the model-call ledger on completion', () => {
    const s = db();
    project(s);
    s.openRun({ id: 'r1', projectId: 'p1' });
    s.recordLlmCall({ runId: 'r1', provider: 'anthropic', model: 'claude-sonnet-4', promptTokens: 1000, completionTokens: 200, costMicros: 6000, latencyMs: 900, at: Date.now() });
    s.recordLlmCall({ runId: 'r1', provider: 'anthropic', model: 'claude-sonnet-4', promptTokens: 500, completionTokens: 100, costMicros: 3000, latencyMs: 700, at: Date.now() });
    s.completeRun({ runId: 'r1', status: 'success', outputs: { ok: true } });

    const run = s.getRun('r1')!;
    // Derived, never accumulated separately — the run row and the ledger
    // cannot drift apart if only one of them is ever written by hand.
    expect(run.promptTokens).toBe(1500);
    expect(run.completionTokens).toBe(300);
    expect(run.costMicros).toBe(9000);
    expect(run.status).toBe('success');
    expect(run.outputs).toEqual({ ok: true });
  });

  it('reports spend over a window', () => {
    const s = db();
    project(s);
    s.openRun({ id: 'r1', projectId: 'p1' });
    s.recordLlmCall({ runId: 'r1', provider: 'openai', model: 'gpt-4o', promptTokens: 10, completionTokens: 5, costMicros: 1234, latencyMs: 1, at: 5_000 });
    s.recordLlmCall({ runId: 'r1', provider: 'openai', model: 'gpt-4o', promptTokens: 10, completionTokens: 5, costMicros: 1000, latencyMs: 1, at: 500 });
    expect(s.spendSince('p1', 1_000)).toEqual({ costMicros: 1234, calls: 1 });
  });
});

describe('cascade', () => {
  it('takes runs and steps with the project when it is deleted', () => {
    const s = db();
    project(s);
    s.openRun({ id: 'r1', projectId: 'p1' });
    s.checkpointStep({ runId: 'r1', stepId: 'a', status: 'success', startedAt: 1 });
    s.claimPort('p1', 33001);

    s.deleteProject('p1');

    expect(s.getRun('r1')).toBeUndefined();
    expect(s.getSteps('r1')).toHaveLength(0);
    expect(s.takenPorts().size).toBe(0);
  });
});
