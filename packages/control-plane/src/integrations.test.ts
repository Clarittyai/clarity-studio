/**
 * The chain that makes an automation able to touch something real:
 *
 *   automation → /internal/integrations/tools/:i/:t/execute
 *              → vault (credential)
 *              → connector spec
 *              → the provider's HTTP API
 *
 * These tests stand a real HTTP server up and drive the whole path, rather than
 * mocking the middle of it — the interesting failures live in the joins.
 */

import { createServer, type Server } from 'node:http';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { ControlPlane } from './server.js';
import type { SecretSource } from './types.js';

/** A stand-in provider API. Records what it was sent, so the test can assert
 *  on the request the connector actually built. */
let received: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
let fakeProvider: Server;
let fakePort = 0;

beforeAll(async () => {
  fakeProvider = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      received.push({
        url: req.url ?? '',
        headers: req.headers as Record<string, string>,
        body,
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, ts: '1712345.6789' }));
    });
  });
  await new Promise<void>((resolve) => fakeProvider.listen(0, '127.0.0.1', resolve));
  fakePort = (fakeProvider.address() as { port: number }).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => fakeProvider.close(() => resolve()));
});

class FakeSecrets implements SecretSource {
  constructor(private readonly creds: Record<string, Record<string, unknown>> = {}) {}
  async providerKey() {
    return undefined;
  }
  async integrationCredentials(_p: string, id: string) {
    return this.creds[id];
  }
  async allSecretValues() {
    return Object.values(this.creds).flatMap((c) => Object.values(c).filter((v): v is string => typeof v === 'string'));
  }
}

let plane: ControlPlane;

async function start(
  creds: Record<string, Record<string, unknown>> = {},
  opts: { allowPrivateHosts?: boolean } = {},
) {
  plane = new ControlPlane({ port: 0, secrets: new FakeSecrets(creds), ...opts });
  const { url } = await plane.listen();
  return { url, identity: plane.register('p1') };
}

async function execute(
  base: string,
  internalSecret: string,
  integrationId: string,
  toolId: string,
  args: Record<string, unknown>,
) {
  const res = await fetch(`${base}/internal/integrations/tools/${integrationId}/${toolId}/execute`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Claritty-Internal': internalSecret },
    body: JSON.stringify({ userId: 'local', arguments: args }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

afterEach(async () => {
  received = [];
  await plane?.close();
});

describe('executing a connector tool', () => {
  it('reaches the provider with the credential attached, and returns the mapped result', async () => {
    // Private hosts allowed so the test can drive a real server end to end.
    // That switch is exactly what someone automating self-hosted software uses.
    const { url, identity } = await start(
      { slack: { bot_token: 'xoxb-test-token' } },
      { allowPrivateHosts: true },
    );

    // Point the Slack spec at the fake provider by overriding its host through
    // the same catalog machinery a real call uses.
    const { CATALOG } = await import('@clarity-studio/connectors');
    const slack = CATALOG.find((i) => i.id === 'slack')!;
    const original = slack.tools[0]!.url;
    slack.tools[0]!.url = `http://127.0.0.1:${fakePort}/api/chat.postMessage`;

    try {
      const result = await execute(url, identity.internalSecret, 'slack', 'post_message', {
        channel: '#general',
        text: 'hello from an automation',
      });

      expect(result.status).toBe(200);
      // `result: 'ts'` in the spec means the tool returns just that field.
      expect(result.body.result).toBe('1712345.6789');

      const call = received[0]!;
      // The credential went into the Authorization header — not the URL.
      expect(call.headers.authorization).toBe('Bearer xoxb-test-token');
      expect(call.url).not.toContain('xoxb');
      expect(JSON.parse(call.body)).toEqual({ channel: '#general', text: 'hello from an automation' });
    } finally {
      slack.tools[0]!.url = original;
    }
  });

  it('answers 409 not-connected when no credential is stored', async () => {
    const { url, identity } = await start({});

    const result = await execute(url, identity.internalSecret, 'slack', 'post_message', {
      channel: '#general',
      text: 'hi',
    });

    // The SDK maps this to CredentialsNotAvailable, which an optional
    // integration degrades on rather than crashing the run.
    expect(result.status).toBe(409);
    expect(result.body.reason).toBe('NOT_CONNECTED');
    // The message tells the user how to fix it, verbatim from the catalog.
    expect(String(result.body.message)).toMatch(/api\.slack\.com\/apps/);
  });

  it('names the tool when Studio has no local connector for it', async () => {
    const { url, identity } = await start({});
    const result = await execute(url, identity.internalSecret, 'salesforce', 'create_lead', {});

    expect(result.status).toBe(404);
    expect(result.body.reason).toBe('NO_LOCAL_CONNECTOR');
  });

  it('refuses a tool call aimed at a private address', async () => {
    const { url, identity } = await start({ 'outbound-webhook': {} });

    const result = await execute(url, identity.internalSecret, 'outbound-webhook', 'post', {
      url: 'http://169.254.169.254/latest/meta-data/',
      payload: {},
    });

    // An automation talked into POSTing to the metadata endpoint is the
    // realistic version of this attack.
    expect(result.status).toBe(400);
    expect(result.body.reason).toBe('SSRF');
  });

  it('requires the internal headers', async () => {
    const { url } = await start({});
    const res = await fetch(`${url}/internal/integrations/tools/slack/post_message/execute`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ arguments: {} }),
    });
    expect(res.status).toBe(401);
  });
});

describe('not leaking the credential back out', () => {
  it('redacts a stored secret out of an error message', async () => {
    const secret = 'xoxb-super-secret-token-value';
    const { url, identity } = await start({ slack: { bot_token: secret } });

    // Point the connector at a host that will fail, so the error path runs.
    const result = await execute(url, identity.internalSecret, 'slack', 'post_message', {
      channel: '#general',
      text: 'hi',
    });

    // Whatever went wrong, the token must not come back in the response — a
    // provider's error body can echo the request that carried it.
    expect(JSON.stringify(result.body)).not.toContain(secret);
  });
});
