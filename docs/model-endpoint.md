# Pointing Studio at your own model

Settings → Model takes a base URL alongside the key. Set it and every run goes
there instead of the provider's own host — your server, your hardware, your
domain, no code change.

This is what Studio sends, taken from `packages/control-plane/src/providers/openai.ts`
rather than from memory. If your server satisfies it, Studio can drive it.

## The one call

```
POST  {your base URL}/chat/completions
```

The base URL is used verbatim with `/chat/completions` appended, so include the
version segment if your server has one — `https://models.example.com/v1`, not
`https://models.example.com`.

### Headers

```
content-type: application/json
authorization: Bearer <your key>     ← only when a key is set
```

**A missing key means no header at all**, not an empty one. A local server that
needs no authentication should not have to ignore `Bearer `.

### Body

```jsonc
{
  "model": "whatever-you-named-it",
  "messages": [ { "role": "system" | "user" | "assistant" | "tool", "content": "…" } ],

  // Present only when the automation uses them:
  "tools":       [ { "type": "function", "function": { "name", "description", "parameters" } } ],
  "tool_choice": "auto" | { "type": "function", "function": { "name": "…" } },
  "temperature": 0.7,
  "max_tokens":  4096
}
```

Nothing else is sent. No streaming: Studio waits for the whole response, because
a run is a batch job and a half-written answer is not useful to a workflow step.

### Response

```jsonc
{
  "choices": [
    {
      "message": {
        "role": "assistant",
        "content": "…",
        // Required if you accepted `tools` — this is how an agent calls one.
        "tool_calls": [
          { "id": "call_1", "type": "function",
            "function": { "name": "app.collect_items", "arguments": "{\"since_hours\":24}" } }
        ]
      },
      "finish_reason": "stop" | "tool_calls" | "length"
    }
  ],
  "usage": { "prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0 }
}
```

**`usage` is optional.** Studio fills in zeros when it is missing, so a server
that does not count tokens works — you simply get no token analytics for those
runs, rather than a failure.

**`arguments` is a JSON *string***, not an object. That is the OpenAI shape, and
an object there is the most common reason a working server drives agents that
never call a tool.

## What has to work for an agent, specifically

A tool-less workflow needs only `content`. An **agent** step needs real tool
calling: it is a loop, and Studio ends it when the model calls `claritty_finish`.
A server that ignores `tools` and answers in prose will loop until the step's
`maxIterations` and then fail — the automation is not broken, the endpoint is.

Test it with tools before trusting it with an agent.

## Anything else

A non-2xx response is surfaced with your server's own body, uncut, because the
reason is usually in it. If Studio ever hides that, the bug is Studio's.

`pnpm proof:byom` is the gate that a configured base URL actually receives the
run's call — it stands up a server, points Studio at it, fires a workflow and
asserts the request arrived. If you change this contract, that is what should
fail first.
