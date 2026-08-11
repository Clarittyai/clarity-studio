import { describe, expect, it } from 'vitest';

import { cleanText, decide, reconnectDelayMs } from './slack-socket-protocol.js';

/**
 * Socket Mode exists here because Studio runs on 127.0.0.1 and Slack cannot
 * reach it. Dialling out means no tunnel, no public URL and no signature to
 * verify — but it moves the risk into message handling, where a mistake shows up
 * as a dropped socket or a runaway loop rather than as a compile error.
 */
describe('deciding what to do with an envelope', () => {
  const mention = (over: Record<string, unknown> = {}) => ({
    envelope_id: 'e1',
    type: 'events_api',
    payload: {
      event: {
        type: 'app_mention',
        text: '<@U0BOT> summarise yesterday',
        channel: 'C1',
        user: 'U1',
        ts: '111.1',
        ...over,
      },
    },
  });

  it('turns a mention into an instruction', () => {
    const action = decide(mention());
    expect(action).toEqual({
      kind: 'ack-and-run',
      instruction: {
        text: 'summarise yesterday',
        channel: 'C1',
        user: 'U1',
        threadTs: '111.1',
      },
    });
  });

  it('answers in the thread the question was asked in', () => {
    const action = decide(mention({ thread_ts: '100.0' }));
    expect(action).toMatchObject({ instruction: { threadTs: '100.0' } });
  });

  it('never reacts to a bot, including itself', () => {
    // Studio posts its answer into the same channel, that post arrives as
    // another event, and without this the automation instructs itself forever —
    // at machine speed, spending tokens every turn.
    expect(decide(mention({ bot_id: 'B1' })).kind).toBe('ack');
    expect(decide(mention({ subtype: 'bot_message' })).kind).toBe('ack');
  });

  it('acknowledges things it will not act on', () => {
    // Silence is read as a dead client and Slack drops the socket, so an
    // envelope we ignore still has to be answered.
    expect(decide({ envelope_id: 'e1', type: 'slash_commands' }).kind).toBe('ack');
    expect(decide(mention({ type: 'reaction_added' })).kind).toBe('ack');
    expect(decide({ envelope_id: 'e1', type: 'events_api' }).kind).toBe('ack');
  });

  it('does not run on an empty instruction', () => {
    // A bare "@studio" is someone getting your attention, not an instruction.
    expect(decide(mention({ text: '<@U0BOT>' })).kind).toBe('ack');
    expect(decide(mention({ channel: '' })).kind).toBe('ack');
  });

  it('reconnects when Slack says it is going away', () => {
    expect(decide({ type: 'disconnect', reason: 'warning' }).kind).toBe('reconnect');
  });

  it('has nothing to do with a hello', () => {
    // No envelope_id, so there is nothing to acknowledge either.
    expect(decide({ type: 'hello' }).kind).toBe('ignore');
  });
});

describe('cleaning the text', () => {
  it('drops the handle so the instruction does not lead with it', () => {
    expect(cleanText('<@U0BOT> what changed <@U9> today')).toBe('what changed today');
  });

  it('leaves an ordinary sentence alone', () => {
    expect(cleanText('  summarise   yesterday ')).toBe('summarise yesterday');
  });
});

describe('backing off', () => {
  it('does not hammer apps.connections.open', () => {
    // Slack rate-limits it, so a tight loop against a revoked token gets the
    // workspace throttled rather than reconnected.
    expect(reconnectDelayMs(0)).toBe(0);
    expect(reconnectDelayMs(1)).toBe(1_000);
    expect(reconnectDelayMs(4)).toBe(8_000);
  });

  it('stops growing at a minute', () => {
    expect(reconnectDelayMs(20)).toBe(60_000);
  });
});
