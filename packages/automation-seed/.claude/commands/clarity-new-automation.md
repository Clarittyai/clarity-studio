---
description: Replace the example automation with a real one, from a plain-English description
---

The user wants to build a real automation. The repo currently holds the example
(`daily-digest`) — your job is to replace it entirely, not to add alongside it.

## 0. Write something that boots, before you ask anything

**Never end a turn with this folder unchanged.** Studio draws the automation from
`intelligence.yaml`; a design you have only described is, from the user's side,
nothing happening. They are watching a diagram that still says `daily-digest`
while you explain what you would build.

So the FIRST thing you do, in your first reply, is replace the example with the
real shape — trigger, steps, agent, outputs — even when half the facts are
missing. Then ask your questions.

**Stub what you do not know yet.** A tool that returns fixtures is a normal,
documented state: the example's own `collect_items.py` does exactly that and says
so. Give the stub a body that logs what it is and returns plausibly-shaped data,
and put the open question in a comment at the top. The manifest boots, Studio
draws it, and the conversation is now about a thing that exists.

    # STUB — waiting on: which banks, and where their documents come from.
    # Returns two fixture documents so the flow runs end to end meanwhile.

**Never block the whole build on one unresolved step.** In a five-step
automation with one unknown, four steps are designable now. Building nothing
because one input is missing is the failure this section exists to prevent — and
it is the most common way an agent produces an hour of conversation and an empty
folder.

If an integration you need has no local connector, that is not a blocker either:
write the `INTEGRATION-REQUEST.md` (see the add-an-integration skill), stub the
step, and carry on. Check `catalog/AVAILABLE.md` before you assume a service is
callable — it is the only list of what this machine can actually reach.

## 1. Read what you were given before asking for more

**Most of the design is already in the request.** Take it. A person who writes
"every Monday, collect documents from my banks and file each in Jira with the
document's name in the ticket title" has told you the cadence, the destination,
the shape of the output and the one thing they will check. Asking them what
fires it is asking them to repeat themselves, and it reads as not having listened.

Mine the folder name too. `weekly-bank-report` states a cadence. `invoice-digest`
states a subject and a form.

Three things decide the design. For each, in this order: **take it from the
request; if it is not there, choose a sensible default and say which you chose;
only ask if a wrong guess would waste real work.**

- **What fires it.** A schedule unless told otherwise — daily 09:00 is a fine
  default, and it is one line to change.
- **What it touches.** Check `catalog/AVAILABLE.md`. If what they named is not
  there, that is not a question, it is a stub plus a connector request.
- **What "done" looks like.** Usually the last clause of their sentence. Write
  it as the workflow's outputs and let them correct it.

**Ask at most one question, and ask it after you have built.** A question asked
against a working diagram is a small correction. The same question asked against
an empty folder is an interrogation, and three rounds of it produce a design
document and no automation.

Never ask a question you could answer by choosing and stating a default. "I've
set it to Mondays at 08:00 — say the word if that's wrong" beats "what time
should it run?" every time: it costs the reader nothing to skip, and it costs
you nothing to change.

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

## 3. Refine it

By now the automation exists and boots. This step replaces stubs with real work
as answers arrive — one at a time, keeping it bootable throughout, so the user
watches it become real rather than waiting for a reveal.

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

## 5. Say what is still a stub

End by listing every stub left and what each is waiting on. An automation that
runs green on fixtures looks finished, and that is precisely when someone
schedules it and trusts the result.
