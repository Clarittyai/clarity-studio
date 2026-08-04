---
name: run-on-claritty
description: What an automation needs in order to run on Claritty's hosted platform rather than only on this machine — always-on schedules, brokered integration credentials, and per-run cost accounting. Use when the user asks to deploy, publish, host, or "make it run without my laptop open", or when deciding between the local runtime and the cloud.
---

# Running it on Claritty

The same automation runs in two places, unchanged. That is the point of the
manifest: it describes what should happen, not where.

- **Locally, in Studio.** Your machine, your keys, your data. Schedules fire only
  while Studio is open, because there is nothing else to fire them.
- **On Claritty.** Always-on. Schedules fire whether or not anything of yours is
  running, webhooks have a stable public URL, integration credentials are brokered
  server-side, and every run is metered.

Nothing in the automation changes between the two. If it needs editing to be
hosted, something in it is wrong for local too.

## What the hosted runtime requires

- **A declared trigger.** Locally you can press Run. Hosted, a workflow with no
  trigger will never fire on its own — it is reachable only by webhook or by hand.
- **Integrations declared, not hardcoded.** A hosted run gets its credentials from
  the broker. An automation that reads `os.environ["GMAIL_TOKEN"]` works on the
  laptop that has that variable and nowhere else. Declare the integration and call
  the brokered tool.
- **No machine-local paths.** Anything written to a path that only exists on your
  laptop is lost. Use the app's data directory, or a storage tool.
- **Deterministic boot.** The manifest must verify clean: dangling references
  fail a hosted deploy the same way they fail `claritty-seed-verify`.

## Costs read differently in the two places

Locally, model calls spend whatever key is in the vault, and Studio shows the
cost per run so it is never a surprise. Hosted, runs are metered against the
workspace. Same accounting, different payer — which is why the run timeline
reports tokens and cost in both.

Authoring is separate from either. Writing the automation happens in your own
Claude Code session on your own plan; it does not touch the automation's key and
does not draw on its run budget.

## Before handing one over

```bash
claritty-seed-verify .                    # clean, no dangling references
clarity-studio run --native --simulate    # the whole workflow, end to end
```

Then run it once for real locally. An automation that has never completed a real
run has not been tested — simulation proves the wiring, not the integration.
