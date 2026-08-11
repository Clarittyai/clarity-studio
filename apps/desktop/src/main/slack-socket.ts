/**
 * The Socket Mode connection itself.
 *
 * Studio dials OUT to Slack, so nothing has to be publicly reachable — see
 * slack-socket-protocol.ts for why that is the only option that fits a
 * local-first app. Every decision about a message lives there and is unit
 * tested; this file is transport, reconnection and the callback out.
 *
 * `WebSocket` is Node's own (Node 22+, which this repo already requires, and
 * Electron 37 bundles). No dependency is added: the alternative was `ws`, and a
 * websocket library is not worth widening the install surface of a desktop app
 * for one integration.
 */

import { decide, reconnectDelayMs, type SlackInstruction } from './slack-socket-protocol.js';

const OPEN_URL = 'https://slack.com/api/apps.connections.open';

export interface SlackSocketOptions {
  /** App-level token, `xapp-…`, with `connections:write`. NOT the bot token. */
  appToken: string;
  /** Called for each instruction. Errors are swallowed: one bad run must not
   *  take the connection down with it. */
  onInstruction: (instruction: SlackInstruction) => Promise<void> | void;
  onStatus?: (status: 'connected' | 'disconnected' | 'failed', detail?: string) => void;
}

export class SlackSocket {
  private socket: WebSocket | undefined;
  private failures = 0;
  private stopped = false;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly opts: SlackSocketOptions) {}

  start(): void {
    this.stopped = false;
    void this.connect();
  }

  /** Stop for good. Safe to call when never started, and when already stopped. */
  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    try {
      this.socket?.close();
    } catch {
      // Already closing or never opened; nothing to salvage either way.
    }
    this.socket = undefined;
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    const delay = reconnectDelayMs(this.failures);
    this.timer = setTimeout(() => void this.connect(), delay);
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    try {
      const res = await fetch(OPEN_URL, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.opts.appToken}` },
      });
      const json = (await res.json()) as { ok?: boolean; url?: string; error?: string };
      if (!json?.ok || !json.url) {
        // `invalid_auth` here is the ordinary case: an app token that was never
        // given connections:write, or one from the wrong app. Say which.
        this.failures++;
        this.opts.onStatus?.('failed', json?.error ?? `HTTP ${res.status}`);
        this.scheduleReconnect();
        return;
      }
      this.open(json.url);
    } catch (e) {
      this.failures++;
      this.opts.onStatus?.('failed', e instanceof Error ? e.message : String(e));
      this.scheduleReconnect();
    }
  }

  private open(url: string): void {
    const socket = new WebSocket(url);
    this.socket = socket;

    socket.addEventListener('open', () => {
      this.failures = 0;
      this.opts.onStatus?.('connected');
    });

    socket.addEventListener('message', (event) => {
      let envelope: unknown;
      try {
        envelope = JSON.parse(String((event as MessageEvent).data));
      } catch {
        return; // Not JSON; nothing to acknowledge and nothing to act on.
      }
      const action = decide(envelope as never);

      // Acknowledge FIRST, always. Slack drops the socket after 3s of silence
      // and redelivers what it thinks was missed, so acking after the work would
      // guarantee both a dead connection and the instruction running twice.
      if (action.kind === 'ack' || action.kind === 'ack-and-run') {
        const id = (envelope as { envelope_id?: string }).envelope_id;
        try {
          socket.send(JSON.stringify({ envelope_id: id }));
        } catch {
          // The socket went while we were deciding; the reconnect path owns it.
        }
      }

      if (action.kind === 'reconnect') {
        try {
          socket.close();
        } catch {
          // Slack is closing it anyway; the close handler reconnects.
        }
        return;
      }

      if (action.kind === 'ack-and-run') {
        void (async () => {
          try {
            await this.opts.onInstruction(action.instruction);
          } catch {
            // One failed run must not take the connection down with it.
          }
        })();
      }
    });

    socket.addEventListener('close', () => {
      this.socket = undefined;
      this.opts.onStatus?.('disconnected');
      // A clean close is Slack cycling the connection, which is routine and not
      // a failure — reconnect immediately rather than backing off.
      this.scheduleReconnect();
    });

    socket.addEventListener('error', () => {
      this.failures++;
    });
  }
}
