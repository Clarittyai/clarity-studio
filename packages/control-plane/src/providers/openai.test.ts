import { afterEach, describe, expect, it, vi } from 'vitest';

import { ollama, openai } from './openai.js';

/**
 * A local model that answers with nothing.
 *
 * `qwen2.5:32b` behind Ollama's OpenAI shim, sent the same request eight times,
 * returned a tool call twice and an empty reply with `finish_reason: "stop"` six
 * times. The SDK's agent loop raises on the first empty answer, so an automation
 * that was entirely correct died on a coin flip and recorded "empty response and
 * no tool call".
 */
const ctx = { apiKey: '', baseUrl: undefined, signal: undefined } as never;

const TOOLS = [
  { type: 'function', function: { name: 'app__collect_items', parameters: {} } },
];

function reply(body: unknown) {
  return { ok: true, status: 200, json: async () => body, text: async () => '' };
}

const EMPTY = {
  choices: [{ index: 0, message: { role: 'assistant', content: '' }, finish_reason: 'stop' }],
};
const WITH_TOOL_CALL = {
  choices: [
    {
      index: 0,
      message: {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'app__collect_items', arguments: '{}' } }],
      },
      finish_reason: 'tool_calls',
    },
  ],
};

afterEach(() => vi.unstubAllGlobals());

describe('an empty reply from a local model', () => {
  it('is asked again, and the second answer is used', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(reply(EMPTY)).mockResolvedValueOnce(reply(WITH_TOOL_CALL));
    vi.stubGlobal('fetch', fetchMock);

    const out = await ollama.complete({ model: 'ollama/qwen2.5:32b', messages: [], tools: TOOLS } as never, ctx);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(out.choices[0]?.message?.tool_calls).toHaveLength(1);
  });

  it('gives up rather than looping', async () => {
    const fetchMock = vi.fn().mockResolvedValue(reply(EMPTY));
    vi.stubGlobal('fetch', fetchMock);

    await ollama.complete({ model: 'ollama/qwen2.5:32b', messages: [], tools: TOOLS } as never, ctx);

    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it('does not start a retry that will not finish', async () => {
    // Three slow attempts spent the agent's whole 120s budget and the step died
    // with "timed out" — a worse answer than the empty reply, because it costs
    // two minutes and names nothing. A slow first attempt predicts a slow second.
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockImplementation(async () => {
      vi.advanceTimersByTime(50_000);
      return reply(EMPTY);
    });
    vi.stubGlobal('fetch', fetchMock);

    await ollama.complete({ model: 'ollama/command-r:latest', messages: [], tools: TOOLS } as never, ctx);

    // 50s each: the first fits, a second would land past the 90s budget and
    // spend the agent's whole 120s on a timeout that names nothing.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('is left alone when no tools were offered', async () => {
    // Nothing to drop, so an empty answer is the model's actual answer.
    const fetchMock = vi.fn().mockResolvedValue(reply(EMPTY));
    vi.stubGlobal('fetch', fetchMock);

    await ollama.complete({ model: 'ollama/qwen2.5:32b', messages: [] } as never, ctx);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not spend a metered provider on the same symptom', async () => {
    // We have only observed this behind Ollama's shim, and retrying a paid
    // endpoint would bill someone for a guess.
    const fetchMock = vi.fn().mockResolvedValue(reply(EMPTY));
    vi.stubGlobal('fetch', fetchMock);

    await openai.complete({ model: 'gpt-4o', messages: [], tools: TOOLS } as never, ctx);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('accepts a first answer that actually said something', async () => {
    const fetchMock = vi.fn().mockResolvedValue(reply(WITH_TOOL_CALL));
    vi.stubGlobal('fetch', fetchMock);

    await ollama.complete({ model: 'ollama/qwen2.5:32b', messages: [], tools: TOOLS } as never, ctx);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
