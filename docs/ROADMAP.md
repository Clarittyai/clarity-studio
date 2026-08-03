# Roadmap

Ordered so the riskiest unknown dies first. Each milestone ends in something
you can actually demo, not a refactor.

## M0 — the local control plane ✅

**The gate.** Claritty Studio rests on one claim: an automation's dependency on
the hosted platform is a small, stable HTTP contract, so a local server can
stand in for it and run the automation unmodified.

Done:

- `packages/control-plane` — Fastify server implementing the contract:
  `/api/v1/chat/completions`, `/internal/integrations/{credentials/fetch,state}`,
  `/internal/workflow-runs/:id/{checkpoint,complete}`, `/v1/traces`,
  `/webhooks/:instanceId`. Dual-header auth, per-project identity, secret
  redaction, egress blocking, budget ceilings, cost accounting.
- Provider adapters: Anthropic, OpenAI, Google, Ollama, OpenRouter, plus a
  **simulator** that exercises an automation's wiring with no key and no spend.
- `packages/automation-seed` — the MIT seed: `intelligence.yaml`, headless
  FastAPI surface, example tool/agent/workflow/trigger, Dockerfile with a
  build-time boot smoke, and the authoring contract (`CLAUDE.md`, `AGENTS.md`,
  `.cursorrules`, `.claude/commands/`).
- `packages/orchestrator` — compose override generation and host-port
  allocation.
- `pnpm spike` — boots the seed against the control plane using `claritty-sdk`
  straight from PyPI and asserts the run timeline is reconstructable from
  checkpoints alone. Runs in CI on every commit.

Three things this turned up that the platform docs get wrong, and that anyone
building on the SDK needs to know:

1. The finish tool is **`claritty_finish`**, not `__finish`.
2. The manifest schema is stricter than documented — `tools[]` and
   `workflows[]` have **no** `name` or `description` field.
3. `AgentDecl.model` defaults to `claude-sonnet-4-6`, so an automation always
   names a model even when the author didn't. Studio therefore needs an
   explicit model override, not just a fallback — otherwise someone holding
   only an OpenAI key could never run a manifest written against Claude.

## M4 — schedules and webhooks ✅

*(Brought forward. A trigger that actually fires is what makes this an
automation tool rather than a nicer way to run scripts, and it needs no UI to
demo — so it was worth finding the flaws here before building screens on top.)*

- `packages/scheduler` — next-fire maths for ONE_TIME / INTERVAL / DAILY /
  WEEKLY / MONTHLY across real IANA zones, with no date library. Handles the
  two days a year that break naive schedulers: a local time skipped by
  spring-forward still fires, and the hour repeated by fall-back fires once.
- The dispatch tick: finds due instances, dedupes on `(trigger, scheduled
  instant)`, fires them independently so one failure can't stop the rest, and
  always reschedules — a failed run must never leave an instance stuck due.
- Missed windows are counted, not swallowed. Default is to skip and record.
- Webhook ingress with **replay**. Every delivery stored whole before
  forwarding; inbound `authorization` and `cookie` headers are dropped while
  provider signature headers survive.
- CLI: `trigger add|ls|rm`, `serve`, `deliveries`, `replay`.

## M1 — the app

Electron shell, design tokens extracted from `clarity-platform` with a CI drift
gate, Launchpad, create-from-seed, start/stop/rebuild, live log streaming,
SQLite store.

*Demo: create an automation in the app, watch it build, open it on localhost.*

## M2 — observability

OTLP receiver, run list, run timeline waterfall, per-step inputs and outputs,
model messages, token and cost accounting, re-run and re-run-from-step.

*Demo: run a workflow and see exactly what it did and what it cost.*

## M3 — keys and connectors

OS-keychain vault, provider routing from stored keys, the declarative HTTP
connector engine plus the first API-key connectors, MCP server support.

*Demo: an automation that searches the web and posts to Slack, on your keys.*

## M4 — schedules and webhooks

Trigger instances, schedule maths with timezones, the 15-second dispatch tick,
webhook ingress with an optional tunnel, delivery log with **replay**.

*Demo: a 9am automation that actually fires, and a webhook you can replay.*

## M5 — authoring

Embedded terminal, coding-agent detection and worktrees, manifest editor with
the validation gates, intelligence canvas, verify-on-save.

*Demo: tell Claude Code "add a Slack step" and watch the canvas grow a node.*

## M6 — import, convert, ship

Import from GitHub, the convert-an-existing-agent flow, export, loopback OAuth
for the providers that permit it, egress modes, signed installers.

*Demo: import someone else's agent, convert it, run it, schedule it.*

## Not planned

- **Accounts, login, or a hosted backend.** Studio is local software. If it
  ever needs a server to work, something has gone wrong.
- **Telemetry.** Not even opt-in, for now. "No telemetry" is a cleaner promise
  than "telemetry, but off by default", and nothing about the product needs it.
- **A generation pipeline.** Studio hands the job to whichever coding agent you
  already use rather than shipping a worse one.
