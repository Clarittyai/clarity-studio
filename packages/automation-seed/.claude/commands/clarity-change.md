---
description: Change an automation that already exists, without breaking it on the way
---

The user wants to change this automation — add a step, swap a service, adjust
what an agent does, change when it fires. It already works, or at least already
boots. That is the thing to protect.

## The rule that outranks the others

**Make the change. Do not describe it.**

Studio draws this automation from `intelligence.yaml` and redraws the moment you
save. A change you have only explained is, from the user's side, nothing
happening — they are looking at the old diagram while you talk about the new one.
If you can see how to do it, do it, then say what you did. If you cannot, make
the part you can see and name what is missing.

Never end a turn having discussed an edit without making one.

## Keep it bootable at every save

The manifest is strict-validated at boot, and Studio reads it on every write.
A save that half-lands — a step referencing a tool you have not added yet, an
agent pointing at a promptFile that does not exist — makes the automation
unloadable, and the person watching sees their flow vanish.

So order the edits so each save is valid on its own:

1. **Add the new thing first** — the tool entry and its Python, the agent and its
   prompt file. Nothing references it yet; the automation still boots.
2. **Then wire it in** — add the step, or point the existing step at it. One
   save, one coherent change.
3. **Then remove what it replaced.** Deleting first is what leaves a manifest
   referencing a file that is gone.

Same order in reverse for a removal: unwire, then delete.

## Change the smallest thing that does the job

A request to "also post it to Slack" is one step and one integration, not a
redesign. Rewriting the manifest wholesale to accommodate a small addition
throws away decisions the user made earlier and cannot remember making — and it
turns a reviewable change into an unreviewable one.

If the change genuinely needs a different shape, say so and say why before you
restructure.

## What to check before you touch it

- `catalog/AVAILABLE.md` if the change involves a service — it is the only list
  of what this machine can actually call. A tool marked `"local": false` will
  fail at run time however sensible the id looks.
- The existing agent prompts. Adding a tool to `agents[].tools` does nothing
  unless the prompt names it: a tool the prompt never mentions is never called,
  and the step silently does less than it appears to.
- Whether the step is `mode: write`. Changing something outward-facing deserves
  a sentence to the user before, not after.

## After the change

```bash
claritty-seed-verify .
```

Then run it, and show the actual output. If the change is on a path that only
runs weekly, fire the workflow directly rather than declaring it good because it
validated — validation proves the shape, not the behaviour.

Finish by saying, in one line each:

- what changed
- what it now does that it did not before
- anything still stubbed, and what it is waiting on
