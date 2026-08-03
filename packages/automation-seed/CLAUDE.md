# Building this automation

You are editing a **Claritty automation**. It is not a web app and not a
library. It is a declarative manifest plus a small amount of Python, run by
`claritty-sdk`. Read this file before changing anything.

## The shape of the thing

`intelligence.yaml` is the source of truth. Everything the automation can do is
declared there, in five primitives:

| Primitive | Is | Is not |
|---|---|---|
| **integration** | a credential this automation needs | a piece of code |
| **tool** | a callable action — deterministic, no model call | a decision |
| **agent** | a prompt that decides which tools to call | a place to put business logic |
| **workflow** | a DAG of steps, each running one agent or one tool | a script |
| **trigger** | the external dispatcher that fires ONE workflow or agent | something the automation runs itself |

The runtime validates all of this at boot and **refuses to start** if it does
not hold together. That is a feature: fix the manifest, don't work around it.

## Rules you must not break

**Manifest**
- Declare every primitive in `intelligence.yaml`. Never create a
  `backend/workflows/*.py` — workflows are YAML, not code.
- The schema is strict; unknown keys are rejected. Tools and workflows have
  **no** `name` or `description` field. Put prose in YAML comments.
- Ids are stable. Renaming one breaks every reference to it and any schedule a
  user already configured.

**Agents**
- An agent has exactly one instruction source: `promptFile` (preferred) or
  `systemPrompt`. Never both, never neither.
- Never write an `execute()` method. The runtime never calls it, so the agent
  would silently do nothing.
- Every tool in `tools:` must be **named in the prompt**. A tool that is listed
  but never mentioned is never called — this is the single most common way an
  automation ends up looking like it works and doing nothing.
- To use an integration's tool, list the exact dotted id (`gmail.send`) in the
  agent's `tools:` **and** declare `gmail` in the top-level `integrations:`.
  Declaring the integration alone grants nothing.
- End every prompt with an explicit final step: call `claritty_finish` with the fields
  declared in the agent's `output:`.

**Tools**
- `@tool(id="...")` on a `def run(input, ctx) -> dict`. The decorator id must
  equal the manifest id.
- Return a dict matching the declared `output:`. Never return `None`, never
  leave a `NotImplementedError` stub.
- Reach the outside world **only** through `ctx.integration("<id>")`. Never
  read an API key from the environment — credentials belong in the vault, and a
  key in your code cannot be rotated, scoped or revoked.
- Do not call a model from a tool. Tools act; agents decide.

**Workflows**
- Each step sets exactly one of `agent:` or `tool:`.
- Every `${...}` must resolve: `${input.x}` to a declared workflow input,
  `${steps.s.output.k}` to an **earlier** step whose output schema has `k`.
  A forward or misspelled reference fails on every single run.
- Use `onError: {strategy: skip}` or `{strategy: retry}` where a step is
  genuinely optional. Silent failure is not a strategy.

**Triggers**
- `SCHEDULE` needs `supportedSchedules` plus `configFields` containing
  `timezone`, and `time` unless the only mode is `INTERVAL`.
- `WEBHOOK` needs a `webhook_secret` configField.
- A trigger fires exactly one `workflow` **xor** one `agent`. Never both, never
  another trigger.
- Never hardcode a cron string. Cadence is the user's choice and lives in
  `configFields`.

**Runtime**
- No background threads, no `asyncio.create_task`, no in-process scheduler, no
  `while True`. The host fires triggers; the automation just answers.
- Nothing durable on local disk — the container is disposable.
- Every persisted row carries a `user_id`.

## Working loop

After any change:

```bash
claritty-seed-verify .     # offline gate: manifest semantics + secret scan
```

Fix everything it reports before moving on. Then run it for real:

```bash
docker compose up --build
curl -X POST localhost:3200/api/workflows/daily-digest/execute \
     -H 'content-type: application/json' -d '{"inputs":{}}'
```

Inside Claritty Studio, both of these are buttons, and the run appears as a
step-by-step trace with the model calls and their cost.

## Converting an existing agent

If you were pointed at a repo that already contains an agent (LangChain,
CrewAI, a cron script, an MCP server), do **not** rewrite it. Instead:

1. Inventory its entry points, its prompts, and every place it causes a side
   effect.
2. Draft an `intelligence.yaml` that maps those onto the five primitives: side
   effects become tools, prompts become agents, the entry point becomes a
   workflow, the cron/webhook becomes a trigger.
3. Write thin `@tool` adapters that call the existing functions unchanged.
4. Move credentials out of the code and into `ctx.integration(...)`.
5. Loop on `claritty-seed-verify` until clean.

The user keeps their code and gains a schedule, traces, a credential vault and
a cost ledger. Rewriting their logic is a failure of the conversion, not a
success.

## Where to look

- `intelligence.yaml` — the automation
- `backend/tools/` — what it can do
- `backend/agents/*.md` — how it decides
- `backend/main.py` — framework; you should rarely need to touch it
- `docs/INTELLIGENCE_YAML.md` — the full manifest spec
