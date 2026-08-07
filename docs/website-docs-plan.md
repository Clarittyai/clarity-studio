# Plan: Studio on claritty.ai, end to end

Written after the README's **Get started »** button was pointed at
`claritty.ai/docs`. That URL returned 200 and the page did not mention Studio,
so this is the work that makes the button honest. It covers the whole journey
rather than only the docs pages, because the docs were never the first thing
half the audience hits.

Not a wish list. The decisions below are the ones that would otherwise be made
badly under time pressure, with the reasoning attached so they can be argued
with rather than guessed at again.

## The flow this is built for

```
lands on claritty.ai  →  what is Studio?  →  docs  →  install  →  first run
                                                                      ↓
                              connect a service  ←  add a model  ←  it works
                                       ↓
                            arm a schedule → hits "only while the app is open"
                                       ↓
                                  Claritty Cloud
```

Two entry points feed it, and they arrive with different questions.

- **From GitHub**, someone has already read the README and clicked
  **Get started »**. They want to install, now, and anything else is friction.
- **From claritty.ai**, someone does not know Studio exists. They need to be
  told what it is before any docs make sense.

Before this work neither was served: the GitHub visitor landed on `/docs` and
found a platform track, and the website visitor found no mention of Studio at
all.

## Part 1 — Studio needs a home on the site

Before docs, one product page: **`/studio`**.

Its job is thirty seconds of "what is this and is it for me". The screenshot of
the agent writing an automation with the flow redrawing beside it does most of
the work. That image is the product, and it is the one thing no competitor page
looks like. Then: it is free and open source, it runs on your machine with your
keys, and one button to the docs.

Link it from the main nav and from wherever the platform is described, because
the OSS project is the top of the funnel for the cloud, not a side project.

## Part 2 — the docs track

Add a **Clarity Studio** section to the existing `/docs` nav, alongside Start
here / Build your app / Widgets / Integrations / Go live. Do not build a second
docs site: `/docs` already exists and already redirects legacy paths.

```
Clarity Studio
  Introduction          what it is, local-first, the no-telemetry promise
  Get started           the three stages below — the most important page
  Connecting a service  ← imports docs/connectors.md
  Writing an automation tools vs agents, the four run-time traps
  Bring your own model  ← imports docs/model-endpoint.md
  Schedules & triggers  arming, missed windows, the app-open limit
  Self-host or cloud    one honest comparison table
```

### Get started is three stages, in this order

Each buys one capability, and the order is what makes it learnable.

1. **Run one with no credentials at all.** Install, create, Run now. Lead with
   this. Most tools open with "first, get an API key" and lose people there;
   Studio can prove the runtime works before anything is spent, which means a
   later failure is a credential problem rather than an install problem.
2. **Add a model, and the agents wake up.** Name what it buys: an automation
   that *decides*. That is the whole difference from a cron job.
3. **Connect a service.** Brokered credentials, your own OAuth apps, no Claritty
   client id to sign into.

Use `docs/img/create.png` and `docs/img/automation.png` here, because this page
is where someone decides whether to install.

**Writing an automation** is the page that saves a debugging session: tools vs
agents (deterministic in a tool, judgement in an agent) and the four traps that
only fail at run time.

## Part 3 — where the cloud appears

Not on page 2. Introduce it on **Schedules & triggers**, at the moment someone
reads that schedules only fire while the app is open. That is the first instant
where a laptop genuinely cannot do the job, so the cloud reads as an answer
rather than an ad.

Everywhere else, mark the difference **inline where it bites** — schedules,
webhooks, integration count, teams — rather than maintaining a parallel "cloud
docs" tree. Two trees rot: the shared 90% gets updated in one and not the other,
and the stale one is what a stranger reads.

The rule for the comparison table: **every cloud row must be something a laptop
genuinely cannot do**, not a feature withheld. A comparison a reader trusts is
one that concedes. If a row stops being true, delete it rather than defending it.

## Part 4 — the build decision

**Import `connectors.md` and `model-endpoint.md` at build time. Do not retype
them into TSX.**

They are generated from `packages/connectors` and the provider code, and CI here
fails if they drift. Thirteen connectors is the largest and fastest-rotting
content on the site. Copy it into React and the website disagrees with the app
on the very next connector, which is not hypothetical: it is the seed catalog
bug, where 28 of 38 integrations were documented as available and an agent built
on a tool nothing implemented.

The existing guides are all hand-written components, so this means adding a
markdown import step to `DeveloperDocsPage`. That is the one piece of real
engineering in the plan.

## Part 5 — screenshots

Four exist and are current: `create.png`, `automation.png`, `controls.png`,
`settings.png`. Regenerate with `pnpm shots` after UI changes rather than taking
them by hand.

What is missing and cannot be automated: per-connector shots of creating the
credential, the Google Cloud OAuth consent screen, the Jira token page,
@BotFather. Those are other people's dashboards, taken by hand. Do the three
hardest (Gmail, Jira, WhatsApp) and leave the rest as text, since a Brave API
key is one field on one page.

## Order of work

1. `/studio` product page. Without it, half the audience never reaches the docs.
2. The markdown import step. Everything else depends on it.
3. Get started, Introduction, Self-host or cloud.
4. The two imported reference pages.
5. Writing an automation, Schedules and triggers.
6. Hand-taken credential screenshots.

## Definition of done

- **Get started »** lands somewhere that covers Studio.
- Adding a connector in `clarity-studio` updates the website with no editing.
- Every cloud-only claim is one a laptop genuinely cannot do.

---

## What landed, and where

Steps 1 to 5 are built in `claritty-core/clarity-website`. Step 6 is not, and
cannot be done from a repo: it needs someone signed into three third-party
dashboards.

| Piece | Where |
| --- | --- |
| `/studio` product page | `src/pages/StudioPage.tsx`, route in `src/App.tsx`, linked from `Navigation.tsx`, `Footer.tsx` and `DevelopersPage.tsx` |
| The seven docs pages | `src/components/docs/studio/`, wired into `src/pages/docs/DeveloperDocsPage.tsx` under a **Clarity Studio** nav group |
| The import step | `scripts/sync-studio-docs.mjs` copies the two generated docs and the four screenshots into `src/content/studio/` and `public/screenshots/studio/`; `npm run build` runs it with `--check` and fails on drift |
| The renderer | `src/components/docs/Markdown.tsx` |
| Derived facts | `src/lib/studioConnectors.ts` parses the imported connector list, so "13 services" and the catalog total in the comparison table are never typed by hand |

The copy step exists because the two repos are separate and `clarity-studio` is
not on the website's build machine, so a direct import cannot work. Behaviour
with no checkout next door is deliberate: the committed copies ship, the check
no-ops, and nothing fails on a builder that has never seen this repo.

**Both README links now point at `/docs/studio/get-started`.** The seven docs
routes are prerendered, because an unlisted `/docs/*` path falls through to the
SPA rewrite and is served the home page's markup, which is not what a stranger
arriving from GitHub should be handed.

### Still open

- **Per-connector credential screenshots** (Gmail, Jira, WhatsApp). Needs a
  human in someone else's dashboard. Everything is text until then, and the text
  is generated, so it is at least correct.
- **`llms.txt` on the website.** `docs/llms.txt` exists here and is worth
  generating from the site's nav too. Cheap, and this is a product whose users
  point coding agents at it. Not done.
- **The platform docs sections are still not prerendered.** They have the same
  SPA-fallback problem the Studio pages just fixed. Out of scope for this pass,
  and a one-line-per-route fix when someone wants it.
