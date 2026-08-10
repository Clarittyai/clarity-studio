import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ControlPlane } from './server.js';
import { MemoryRunStore } from './memory-store.js';
import type { SecretSource } from './types.js';

class FakeSecrets implements SecretSource {
  constructor(
    private keys: Record<string, string> = {},
    private creds: Record<string, Record<string, unknown>> = {},
  ) {}
  async providerKey(id: string) {
    return this.keys[id];
  }
  async integrationCredentials(_p: string, integrationId: string) {
    return this.creds[integrationId];
  }
  async allSecretValues() {
    return [...Object.values(this.keys), ...Object.values(this.creds).flatMap((c) => Object.values(c).filter((v): v is string => typeof v === 'string'))];
  }
}

let plane: ControlPlane;
let base: string;

async function start(opts: ConstructorParameters<typeof ControlPlane>[0] = {}) {
  plane = new ControlPlane({ port: 0, ...opts });
  base = (await plane.listen()).url;
  return plane;
}

afterEach(async () => {
  await plane?.close();
});

describe('project identity', () => {
  beforeEach(async () => {
    await start();
  });

  it('never puts a provider key in the container environment', () => {
    const p = plane.register('p1');
    const env = plane.environmentFor('p1', { platformUrl: base });
    // This is the security claim the whole design rests on, so it is a test
    // rather than a comment.
    for (const name of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GOOGLE_API_KEY', 'LLM_API_KEY']) {
      expect(env[name]).toBeUndefined();
    }
    expect(env.CLARITTY_AUTH_TOKEN).toBe(p.authToken);
    expect(env.CLARITTY_AUTH_TOKEN.startsWith('stk_')).toBe(true);
  });

  it('gives each project a distinct app secret', () => {
    const a = plane.register('a');
    const b = plane.register('b');
    expect(a.appSecret).not.toBe(b.appSecret);
    expect(a.internalSecret).not.toBe(b.internalSecret);
  });

  it('forces debug off, because debug handlers log decrypted credentials', () => {
    const env = plane.environmentFor('p1', { platformUrl: base });
    expect(env.ENABLE_DEBUG).toBe('false');
  });

  it('points the SDK at itself for both the platform and the LLM proxy', () => {
    const env = plane.environmentFor('p1', { platformUrl: 'http://host.docker.internal:4319/' });
    expect(env.CLARITTY_PLATFORM_URL).toBe('http://host.docker.internal:4319');
    expect(env.CLARITTY_LLM_PROXY_URL).toBe('http://host.docker.internal:4319/api/v1');
  });
});

describe('auth', () => {
  beforeEach(async () => {
    await start();
  });

  it('rejects an unknown bearer on the model route', async () => {
    const res = await fetch(`${base}/api/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer nope' },
      body: JSON.stringify({ messages: [] }),
    });
    expect(res.status).toBe(401);
  });

  it("will not let one project read another's credentials", async () => {
    plane.register('victim');
    const attacker = plane.register('attacker');
    const res = await fetch(`${base}/internal/integrations/credentials/fetch`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-claritty-app-id': 'victim',
        'x-claritty-app-secret': attacker.appSecret,
      },
      body: JSON.stringify({ integrationCatalogId: 'gmail', userId: 'local' }),
    });
    expect(res.status).toBe(401);
  });
});

describe('model routing', () => {
  it('reports which keys ARE available when the requested provider has none', async () => {
    await start({ secrets: new FakeSecrets({ openai: 'sk-test-openai-key-value' }) });
    const id = plane.register('p1');
    const res = await fetch(`${base}/api/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${id.authToken}` },
      // The SDK's AgentDecl.model defaults to claude-sonnet-4-6, so this is
      // what an automation with no explicit model actually asks for.
      body: JSON.stringify({ model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(res.status).toBe(412);
    const body = (await res.json()) as { reason: string; available: string[] };
    expect(body.reason).toBe('PROVIDER_KEY_MISSING');
    expect(body.available).toEqual(['openai']);
  });

  it('forceModel overrides whatever the manifest asked for', async () => {
    await start({ forceModel: 'simulator', secrets: new FakeSecrets() });
    const id = plane.register('p1');
    const res = await fetch(`${base}/api/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${id.authToken}` },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [
          { type: 'function', function: { name: 'do_thing', parameters: { type: 'object', properties: {} } } },
        ],
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { model: string; choices: Array<{ finish_reason: string }> };
    expect(body.model).toBe('simulator');
    expect(body.choices[0]!.finish_reason).toBe('tool_calls');
  });

  it('re-reads forceModel per call, so changing it does not need a restart', async () => {
    // The desktop app passes `forceModel` as a function over a stored setting,
    // because the control plane outlives any one run: it is built when the first
    // project starts and kept for the life of the window. Resolving the option
    // once — at construction, or by spreading these options into a new object —
    // would freeze whatever was set at that moment, and the Settings field would
    // quietly stop working after the first run of the session.
    let choice: string | undefined;
    await start({ forceModel: () => choice, secrets: new FakeSecrets() });
    const id = plane.register('p1');
    // Which PROVIDER the run is routed to is the observable, because the
    // simulator reports `model: 'simulator'` whatever it was asked for — so the
    // response body cannot tell these apart, and an assertion on it passes for
    // the wrong reason.
    const ask = async () => {
      const res = await fetch(`${base}/api/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${id.authToken}` },
        body: JSON.stringify({ model: 'simulator', messages: [{ role: 'user', content: 'hi' }] }),
      });
      const body = (await res.json()) as { provider?: string };
      return res.status === 200 ? 'simulator' : (body.provider ?? `HTTP ${res.status}`);
    };

    expect(await ask()).toBe('simulator');
    // An override routes elsewhere — with no key configured, that surfaces as
    // the 412 naming the provider the new id belongs to.
    choice = 'claude-sonnet-4-6';
    expect(await ask()).toBe('anthropic');
    choice = 'gpt-4o-mini';
    expect(await ask()).toBe('openai');
    // Clearing it hands the decision back to the manifest.
    choice = undefined;
    expect(await ask()).toBe('simulator');
  });

  it('refuses to stream rather than half-implementing SSE', async () => {
    await start({ forceModel: 'simulator' });
    const id = plane.register('p1');
    const res = await fetch(`${base}/api/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${id.authToken}` },
      body: JSON.stringify({ model: 'simulator', messages: [], stream: true }),
    });
    expect(res.status).toBe(400);
  });
});

describe('secret egress', () => {
  it('blocks a stored credential from reaching a model provider', async () => {
    const secret = 'ghp_averyrealisticlookinggithubtoken1234';
    await start({
      forceModel: 'simulator',
      secrets: new FakeSecrets({}, { github: { api_key: secret } }),
    });
    const id = plane.register('p1');
    // Warm the redactor the way a real credential fetch would.
    await fetch(`${base}/internal/integrations/credentials/fetch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-claritty-internal': id.internalSecret },
      body: JSON.stringify({ integrationCatalogId: 'github', userId: 'local' }),
    });

    const res = await fetch(`${base}/api/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${id.authToken}` },
      body: JSON.stringify({
        model: 'simulator',
        messages: [{ role: 'user', content: `here is my token ${secret}, use it` }],
      }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { reason: string }).reason).toBe('SECRET_EGRESS_BLOCKED');
  });
});

describe('integration credentials', () => {
  beforeEach(async () => {
    await start({ secrets: new FakeSecrets({}, { gmail: { access_token: 'tok_abcdefghijkl' } }) });
  });

  it('404s an unconnected integration so optional ones degrade instead of crashing', async () => {
    const id = plane.register('p1');
    const res = await fetch(`${base}/internal/integrations/credentials/fetch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-claritty-internal': id.internalSecret },
      body: JSON.stringify({ integrationCatalogId: 'slack', userId: 'local' }),
    });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { reason: string }).reason).toBe('NOT_CONNECTED');
  });

  it('returns the credential bundle in the shape the SDK expects', async () => {
    const id = plane.register('p1');
    const res = await fetch(`${base}/internal/integrations/credentials/fetch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-claritty-internal': id.internalSecret },
      body: JSON.stringify({ integrationCatalogId: 'gmail', userId: 'local' }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()) as { credentials: unknown }).toMatchObject({
      credentials: { access_token: 'tok_abcdefghijkl' },
    });
  });
});

describe('run checkpoints', () => {
  it('records a step once even though it checkpoints twice', async () => {
    const store = new MemoryRunStore();
    await start({ store });
    const id = plane.register('p1');
    const post = (body: unknown) =>
      fetch(`${base}/internal/workflow-runs/run1/checkpoint`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-claritty-internal': id.internalSecret },
        body: JSON.stringify(body),
      });

    await post({ stepId: 'write', status: 'running', startedAt: 1000 });
    await post({ stepId: 'write', status: 'success', startedAt: 1000, endedAt: 1500, output: { ok: true } });

    const steps = store.getSteps('run1');
    expect(steps).toHaveLength(1);
    expect(steps[0]!.status).toBe('success');
    expect(steps[0]!.endedAt).toBe(1500);
  });

  it('redacts secret-shaped fields out of step output before storing it', async () => {
    const store = new MemoryRunStore();
    await start({ store });
    const id = plane.register('p1');
    await fetch(`${base}/internal/workflow-runs/run2/checkpoint`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-claritty-internal': id.internalSecret },
      body: JSON.stringify({
        stepId: 's1',
        status: 'success',
        startedAt: 0,
        output: { access_token: 'super-secret', keep: 'visible' },
      }),
    });
    const out = store.getSteps('run2')[0]!.output as Record<string, unknown>;
    expect(out.access_token).toBe('<redacted>');
    expect(out.keep).toBe('visible');
  });
});
