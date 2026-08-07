# Contributing

Thanks for looking. This is a young project and the code is small enough to read
in an afternoon — `packages/` is the runtime, `apps/desktop` is the app.

## Getting green

```bash
pnpm install
pnpm build
pnpm typecheck && pnpm test        # ~180 unit tests, seconds
pnpm check:app                     # 53 checks driven against a real window
```

`check:app` launches Electron and clicks through the app, so it needs a display.
Everything else runs anywhere.

The heavier proofs need Python 3.12+ and build a venv from PyPI, so they take
minutes on a cold machine:

```bash
pnpm proof:run                     # presses Run now, executes a workflow
pnpm proof:scheduled-run           # a schedule fires with nobody touching it
pnpm proof:sdk                     # the seed installs claritty-sdk from PyPI
```

You do not need all of them locally — CI runs the lot. Run the ones near what you
changed.

## The one thing that will catch you out

**Test against the packaged app, not `electron .`.**

They are not equivalent. `electron .` resolves workspace paths that do not exist
in a shipped bundle, and that difference once hid a total failure: the automation
seed was never added to electron-builder's `files`, so **every packaged install
could not create an automation at all** — while the proof passed, because it ran
from the repo.

```bash
pnpm package        # then re-run the proof; it uses the bundle when one exists
```

If you touch packaging, file resolution or anything under `assets/`, package
first and check the proof says *"Against the packaged app"*.

## Generated files

Two things are generated and **must not be hand-edited** — CI regenerates them
and fails on a diff:

- `packages/automation-seed/catalog/**` and `docs/connectors.md` — from
  `packages/connectors`. Add a connector there and run `pnpm sync:catalog`.
- The connector catalog is the single source for what an automation can call.
  Documenting an integration by hand is how the docs end up promising tools that
  do not exist, which is a bug we have already had.

## Adding a connector

`packages/connectors/src/catalog.ts`, then `pnpm sync:catalog`. A connector needs
a `howToConnect` sentence written for someone who has never opened that
dashboard — it is shown verbatim in the app and in the docs, so it is the one
piece of prose that has to be right.

Credentials never reach an automation's process: the host executes catalog tools
and brokers the call. If you find yourself passing a key into Python, stop —
that is a sign the tool should be `source: catalog`.

## Style, such as it is

- **Comments explain why, not what.** The repo is full of comments naming the bug
  a line prevents. Those are the valuable ones; keep writing them.
- **No `any`.** Use `unknown` and narrow.
- **The product is one-`t` Clarity; the brand is two-`t` Claritty.** CI enforces
  this — see the `naming` job for exactly where each is allowed.
- **Nothing calls home.** Runtime code must never reach `claritty.ai`. Links a
  person clicks live in `cloud-links.ts`, which is constants and never fetches.
  CI enforces that too.

## Tests

A check that cannot fail is worse than no check. Several times in this repo a
proof passed while the thing it named was broken — a probe that inspected
nothing, a selector that matched an element the app never labels, a gate whose
grep silently errored.

If you write one, make it fail first. Break the thing on purpose, watch the check
go red, then fix it. Where that is awkward, plant the defect the check hunts for
and assert it is found — `check:app` does this for the divider rule.

## Pull requests

Small and explicable beats large and complete. Say what broke and how you knew —
a PR that names the failure it prevents is easier to review than one that
describes the code it adds.

## Reporting something

An issue with the version from **Settings**, your OS, and what you expected is
plenty. If an automation misbehaved, the run timeline and the step that failed
are the useful part — Studio surfaces the provider's own error text uncut, and
that sentence usually contains the answer.
