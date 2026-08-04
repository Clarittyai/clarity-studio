---
name: claritty-automation
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
