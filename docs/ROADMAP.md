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

## M2 — the window ✅

- `packages/design` — tokens and the `glass-*` recipes **generated** from
  `clarity-platform`, with a Tailwind preset that is hand-written but whose
  load-bearing constants are asserted against upstream on every CI run. The one
  that matters most is `md: 920px`: it is not Tailwind's default, and getting it
  wrong breaks every layout in a way that looks like a styling mistake.
- `apps/desktop` — Electron shell, sidebar, project overview, triggers, and the
  run list with a **waterfall** timeline laid out against the run's own span, so
  where the time went is visible rather than inferred.
- Security posture asserted, not assumed: `contextIsolation` on, `sandbox` on,
  `nodeIntegration` off, a self-only CSP, navigation blocked. A test checks that
  `window.require` and `window.process` are genuinely absent in the renderer.
- Verified by launching the real app under xvfb and screenshotting it, in both
  themes, against real store rows rather than fixtures.

**The constraint this turned up:** `node:sqlite` needs Node 22, so the desktop
app requires **Electron 35+**. Electron 33 bundles Node 20 and dies at load with
`ERR_UNKNOWN_BUILTIN_MODULE` — which reads like a packaging bug rather than a
version floor. Recorded in `packages/db/src/schema.ts` next to the decision that
caused it.

Still to come here: live log streaming, and wiring Start/Stop/Run in the window
(they currently say plainly that they are CLI-only rather than doing nothing).

## M3 — keys and connectors ✅

- `packages/vault` — three backends: Electron `safeStorage` (the real one, OS
  keyring), scrypt + AES-256-GCM from a passphrase for headless use, and
  read-only env for CI. **When encryption is unavailable it refuses to store**
  rather than quietly writing plaintext; a user who believes their key is
  encrypted and later finds it in a file has been lied to.
- `packages/connectors` — the declarative HTTP engine. Two rules are enforced
  in the engine rather than left to spec authors: a credential can never be
  interpolated into a URL (URLs reach logs, errors and run history), and the
  target must be a public host (nine SSRF cases tested, including the cloud
  metadata endpoint). An explicit `allowPrivateHosts` opt-in exists for people
  automating something they self-host.
- Eight integrations, chosen by one criterion: you can get a working credential
  in under a minute without registering an OAuth app.
- CLI: `keys set|ls|rm`, `integrations`, `connect`.
- `pnpm proof:integrations` drives the whole chain end to end against a real
  HTTP server and asserts the payload arrived.

**Worth knowing:** the simulator proves *wiring*, not argument quality. Running
the same automation through it reported success while calling nothing useful,
because synthesised arguments produced an empty URL. A dry run answers "is this
connected correctly", never "will the model pass sensible values".

Still to come: OAuth for the providers that permit a loopback redirect, and MCP
servers (which work today via the SDK, but are not yet surfaced in Studio).

## M4 — schedules and webhooks

Trigger instances, schedule maths with timezones, the 15-second dispatch tick,
webhook ingress with an optional tunnel, delivery log with **replay**.

*Demo: a 9am automation that actually fires, and a webhook you can replay.*

## M5 — authoring (partly done)

Done:

- `packages/graph` — `intelligence.yaml` → canvas nodes and edges, flowing the
  way the automation runs. It renders **what is broken**, not only what exists:
  a step pointing at a deleted agent becomes a dashed "not declared" node rather
  than silently vanishing, which is the bug you opened the canvas to find.
  Carries the same checks the runtime enforces at boot — agents with no
  instructions, triggers firing nothing or two things, workflows with no steps,
  and an agent calling an integration tool it never granted itself.
- `packages/agent-bridge` — detects `claude`, `codex`, `gemini`, `cursor-agent`,
  `opencode` and `aider`, and composes the opening prompt. The prompt is
  deliberately short: the project already carries its rules in `CLAUDE.md` and
  `AGENTS.md`, and a second copy would waste context and drift.
- The canvas in the desktop app.

Not done — **the embedded terminal**. A real terminal needs a pty, and
`node-pty` is a native module, which cuts against the rule that made the store
use `node:sqlite`. The resolution is that they serve different audiences:
`node-pty` will be a dependency of the **desktop app only**, where people
install a signed binary with prebuilds inside and never run `npm install`. The
CLI and everything it depends on stay native-free. Until that lands, Studio
detects your agent and tells you what to run; it does not host it.

Also outstanding: worktree isolation per session, the manifest editor, and
verify-on-save.

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
