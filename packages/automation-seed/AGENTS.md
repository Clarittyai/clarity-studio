# Clarity automation

**Read [`CLAUDE.md`](./CLAUDE.md) first — it is the full authoring contract.**
This file is the short version, kept as a real file (not a symlink) so it
survives a Windows checkout.

`intelligence.yaml` is the source of truth. Five primitives: integrations,
tools, agents, workflows, triggers. The runtime validates the manifest at boot
and refuses to start if it doesn't hold together.

The rules that matter most, because breaking them produces an automation that
looks fine and does nothing:

1. **Every tool an agent may call must be named in its prompt.** Listing it in
   `tools:` is not enough — an unmentioned tool is never called.
2. **Agents never define `execute()`.** The runtime doesn't call it. Use a
   `promptFile`.
3. **Tools never call a model, agents never do I/O directly.** Tools act;
   agents decide.
4. **Reach external services only via `ctx.integration("<id>")`.** Never read an
   API key from the environment.
5. **Every `${steps.x.output.y}` must name an earlier step and a real output
   field.** A bad reference fails on every run, not just the first.
6. **The automation runs no scheduler.** The host fires triggers; you just
   answer. No threads, no `create_task`, no `while True`.

After any change, run `claritty-seed-verify .` and fix everything it reports.

Converting an existing agent? Wrap it, don't rewrite it — see the
"Converting an existing agent" section of `CLAUDE.md`.
