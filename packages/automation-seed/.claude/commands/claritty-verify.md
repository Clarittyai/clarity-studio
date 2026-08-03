---
description: Validate this automation's manifest and wiring, then fix what it reports
---

Run the offline gate and fix every finding.

```bash
claritty-seed-verify .
```

Then check the things the gate cannot see, because they are semantic rather
than structural:

1. **Prompt ↔ tools coherence.** For each agent, open its `promptFile` and
   confirm every id in its `tools:` list is named in the prompt, and that the
   prompt ends by calling `claritty_finish` with exactly the fields declared in the
   agent's `output:`. A tool that is listed but unmentioned is never called —
   the automation will run green and do nothing.
2. **Step piping.** For every `${steps.S.output.K}`, confirm `S` is an earlier
   step and that `K` is actually in that step's declared `output:`.
3. **Trigger completeness.** `SCHEDULE` needs `supportedSchedules` plus
   `timezone` (and `time` unless INTERVAL-only) in `configFields`;
   `WEBHOOK` needs `webhook_secret`. Each trigger fires exactly one workflow
   xor one agent.
4. **No stubs.** No tool handler raises `NotImplementedError` or returns a
   placeholder.

Report what you found and what you changed. If everything passes, say so
plainly rather than inventing work.
