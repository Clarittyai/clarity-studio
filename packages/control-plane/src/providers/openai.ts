/**
 * OpenAI-compatible adapter.
 *
 * The SDK already speaks Chat Completions, so this is close to a passthrough.
 * It also serves every other OpenAI-shaped endpoint — Ollama, OpenRouter,
 * LM Studio, vLLM, Together — which is why the base URL is a parameter rather
 * than a constant.
 */

import type { ChatCompletionRequest, ChatCompletionResponse, Provider } from '../types.js';
import { ProviderHttpError } from './anthropic.js';

const OPENAI = 'https://api.openai.com/v1';

/**
 * How many extra attempts a local model gets when it answers with nothing.
 *
 * Measured, not guessed. `qwen2.5:32b` behind Ollama's OpenAI shim, sent the
 * SAME request eight times, produced a tool call twice and an empty reply with
 * `finish_reason: "stop"` six times. The automation is not wrong and the request
 * is not wrong — the shim is simply unreliable at emitting `tool_calls`, and the
 * SDK's agent loop raises on the first empty answer, so a run died on a coin
 * flip. Three attempts turns a 25% chance into roughly 58%, which is the
 * difference between "this never works" and "this usually works".
 *
 * Deliberately ollama-only. Retrying costs nothing locally, whereas doing it to
 * a metered provider would spend someone's money on a symptom we have only
 * observed here.
 */
const EMPTY_REPLY_RETRIES = 1;

/**
 * Don't start a retry that will not finish.
 *
 * The agent gives a step 120s. Three attempts at ~40s each spent the whole
 * budget and the step died with "timed out" — a worse answer than the empty
 * reply it was trying to fix, because it costs two minutes and names nothing.
 * A 32B model answers here in ~20s and a 59B one in ~55s, so the first attempt's
 * own duration is the honest predictor of whether a second one fits.
 */
const RETRY_IF_FIRST_TOOK_UNDER_MS = 30_000;

/** An answer with neither words nor a tool call is not an answer. */
function saidNothing(data: ChatCompletionResponse): boolean {
  const message = (data as { choices?: Array<{ message?: { content?: unknown; tool_calls?: unknown } }> })
    .choices?.[0]?.message;
  if (!message) return true;
  const calls = message.tool_calls;
  if (Array.isArray(calls) && calls.length > 0) return false;
  return String(message.content ?? '').trim() === '';
}

function makeAdapter(id: string, defaultBase: string, matches: (m: string) => boolean): Provider {
  return {
    id,
    handles: matches,
    async complete(req, ctx) {
      const base = (ctx.baseUrl ?? defaultBase).replace(/\/+$/, '');
      const model = stripPrefix(req.model ?? '');

      const body: Record<string, unknown> = {
        model,
        messages: req.messages,
      };
      if (req.tools?.length) {
        body.tools = req.tools;
        if (req.tool_choice !== undefined) body.tool_choice = req.tool_choice;
      }
      if (typeof req.temperature === 'number') body.temperature = req.temperature;
      if (typeof req.max_tokens === 'number') {
        // Reasoning models renamed the parameter and reject the old one.
        if (/^(o[1-9]|gpt-5)/.test(model)) body.max_completion_tokens = req.max_tokens;
        else body.max_tokens = req.max_tokens;
      }

      const headers: Record<string, string> = { 'content-type': 'application/json' };
      // A local Ollama has no key and rejects nothing; sending an empty bearer
      // is worse than sending none.
      if (ctx.apiKey) headers.authorization = `Bearer ${ctx.apiKey}`;
      if (id === 'openrouter') {
        headers['HTTP-Referer'] = 'https://github.com/Clarittyai/clarity-studio';
        headers['X-Title'] = 'Clarity Studio';
      }

      // A local model that answers with nothing gets another go — see
      // EMPTY_REPLY_RETRIES. Only when tools were offered: a toolless request
      // answering with prose is the normal case, and an empty one there is the
      // model's actual answer rather than a dropped tool call.
      const attempts = id === 'ollama' && req.tools?.length ? EMPTY_REPLY_RETRIES + 1 : 1;
      let data!: ChatCompletionResponse;
      for (let attempt = 1; attempt <= attempts; attempt++) {
        const startedAt = Date.now();
        const res = await fetch(`${base}/chat/completions`, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: ctx.signal,
        });
        if (!res.ok) throw new ProviderHttpError(id, res.status, await res.text());

        data = (await res.json()) as ChatCompletionResponse;
        if (!saidNothing(data) || attempt === attempts) break;
        if (Date.now() - startedAt > RETRY_IF_FIRST_TOOK_UNDER_MS) break;
      }
      // Some OpenAI-compatible servers omit usage entirely. Normalise so cost
      // accounting downstream never has to guard.
      data.usage ??= { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
      return data;
    },
  };
}

function stripPrefix(model: string): string {
  for (const p of ['openai/', 'ollama/', 'openrouter/']) {
    if (model.startsWith(p)) return model.slice(p.length);
  }
  return model;
}

export const openai = makeAdapter('openai', OPENAI, (m) =>
  m.startsWith('gpt-') || m.startsWith('openai/') || /^o[1-9]/.test(m) || m.startsWith('chatgpt'),
);

export const ollama = makeAdapter('ollama', 'http://127.0.0.1:11434/v1', (m) =>
  m.startsWith('ollama/'),
);

export const openrouter = makeAdapter('openrouter', 'https://openrouter.ai/api/v1', (m) =>
  m.startsWith('openrouter/'),
);
