import { describe, expect, it, vi } from 'vitest';

import { assertPublicUrl, ConnectorError, executeTool, type HttpToolSpec } from './engine.js';

function ok(body: unknown, status = 200) {
  return vi.fn().mockResolvedValue({
    ok: status < 400,
    status,
    text: async () => JSON.stringify(body),
  } as unknown as Response);
}

const slackPost: HttpToolSpec = {
  id: 'slack.post_message',
  method: 'POST',
  url: 'https://slack.com/api/chat.postMessage',
  auth: { type: 'bearer', field: 'bot_token' },
  body: { channel: '{arg.channel}', text: '{arg.text}' },
  result: 'ts',
};

describe('making the call', () => {
  it('sends the templated body and returns the plucked field', async () => {
    const fetchImpl = ok({ ok: true, ts: '1712345.6789' });

    const result = await executeTool({
      spec: slackPost,
      args: { channel: '#general', text: 'hello' },
      credentials: { bot_token: 'xoxb-secret' },
      fetchImpl,
    });

    expect(result).toBe('1712345.6789');
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://slack.com/api/chat.postMessage');
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ channel: '#general', text: 'hello' });
    expect((init as RequestInit).headers).toMatchObject({ authorization: 'Bearer xoxb-secret' });
  });

  it('keeps an argument’s type when the whole value is a placeholder', async () => {
    const fetchImpl = ok({ id: 1 });
    await executeTool({
      spec: {
        id: 'x.send', method: 'POST', url: 'https://api.example.com/send',
        auth: { type: 'bearer', field: 'token' },
        body: { to: '{arg.recipients}', count: '{arg.count}' },
      },
      args: { recipients: ['a@example.com', 'b@example.com'], count: 2 },
      credentials: { token: 't' },
      fetchImpl,
    });

    const body = JSON.parse(String(fetchImpl.mock.calls[0]![1].body));
    // An array of recipients arriving as "[object Object]" is the kind of bug
    // that looks like the provider's fault.
    expect(body.to).toEqual(['a@example.com', 'b@example.com']);
    expect(body.count).toBe(2);
  });

  it('drops a whole-value field whose argument was not supplied', async () => {
    const fetchImpl = ok({});
    await executeTool({
      spec: {
        id: 'x.create', method: 'POST', url: 'https://api.example.com/x',
        auth: { type: 'none' },
        body: { title: '{arg.title}', optional: '{arg.missing}', greeting: 'Hi {arg.missing}' },
      },
      args: { title: 'hi' },
      credentials: {},
      fetchImpl,
    });

    const body = JSON.parse(String(fetchImpl.mock.calls[0]![1].body));
    // A missing whole-value placeholder omits the key entirely. Sending ""
    // instead would be wrong: plenty of APIs read an empty string as "clear
    // this field" rather than "leave it alone".
    expect(body).not.toHaveProperty('optional');
    // Inside a larger string there is nothing to omit, so it substitutes empty.
    expect(body.greeting).toBe('Hi ');
    expect(body.title).toBe('hi');
  });

  it('supports header, query and basic auth', async () => {
    const header = ok({});
    await executeTool({
      spec: { id: 'a.b', method: 'GET', url: 'https://api.example.com/x',
        auth: { type: 'header', name: 'X-API-Key', field: 'api_key' } },
      args: {}, credentials: { api_key: 'k123' }, fetchImpl: header,
    });
    expect(header.mock.calls[0]![1].headers).toMatchObject({ 'x-api-key': 'k123' });

    const query = ok({});
    await executeTool({
      spec: { id: 'a.b', method: 'GET', url: 'https://api.example.com/x',
        auth: { type: 'query', name: 'key', field: 'api_key' } },
      args: {}, credentials: { api_key: 'k123' }, fetchImpl: query,
    });
    expect(String(query.mock.calls[0]![0])).toContain('key=k123');

    const basic = ok({});
    await executeTool({
      spec: { id: 'a.b', method: 'GET', url: 'https://api.example.com/x',
        auth: { type: 'basic', userField: 'user', passwordField: 'pass' } },
      args: {}, credentials: { user: 'u', pass: 'p' }, fetchImpl: basic,
    });
    expect(basic.mock.calls[0]![1].headers.authorization).toBe(
      `Basic ${Buffer.from('u:p').toString('base64')}`,
    );
  });
});

describe('refusing to leak a credential', () => {
  it('rejects a spec that puts a credential in the URL', async () => {
    // URLs reach logs, error messages, referrers and the run timeline. A spec
    // that does this fails loudly rather than leaking on every call.
    await expect(
      executeTool({
        spec: { id: 'bad.tool', method: 'GET', url: 'https://api.example.com/{creds.api_key}/x',
          auth: { type: 'none' } },
        args: {}, credentials: { api_key: 'secret' }, fetchImpl: ok({}),
      }),
    ).rejects.toThrow(/must never appear in a URL/);
  });

  it('rejects a credential in a query template too', async () => {
    await expect(
      executeTool({
        spec: { id: 'bad.tool', method: 'GET', url: 'https://api.example.com/x',
          auth: { type: 'none' }, query: { token: '{creds.api_key}' } },
        args: {}, credentials: { api_key: 'secret' }, fetchImpl: ok({}),
      }),
    ).rejects.toThrow(/must never appear in a URL/);
  });

  it('says which credential is missing rather than sending an empty header', async () => {
    await expect(
      executeTool({ spec: slackPost, args: {}, credentials: {}, fetchImpl: ok({}) }),
    ).rejects.toThrow(/needs the "bot_token" credential/);
  });
});

describe('the SSRF guard', () => {
  const blocked = [
    'http://localhost:8080/x',
    'http://127.0.0.1/x',
    'http://10.0.0.5/x',
    'http://192.168.1.1/admin',
    'http://172.16.0.1/x',
    'http://169.254.169.254/latest/meta-data/',  // cloud metadata
    'http://[::1]/x',
    'http://printer.local/x',
    'file:///etc/passwd',
  ];

  for (const url of blocked) {
    it(`refuses ${url}`, () => {
      expect(() => assertPublicUrl(url)).toThrow(ConnectorError);
    });
  }

  it('allows a normal public host', () => {
    expect(assertPublicUrl('https://api.slack.com/x').hostname).toBe('api.slack.com');
  });

  it('blocks an argument-driven URL that points inward', async () => {
    // The realistic attack: a tool takes a URL as input and an automation is
    // talked into pointing it at the machine's own network.
    await expect(
      executeTool({
        spec: { id: 'web.fetch', method: 'GET', url: '{arg.url}', auth: { type: 'none' } },
        args: { url: 'http://169.254.169.254/latest/meta-data/' },
        credentials: {}, fetchImpl: ok({}),
      }),
    ).rejects.toThrow(/private address|public hosts only/);
  });
});

describe('failures', () => {
  it('surfaces the provider’s own error message', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false, status: 403, text: async () => JSON.stringify({ message: 'insufficient scope' }),
    } as unknown as Response);

    await expect(
      executeTool({ spec: slackPost, args: { channel: '#a', text: 'b' },
        credentials: { bot_token: 't' }, fetchImpl }),
    ).rejects.toThrow(/insufficient scope/);
  });

  it('treats a 200 with ok:false as a failure', async () => {
    // Slack answers 200 {ok:false,error:"channel_not_found"}. Calling that a
    // success is how an automation reports "sent" for a message nobody got.
    const fetchImpl = ok({ ok: false, error: 'channel_not_found' });
    await expect(
      executeTool({ spec: slackPost, args: { channel: '#nope', text: 'b' },
        credentials: { bot_token: 't' }, fetchImpl }),
    ).rejects.toThrow(/channel_not_found/);
  });

  it('does not choke on a non-JSON response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true, status: 200, text: async () => 'plain text',
    } as unknown as Response);
    await expect(
      executeTool({ spec: { id: 'a.b', method: 'GET', url: 'https://api.example.com/x',
        auth: { type: 'none' } }, args: {}, credentials: {}, fetchImpl }),
    ).resolves.toEqual({ raw: 'plain text' });
  });
});

describe('the catalog', () => {
  it('sends a webhook payload as the whole body', async () => {
    const { resolveTool } = await import('./catalog.js');
    const found = resolveTool('outbound-webhook', 'post', {})!;
    const fetchImpl = ok({ received: true });

    await executeTool({
      spec: found.tool,
      args: { url: 'https://hooks.example.com/abc', payload: { event: 'paid', amount: 42 } },
      credentials: {},
      fetchImpl,
    });

    expect(JSON.parse(String(fetchImpl.mock.calls[0]![1].body))).toEqual({ event: 'paid', amount: 42 });
  });

  it('carries the Telegram token in the path, because that is where Telegram wants it', async () => {
    // Telegram accepts its token nowhere else. Rather than special-case the
    // provider inside resolveTool — which put the secret in the URL with
    // nothing scrubbing it back out of errors — the spec DECLARES `path` auth
    // and the engine handles it uniformly. See oauth.test.ts for the scrub.
    const { resolveTool } = await import('./catalog.js');
    const found = resolveTool('telegram', 'send_message')!;
    expect(found.tool.auth.type).toBe('path');
    expect(found.tool.url).toBe('https://api.telegram.org/bot{creds.bot_token}/sendMessage');

    const fetchImpl = ok({ ok: true, result: { message_id: 9 } });
    await executeTool({
      spec: found.tool,
      args: { chat_id: '1', text: 'hi' },
      credentials: { bot_token: '123:ABC' },
      fetchImpl,
    });
    expect(String(fetchImpl.mock.calls[0]![0])).toBe(
      'https://api.telegram.org/bot123:ABC/sendMessage',
    );
  });

  it('every catalog tool has a public https URL and a real auth field', async () => {
    const { CATALOG } = await import('./catalog.js');
    for (const integration of CATALOG) {
      for (const tool of integration.tools) {
        // A url carrying a placeholder is checked at call time, once filled.
        const templated = tool.url.includes('{arg.') || tool.url.includes('{creds.');
        if (!templated) expect(() => assertPublicUrl(tool.url)).not.toThrow();
        if (tool.auth.type === 'bearer' || tool.auth.type === 'header' || tool.auth.type === 'query') {
          // A spec whose auth names a field the integration never asks for
          // would fail only at call time, on someone's real automation.
          expect(integration.fields.map((f) => f.key)).toContain(tool.auth.field);
        }
      }
    }
  });
});
