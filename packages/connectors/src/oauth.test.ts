/**
 * "Bring your own OAuth app" is a promise, so it is a test.
 *
 * Studio ships no Claritty OAuth client — every OAuth integration runs on
 * credentials the user registered themselves. This asserts the exchange happens
 * against THEIR app, that the derived access token is what reaches the API, and
 * that a second call reuses the cached token instead of refreshing again.
 */
import { createServer, type Server } from 'node:http';

import { describe, expect, it } from 'vitest';

import { executeTool } from './engine.js';

async function listen(handler: Parameters<typeof createServer>[0]): Promise<[Server, string]> {
  const server = createServer(handler);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const { port } = server.address() as { port: number };
  return [server, `http://127.0.0.1:${port}`];
}

describe('oauth2 with the user’s own app', () => {
  it('exchanges the refresh token and calls the API with the derived one', async () => {
    let refreshes = 0;
    const seen: { auth?: string; grant?: string; clientId?: string } = {};

    const [server, base] = await listen((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        if (req.url === '/token') {
          refreshes += 1;
          const form = new URLSearchParams(body);
          seen.grant = form.get('grant_type') ?? undefined;
          seen.clientId = form.get('client_id') ?? undefined;
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ access_token: 'derived-token', expires_in: 3600 }));
          return;
        }
        seen.auth = req.headers.authorization;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
    });

    const spec = {
      id: 'test.call',
      method: 'GET' as const,
      url: `${base}/api`,
      auth: {
        type: 'oauth2' as const,
        tokenUrl: `${base}/token`,
        clientIdField: 'client_id',
        clientSecretField: 'client_secret',
        refreshTokenField: 'refresh_token',
      },
    };
    const credentials = {
      client_id: 'the-users-own-app',
      client_secret: 'their-secret',
      refresh_token: 'their-refresh-token',
    };

    await executeTool({ spec, args: {}, credentials, allowPrivateHosts: true });

    expect(seen.grant).toBe('refresh_token');
    // Their app, not ours. This is the whole point.
    expect(seen.clientId).toBe('the-users-own-app');
    expect(seen.auth).toBe('Bearer derived-token');

    // A second call must not refresh again — the token is cached until it expires.
    await executeTool({ spec, args: {}, credentials, allowPrivateHosts: true });
    expect(refreshes).toBe(1);

    server.close();
  });

  it('surfaces the provider’s own words when a refresh token is dead', async () => {
    const [server, base] = await listen((req, res) => {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }));
    });

    await expect(
      executeTool({
        spec: {
          id: 'test.call',
          method: 'GET' as const,
          url: `${base}/api`,
          auth: { type: 'oauth2' as const, tokenUrl: `${base}/token` },
        },
        args: {},
        credentials: { client_id: 'a', client_secret: 'b', refresh_token: 'c' },
        allowPrivateHosts: true,
      }),
    ).rejects.toThrow(/expired or revoked/i);

    server.close();
  });
});

describe('path auth', () => {
  it('puts the token in the url and keeps it out of the error', async () => {
    const [server, base] = await listen((req, res) => {
      // Telegram-shaped: the token is in the path, and it echoes back on error.
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, description: `Unauthorized for ${req.url}` }));
    });

    const spec = {
      id: 'telegram.send_message',
      method: 'POST' as const,
      url: `${base}/bot{creds.bot_token}/sendMessage`,
      auth: { type: 'path' as const, field: 'bot_token' },
      body: { text: '{arg.text}' },
    };

    await expect(
      executeTool({
        spec,
        args: { text: 'hi' },
        credentials: { bot_token: '123456:SUPER-SECRET' },
        allowPrivateHosts: true,
      }),
    ).rejects.toThrow(/\*\*\*/);

    // And specifically: the secret itself must not survive into the message.
    await executeTool({
      spec,
      args: { text: 'hi' },
      credentials: { bot_token: '123456:SUPER-SECRET' },
      allowPrivateHosts: true,
    }).catch((e: Error) => {
      expect(e.message).not.toContain('SUPER-SECRET');
    });

    server.close();
  });

  it('still refuses a credential in a url when auth does not declare path', async () => {
    await expect(
      executeTool({
        spec: {
          id: 'bad.spec',
          method: 'GET' as const,
          url: 'https://example.com/{creds.api_key}',
          auth: { type: 'bearer' as const, field: 'api_key' },
        },
        args: {},
        credentials: { api_key: 'leaky' },
      }),
    ).rejects.toThrow(/must never appear/i);
  });
});
