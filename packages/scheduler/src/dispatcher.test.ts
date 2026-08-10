import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Store } from '@clarity-studio/db';

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

describe('bringing a stopped automation up', () => {
  it('starts it, then fires', async () => {
    // The desktop case: automations are normally stopped. Without this the
    // schedule resolves to no target and skips, silently, every time.
    const now = Date.parse('2026-06-15T09:00:01Z');
    seedInstance({ dueAt: Date.parse('2026-06-15T09:00:00Z') });
    const started: string[] = [];
    let up = false;

    const results = await new Dispatcher({
      store,
      now: () => now,
      ensureRunning: async (projectId) => {
        started.push(projectId);
        up = true;
      },
      resolveTarget: () => (up ? { baseUrl: 'http://127.0.0.1:33001', internalSecret: 's' } : undefined),
    }).tick();

    expect(started).toEqual(['p1']);
    expect(results[0]!.fired).toBe(true);
  });

  it('reports a failure to start rather than calling it a skip', async () => {
    // "skipped" reads like a decision. An automation that could not start at
    // its scheduled time is the thing you most need telling about.
    const now = Date.parse('2026-06-15T09:00:01Z');
    const instance = seedInstance({ dueAt: Date.parse('2026-06-15T09:00:00Z') });

    const results = await new Dispatcher({
      store,
      now: () => now,
      ensureRunning: async () => {
        throw new Error('Docker is not running');
      },
      resolveTarget: () => undefined,
    }).tick();

    expect(results[0]!.fired).toBe(false);
    expect(results[0]!.skipped).toBeUndefined();
    expect(results[0]!.error).toMatch(/Docker is not running/);
    expect(fetchMock).not.toHaveBeenCalled();
    // And it must still be rescheduled, or one bad morning leaves it due
    // forever, retrying every tick.
    expect(store.triggers.list('p1')[0]!.nextRunAt).toBeGreaterThan(now);
    expect(store.triggers.list('p1')[0]!.lastStatus).toBe('failed');
  });
});

describe('a schedule whose services are not connected', () => {
  /** A dispatcher that also knows which required services are missing. */
  function gated(now: number, missing: string[], ensureRunning?: () => Promise<void>) {
    return new Dispatcher({
      store,
      now: () => now,
      resolveTarget: () => ({ baseUrl: 'http://127.0.0.1:33001', internalSecret: 'secret' }),
      ensureRunning,
      blockedBy: async () => missing,
    });
  }

  it('does not fire, and says which service and what to do', async () => {
    // The whole point. Firing is not a cheaper version of not firing: the run
    // reaches its agent, spends its tokens, cannot do the job, and records
    // success with every output null — every morning, until somebody reads the
    // timeline closely enough to notice.
    seedInstance({ dueAt: 1_000 });
    const results = await gated(1_000, ['gmail']).tick();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(results[0]!.fired).toBe(false);
    expect(results[0]!.error).toMatch(/gmail is not connected/i);
    expect(results[0]!.error).toMatch(/Settings/);
  });

  it('records it as FAILED, because it is not a decision anybody made', async () => {
    // "Skipped" reads like policy. An automation that could not run at its
    // scheduled time is the thing you most need telling about — the same
    // reasoning `ensureRunning` already uses one branch below.
    const instance = seedInstance({ dueAt: 1_000 });
    await gated(1_000, ['gmail']).tick();

    const after = store.triggers.get(instance.id)!;
    expect(after.lastStatus).toBe('failed');
    expect(after.lastError).toMatch(/not connected/i);
  });

  it('still reschedules, so one missing credential does not wedge it forever', async () => {
    // A due instance left with no future next_run_at retries every tick for
    // ever. Connecting the service later has to be enough to fix it.
    const instance = seedInstance({ dueAt: 1_000 });
    await gated(1_000, ['gmail']).tick();

    expect(store.triggers.get(instance.id)!.nextRunAt).toBeGreaterThan(1_000);
  });

  it('does not even boot the project for a run that cannot work', async () => {
    const ensureRunning = vi.fn().mockResolvedValue(undefined);
    seedInstance({ dueAt: 1_000 });
    await gated(1_000, ['gmail'], ensureRunning).tick();

    expect(ensureRunning).not.toHaveBeenCalled();
  });

  it('names every missing service, not just the first', async () => {
    seedInstance({ dueAt: 1_000 });
    const results = await gated(1_000, ['gmail', 'slack']).tick();
    expect(results[0]!.error).toMatch(/gmail and slack are not connected/i);
  });

  it('fires normally when nothing is missing', async () => {
    seedInstance({ dueAt: 1_000 });
    const results = await gated(1_000, []).tick();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(results[0]!.fired).toBe(true);
  });

  it('FAILS OPEN when the check itself cannot answer', async () => {
    // A briefly unreadable vault must not silently stop a working automation.
    // That would be a worse fault than the one this guards against, and a
    // quieter one — nothing would run and nothing would say why.
    seedInstance({ dueAt: 1_000 });
    const dispatcher = new Dispatcher({
      store,
      now: () => 1_000,
      resolveTarget: () => ({ baseUrl: 'http://127.0.0.1:33001', internalSecret: 'secret' }),
      blockedBy: async () => {
        throw new Error('vault locked');
      },
    });

    const results = await dispatcher.tick();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(results[0]!.fired).toBe(true);
  });

  it('is absent by default, so a host that does not check is unaffected', async () => {
    seedInstance({ dueAt: 1_000 });
    const results = await dispatcher(1_000).tick();
    expect(results[0]!.fired).toBe(true);
  });
});
