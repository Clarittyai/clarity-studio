# Claritty Studio

**Read [`CLAUDE.md`](./CLAUDE.md) first — it is the full contract for working on
this repo.** This file is the short version, kept as a real file so it survives
a Windows checkout and so Codex finds it.

An open-source, local-first desktop app for building, running, scheduling and
observing AI automations. pnpm monorepo, Node 22+.

```bash
pnpm setup && pnpm test     # get running, then check nothing is broken
pnpm spike                  # the gate: a real automation on a local control plane
```

The five things most likely to bite you:

1. **`node:sqlite` forces Electron 35+.** Electron 33 bundles Node 20 and dies
   at load with a message that reads like a packaging bug.
2. **No native modules outside `apps/desktop`.** Installing Studio must never
   need a C++ toolchain.
3. **No provider key ever enters an automation's container**, and the vault
   refuses to store rather than falling back to plaintext.
4. **A credential can never appear in a URL**, and connectors reach public hosts
   only.
5. **The Docker path and the real provider adapters have never been executed.**
   Do not describe them as working.

The SDK's own docs are wrong in six specific ways that will waste your time —
they are listed in `CLAUDE.md`.
