/**
 * End-to-end proof that creating an automation produces a real one.
 *
 * "New automation" is the first thing anyone does, and almost all of it happens
 * where a unit test cannot see: a dialog collects a name and a request, the main
 * process copies the seed onto disk, adopts it into the library, and hands the
 * request to a coding agent. Any one of those can succeed halfway and leave a
 * folder that looks created and cannot run.
 *
 * So this drives the real window and then checks the disk — the two things that
 * have to agree.
 *
 * Run: node scripts/generation-proof.mjs
 */

import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { _electron as electron } from 'playwright';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// yaml is the desktop app's dependency, not the workspace root's.
const { parse: parseYaml } = await import(join(ROOT, 'apps/desktop/node_modules/yaml/dist/index.js'));

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};

const HOME = '/tmp/generation-proof-home';
const LIBRARY = '/tmp/generation-proof-library';
for (const dir of [HOME, LIBRARY]) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
}

// Point the library at a throwaway folder, so this never writes into anyone's
// real ~/Automations.
const { Store } = await import(join(ROOT, 'packages/db/dist/index.js'));
new Store(join(HOME, 'studio.db')).close();
const { writeFileSync } = await import('node:fs');
writeFileSync(join(HOME, 'settings.json'), JSON.stringify({ automationsRoot: LIBRARY }));

const NAME = 'Weekly invoice digest';
const REQUEST = 'Every Monday, read last week’s invoices from Gmail and send me a summary.';
const SLUG = 'weekly-invoice-digest';
const TARGET = join(LIBRARY, SLUG);

// Against the PACKAGED app when one exists, because that is the only build a
// user ever runs — and the difference is not cosmetic. The seed is copied into
// Contents/Resources by electron-builder; running `electron .` finds it in the
// workspace instead, so a bundle that shipped without it passed this proof
// while every real install failed at "New automation".
const PACKAGED = join(ROOT, 'apps/desktop/release/mac-arm64/Claritty Studio.app/Contents/MacOS/Claritty Studio');
const packaged = existsSync(PACKAGED);
console.log(packaged ? `Against the packaged app: ${PACKAGED}` : 'Against the dev build (no package found)');
const app = await electron.launch(
  packaged
    ? { executablePath: PACKAGED, args: [], env: { ...process.env, STUDIO_HOME: HOME } }
    : { args: ['.'], cwd: join(ROOT, 'apps/desktop'), env: { ...process.env, STUDIO_HOME: HOME } },
);
const win = await app.firstWindow();
const errors = [];
win.on('pageerror', (e) => errors.push(String(e)));
await win.waitForSelector('[data-brand]');
await win.waitForTimeout(2500);

console.log('\nCreating one, the way a person does:');

await win.locator('aside button[title="New automation"]').click();
await win.waitForTimeout(700);
const dialog = await win.locator('body').innerText();
check('the dialog asks what it should do', /What should it do/i.test(dialog));
check('and says where it will go', new RegExp(SLUG.split('-')[0], 'i').test(dialog) || /generation-proof-library|Automations/.test(dialog));

const inputs = win.locator('input[type="text"], input:not([type])');
await inputs.first().fill(NAME);
const textarea = win.locator('textarea');
if (await textarea.count()) await textarea.first().fill(REQUEST);
await win.waitForTimeout(300);

await win.locator('button:has-text("Create")').last().click();
// The scaffold is a recursive copy of the seed; give it room without being
// generous enough to hide a hang.
await win.waitForSelector(`text=${NAME}`, { timeout: 30_000 }).catch(() => {});
await win.waitForTimeout(2500);

console.log('\nWhat landed on disk:');

check('the folder exists', existsSync(TARGET), TARGET);
// The files that make it an automation rather than a directory. Each is
// load-bearing: the manifest is what Studio reads, backend/ is what runs, and
// the agent files are what a coding agent is steered by.
for (const rel of [
  'intelligence.yaml',
  'app-config.json',
  'backend',
  'CLAUDE.md',
  'AGENTS.md',
  '.claude/skills/clarity-automation/SKILL.md',
  'catalog/integrations',
]) {
  check(`  ${rel}`, existsSync(join(TARGET, rel)));
}
check(
  'no build litter came along',
  !existsSync(join(TARGET, '.studio')) && !existsSync(join(TARGET, '__pycache__')),
);

console.log('\nIs it actually loadable:');

let manifest;
try {
  manifest = parseYaml(readFileSync(join(TARGET, 'intelligence.yaml'), 'utf8'));
} catch (cause) {
  check('the manifest parses', false, String(cause));
}
check('the manifest parses', Boolean(manifest));
check('it declares agents', Array.isArray(manifest?.agents) && manifest.agents.length > 0);
check(
  'it declares a workflow with steps',
  Array.isArray(manifest?.workflows) && (manifest.workflows[0]?.steps?.length ?? 0) > 0,
);
// `WorkflowStep` is strict (`extra="forbid"`), so a field the SDK does not
// define makes the manifest fail to load outright — and the seed is the first
// automation anyone runs. Note `input`, singular: `inputs` is the workflow-level
// declaration of what a person may hand a run, and confusing the two is exactly
// the kind of near-miss that reads fine and silently draws nothing.
const STEP_FIELDS = [
  'id', 'agent', 'tool', 'input', 'with', 'mode', 'onError',
  'forEach', 'for_each', 'as', 'maxIterations', 'max_iterations',
];
for (const [i, step] of (manifest?.workflows?.[0]?.steps ?? []).entries()) {
  const unknown = Object.keys(step).filter((k) => !STEP_FIELDS.includes(k));
  check(`step ${i + 1} uses only fields the SDK defines`, unknown.length === 0, unknown.join(', '));
}

console.log('\nWhat the window shows:');

const body = await win.locator('body').innerText();
check('the new automation is open', body.includes(NAME) || body.includes(SLUG));
check('its flow is drawn from the manifest it just wrote', /What runs, in order/.test(body));
check('the library lists it', (await win.locator('aside button', { hasText: SLUG.split('-')[0] }).count()) > 0);
// The request is the whole point of asking: it becomes the agent's opening
// instruction rather than a generic "build something".
const terminal = await win.locator('.xterm').count();
check('a coding-agent session opened', terminal > 0);
check('no renderer errors', errors.length === 0, errors[0] ?? '');

console.log('\nCreating the same name twice:');
await win.locator('aside button[title="New automation"]').click();
await win.waitForTimeout(600);
await win.locator('input[type="text"], input:not([type])').first().fill(NAME);
await win.locator('button:has-text("Create")').last().click();
await win.waitForTimeout(2500);
const after = await win.locator('body').innerText();
// Silently overwriting, or silently making a second folder, both lose work.
check('it refuses and says why', /already exists/i.test(after), after.match(/.{0,80}already exists.{0,40}/i)?.[0] ?? 'no message');

await app.close();
rmSync(HOME, { recursive: true, force: true });
rmSync(LIBRARY, { recursive: true, force: true });

console.log(failures === 0 ? '\nOK — generation produces a real automation.\n' : `\n${failures} failed.\n`);
process.exit(failures === 0 ? 0 : 1);
