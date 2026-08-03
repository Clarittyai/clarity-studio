# Claritty Studio

**Build, run, schedule and observe AI automations on your own machine, with your own keys.**

Claritty Studio is an open-source desktop app for agentic automations — the ones that keep working
after you close the laptop lid. Write them with the coding agent you already use, run them in Docker,
give them real schedules and webhooks, connect them to real services, and watch every step, token and
dollar they spend.

> **No accounts. No login. No telemetry. No phoning home.**
> Studio talks to exactly two kinds of remote host: the LLM provider whose key *you* configured, and
> the third-party APIs *your* automation calls. Nothing else, ever.

---

## Why this exists

Agent harnesses today are development scratchpads — great for running coding agents side by side,
useless the moment you want something to happen at 9am on Tuesday. Studio is built for the other
half: automations that run on a schedule, react to webhooks, hold credentials, and need to be
debugged six weeks after you wrote them.

|  | Coding-agent harnesses | **Claritty Studio** |
|---|---|---|
| Runs agents in parallel | ✅ | ✅ |
| Git worktree isolation | ✅ | ✅ |
| Fires on a schedule | ❌ | ✅ |
| Webhook ingress + **replay** | ❌ | ✅ |
| Credential vault for third-party APIs | ❌ | ✅ |
| Per-step run traces, tokens and cost | ❌ | ✅ |
| Portable artifact you can host anywhere | ❌ | ✅ |

## How it works

Every automation is a plain git repo containing an **`intelligence.yaml`** — a declarative manifest of
five primitives:

```yaml
schemaVersion: 2
id: overdue-invoice-chaser

integrations: [{ id: gmail, required: true }]

tools:
  - id: app.list_overdue
    handler: backend.tools.list_overdue:run
    output: { invoices: { type: array, required: true } }

agents:
  - id: chaser
    tools: [app.list_overdue, gmail.send]
    promptFile: backend/agents/chaser.md

workflows:
  - id: chase
    steps: [{ id: run, agent: chaser }]

triggers:
  - id: weekday-morning
    type: SCHEDULE
    workflow: chase
    supportedSchedules: [DAILY]
    configFields:
      - { key: time, type: time, required: true, label: "Run at", default: "09:00" }
      - { key: timezone, type: timezone, required: true, label: "Timezone" }
```

The runtime that executes this is [`claritty-sdk`](https://pypi.org/project/claritty-sdk/) (MIT, on
PyPI). Studio runs a **local control plane** on `127.0.0.1:4319` that serves the SDK everything it
needs — model calls routed to your own provider key, credentials from your OS keychain, run
checkpoints, traces — so the automation runs unmodified on your machine.

That last property is the point: the automation is a portable artifact. `docker compose up` works
without Studio. Your own server works. So does Claritty Cloud, if you ever want always-on schedules.
Nothing here locks you in either direction.

## Status

Pre-alpha, built in the open. See [`docs/ROADMAP.md`](docs/ROADMAP.md).

- **M0 — local control plane + automation seed** ← we are here
- M1 — Electron shell, project lifecycle, live logs
- M2 — run timeline, traces, token/cost accounting
- M3 — credential vault, BYO provider routing, connectors, MCP
- M4 — scheduler, webhook ingress and replay
- M5 — embedded terminal, coding-agent bridge, intelligence canvas
- M6 — import & convert existing agents, signed installers

## Repository layout

```
apps/desktop/              Electron app
apps/cli/                  claritty-studio — the same core, headless
packages/control-plane/    the local Claritty runtime the SDK talks to
packages/orchestrator/     Docker lifecycle, ports, logs, health
packages/automation-seed/  the MIT seed every new automation starts from
packages/connectors/       declarative HTTP connector engine + specs
packages/vault/            OS-keychain-backed secret store
packages/manifest/         intelligence.yaml schema + validation gates
packages/design/           design tokens and primitives
packages/agent-bridge/     detect and drive claude / codex / gemini / cursor
packages/graph/            manifest → canvas graph
packages/db/               local SQLite store
```

## License

MIT. Built by the team behind [Claritty](https://claritty.ai).
