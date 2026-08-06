import { randomUUID } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { _electron as electron } from 'playwright';
import { Store } from '../packages/db/dist/index.js';

const ROOT = new URL('..', import.meta.url).pathname;

// The check builds its own fixture rather than depending on a folder somebody
// scaffolded earlier — a harness that only passes on the machine that set it up
// is not a check.
const PROJECT = process.env.PROJECT_DIR ?? '/tmp/studio-full-project';
if (!process.env.PROJECT_DIR) {
  rmSync(PROJECT, { recursive: true, force: true });
  cpSync(join(ROOT, 'packages/automation-seed'), PROJECT, {
    recursive: true,
    filter: (src) => !src.includes('/.studio') && !src.includes('__pycache__'),
  });
}
if (!existsSync(join(PROJECT, 'intelligence.yaml'))) {
  throw new Error(`no manifest in ${PROJECT} — the fixture is wrong, not the app`);
}

const HOME = '/tmp/studio-full';
rmSync(HOME, { recursive: true, force: true });
mkdirSync(HOME, { recursive: true });
const s = new Store(join(HOME, 'studio.db'));
const id = randomUUID();
s.upsertProject({ id, name: 'fresh-auto', slug: 'fresh-auto', path: PROJECT, runtime: 'native', status: 'stopped' });
s.close();

const app = await electron.launch({ args: ['.'], cwd: join(ROOT, 'apps/desktop'), env: { ...process.env, STUDIO_HOME: HOME } });
const win = await app.firstWindow();
const errs = [];
win.on('pageerror', (e) => errs.push(e.message));
win.on('console', (m) => { if (m.type() === 'error') errs.push(`console: ${m.text()}`); });

const pass = [], fail = [];
const check = (name, ok, detail = '') => (ok ? pass : fail).push(`${name}${detail ? ` — ${detail}` : ''}`);

await win.waitForSelector('[data-brand]');
await win.waitForTimeout(4000);
const t = () => win.locator('body').innerText();

// Home is the launch screen now, so these checks belong here — and then the
// project checks below need the project actually opened first. The suite used
// to assume a project was auto-selected, which is the very bug that made Home
// unreachable, so it was asserting the broken behaviour.
{
  const home = await t();
  check('lands on Home', /Your automations/.test(home));
  check('showcase present', (await win.locator('[class*="rounded-3xl"] h2').count()) > 0);
  check('aggregate tiles', /Tokens, 7 days/.test(home) && /Next run/.test(home));
  check('contribute + issues', /come and read it/.test(home) && /report an issue/.test(home));
  check('sidebar Home row', (await win.locator('aside button:has-text("Home")').count()) === 1);
}

// Open the automation; everything below is the project screen.
// By name, not by position: the sidebar's `+` is also a text-less button, so
// "the first one that isn't Home" opened the create dialog instead.
await win.locator('aside button', { hasText: 'fresh-auto' }).first().click();
// The pty starts on mount, so wait for the terminal rather than a fixed sleep —
// a timing guess is how a suite goes red on a slower machine.
await win.waitForSelector('.xterm', { timeout: 60_000 }).catch(() => undefined);
// The manifest is read from disk after mount, so the flow and the agents band
// arrive later than the terminal. Waiting for the content beats sleeping past
// it: this check failed once on a busy machine and passed on a re-run, which
// is the least useful kind of red.
await win
  .waitForSelector('text=digest-writer', { timeout: 30_000 })
  .catch(() => undefined);
await win.waitForTimeout(1500);

// Brand in the sidebar, not the title bar.
const brandBox = await win.locator('[data-brand]').boundingBox();
check('brand in sidebar under traffic lights', brandBox.y > 40 && brandBox.x < 260, `x=${Math.round(brandBox.x)} y=${Math.round(brandBox.y)}`);
check('brand is platform-size', brandBox.height >= 28, `h=${Math.round(brandBox.height)}`);

let body = await t();
check('flow renders from manifest', /Flow/.test(body) && /write|Trigger/.test(body));
check('agents band', /digest-writer/.test(body));
// A `divide-y` list draws its rule as each child's top border. If that child is
// a rounded button the rule follows the curve and lifts at both ends, and a
// negative margin pushes those ends past the column. General, because the shape
// recurs: the rule belongs to the row, the rounding to the control inside it.
//
// Run here, on the automation, because this is the view carrying the most
// lists — Connections, Agents, channels, Triggers. Run at the end of the script
// it inspected one.
const dividers = await win.evaluate(() => {
  const curvedIn = (root) =>
    [...root.querySelectorAll('.divide-y')].flatMap((list) =>
      [...list.children]
        .filter((child) => {
          const s = getComputedStyle(child);
          return parseFloat(s.borderTopWidth) > 0 && parseFloat(s.borderTopLeftRadius) > 0;
        })
        .map((child) => `${child.tagName.toLowerCase()}.${child.className.split(' ')[0]}`),
    );

  // Prove the detector is not vacuous before trusting a clean result: plant the
  // exact shape it hunts for and confirm it is found. A check that inspects
  // nothing passes just as quietly as one that inspects something good.
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;left:-9999px';
  host.innerHTML = '<div class="divide-y"><div></div><button class="probe-row"></button></div>';
  document.body.append(host);
  host.querySelector('.probe-row').style.cssText = 'border-top:1px solid red;border-radius:12px';
  const detectorWorks = curvedIn(host).length === 1;
  host.remove();

  return { lists: document.querySelectorAll('.divide-y').length, curved: curvedIn(document), detectorWorks };
});
check('the divider detector actually detects', dividers.detectorWorks);
// Two on this fixture — the agents band and the notify channels. Connections
// and Triggers render empty states for `fresh-auto`, which have no list at all.
// The floor exists so a page that rendered nothing cannot pass as "clean".
check('there are lists to check', dividers.lists >= 2, `${dividers.lists} lists`);
check(
  'no divider follows a rounded corner',
  dividers.curved.length === 0,
  dividers.curved.join(', ') || `${dividers.lists} lists clean`,
);

check('triggers band', /Triggers/.test(body));
check('terminal dock present', /Build it/.test(body));
check('xterm mounted', (await win.locator('.xterm').count()) === 1);
check('no pty error', !/posix_spawnp|Error invoking/.test(body));

// Two columns: the aside must sit to the RIGHT of the flow, not under it.
const flow = await win.locator('h2:has-text("Flow")').boundingBox().catch(() => null);
const agents = await win.locator('h2:has-text("Agents")').boundingBox().catch(() => null);
check('two-column layout', Boolean(flow && agents && agents.x > flow.x + 100), flow && agents ? `flow.x=${Math.round(flow.x)} agents.x=${Math.round(agents.x)}` : 'missing');

// Terminal spans wide (full-bleed, not a narrow card).
const term = await win.locator('.xterm').boundingBox();
const winSize = await win.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
check('terminal is full-bleed', term.width > winSize.w * 0.55, `${Math.round(term.width)}px of ${winSize.w}px`);

// Executions tab switches.
await win.locator('button:has-text("Executions")').click();
await win.waitForTimeout(600);
check('Executions tab switches', /Every run|No runs yet/.test(await t()));
await win.locator('button:has-text("Flow")').first().click();
await win.waitForTimeout(400);

// Drag the dock taller.
const before = (await win.locator('.xterm').boundingBox()).height;
const grip = await win.locator('div[title*="Drag to resize"]').boundingBox();
await win.mouse.move(grip.x + grip.width / 2, grip.y + 1);
await win.mouse.down();
await win.mouse.move(grip.x + grip.width / 2, grip.y - 120, { steps: 8 });
await win.mouse.up();
await win.waitForTimeout(600);
const after = (await win.locator('.xterm').boundingBox()).height;
check('drag resizes the dock', after > before + 40, `${Math.round(before)} → ${Math.round(after)}`);

// Collapse keeps the session alive (element hidden, not unmounted).
await win.locator('button:has-text("Build it")').click();
await win.waitForTimeout(500);
check('collapse hides but keeps session', (await win.locator('.xterm').count()) === 1 && !(await win.locator('.xterm').isVisible()));
await win.locator('button:has-text("Build it")').click();
await win.waitForTimeout(500);

// How to reach you. Nothing is connected yet, so every outside channel must
// read as unavailable rather than as a switch that sends nothing.
body = await t();
check('notify: desktop channel', /This computer/.test(body));
check(
  'notify: unconnected channels say where to fix it',
  /Connect Slack in Settings/.test(body) &&
    /Connect Telegram in Settings/.test(body) &&
    /Connect WhatsApp in Settings/.test(body),
);
check(
  'notify: an unconnected channel cannot be switched on',
  await win.locator('[data-channel="slack"] button').first().isDisabled(),
);
// A button in a narrow column gets starved by the prose beside it. "Send a
// test" was squeezed to 55px and broke across three lines; height is the tell,
// since a wrapped label is taller than one line.
const testBtn = await win.locator('button:has-text("Send a test")').boundingBox();
check(
  'notify: the test button is not squeezed',
  testBtn && testBtn.height <= 40 && testBtn.width >= 80,
  testBtn ? `${Math.round(testBtn.width)}×${Math.round(testBtn.height)}` : 'missing',
);
check(
  'notify: desktop can be switched',
  !(await win.locator('[data-channel="desktop"] button').first().isDisabled()),
);

// Settings.
await win.locator('button[title="Settings"]').click();
await win.waitForTimeout(800);
body = await t();
check('settings: library folder', /Library/.test(body) && /Automations/.test(body));
check('settings: model providers', /Anthropic/i.test(body) && /Openai/i.test(body));
check('settings: local model examples', /11434|Ollama/.test(body) && /chat\/completions/.test(body));

// Connections live here, not inside an automation: the whole catalog, with a
// form built from each connector's own fields. The regression this guards is
// the one that started it — Telegram and email as a link to a tracker.
check(
  'settings: connections list',
  /Connections/.test(body) && /Slack/i.test(body) && /Telegram/i.test(body) && /WhatsApp/i.test(body),
);
check('settings: shared across automations', /every automation/i.test(body));
await win.locator('[data-connector="telegram"] button:has-text("Connect")').click();
await win.waitForTimeout(500);
body = await t();
check('settings: connect form is the connector\'s own', /BotFather/.test(body) && /Bot token/i.test(body));
check('settings: form asks every field', /Chat id/i.test(body));
check(
  'settings: save is off until something is typed',
  await win.locator('[data-connector="telegram"] button:has-text("Save")').isDisabled(),
);
await win.locator('[data-connector="telegram"] input[type="password"]').fill('123456:TEST-token');
await win.waitForTimeout(200);
check(
  'settings: save enables once filled',
  !(await win.locator('[data-connector="telegram"] button:has-text("Save")').isDisabled()),
);

// The round trip, which is the only thing that proves any of the above. A form
// that renders and a Save that lights up are worth nothing if the credential
// does not come back as Connected on the next read.
await win.locator('[data-connector="telegram"] input:not([type="password"])').fill('987654321');
await win.locator('[data-connector="telegram"] button:has-text("Save")').click();
await win.waitForSelector('[data-connector="telegram"] :text("Connected")', { timeout: 5000 });
check('settings: saving connects it', true);
// Back to the automation: connecting the account is what makes the channel
// usable. This is the whole chain — Settings writes a credential, the panel
// reads it, and the toggle stops being decorative.
// Back via the sidebar, the way a person would: toggling Settings returns to
// Home, not to the automation you came from.
await win.locator('aside button', { hasText: 'fresh-auto' }).first().click();
await win.waitForSelector('[data-channel="telegram"]', { timeout: 10000 });
check(
  'notify: connecting Telegram enables its channel',
  !(await win.locator('[data-channel="telegram"] button').first().isDisabled()),
);
await win.locator('[data-channel="telegram"] button').first().click();
await win.waitForTimeout(400);
check('notify: the channel switches on', /Message you from your bot/.test(await t()));

// Pressing Run now with no model key must SAY so, on the automation's own page.
// This guard runs BEFORE a run row is opened — which is also why it cannot
// notify: no run happened. A guard that failed silently is a dead button.
await win.locator('button:has-text("Run now")').click();
// Wait for the text, not a guess at how long the runtime takes to refuse.
await win.waitForSelector('text=/model provider key/i', { timeout: 20000 }).catch(() => {});
body = await t();
check('Run now explains what is missing', /model provider key/i.test(body));
check('and says how to fix it', /keys set|ANTHROPIC_API_KEY/i.test(body));

await win.locator('button[title="Settings"]').click();
await win.waitForSelector('[data-connector="telegram"]', { timeout: 10000 });
await win.locator('[data-connector="telegram"] button:has-text("Disconnect")').click();
await win.waitForTimeout(600);
check(
  'settings: disconnect clears it',
  !(await win.locator('[data-connector="telegram"]').innerText()).includes('Connected'),
);
await win.locator('button[title="Settings"]').click();
await win.waitForTimeout(500);

// New-automation dialog is in-app (no native panel).
await win.locator('aside button[title="New automation"]').click();
await win.waitForTimeout(600);
body = await t();
check('in-app new dialog', /What should it do/.test(body) && /Create/.test(body));
check('dialog shows destination', /Automations\//.test(body));
await win.keyboard.press('Escape');
await win.waitForTimeout(400);

check('no renderer errors', errs.length === 0, errs.slice(0, 2).join(' | '));

console.log(`\nPASS (${pass.length}):`);
for (const p of pass) console.log('  ✓', p);
if (fail.length) { console.log(`\nFAIL (${fail.length}):`); for (const f of fail) console.log('  ✗', f); }
await win.screenshot({ path: '/tmp/full-check.png' });
await app.close();
process.exit(fail.length ? 1 : 0);
