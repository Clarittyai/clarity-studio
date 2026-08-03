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

## Quickstart

Needs **Node 22+**. Python 3.9+ and Docker are optional — see below.

```bash
pnpm setup                       # checks the machine, builds, prepares Python
pnpm spike                       # proves an automation runs against the local control plane
```

Then make one and run it:

```bash
node apps/cli/dist/index.js new my-automation
cd my-automation

# Check the wiring — no model, no key, nothing spent
node ../apps/cli/dist/index.js run --native --simulate
```

```
✓ my-automation v1.0.0 on http://127.0.0.1:33000
→ running daily-digest…

  Run timeline
  ──────────────────────────────────────────────────────────────────────
  ● write                success   213ms
  ──────────────────────────────────────────────────────────────────────
  3 model call(s) · 1515 in / 0 out · $0.00 · 0.3s wall
✓ workflow succeeded — {"digest_id":"dg_9bbe05dce9b1", …}
```

To run it for real, give the control plane a key and drop `--simulate`:

```bash
export ANTHROPIC_API_KEY=sk-ant-…      # or OPENAI_API_KEY / GOOGLE_API_KEY
node ../apps/cli/dist/index.js run --native
```

Now open the folder in Claude Code or Codex and tell it what you actually want
the automation to do. `CLAUDE.md`, `AGENTS.md` and `.cursorrules` are already
there, so the agent knows the rules; `/claritty-new-automation` and
`/claritty-convert` are ready as slash commands.

**Two runtimes.** `--native` uses a local Python virtualenv, so Studio is
useful a minute after download on a machine that has never seen Docker. Drop
the flag and it runs the automation in its container instead — the same one it
would run in on a server, which is what you want before you trust it with a
schedule.

**About your keys.** They are read by the local control plane and *never* given
to the automation. The container gets a local, revocable token and nothing
else, so a compromised image yields no credential. That is the same trust model
the hosted platform uses, which is why an automation that works here works
unchanged anywhere.

### Make it run on its own

This is the part other agent harnesses don't do.

```bash
node ../apps/cli/dist/index.js trigger add --daily 09:00
node ../apps/cli/dist/index.js serve --native
```

`serve` holds the automation up, ticks every 15 seconds, and fires anything
that's due. Close the terminal and nothing runs — that's a property of your
laptop, not a limitation we chose. When Studio starts again it tells you what
it missed rather than pretending nothing happened.

Webhooks land on the same process:

```bash
node ../apps/cli/dist/index.js trigger add on-event      # a WEBHOOK trigger
# → http://127.0.0.1:4319/webhooks/<instance-id>
curl -X POST http://127.0.0.1:4319/webhooks/<id> -d '{"hello":"world"}'
```

Every delivery is stored whole — headers and body — **before** it is forwarded.
So when one fails at 2am, you don't ask the sender to please do it again:

```bash
node ../apps/cli/dist/index.js deliveries
node ../apps/cli/dist/index.js replay <delivery-id>
```

Deliveries that arrive while the automation is down are still recorded, and
answered with a 503 rather than a 404 — nothing is lost, and you replay them
once it's back.

Other commands: `doctor` (check this machine), `ps` (your automations),
`runs` (recent runs with cost), `trigger ls|rm`, `up`, `help`.

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
| Survives DST without drifting | ❌ | ✅ |
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

- ✅ **M0** — local control plane + automation seed
- ✅ **M1** — local store, Docker and native runtimes, the `claritty-studio` CLI
- ✅ **M4** — scheduler, webhook ingress and replay
- ✅ **M2** — Electron shell, design system, run timeline as a waterfall
- ✅ **M3** — credential vault, connector engine, eight integrations
- ◐ **M5** — intelligence canvas and agent detection done; embedded terminal outstanding
- **M6** — import & convert existing agents, signed installers ← next

## Working on Studio itself

`CLAUDE.md` in the repo root is the contract for anyone — human or agent —
changing this codebase: architecture, invariants, the traps that cost real time
to find, six ways the upstream SDK's own docs are wrong, and an honest list of
what has never been executed. `AGENTS.md` is the short version.

If you open this repo in Claude Code, Codex or Cursor, they read those on their
own. `.claude/settings.json` pre-approves the build and test commands so a
session is not stopped for permission on every `pnpm test`.

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
