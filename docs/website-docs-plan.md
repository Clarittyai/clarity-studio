# Plan: the Studio + Cloud docs on claritty.ai

Written after the README's **Get started »** button was pointed at
`claritty.ai/docs`. That URL returns 200 and the page does not mention Studio, so
this is the work that makes the button honest.

Not a wish list — the decisions below are the ones that will otherwise be made
badly under time pressure, with the reasoning attached so they can be argued
with rather than guessed at again.

## What exists today

`clarity-website`:

- `src/App.tsx` — `/docs/*` → `DeveloperDocsPage`, and `/docs/developers/*`
  already redirects into it
- `src/pages/docs/DeveloperDocsPage.tsx` — nav sections: **Start here · Build
  your app · Build the code · Widgets · Integrations · Go live**
- `src/components/docs/` — `GettingStartedGuide`, `BuildGuide`,
  `IntegrationsGuide`, `WidgetSystemGuide`, `SubmissionGuide`,
  `DevelopmentGuide`, `TroubleshootingGuide`, `ui.tsx`

All of it is the **platform** track, hand-written as TSX. Nothing covers Studio.

`clarity-studio` has two docs that are **generated**:

- `docs/connectors.md` — every connector, its setup sentence, its fields and its
  callable tool ids, from `packages/connectors`
- `docs/model-endpoint.md` — the exact request Studio sends, from
  `providers/openai.ts`

## The decision that matters most

**Import the generated files at build time. Do not retype them into TSX.**

Thirteen connectors, each with a credential, a dashboard and a setup sentence, is
the single largest piece of content here and the fastest-rotting. It is generated
in `clarity-studio` precisely because a hand-written copy drifts on the next
connector added — and CI there fails if it does. Copying it into React throws
that away and the website starts disagreeing with the app immediately.

This is the same failure that was fixed in the seed catalog this week: 28 of 38
integrations were documented as available when Studio could not broker any of
them, and an agent built on `jira.create_issue` because a manifest said so.
Hand-maintained truth about integrations does not stay true.

Practically: a markdown loader in the website build, or a small sync step that
copies the two files in and fails if they differ from source. Either is fine.
Retyping is not.

## Serving both audiences at once

The docs have two readers with different first questions, and the common failure
is writing for one and bolting the other on:

- **Self-hoster:** "can I do this without an account, and what will I have to set
  up?" They leave the moment docs feel like a sales funnel.
- **Cloud user:** "what do I get for paying, and how do I start?"

What works, and what Postiz gets right in shape if not in depth: **one set of
docs, with the deployment difference marked inline where it actually matters**,
rather than two parallel trees. Two trees rot — the shared 90% gets updated in
one and not the other.

So:

- Write every page for the product, not the deployment.
- Where behaviour genuinely differs, say so in place with a short callout. There
  are only a few, and they are real:
  - **Schedules** fire only while Studio is open; the cloud runs them unattended.
  - **Webhooks** are headless-CLI-only locally; the cloud gives hosted endpoints.
  - **Integrations** — Studio brokers 13 with *your own* OAuth apps; the cloud
    offers the full catalog with sign-in.
  - **Sharing, teams, marketplace** are cloud-only.
- One honest comparison table, once, on its own page. The Studio README already
  has a version of it — reuse the wording.

**Be explicit about what you do NOT need the cloud for.** A comparison a reader
trusts is one that concedes. Every cloud row above is a thing a laptop genuinely
cannot do, not a feature withheld — keep it that way, and if a row ever stops
being true, delete it rather than defending it.

## Structure

Add a **Clarity Studio** section to the existing nav. Do not build a second docs
site: `/docs` is already the destination and already redirects legacy paths.

```
Clarity Studio
  Introduction          what it is, local-first, the no-telemetry promise
  Get started           the three stages below — the most important page
  Connecting a service  ← generated: docs/connectors.md
  Writing an automation the agent loop, tools vs agents, the four run-time traps
  Bring your own model  ← generated: docs/model-endpoint.md
  Schedules & triggers  arming, missed windows, the app-open limit
  Self-host or cloud    the comparison table
```

### Get started is three stages, in this order

Each buys one capability, and the order is what makes it learnable:

1. **Run one with no credentials at all.** Install, create, Run now. Lead with
   this — most tools open with "first, get an API key" and lose people there.
   Studio can prove the runtime works before anything is spent, and that means a
   later failure is a credential problem rather than an install problem.
2. **Add a model, and the agents wake up.** Name what this buys: an automation
   that *decides*, which is the whole difference from a cron job.
3. **Connect a service.** Brokered credentials, your own OAuth apps, no Claritty
   client id to sign into.

Then schedules, with the app-open limit stated up front rather than discovered at
6am.

## Notes on Postiz, since it prompted this

Their introduction is ~200 words and two cards — thin, and not worth copying for
depth. Two things are worth taking:

- **The README header shape**, already adopted: logo, licence badge, tagline,
  then a link row led by "Explore the docs »" with the hosted product beside it
  rather than in front.
- **`llms.txt`** — a plain-text index of the docs for agents. Cheap, and this is
  a product whose users are pointing coding agents at it. Worth generating from
  the same nav.

## Definition of done

- `claritty.ai/docs` has a Studio section, and the README's **Get started »**
  lands somewhere that covers Studio.
- `connectors.md` and `model-endpoint.md` are imported, not retyped, and adding a
  connector in `clarity-studio` updates the website with no editing.
- Every cloud-only claim on the site is one a laptop genuinely cannot do.
