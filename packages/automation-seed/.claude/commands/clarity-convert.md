---
description: Convert an existing agent (LangChain, CrewAI, cron script, MCP server) into a Clarity automation
---

You are converting an existing codebase into a Clarity automation. **Wrap the
user's code; do not rewrite it.** A conversion that reimplements their logic has
failed, however clean the result looks.

## 1. Inventory first — write nothing yet

Read the repo and produce a short table before touching any file:

| What | Where | Becomes |
|---|---|---|
| Entry point(s) — `main()`, a CLI command, an HTTP route, a cron target | | a **workflow** |
| Prompts / system messages / role definitions | | an **agent** (`promptFile`) |
| Every side effect — HTTP POST, DB write, email, file write, API call | | a **tool** |
| Read-only fetches the agent depends on | | a **tool** |
| Scheduling — crontab, APScheduler, GitHub Action, Lambda rule | | a **trigger** |
| Credentials — env vars, `.env`, hardcoded keys | | an **integration** |

Show the user this table and confirm it before proceeding. Getting the mapping
wrong is much more expensive than asking.

## 2. Draft `intelligence.yaml`

Map the table onto the five primitives. Keep the user's names where they are
already good. Declare integrations for every credential you found.

## 3. Write thin adapters

For each side effect, add `backend/tools/<name>.py`:

```python
@tool(id="app.<name>")
def run(input, ctx):
    from their_package.their_module import their_function   # unchanged
    result = their_function(**input)
    return {"...": result}                                   # match output:
```

The adapter's whole job is shape translation. If you find yourself
reimplementing their logic inside `run()`, stop — you have taken a wrong turn.

## 4. Move credentials into the vault

Replace every `os.environ["SOME_API_KEY"]` with `ctx.integration("<id>")`. If
no catalog integration matches the service, say so explicitly and leave the key
as a declared input rather than silently inventing an integration id.

## 5. Move the prompts

Copy their system prompts into `backend/agents/<id>.md` **verbatim first**, then
add the two things the runtime requires: name every tool the agent may call, and
end with an explicit `claritty_finish` call carrying the declared `output:` fields.
Preserve their voice and their domain rules — those are the valuable part.

## 6. Delete their scheduler

Any `while True`, `schedule.every()`, `APScheduler`, or `asyncio.create_task`
loop must go. The host fires triggers now. Point out what you removed so the
user can confirm the cadence survived into `configFields`.

## 7. Verify

```bash
claritty-seed-verify .
```

Loop until clean, then run the workflow once and show the user the output.

## Report

End with: what you mapped, what you wrapped, what you deleted, what you could
not convert and why. Be specific about the last one — an honest gap is far more
useful than a stub that pretends to work.
