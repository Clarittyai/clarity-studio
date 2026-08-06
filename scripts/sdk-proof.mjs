/**
 * Proof that an automation runs on the PUBLISHED SDK, from public PyPI.
 *
 * Every automation Studio creates declares `claritty-sdk` and nothing else
 * ships it — so the chain that has to hold is: the seed we bundle → its
 * requirements.txt → public PyPI → a version whose schema still loads that
 * seed's manifest. Any link can break without a single test going red:
 *
 *   - the SDK version the seed asks for was never published
 *   - a private index or a local `-e ../sdk` path creeps into requirements
 *   - a new SDK release tightens the manifest schema and the seed stops booting
 *
 * The last is the quiet one. The seed is strict-validated at boot, so a field
 * the SDK later forbids turns every new automation into one that fails to
 * start — on the user's machine, after install, with nothing red in this repo.
 *
 * Uses the PACKAGED seed when a build exists, because that is the copy users
 * get. Run: node scripts/sdk-proof.mjs
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};

const PACKAGED_SEED = join(
  ROOT,
  'apps/desktop/release/mac-arm64/Claritty Studio.app/Contents/Resources/seed',
);
const WORKSPACE_SEED = join(ROOT, 'packages/automation-seed');
const SEED = existsSync(join(PACKAGED_SEED, 'intelligence.yaml')) ? PACKAGED_SEED : WORKSPACE_SEED;
console.log(`\nSeed: ${SEED === PACKAGED_SEED ? 'the packaged copy' : 'the workspace package'}`);

const requirements = join(SEED, 'backend/requirements.txt');
check('the seed declares its dependencies', existsSync(requirements));
const declared = readFileSync(requirements, 'utf8');

// A local path or an alternate index means the automation only builds on a
// machine that already has something — which is every machine except a user's.
const escapes = declared
  .split('\n')
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith('#'))
  .filter((l) => /^-e |^\.|\/|--index-url|--extra-index-url|--find-links|@ (file|git)/.test(l));
check('nothing points outside public PyPI', escapes.length === 0, escapes.join('; '));
check(
  'and it asks for the SDK by name',
  /^claritty-sdk[<>=!~ ]/m.test(declared),
  declared.split('\n').find((l) => l.startsWith('claritty-sdk')),
);

const python = process.env.STUDIO_PYTHON || 'python3';
const venv = mkdtempSync(join(tmpdir(), 'sdk-proof-'));
const bin = (name) => join(venv, 'bin', name);

console.log('\nInstalling it the way a first run does:');
try {
  execFileSync(python, ['-m', 'venv', venv], { stdio: 'pipe' });
  execFileSync(
    bin('pip'),
    ['install', '--quiet', '--disable-pip-version-check', '-r', requirements],
    { stdio: 'pipe', timeout: 10 * 60_000 },
  );
  check('pip resolves everything from PyPI', true);
} catch (cause) {
  check('pip resolves everything from PyPI', false, String(cause.stderr ?? cause).slice(-400));
}

const py = (source) =>
  execFileSync(bin('python'), ['-c', source], { cwd: SEED, encoding: 'utf8', stdio: 'pipe' }).trim();

try {
  const version = py("import importlib.metadata as m; print(m.version('claritty-sdk'))");
  check('the published SDK is installed', /^\d+\./.test(version), version);

  // Installed from the index, not from a checkout on this machine.
  const origin = py(
    "import claritty_sdk, pathlib; print('site-packages' if 'site-packages' in str(pathlib.Path(claritty_sdk.__file__)) else str(pathlib.Path(claritty_sdk.__file__)))",
  );
  check('from the index, not a local checkout', origin === 'site-packages', origin);

  // The imports the seed's own files make. A module that moved between SDK
  // releases fails here rather than at 3am in someone's run.
  py('from claritty_sdk import tool; from claritty_sdk.context import ToolCtx; from claritty_sdk.runtime import bootstrap; from claritty_sdk.integrations.client import make_resolver');
  check('the seed’s imports all resolve', true);

  // The real test: strict-validate the shipped manifest with the shipped SDK.
  const booted = py(`
from pathlib import Path
from claritty_sdk.runtime import bootstrap
m = bootstrap.load(Path('intelligence.yaml')).manifest
print(f"{m.id}|{len(m.tools)}|{len(m.agents)}|{len(m.workflows)}|{len(m.triggers)}")
`);
  const [id, tools, agents, workflows, triggers] = booted.split('|');
  check('the seed manifest boots against it', Boolean(id), booted);
  check('with its tools, agents, workflow and trigger intact', Number(tools) > 0 && Number(agents) > 0 && Number(workflows) > 0 && Number(triggers) > 0, `${tools} tools, ${agents} agents, ${workflows} workflow(s), ${triggers} trigger(s)`);

  // Every extra automation handed on the command line, checked the same way.
  for (const extra of process.argv.slice(2)) {
    const dir = resolve(extra);
    if (!existsSync(join(dir, 'intelligence.yaml'))) {
      check(`${extra} is an automation`, false, 'no intelligence.yaml');
      continue;
    }
    try {
      const out = execFileSync(
        bin('python'),
        ['-c', "from pathlib import Path\nfrom claritty_sdk.runtime import bootstrap\nm = bootstrap.load(Path('intelligence.yaml')).manifest\nprint(f'{m.id} — {len(m.tools)} tools, {len(m.agents)} agents, {len(m.workflows)} workflow(s)')"],
        { cwd: dir, encoding: 'utf8', stdio: 'pipe' },
      ).trim();
      check(`${extra} boots`, true, out);
    } catch (cause) {
      const why = String(cause.stderr ?? cause).trim().split('\n').slice(-3).join(' ');
      check(`${extra} boots`, false, why);
    }
  }
} catch (cause) {
  check('the seed runs on the published SDK', false, String(cause.stderr ?? cause).slice(-600));
}

rmSync(venv, { recursive: true, force: true });
console.log(failures === 0 ? '\nOK — it runs on the published SDK.\n' : `\n${failures} failed.\n`);
process.exit(failures === 0 ? 0 : 1);
