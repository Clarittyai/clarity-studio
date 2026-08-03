/**
 * Google Gemini adapter, via the OpenAI-compatibility endpoint.
 *
 * Google ships a Chat-Completions-shaped surface that supports tool calling,
 * so we use it rather than translating to `generateContent` by hand. Less
 * surface, fewer places to be subtly wrong about function-call round-tripping.
 */

import type { ChatCompletionResponse, Provider } from '../types.js';
import { ProviderHttpError } from './anthropic.js';

const BASE = 'https://generativelanguage.googleapis.com/v1beta/openai';

export const google: Provider = {
  id: 'google',

  handles(model) {
    return model.startsWith('gemini') || model.startsWith('google/');
  },

  async complete(req, ctx) {
    const model = req.model?.startsWith('google/') ? req.model.slice('google/'.length) : req.model;

    const body: Record<string, unknown> = { model, messages: req.messages };
    if (req.tools?.length) {
      body.tools = req.tools;
      if (req.tool_choice !== undefined) body.tool_choice = req.tool_choice;
    }
    if (typeof req.temperature === 'number') body.temperature = req.temperature;
    if (typeof req.max_tokens === 'number') body.max_tokens = req.max_tokens;

    const res = await fetch(`${(ctx.baseUrl ?? BASE).replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ctx.apiKey}` },
      body: JSON.stringify(body),
      signal: ctx.signal,
    });
    if (!res.ok) throw new ProviderHttpError('google', res.status, await res.text());

    const data = (await res.json()) as ChatCompletionResponse;
    data.usage ??= { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
    return data;
  },
};
