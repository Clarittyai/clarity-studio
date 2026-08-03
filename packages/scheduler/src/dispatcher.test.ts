import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Store } from '@claritty-studio/db';

import { Dispatcher, countMissedWindows, MISSED_THRESHOLD_MS } from './dispatcher.js';
import type { Schedule } from './schedule.js';

const DAILY_9: Schedule = { mode: 'DAILY', time: '09:00', timezone: 'UTC' };

let store: Store;
let fetchMock: ReturnType<typeof vi.fn>;

function seedProject(id = 'p1') {
  store.upsertProject({ id, name: 'A', slug: id, path: `/tmp/${id}`, runtime: 'native', status: 'running' });
}

function seedInstance(opts: { dueAt: number; policy?: 'skip' | 'run-once' } = { dueAt: 0 }) {
  return store.triggers.add({
    projectId: 'p1',
    recipeTriggerId: 'every-morning',
    workflowId: 'daily-digest',
    type: 'SCHEDULE',
    enabled: true,
    schedule: DAILY_9,
    timezone: 'UTC',
    nextRunAt: opts.dueAt,
    missedPolicy: opts.policy ?? 'skip',
  });
}

function dispatcher(now: number) {
  return new Dispatcher({
    store,
    now: () => now,
    resolveTarget: () => ({ baseUrl: 'http://127.0.0.1:33001', internalSecret: 'secret' }),
  });
}

function okResponse() {
  return {
    ok: true,
    status: 200,
    json: async () => ({ executed: 1, results: [{ success: true, status: 'success' }] }),
  };
}

beforeEach(() => {
  store = new Store(':memory:');
  seedProject();
  fetchMock = vi.fn().mockResolvedValue(okResponse());
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  store.close();
});

describe('firing', () => {
  it('calls the automation with the dispatch envelope it expects', async () => {
    const now = Date.parse('2026-06-15T09:00:01Z');
    const instance = seedInstance({ dueAt: Date.parse('2026-06-15T09:00:00Z') });

    const results = await dispatcher(now).tick();

    expect(results[0]!.fired).toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://127.0.0.1:33001/internal/run-due-triggers');
    expect((init as RequestInit).headers).toMatchObject({ 'X-Claritty-Internal': 'secret' });

    const body = JSON.parse(String((init as RequestInit).body));
    expect(body.instances[0]).toMatchObject({
      instanceId: instance.id,
      recipeTriggerId: 'every-morning',
      workflowId: 'daily-digest',
    });
    // Without a workflowRunId the engine runs without checkpointing, and the
    // run would have no timeline at all.
    expect(body.instances[0].workflowRunId).toBeTruthy();
  });

  it('records the run and moves the instance on to tomorrow', async () => {
    const now = Date.parse('2026-06-15T09:00:01Z');
    const instance = seedInstance({ dueAt: Date.parse('2026-06-15T09:00:00Z') });

    await dispatcher(now).tick();

    const after = store.triggers.get(instance.id)!;
    expect(after.lastStatus).toBe('success');
    expect(new Date(after.nextRunAt!).toISOString()).toBe('2026-06-16T09:00:00.000Z');
    expect(store.listRuns('p1')).toHaveLength(1);
  });

  it('does not fire the same window twice when two ticks race', async () => {
    const due = Date.parse('2026-06-15T09:00:00Z');
    const now = due + 1000;
    seedInstance({ dueAt: due });

    const d = dispatcher(now);
    await d.tick();
    // Force the instance back to due, as a crash-and-restart would.
    store.triggers.setNextRun(store.triggers.list()[0]!.id, due);
    const second = await d.tick();

    expect(second[0]!.skipped).toBe('deduped');
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(store.listRuns('p1')).toHaveLength(1);
  });
});

describe('when things go wrong', () => {
  it('records the failure and still schedules the next run', async () => {
    fetchMock.mockRejectedValue(new Error('connection refused'));
    const now = Date.parse('2026-06-15T09:00:01Z');
    const instance = seedInstance({ dueAt: Date.parse('2026-06-15T09:00:00Z') });

    const results = await dispatcher(now).tick();

    expect(results[0]!.error).toContain('connection refused');
    const after = store.triggers.get(instance.id)!;
    // The important part: a failed fire must not leave the instance stuck due,
    // retrying every 15 seconds forever.
    expect(after.nextRunAt).toBeGreaterThan(now);
    expect(after.lastStatus).toBe('failed');
    // And the run must not sit at "running" for eternity.
    expect(store.getRun(results[0]!.runId!)!.status).toBe('failed');
  });

  it('skips instances whose automation is not running, without burning the window', async () => {
    const now = Date.parse('2026-06-15T09:00:01Z');
    seedInstance({ dueAt: Date.parse('2026-06-15T09:00:00Z') });
    const d = new Dispatcher({ store, now: () => now, resolveTarget: () => undefined });

    const results = await d.tick();

    expect(results[0]!.skipped).toBe('no-target');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(store.listRuns('p1')).toHaveLength(0);
  });

  it('reports a non-2xx as a failure rather than a silent success', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
    const now = Date.parse('2026-06-15T09:00:01Z');
    const instance = seedInstance({ dueAt: Date.parse('2026-06-15T09:00:00Z') });

    await dispatcher(now).tick();

    expect(store.triggers.get(instance.id)!.lastStatus).toBe('failed');
    expect(store.triggers.deliveries(instance.id)[0]!.success).toBe(false);
  });
});

describe('missed windows — the laptop-was-asleep case', () => {
  it('counts them and does not run, by default', async () => {
    // Due yesterday morning; the machine has only just woken up.
    const due = Date.parse('2026-06-14T09:00:00Z');
    const now = Date.parse('2026-06-16T11:00:00Z');
    const instance = seedInstance({ dueAt: due });

    const results = await dispatcher(now).tick();

    expect(results[0]!.skipped).toBe('missed-window');
    expect(fetchMock).not.toHaveBeenCalled();
    // Counted, not swallowed: this is what lets the UI say "2 runs missed"
    // rather than showing nothing at all.
    expect(store.triggers.get(instance.id)!.missedCount).toBe(2);
    expect(store.triggers.get(instance.id)!.nextRunAt).toBeGreaterThan(now);
  });

  it('runs once when the user asked for that instead', async () => {
    const due = Date.parse('2026-06-14T09:00:00Z');
    const now = Date.parse('2026-06-16T11:00:00Z');
    seedInstance({ dueAt: due, policy: 'run-once' });

    const results = await dispatcher(now).tick();

    expect(results[0]!.fired).toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('treats a slightly late tick as on time, not as missed', async () => {
    const due = Date.parse('2026-06-15T09:00:00Z');
    const now = due + MISSED_THRESHOLD_MS - 1;
    seedInstance({ dueAt: due });

    const results = await dispatcher(now).tick();

    expect(results[0]!.fired).toBe(true);
  });
});

describe('selection', () => {
  it('leaves disabled instances alone', async () => {
    const instance = seedInstance({ dueAt: Date.parse('2026-06-15T09:00:00Z') });
    store.triggers.setEnabled(instance.id, false);

    const results = await dispatcher(Date.parse('2026-06-15T09:00:01Z')).tick();

    expect(results).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('leaves instances that are not yet due alone', async () => {
    seedInstance({ dueAt: Date.parse('2026-06-15T09:00:00Z') });
    const results = await dispatcher(Date.parse('2026-06-15T08:59:00Z')).tick();
    expect(results).toHaveLength(0);
  });

  it('gives an unprimed instance a next-fire time on start', () => {
    const instance = store.triggers.add({
      projectId: 'p1', recipeTriggerId: 't', workflowId: 'w', type: 'SCHEDULE',
      enabled: true, schedule: DAILY_9, missedPolicy: 'skip', nextRunAt: null,
    });
    dispatcher(Date.parse('2026-06-15T08:00:00Z')).primeAll();
    expect(store.triggers.get(instance.id)!.nextRunAt).toBe(Date.parse('2026-06-15T09:00:00Z'));
  });
});

describe('counting missed windows', () => {
  it('counts each window between the due time and now', () => {
    expect(
      countMissedWindows(DAILY_9, Date.parse('2026-06-10T09:00:00Z'), Date.parse('2026-06-14T10:00:00Z')),
    ).toBe(4);
  });

  it('caps rather than walking a year of minutes', () => {
    const everyMinute: Schedule = { mode: 'INTERVAL', everyMinutes: 1 };
    const count = countMissedWindows(
      everyMinute, Date.parse('2026-01-01T00:00:00Z'), Date.parse('2026-06-01T00:00:00Z'),
    );
    expect(count).toBe(100);
  });
});
