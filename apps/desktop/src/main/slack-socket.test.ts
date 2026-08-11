import { afterEach, describe, expect, it, vi } from 'vitest';

import { SlackSocket } from './slack-socket.js';
import { startFakeSlack, type FakeSlackSocketServer } from './fake-socket-server.testing.js';
import type { SlackInstruction } from './slack-socket-protocol.js';

/**
 * The connection, against a real socket.
 *
 * `SlackSocket` shipped without ever having opened one, so mocks would only
 * confirm my reading of the protocol — the same reading that could be wrong.
 * These run the real client through a genuine RFC6455 handshake and real masked
 * frames (see fake-socket-server.testing.ts).
 */
let server: FakeSlackSocketServer | undefined;
let socket: SlackSocket | undefined;

const until = async (predicate: () => boolean, ms = 4000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return false;
};

/** Stand in for `apps.connections.open`, pointing the client at our server. */
function stubOpen(url: string, body?: Record<string, unknown>) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      status: 200,
      json: async () => body ?? { ok: true, url },
    })),
  );
}

afterEach(async () => {
  socket?.stop();
  socket = undefined;
  await server?.close();
  server = undefined;
  vi.unstubAllGlobals();
});

describe('a live Socket Mode connection', () => {
  it('opens, receives a mention and runs it', async () => {
    server = await startFakeSlack();
    stubOpen(server.url);
    const instructions: SlackInstruction[] = [];

    socket = new SlackSocket({
      appToken: 'xapp-test',
      onInstruction: (i) => void instructions.push(i),
    });
    socket.start();

    await server.waitForConnection();
    server.send({ type: 'hello' });
    server.send({
      envelope_id: 'env-1',
      type: 'events_api',
      payload: {
        event: {
          type: 'app_mention',
          text: '<@U0BOT> summarise yesterday',
          channel: 'C1',
          user: 'U1',
          ts: '111.1',
        },
      },
    });

    expect(await until(() => instructions.length > 0)).toBe(true);
    expect(instructions[0]).toEqual({
      text: 'summarise yesterday',
      channel: 'C1',
      user: 'U1',
      threadTs: '111.1',
    });
  });

  it('acknowledges the envelope, and does it before the work finishes', async () => {
    // The rule the whole design rests on: Slack drops the socket after 3s of
    // silence and redelivers what it thinks was missed. Acking after the run —
    // tens of seconds — would guarantee a dead connection AND the instruction
    // running repeatedly. So a handler that never resolves must still be acked.
    server = await startFakeSlack();
    stubOpen(server.url);

    socket = new SlackSocket({
      appToken: 'xapp-test',
      onInstruction: () => new Promise<void>(() => undefined),
    });
    socket.start();

    await server.waitForConnection();
    server.send({
      envelope_id: 'env-42',
      type: 'events_api',
      payload: {
        event: { type: 'app_mention', text: '<@U0BOT> go', channel: 'C1', user: 'U1', ts: '1' },
      },
    });

    expect(await until(() => server!.received.length > 0)).toBe(true);
    expect(JSON.parse(server.received[0]!)).toEqual({ envelope_id: 'env-42' });
  });

  it('acknowledges an envelope it will not act on', async () => {
    // Silence reads as a dead client whatever the reason for it.
    server = await startFakeSlack();
    stubOpen(server.url);

    socket = new SlackSocket({ appToken: 'xapp-test', onInstruction: () => undefined });
    socket.start();

    await server.waitForConnection();
    server.send({ envelope_id: 'env-7', type: 'slash_commands' });

    expect(await until(() => server!.received.length > 0)).toBe(true);
    expect(JSON.parse(server.received[0]!)).toEqual({ envelope_id: 'env-7' });
  });

  it('never runs on its own messages', async () => {
    // Studio posts its answer into the channel it reads. Without this the
    // automation instructs itself forever, at machine speed, spending tokens.
    server = await startFakeSlack();
    stubOpen(server.url);
    const instructions: SlackInstruction[] = [];

    socket = new SlackSocket({
      appToken: 'xapp-test',
      onInstruction: (i) => void instructions.push(i),
    });
    socket.start();

    await server.waitForConnection();
    server.send({
      envelope_id: 'env-bot',
      type: 'events_api',
      payload: {
        event: { type: 'message', text: 'Running it.', channel: 'C1', bot_id: 'B1', ts: '2' },
      },
    });

    expect(await until(() => server!.received.length > 0)).toBe(true);
    expect(instructions).toHaveLength(0);
  });

  it('reconnects after Slack drops the connection', async () => {
    server = await startFakeSlack();
    stubOpen(server.url);

    socket = new SlackSocket({ appToken: 'xapp-test', onInstruction: () => undefined });
    socket.start();

    await server.waitForConnection();
    expect(server.connections()).toBe(1);
    server.dropConnection();

    expect(await until(() => server!.connections() >= 2, 6000)).toBe(true);
  });

  it('reports a token Slack refuses, rather than dying quietly', async () => {
    // `invalid_auth` is the ordinary first-run failure: an app token without
    // connections:write, or one from the wrong app. It must be visible.
    server = await startFakeSlack();
    stubOpen(server.url, { ok: false, error: 'invalid_auth' });
    const statuses: Array<[string, string | undefined]> = [];

    socket = new SlackSocket({
      appToken: 'xapp-bad',
      onInstruction: () => undefined,
      onStatus: (s, d) => void statuses.push([s, d]),
    });
    socket.start();

    expect(await until(() => statuses.length > 0)).toBe(true);
    expect(statuses[0]).toEqual(['failed', 'invalid_auth']);
  });

  it('stops for good when told to', async () => {
    server = await startFakeSlack();
    stubOpen(server.url);

    socket = new SlackSocket({ appToken: 'xapp-test', onInstruction: () => undefined });
    socket.start();
    await server.waitForConnection();

    socket.stop();
    server.dropConnection();

    // A stopped socket must not resurrect itself on the close handler.
    await new Promise((r) => setTimeout(r, 1500));
    expect(server.connections()).toBe(1);
  });
});
