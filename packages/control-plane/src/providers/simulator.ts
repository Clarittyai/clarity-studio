/**
 * The simulator — a provider that exercises an automation's wiring without a
 * model, a key, or a cent.
 *
 * This is not only a test fixture. "Dry run" is a first-class Studio feature:
 * it answers *is this automation wired correctly* — do the tools resolve, do
 * the handlers run, does the step piping line up, does the workflow reach a
 * terminal state — which is a different question from *is the prompt any good*
 * and is the one you ask ninety times while building.
 *
 * Strategy: look at the tools the loop offered, work out from the conversation
 * which have already run, and call the next one. When they have all run, call
 * `claritty_finish` with a value synthesised from its declared schema.
 *
 * It deliberately calls tools in declaration order rather than reasoning about
 * intent. A real model may choose differently; that difference is exactly what
 * a dry run is not trying to test.
 */

import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  OpenAiToolCall,
  Provider,
} from '../types.js';

const FINISH = 'claritty_finish';

interface ToolDef {
  type: 'function';
  function: { name: string; description?: string; parameters?: JsonSchema };
}

interface JsonSchema {
  type?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: unknown[];
  description?: string;
}

export function createSimulator(): Provider {
  return {
    id: 'simulator',
    handles: (model) => model === 'simulator' || model.startsWith('simulator/'),

    async complete(req: ChatCompletionRequest): Promise<ChatCompletionResponse> {
      const tools = (req.tools ?? []) as ToolDef[];
      const called = calledToolNames(req);

      const next = tools.find(
        (t) => t.function.name !== FINISH && !called.has(t.function.name),
      );

      const finishDef = tools.find((t) => t.function.name === FINISH);
      const call: OpenAiToolCall = next
        ? {
            id: `sim_${called.size + 1}`,
            type: 'function',
            function: {
              name: next.function.name,
              arguments: JSON.stringify(synthesise(next.function.parameters)),
            },
          }
        : {
            id: `sim_finish`,
            type: 'function',
            function: {
              name: FINISH,
              // Prefer real values the tools actually returned over synthetic
              // ones — a dry run that echoes the pipeline's own output tells
              // you far more about whether the piping works.
              arguments: JSON.stringify(
                harvest(req, synthesise(finishDef?.function.parameters)),
              ),
            },
          };

      // If the loop offered no tools at all there is nothing to exercise, so
      // answer in prose and stop rather than spinning.
      if (tools.length === 0) {
        return envelope(req, { content: '[simulated] no tools offered', finish: 'stop' });
      }

      return envelope(req, { toolCalls: [call], finish: 'tool_calls' });
    },
  };
}

/** Tool names the assistant has already invoked in this conversation. */
function calledToolNames(req: ChatCompletionRequest): Set<string> {
  const names = new Set<string>();
  for (const m of req.messages) {
    if (m.role !== 'assistant') continue;
    for (const tc of m.tool_calls ?? []) names.add(tc.function.name);
  }
  return names;
}

/**
 * Pull real field values out of tool results so the finish payload carries
 * genuine data where the pipeline produced it.
 */
function harvest(req: ChatCompletionRequest, base: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base };
  const wanted = Object.keys(base);
  if (wanted.length === 0) return merged;

  for (const m of req.messages) {
    if (m.role !== 'tool' || !m.content) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(m.content);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== 'object') continue;
    for (const key of wanted) {
      const found = (parsed as Record<string, unknown>)[key];
      if (found !== undefined) merged[key] = found;
    }
  }
  return merged;
}

/** Build a value satisfying a JSON schema. Required fields only — an optional
 *  field left unset is a legitimate shape, and filling it hides bugs. */
function synthesise(schema: JsonSchema | undefined): Record<string, unknown> {
  if (!schema?.properties) return {};
  const required = new Set(schema.required ?? []);
  const out: Record<string, unknown> = {};
  for (const [key, prop] of Object.entries(schema.properties)) {
    if (!required.has(key)) continue;
    out[key] = valueFor(key, prop);
  }
  return out;
}

function valueFor(key: string, schema: JsonSchema, depth = 0): unknown {
  if (schema.enum?.length) return schema.enum[0];
  if (depth > 5) return null;
  switch (schema.type) {
    case 'number':
    case 'integer':
      return 0;
    case 'boolean':
      return false;
    case 'array':
      return [];
    case 'object': {
      const inner: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(schema.properties ?? {})) {
        if ((schema.required ?? []).includes(k)) inner[k] = valueFor(k, v, depth + 1);
      }
      return inner;
    }
    default:
      return `[simulated ${key}]`;
  }
}

function envelope(
  req: ChatCompletionRequest,
  opts: { content?: string; toolCalls?: OpenAiToolCall[]; finish: 'stop' | 'tool_calls' },
): ChatCompletionResponse {
  // Rough but honest: the simulator reports the size of what it was given so
  // the run timeline still shows a token shape, with zero cost attached.
  const promptTokens = Math.ceil(JSON.stringify(req.messages).length / 4);
  return {
    id: `sim_${Date.now().toString(36)}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: 'simulator',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: opts.content ?? null,
          ...(opts.toolCalls ? { tool_calls: opts.toolCalls } : {}),
        },
        finish_reason: opts.finish,
      },
    ],
    usage: { prompt_tokens: promptTokens, completion_tokens: 0, total_tokens: promptTokens },
  };
}
