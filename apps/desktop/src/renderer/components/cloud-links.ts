/**
 * Links to the hosted product and the project.
 *
 * The ONE file in the app allowed to name claritty.ai, and the reason the
 * no-phone-home check has an exception for it. The distinction that matters:
 *
 *   - Nothing here is fetched. These are constants compiled into the bundle, so
 *     an offline Studio shows exactly what an online one does, and no request
 *     leaves the machine to decide what to display.
 *   - They open in the user's browser via `shell.openExternal`, only when a
 *     person clicks. "No telemetry, no accounts, no phoning home" is a promise
 *     about what the app does on its own — not a rule that it may never mention
 *     where it came from.
 *
 * If anything in here ever becomes a `fetch`, the promise is broken and the
 * check should fail. That is what it is still asserting.
 */

export interface CloudLink {
  id: string;
  title: string;
  body: string;
  cta: string;
  href: string;
}

/** What the hosted platform does that a laptop cannot. */
export const CLOUD_LINKS: CloudLink[] = [
  {
    id: 'cloud',
    title: 'Run it without this window open',
    body: 'Schedules only fire while Studio is running. Hosted, they fire whether or not your laptop is awake — same automation, same manifest, nothing to change.',
    cta: 'See Claritty Cloud',
    href: 'https://claritty.ai',
  },
  {
    id: 'marketplace',
    title: 'Marketplace',
    body: 'Automations and agentic apps other people already built and published, installable into a workspace.',
    cta: 'Browse the marketplace',
    href: 'https://claritty.ai/marketplace',
  },
  {
    id: 'teams',
    title: 'Teams',
    body: 'Agents that work as a standing team rather than a single fixed workflow — they take the goal, decide the steps, and report back.',
    cta: 'See how teams work',
    href: 'https://claritty.ai/teams',
  },
];

/** Studio is open source; this is how to work on it. */
export const CONTRIBUTE = {
  repo: 'https://github.com/Clarittyai/clarity-studio',
  issues: 'https://github.com/Clarittyai/clarity-studio/issues',
};
