import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Store } from '@claritty-studio/db';

import { WebhookIngress } from './webhooks.js';

let store: Store;
let fetchMock: ReturnType<typeof vi.fn>;

function ingress(running = true) {
  return new WebhookIngress({
    store,
    resolveTarget: () =>
      running ? { baseUrl: 'http://127.0.0.1:33001', internalSecret: 'secret' } : undefined,
  });
}

function seedInstance() {
  store.upsertProject({ id: 'p1', name: 'A', slug: 'p1', path: '/tmp/p1', runtime: 'native', status: 'running' });
  return store.triggers.add({
    projectId: 'p1',
    recipeTriggerId: 'on-push',
    workflowId: 'handle-push',
    type: 'WEBHOOK',
    enabled: true,
    missedPolicy: 'skip',
  });
}

beforeEach(() => {
  store = new Store(':memory:');
  fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ success: true }) });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  store.close();
});

describe('delivery', () => {
  it('forwards the payload and records the run', async () => {
    const instance = seedInstance();
    const result = await ingress().deliver(instance.id, { action: 'opened', number: 42 }, {
      'x-github-event': 'pull_request',
    });

    expect(result.status).toBe(200);
    const body = JSON.parse(String(fetchMock.mock.calls[0]![1].body));
    expect(body.payload).toEqual({ action: 'opened', number: 42 });
    expect(body.headers['x-github-event']).toBe('pull_request');
    expect(store.listRuns('p1')).toHaveLength(1);
  });

  it('never forwards credentials that were addressed to Studio', async () => {
    const instance = seedInstance();
    await ingress().deliver(instance.id, {}, {
      authorization: 'Bearer super-secret',
      cookie: 'session=abc',
      host: 'localhost:4319',
      'x-hub-signature-256': 'sha256=keepme',
    });

    const body = JSON.parse(String(fetchMock.mock.calls[0]![1].body));
    expect(body.headers.authorization).toBeUndefined();
    expect(body.headers.cookie).toBeUndefined();
    expect(body.headers.host).toBeUndefined();
    // The provider's own signature header must survive — the automation needs
    // it to verify the delivery itself.
    expect(body.headers['x-hub-signature-256']).toBe('sha256=keepme');
  });

  it('stores the delivery whole, before anything can go wrong', async () => {
    fetchMock.mockRejectedValue(new Error('automation exploded'));
    const instance = seedInstance();
    await ingress().deliver(instance.id, { important: 'payload' }, { 'x-sig': 'abc' });

    const [delivery] = store.triggers.deliveries(instance.id);
    // The payload survives a crash, which is the entire point — otherwise the
    // one delivery you most need to inspect is the one you lost.
    expect(delivery!.requestBody).toEqual({ important: 'payload' });
    expect(delivery!.requestHeaders).toMatchObject({ 'x-sig': 'abc' });
    expect(delivery!.success).toBe(false);
  });

  it('answers 503, not an error, when the automation is not running', async () => {
    const instance = seedInstance();
    const result = await ingress(false).deliver(instance.id, {});
    expect(result.status).toBe(503);
    // Still recorded, so it can be replayed once the automation is up.
    expect(store.triggers.deliveries(instance.id)).toHaveLength(1);
  });

  it('accepts but does not forward when the trigger is paused', async () => {
    const instance = seedInstance();
    store.triggers.setEnabled(instance.id, false);

    const result = await ingress().deliver(instance.id, {});

    // 202 rather than 4xx: most providers disable an endpoint that keeps
    // erroring, and the sender did nothing wrong.
    expect(result.status).toBe(202);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('404s an unknown instance', async () => {
    const result = await ingress().deliver('nope', {});
    expect(result.status).toBe(404);
  });
});

describe('replay', () => {
  it('sends the original bytes again', async () => {
    const instance = seedInstance();
    fetchMock.mockRejectedValueOnce(new Error('automation was down'));
    const first = await ingress().deliver(instance.id, { id: 'evt_1' }, { 'x-sig': 'v1' });

    const replayed = await ingress().replay(first.deliveryId);

    expect(replayed.status).toBe(200);
    const body = JSON.parse(String(fetchMock.mock.calls[1]![1].body));
    expect(body.payload).toEqual({ id: 'evt_1' });
    expect(body.headers['x-sig']).toBe('v1');
  });

  it('records the replay as its own delivery rather than overwriting', async () => {
    const instance = seedInstance();
    const first = await ingress().deliver(instance.id, { id: 'evt_1' });
    await ingress().replay(first.deliveryId);

    // You want to see that you replayed it, and how often.
    expect(store.triggers.deliveries(instance.id)).toHaveLength(2);
  });

  it('runs the workflow again rather than deduping the replay away', async () => {
    const instance = seedInstance();
    const first = await ingress().deliver(instance.id, { id: 'evt_1' });
    await ingress().replay(first.deliveryId);

    // A replay is an explicit instruction to run it again. Idempotency is keyed
    // on the delivery, so the replay gets its own run.
    expect(store.listRuns('p1')).toHaveLength(2);
    expect(store.listRuns('p1')[0]!.triggeredBy).toBe('webhook-replay');
  });

  it('404s an unknown delivery', async () => {
    expect((await ingress().replay('nope')).status).toBe(404);
  });
});
