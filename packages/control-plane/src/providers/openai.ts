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
        headers['HTTP-Referer'] = 'https://github.com/Clarittyai/claritty-studio';
        headers['X-Title'] = 'Claritty Studio';
      }

      const res = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: ctx.signal,
      });
      if (!res.ok) throw new ProviderHttpError(id, res.status, await res.text());

      const data = (await res.json()) as ChatCompletionResponse;
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
