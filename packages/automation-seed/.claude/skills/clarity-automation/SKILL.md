---
name: clarity-automation
description: How a Claritty automation is actually wired — intelligence.yaml, tools, agents, workflows, triggers — and the contracts that make one run instead of merely look right. Use whenever editing intelligence.yaml, adding or changing a tool or agent, wiring an integration, or diagnosing an automation that boots but does nothing.
---

# Building a Claritty automation

`intelligence.yaml` is the automation. Python files are only the bodies it points
at. If a change is not reflected in the manifest, it does not exist at runtime.

## The five things a manifest declares

- **`integrations`** — outside services this automation is allowed to touch.
  Declaring one is what makes its credentials available; the automation never
  sees the secret itself, it calls a brokered tool.
- **`tools`** — deterministic functions. `handler` points at `module:function`,
  or `broker` when the host executes it on your behalf (that is how an
  integration call stays credential-free).
- **`agents`** — the steps that need judgement. An agent has a prompt (inline or
  `prompt_file`) and an explicit list of `tools` it may call. It cannot call
  anything not on that list.
- **`workflows`** — ordered `steps`, each running exactly one `agent` or one
  `tool`. Later steps read earlier output with `${steps.<id>.output.<field>}`.
- **`triggers`** — what starts a workflow without a person: a schedule, or a
  webhook.

## Stay inside this folder

**Do not read outside this project** — not the installed SDK's source, not a
`claritty-core` checkout, not any other repo on this machine. They are not part
of the automation and will not exist for anyone else who opens it. Everything
below is here.

## Where the integrations are

`catalog/integrations/` in THIS repo, one directory per service, each with a
`manifest.json` describing the tools it offers and the arguments they take.
Read the manifest for the service you need — `catalog/integrations/gmail/manifest.json`
for `gmail.send`, and so on — and declare the integration in `intelligence.yaml`
before an agent may call its tools.

Everything needed to build an automation is in this repo. There is no other
checkout to consult and no local Claritty API to run: the catalog ships here,
the runtime is the published `claritty-sdk`, and the host executes brokered
tools on your behalf.

If the service you need is not in `catalog/integrations/`, or Studio shows
"No local connector yet", **do not invent a tool id** — a manifest referencing a
tool nothing implements passes validation, runs, gets skipped, and reports
success. Follow the `add-an-integration` skill and write the connector request
instead.

## What a step may declare

`WorkflowStep` is a **strict** model — an unknown key makes the manifest fail to
load, so do not invent fields. A step has exactly these:

- `id` — required.
- `agent` **or** `tool` — exactly one. Both, or neither, is rejected.
- `input` — the arguments, where `${steps.<id>.output.<field>}` references
  earlier output.
- `mode` — `read` (default), `write`, or `download`. **Set `write` on anything
  that sends, posts, files or changes something.** A dry run stubs writes to a
  preview and only executes them on approval, so a send marked `read` is a real
  email nobody agreed to.
- `onError` — `{ strategy: skip | fail | retry, maxAttempts, fallbackStep }`.
- `forEach` + `as` + `maxIterations` — fan-out. `forEach` points at a list
  (`"${steps.search.output.messages}"`), the step then runs once per item with
  the item bound to `as` (default `item`), so the input can say `${item.id}`.
  `maxIterations` (default 50) is a hard ceiling and the engine reports when it
  truncates.

There is **no `description` on a step.** Write the explanation on the agent or
the tool it calls — those do declare one, and that is what the flow view shows.

**Instructions for a step live in the agent's prompt**, not in the manifest. If a
step needs telling how to behave, it is an agent step and the prompt is where the
telling goes.

## Contracts that are easy to break silently

- **Every id referenced must be declared.** An agent listing a tool that no
  `tools:` entry defines is a dangling reference. It parses; it fails at run.
- **A tool's `handler` must import.** `backend.tools.foo:run` means
  `backend/tools/foo.py` defines `run`. A typo here is a boot failure, not a
  runtime one.
- **An agent needs a prompt.** Either `system_prompt` or `prompt_file`. Neither
  means the automation refuses to boot — deliberately, because an agent with no
  instructions does something arbitrary.
- **Tool functions take a context and return JSON-serialisable data.** Anything
  else cannot be checkpointed, and a step that cannot be checkpointed leaves a
  run with no timeline.
- **Outputs must name real fields.** `${steps.write.output.digest_id}` requires
  the `write` step to actually return `digest_id`.

## The loop that catches these

```bash
claritty-seed-verify .        # the manifest against the code: dangling refs, bad handlers
clarity-studio run --native --simulate   # end to end, no model key, no cost
```

`--simulate` runs the whole workflow with a stubbed model, so the wiring is
proven before a single token is spent. Use it after every structural change —
it is much faster than discovering a dangling reference during a real run.

## What "it runs but does nothing" usually means

- The workflow has no trigger, so nothing ever starts it.
- A step's inputs reference a field the previous step does not return, so it
  receives nothing and exits early.
- An agent has tools it cannot reach because the integration is not connected.
- The tool returned a shape the next step does not read (an id, when the next
  step wanted the record).

Check the run timeline first: it names the step that stopped, which is faster
than reading the code.
