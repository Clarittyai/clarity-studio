---
description: Replace the example automation with a real one, from a plain-English description
---

The user wants to build a real automation. The repo currently holds the example
(`daily-digest`) — your job is to replace it entirely, not to add alongside it.

## 1. Understand the job before designing it

Ask at most three questions, and only ones whose answers change the design:

- **What fires it?** A time of day, an incoming event, or a person pressing a
  button. This decides the trigger type, and it is the question people most
  often haven't thought through.
- **What does it touch?** Which services it reads from and writes to. This
  decides the integrations, and whether anything is irreversible.
- **What does "done" look like?** One sentence describing the result a human
  would check. This becomes the workflow's outputs.

If the description already answers one, don't ask it back.

## 2. Design against the grain of the runtime

- Prefer **one agent with a few tools** over a chain of agents. Agents are
  expensive and non-deterministic; every one you add is another place the run
  can go sideways.
- Put anything deterministic in a **tool**, not in a prompt. "Fetch the rows
  from the last 24 hours" is a tool. "Decide which of these matters" is an
  agent.
- **Human-in-the-loop by default** for anything irreversible or outward-facing.
  Draft-then-approve beats send-immediately, and the user can always relax it.
- If a capable person would improvise rather than follow a fixed checklist,
  consider `type: team` instead of a DAG.

## 3. Build it

Replace `intelligence.yaml` wholesale. Delete `backend/tools/collect_items.py`,
`backend/tools/save_digest.py` and `backend/agents/digest_writer.md` — leaving
the example behind is how a repo ends up with two half-automations. Update
`app-config.json#triggers[]` so its ids match the manifest.

Follow every rule in `CLAUDE.md`, especially: name each tool in the prompt that
may call it, and end the prompt with an explicit `claritty_finish`.

## 4. Verify and run

```bash
claritty-seed-verify .
docker compose up --build
curl -X POST localhost:3200/api/workflows/<id>/execute \
     -H 'content-type: application/json' -d '{"inputs":{}}'
```

Show the user the actual output. If a step failed, show the error rather than
describing it as a success with caveats.
