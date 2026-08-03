/**
 * Anthropic adapter.
 *
 * Translates OpenAI Chat Completions (what the SDK speaks) to the Messages API
 * and back. The two fiddly parts, both of which produce silent misbehaviour if
 * you get them wrong:
 *
 * 1. **Tool results are user turns.** OpenAI models them as `role: "tool"`
 *    messages; Anthropic models them as `tool_result` content blocks inside a
 *    user turn, and consecutive results must be merged into ONE turn or the API
 *    rejects the conversation.
 * 2. **`temperature` must be absent while thinking is on.** Anthropic pins it
 *    to 1 and errors if you also send a value. The SDK already omits it, and we
 *    must not add one back.
 */

import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatMessage,
  OpenAiToolCall,
  Provider,
} from '../types.js';

const API = 'https://api.anthropic.com/v1/messages';
const VERSION = '2023-06-01';

interface AnthropicBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
}

export const anthropic: Provider = {
  id: 'anthropic',

  handles(model) {
    return model.startsWith('claude') || model.startsWith('anthropic/');
  },

  async complete(req, ctx) {
    const model = stripPrefix(req.model ?? '');
    const { system, messages } = toAnthropicMessages(req.messages);

    const body: Record<string, unknown> = {
      model,
      messages,
      // Anthropic requires max_tokens. The SDK often omits it; 4096 is a sane
      // ceiling for an agent turn and cheap to raise per-agent.
      max_tokens: req.max_tokens ?? 4096,
    };
    if (system) body.system = system;
    if (req.thinking) {
      body.thinking = req.thinking;
    } else if (typeof req.temperature === 'number') {
      body.temperature = req.temperature;
    }
    if (req.tools?.length) {
      body.tools = toAnthropicTools(req.tools);
      const tc = toAnthropicToolChoice(req.tool_choice);
      if (tc) body.tool_choice = tc;
    }

    const res = await fetch(ctx.baseUrl ?? API, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': ctx.apiKey,
        'anthropic-version': VERSION,
      },
      body: JSON.stringify(body),
      signal: ctx.signal,
    });

    if (!res.ok) {
      throw new ProviderHttpError('anthropic', res.status, await res.text());
    }

    const data = (await res.json()) as {
      id: string;
      model: string;
      content: AnthropicBlock[];
      stop_reason: string;
      usage: { input_tokens: number; output_tokens: number };
    };

    const text = data.content.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('');
    const toolCalls: OpenAiToolCall[] = data.content
      .filter((b) => b.type === 'tool_use')
      .map((b) => ({
        id: b.id ?? '',
        type: 'function' as const,
        function: { name: b.name ?? '', arguments: JSON.stringify(b.input ?? {}) },
      }));

    return {
      id: data.id,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: data.model,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: text || null,
            ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
          },
          finish_reason: data.stop_reason === 'tool_use' ? 'tool_calls' : 'stop',
        },
      ],
      usage: {
        prompt_tokens: data.usage.input_tokens,
        completion_tokens: data.usage.output_tokens,
        total_tokens: data.usage.input_tokens + data.usage.output_tokens,
      },
    };
  },
};

export class ProviderHttpError extends Error {
  constructor(
    readonly provider: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(`${provider} returned ${status}: ${body.slice(0, 400)}`);
    this.name = 'ProviderHttpError';
  }
}

function stripPrefix(model: string): string {
  return model.startsWith('anthropic/') ? model.slice('anthropic/'.length) : model;
}

export function toAnthropicMessages(messages: ChatMessage[]): {
  system?: string;
  messages: Array<{ role: 'user' | 'assistant'; content: AnthropicBlock[] }>;
} {
  const systemParts: string[] = [];
  const out: Array<{ role: 'user' | 'assistant'; content: AnthropicBlock[] }> = [];

  const pushBlocks = (role: 'user' | 'assistant', blocks: AnthropicBlock[]) => {
    if (blocks.length === 0) return;
    const last = out[out.length - 1];
    // Merge into the previous turn when the role matches. This is what makes
    // consecutive tool results land in a single user turn, as Anthropic wants.
    if (last && last.role === role) last.content.push(...blocks);
    else out.push({ role, content: blocks });
  };

  for (const m of messages) {
    if (m.role === 'system') {
      if (m.content) systemParts.push(m.content);
      continue;
    }

    if (m.role === 'tool') {
      pushBlocks('user', [
        {
          type: 'tool_result',
          tool_use_id: m.tool_call_id ?? '',
          content: m.content ?? '',
        },
      ]);
      continue;
    }

    if (m.role === 'assistant') {
      const blocks: AnthropicBlock[] = [];
      if (m.content) blocks.push({ type: 'text', text: m.content });
      for (const tc of m.tool_calls ?? []) {
        blocks.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.function.name,
          input: parseJson(tc.function.arguments),
        });
      }
      pushBlocks('assistant', blocks);
      continue;
    }

    pushBlocks('user', [{ type: 'text', text: m.content ?? '' }]);
  }

  // The Messages API rejects an empty conversation, and an agent loop can
  // legitimately reach here with system-only input on its first turn.
  if (out.length === 0) out.push({ role: 'user', content: [{ type: 'text', text: 'Begin.' }] });

  return { ...(systemParts.length ? { system: systemParts.join('\n\n') } : {}), messages: out };
}

function toAnthropicTools(tools: unknown[]): unknown[] {
  return tools.map((t) => {
    const fn = (t as { function?: { name: string; description?: string; parameters?: unknown } })
      .function;
    if (!fn) return t;
    return {
      name: fn.name,
      description: fn.description ?? '',
      input_schema: fn.parameters ?? { type: 'object', properties: {} },
    };
  });
}

function toAnthropicToolChoice(choice: unknown): unknown {
  if (choice === 'auto') return { type: 'auto' };
  if (choice === 'required') return { type: 'any' };
  if (choice && typeof choice === 'object') {
    const name = (choice as { function?: { name?: string } }).function?.name;
    if (name) return { type: 'tool', name };
  }
  return undefined;
}

function parseJson(s: string): unknown {
  try {
    return JSON.parse(s || '{}');
  } catch {
    return {};
  }
}
