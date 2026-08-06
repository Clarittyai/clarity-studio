import { describe, expect, it, vi } from 'vitest';

import { deliver, headline, type NotifyPrefs } from './notifier.js';

const ok = () =>
  vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ ok: true, ts: '1', id: 'e1', result: { message_id: 5 } }),
  } as unknown as Response);

const FINISHED = { automation: 'Invoice digest', status: 'success', error: null };
const FAILED = { automation: 'Invoice digest', status: 'failed', error: 'Gmail refused the token' };

const creds = (map: Record<string, Record<string, string>>) => (id: string) => map[id];

describe('what the message says', () => {
  it('names the automation and what happened', () => {
    expect(headline(FINISHED)).toBe('Invoice digest finished');
    expect(headline(FAILED)).toBe('Invoice digest failed');
  });
});

describe('delivering', () => {
  it('sends nothing when no channel is switched on', async () => {
    const fetchImpl = ok();
    const results = await deliver({ desktop: true }, FINISHED, creds({}), 1, fetchImpl);
    // Desktop is Electron's own; this function is only the outside channels.
    expect(results).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('posts to the Slack channel that was chosen', async () => {
    const fetchImpl = ok();
    const prefs: NotifyPrefs = { slack: true, slackChannel: ' #runs ' };
    const [result] = await deliver(
      prefs,
      FAILED,
      creds({ slack: { bot_token: 'xoxb-1' } }),
      1,
      fetchImpl,
    );

    expect(result).toMatchObject({ channel: 'slack', ok: true });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://slack.com/api/chat.postMessage');
    const body = JSON.parse(String((init as RequestInit).body));
    expect(body.channel).toBe('#runs');
    // The failure reason has to travel with it — "a run failed" with no reason
    // means opening the app anyway, which is what the channel was avoiding.
    expect(body.text).toContain('Gmail refused the token');
  });

  it('does not send to Slack with no channel to send to', async () => {
    const fetchImpl = ok();
    const results = await deliver(
      { slack: true },
      FINISHED,
      creds({ slack: { bot_token: 'x' } }),
      1,
      fetchImpl,
    );
    expect(results).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('takes the Telegram chat id from the connection, not the preferences', async () => {
    const fetchImpl = ok();
    const [result] = await deliver(
      { telegram: true },
      FINISHED,
      creds({ telegram: { bot_token: '123:ABC', chat_id: '55' } }),
      1,
      fetchImpl,
    );
    expect(result).toMatchObject({ channel: 'telegram', ok: true });
    expect(String(fetchImpl.mock.calls[0]![0])).toBe(
      'https://api.telegram.org/bot123:ABC/sendMessage',
    );
    expect(JSON.parse(String(fetchImpl.mock.calls[0]![1].body)).chat_id).toBe('55');
  });

  it('says so when Telegram is connected without a chat id', async () => {
    // Silently sending nothing is the failure this whole file exists to avoid.
    const [result] = await deliver(
      { telegram: true },
      FINISHED,
      creds({ telegram: { bot_token: '123:ABC' } }),
      1,
      ok(),
    );
    expect(result!.ok).toBe(false);
    expect(result!.error).toMatch(/chat id/i);
  });

  it('needs both ends of an email before sending one', async () => {
    const fetchImpl = ok();
    const creds1 = creds({ resend: { api_key: 're_1' } });
    expect(await deliver({ email: true, emailTo: 'a@b.com' }, FINISHED, creds1, 1, fetchImpl)).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();

    const [result] = await deliver(
      { email: true, emailTo: 'a@b.com', emailFrom: 'runs@mine.com' },
      FINISHED,
      creds1,
      1,
      fetchImpl,
    );
    expect(result).toMatchObject({ channel: 'email', ok: true });
    expect(JSON.parse(String(fetchImpl.mock.calls[0]![1].body))).toMatchObject({
      from: 'runs@mine.com',
      to: 'a@b.com',
      subject: 'Invoice digest finished',
    });
  });

  it('reports the provider’s own words when a send is refused', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      text: async () => JSON.stringify({ error: 'not_in_channel' }),
    } as unknown as Response);

    const [result] = await deliver(
      { slack: true, slackChannel: '#runs' },
      FINISHED,
      creds({ slack: { bot_token: 'xoxb-1' } }),
      1,
      fetchImpl,
    );
    expect(result!.ok).toBe(false);
    expect(result!.error).toMatch(/not_in_channel/);
  });

  it('says a channel is not connected instead of throwing', async () => {
    const [result] = await deliver(
      { slack: true, slackChannel: '#runs' },
      FINISHED,
      creds({}),
      1,
      ok(),
    );
    expect(result).toMatchObject({ channel: 'slack', ok: false });
    expect(result!.error).toMatch(/not connected/i);
  });

  it('one channel failing does not stop the others', async () => {
    // The realistic case: Slack's token was revoked and Telegram still works.
    // Losing the working channel because of the broken one is how you end up
    // not being told anything at all.
    const fetchImpl = vi.fn(async (url: string | URL) =>
      String(url).includes('slack')
        ? ({ ok: false, status: 401, text: async () => '{"error":"invalid_auth"}' } as unknown as Response)
        : ({ ok: true, status: 200, text: async () => '{"ok":true,"result":{"message_id":1}}' } as unknown as Response),
    );

    const results = await deliver(
      { slack: true, slackChannel: '#runs', telegram: true },
      FAILED,
      creds({ slack: { bot_token: 'x' }, telegram: { bot_token: '1:A', chat_id: '9' } }),
      1,
      fetchImpl as unknown as typeof fetch,
    );

    expect(results.find((r) => r.channel === 'slack')?.ok).toBe(false);
    expect(results.find((r) => r.channel === 'telegram')?.ok).toBe(true);
  });
});
