# Working on Clarity Studio

You are working on **Clarity Studio**: an open-source, local-first desktop app
for building, running, scheduling and observing AI automations. It is a pnpm
monorepo. Read this before changing anything — several constraints here were
discovered the expensive way and are not obvious from the code.

Do not confuse this file with `packages/automation-seed/CLAUDE.md`. That one is
shipped **to users** and governs the automations they write. This one governs
the tool itself.

---

## Getting it running

```bash
pnpm setup      # checks the machine, installs, builds, prepares the Python venv
pnpm test       # 155 tests across 8 packages
pnpm spike      # the M0 gate — an unmodified SDK automation on a local control plane
pnpm proof:integrations   # an automation reaching a real HTTP service
```

`pnpm setup` is safe to re-run and explains anything it can't do.

**Requirements:** Node 22+ is the only hard one. Python 3.9+ is needed for
`--native` runs and both proofs. Docker is optional. If a command fails, run
`node apps/cli/dist/index.js doctor` before assuming the code is broken.

### Trying the product

```bash
node apps/cli/dist/index.js new my-automation
cd my-automation
node ../apps/cli/dist/index.js run --native --simulate
```

`--simulate` uses a fake model provider, so it needs no key and costs nothing.
Drop it and set `ANTHROPIC_API_KEY` (or `OPENAI_API_KEY`) for a real run.

Seeing the window:

```bash
pnpm --filter @clarity-studio/desktop build
cd apps/desktop && npx electron .
# headless: xvfb-run -a npx electron . --no-sandbox
```

---

## The one idea the whole thing rests on

A Clarity automation is a Python project that runs on
[`claritty-sdk`](https://pypi.org/project/claritty-sdk/) (MIT, on PyPI). When
deployed, that SDK expects a *platform* behind `CLARITTY_PLATFORM_URL` to give
it three things: a model to call, credentials to use, and somewhere to report
each step.

**`packages/control-plane` is that platform, running on `127.0.0.1`.** The
automation cannot tell the difference. That is why an automation written here
runs unchanged anywhere else, and why Studio needs no fork of the SDK.

If you break the shape of those HTTP endpoints, automations stop working in a
way no unit test will catch. `pnpm spike` is the guard — it boots a real
automation against a real control plane and fails if the contract drifts.

---

## Layout

| Package | What it is |
|---|---|
| `packages/control-plane` | The local platform. Model routing, credentials, run checkpoints, traces, webhook ingress. |
| `packages/orchestrator` | Runs an automation: Docker (real) or a Python venv (`--native`). Compose overrides, port allocation, health. |
| `packages/scheduler` | Next-fire maths, the 15s dispatch tick, webhook delivery and replay. |
| `packages/vault` | Credential storage. OS keyring, passphrase, or read-only env. |
| `packages/connectors` | Declarative HTTP connector engine + the catalog of integrations. |
| `packages/db` | The local SQLite store. Also implements the control plane's `RunStore`. |
| `packages/graph` | `intelligence.yaml` → canvas nodes and edges, including what is broken. |
| `packages/agent-bridge` | Detects installed coding CLIs and composes the opening prompt. |
| `packages/design` | Design tokens, generated from the Clarity platform. |
| `packages/automation-seed` | **Shipped to users.** The template every new automation starts from. |
| `apps/cli` | `clarity-studio`. Same core as the app, no window. |
| `apps/desktop` | Electron. Read-only over the store today. |

---

## Invariants — do not break these

**No provider key ever enters an automation's container.** The container gets a
local, revocable token and nothing else, so a compromised image yields no
credential. `packages/control-plane/src/server.test.ts` asserts it. This mirrors
the hosted platform, which is *why* local and deployed behave identically.

**The vault refuses rather than degrades.** If the OS keyring is unavailable it
throws; it never silently writes plaintext. A user who believes their key is
encrypted and later finds it in a file has been lied to.

**A credential can never be interpolated into a URL.** URLs reach logs, error
messages, referrers and run history. `packages/connectors/src/engine.ts` rejects
any spec that tries.

**Connectors reach public hosts only**, unless `allowPrivateHosts` is explicitly
set. Nine SSRF cases are tested including the cloud metadata endpoint. That
switch is never settable from a spec or a tool argument.

**No accounts, no login, no telemetry.** A CI job greps the built output for
`claritty.ai` and `auth0.com` and fails if runtime code reaches either. Links in
markdown and the About box are fine; call sites are not.

**No native modules outside the desktop app.** See the trap below.

---

## One `t` is ours, two `t`s are upstream

The product is **Clarity Studio**, one `t`. Everything this repo owns spells it
that way: `@clarity-studio/*`, the `clarity-studio` binary, the `ai.clarity.studio.*`
Docker labels, the `/clarity-*` slash commands, all prose.

Everything the **SDK** reads still has two, because it is a published package we
do not control. Renaming any of these turns a working automation into a broken
one with no error message:

`claritty-sdk` · `claritty_sdk.*` · `CLARITTY_*` env vars · `X-Claritty-*` headers ·
`claritty_finish` · `claritty-seed-verify` · the `claritty.*` OTel attribute
namespace · `gen_ai.system = claritty-proxy`

Also left alone deliberately: the `Clarittyai` GitHub org and the `claritty.ai`
domain, which are live addresses — a "fix" there is a dead link.

So: if a token is read by Python, leave it. If it names something we ship, one `t`.

---

## Traps

These cost real time to find. None are visible from the code that causes them.

**`node:sqlite` forces Electron 35+.** The store uses Node's built-in SQLite so
that installing Studio never needs a C++ toolchain. Electron 33 bundles Node 20
and dies at load with `ERR_UNKNOWN_BUILTIN_MODULE: node:sqlite`, which reads
like a packaging bug rather than a version floor. Electron is pinned to `^37`.
Do not downgrade it without swapping the driver.

**`node:sqlite` is invisible to Vite 5.** It is imported through `createRequire`
in `packages/db/src/store.ts`, not statically, because bundlers that don't know
the module try to resolve it as a file. Keep it that way.

**pnpm 10 blocks postinstall scripts.** Electron's binary comes from one, so
without the `onlyBuiltDependencies` allowlist in `pnpm-workspace.yaml` you get
"Electron failed to install correctly" at launch.

**`node-pty` is native, and the terminal needs it.** That cuts against the rule
above. The resolution: `node-pty` may be a dependency of `apps/desktop` **only**,
where users install a signed binary with prebuilds inside. The CLI and every
package it depends on stay native-free. Do not add it to a shared package.

**Compose env values must be quoted.** `ENABLE_DEBUG: false` unquoted is a YAML
boolean and Docker Compose rejects it. `packages/orchestrator/src/compose.ts`
handles this; there is a test.

**Order matters when claiming a port.** `ports` is foreign-keyed to `projects`,
so the project row must exist first.

---

## Facts about the upstream SDK that its own docs get wrong

Verified against the published package, not the documentation:

1. The finish tool is **`claritty_finish`**, not `__finish`.
2. The manifest schema is **strict** and rejects unknown keys. `tools[]` and
   `workflows[]` have **no** `name` or `description` field.
3. `AgentDecl.model` defaults to `claude-sonnet-4-6`, so an automation always
   names a model even when the author didn't. The control plane therefore needs
   `forceModel`, not just a fallback — otherwise someone holding only an OpenAI
   key could never run a Claude-authored manifest.
4. `PlatformClient.get_workflow_run` is a permanent stub returning `None`, so
   run idempotency must be enforced Studio-side. It is, on
   `runs.idempotency_key`.
5. `PlatformClient._post` swallows every failure. A misconfigured secret
   presents as "runs have no timeline" with no error anywhere.
6. `CLARITTY_FAKE_CREDS_<ID>` produces illegal env names for hyphenated ids.
   Don't build on it.

If you find another, add it here.

---

## What is proven, and what has never been run

Be accurate about this. Do not describe unverified code as working.

**Proven, with a command you can re-run:**

- The control-plane contract — `pnpm spike`
- Connector chain to a real HTTP service — `pnpm proof:integrations`
- Scheduler firing unattended, webhook delivery and replay — done live
- Native runtime, store, CLI, renderer, Electron app — 155 tests + screenshots

**Never executed:**

- **The Docker path.** `DockerRunner` is written and its deterministic parts are
  tested, but `docker compose up` has never run — the build container had no
  daemon. Try `clarity-studio run` without `--native` early.
- **Real provider adapters.** Anthropic, OpenAI and Google have never hit a live
  API; only the simulator has. The Anthropic message translation is the riskiest
  code in the repo: OpenAI models tool results as `role: "tool"` messages,
  Anthropic wants `tool_result` blocks merged into a **single** user turn.

---

## House style

Match what is already there. Specifically:

- Comments explain **why**, never what. If a line is surprising, say what would
  break without it. Delete comments that restate the code.
- Errors tell the user what to do next. `"no API key configured"` is worse than
  naming the keys they *do* have and what to run.
- Tests assert behaviour that matters, and their comments say why the case is
  worth testing. Several tests here caught real bugs — keep them that way.
- UI: every button is a pill, one `accent` action per view, nothing moves on
  hover, glass surfaces rather than flat fills. See `docs/` and
  `packages/design`.
- Never mark something done that is unverified. Say what you ran.

## Before you finish

```bash
pnpm build && pnpm typecheck && pnpm test
pnpm spike                  # if you touched the control plane or the seed
pnpm proof:integrations     # if you touched connectors or the vault
```

If you changed `packages/design`, regenerate rather than hand-editing:
`pnpm design:sync --source <path-to-clarity-platform>`.
