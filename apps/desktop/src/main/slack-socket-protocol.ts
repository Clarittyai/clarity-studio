/**
 * Slack Socket Mode, as pure decisions.
 *
 * Studio runs on 127.0.0.1 and Slack cannot reach it. The webhook path would
 * need a public URL, a tunnel, urlencoded parsing, signature verification and a
 * challenge echo — five things that do not exist here and one of which (the
 * tunnel) contradicts the whole premise of a local-first app. Socket Mode
 * inverts it: Studio dials OUT over a WebSocket, so there is nothing to expose
 * and no signature to verify, because the socket itself is authenticated by the
 * app-level token used to open it.
 *
 * The transport lives elsewhere. Everything here is a decision about a message,
 * because those are the parts that are wrong in ways a live socket would only
 * reveal at 3am: the acknowledgement deadline, which events are ours, and
 * whether a disconnect means reconnect or stop.
 */

/** What Slack sends down the socket. Only the fields we act on. */
export interface SocketEnvelope {
  /** Present on anything that must be acknowledged. Absent on `hello`. */
  envelope_id?: string;
  type?: string;
  /** Slack asks us to reconnect before it drops the socket. */
  reason?: string;
  payload?: {
    event?: {
      type?: string;
      subtype?: string;
      text?: string;
      channel?: string;
      user?: string;
      ts?: string;
      thread_ts?: string;
      bot_id?: string;
    };
  };
}

/** An instruction from a person, ready to become a run. */
export interface SlackInstruction {
  text: string;
  channel: string;
  user: string;
  /** Reply here so the answer lands under the question, not beside it. */
  threadTs: string;
}

export type SocketAction =
  | { kind: 'ignore' }
  | { kind: 'ack' }
  | { kind: 'ack-and-run'; instruction: SlackInstruction }
  | { kind: 'reconnect' };

/**
 * Slack drops the socket if an envelope is not acknowledged within 3 seconds,
 * and redelivers what it thinks was missed. Acknowledging BEFORE doing the work
 * is therefore required, not an optimisation: an automation takes tens of
 * seconds, so acking afterwards would guarantee both a dropped socket and the
 * same instruction running repeatedly.
 */
export const ACK_DEADLINE_MS = 3_000;

/** Strip the bot mention, so the instruction does not start with its own handle. */
export function cleanText(raw: string): string {
  return raw.replace(/<@[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * What to do with one envelope.
 *
 * The bot-loop guard is the one that bites hardest in practice: Studio posts its
 * answer back into the same channel, that post arrives as another event, and
 * without this the automation instructs itself forever — each turn spending
 * tokens, at machine speed.
 */
export function decide(envelope: SocketEnvelope): SocketAction {
  if (envelope.type === 'hello') return { kind: 'ignore' };
  if (envelope.type === 'disconnect') return { kind: 'reconnect' };

  // Anything with an id must be acknowledged even when we do nothing with it,
  // or Slack treats the silence as a dead client and drops the connection.
  if (!envelope.envelope_id) return { kind: 'ignore' };
  if (envelope.type !== 'events_api') return { kind: 'ack' };

  const event = envelope.payload?.event;
  if (!event) return { kind: 'ack' };

  // Never react to a bot, including ourselves.
  if (event.bot_id || event.subtype === 'bot_message') return { kind: 'ack' };
  if (event.type !== 'app_mention' && event.type !== 'message') return { kind: 'ack' };

  const text = cleanText(String(event.text ?? ''));
  const channel = String(event.channel ?? '');
  if (!text || !channel) return { kind: 'ack' };

  return {
    kind: 'ack-and-run',
    instruction: {
      text,
      channel,
      user: String(event.user ?? ''),
      // Reply in the thread the question started, falling back to the message
      // itself so an answer to a top-level message opens one rather than
      // landing loose in the channel.
      threadTs: String(event.thread_ts ?? event.ts ?? ''),
    },
  };
}

/**
 * How long to wait before dialling again.
 *
 * Slack rate-limits `apps.connections.open`, so a tight reconnect loop against a
 * revoked token would get the workspace throttled rather than reconnected.
 * Backs off to a minute and stays there.
 */
export function reconnectDelayMs(consecutiveFailures: number): number {
  if (consecutiveFailures <= 0) return 0;
  return Math.min(60_000, 1_000 * 2 ** (consecutiveFailures - 1));
}
