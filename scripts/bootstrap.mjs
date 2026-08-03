#!/usr/bin/env node
/**
 * One command to go from a fresh clone to a working install.
 *
 *   pnpm setup
 *
 * Checks the machine, builds the workspace, and prepares the Python
 * environment the spike uses. Every failure explains what to do about it —
 * "command not found" with no further comment is how people give up on a tool
 * in the first five minutes.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const isWindows = process.platform === 'win32';
const VENV = join(ROOT, '.venv-probe');
const VENV_PY = isWindows ? join(VENV, 'Scripts', 'python.exe') : join(VENV, 'bin', 'python');

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code) => (s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const dim = paint('2');
const bold = paint('1');
const green = paint('32');
const red = paint('31');

const step = (m) => console.log(`\x1b[36m→\x1b[0m ${m}`);
const ok = (m) => console.log(`${green('✓')} ${m}`);
const die = (m) => {
  console.error(`${red('✘')} ${m}`);
  process.exit(1);
};

function sh(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit', shell: isWindows, ...opts });
}

function quiet(cmd, args) {
  return spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', shell: isWindows });
}

console.log();
console.log(bold('Claritty Studio — setup'));
console.log();

// ── Node ─────────────────────────────────────────────────────────────────────
const nodeMajor = Number(process.versions.node.split('.')[0]);
if (nodeMajor < 22) {
  die(
    `Node ${process.versions.node} is too old — Studio needs 22 or newer.\n` +
      `  Studio uses Node's built-in SQLite so that installing it never needs a\n` +
      `  C++ toolchain. Upgrade with nvm, fnm, or from nodejs.org.`,
  );
}
ok(`Node ${process.versions.node}`);

// ── dependencies ─────────────────────────────────────────────────────────────
if (!existsSync(join(ROOT, 'node_modules'))) {
  step('installing workspace dependencies…');
  if (sh('pnpm', ['install']).status !== 0) {
    die('pnpm install failed. If pnpm is missing: npm install -g pnpm');
  }
}
ok('dependencies installed');

// ── build ────────────────────────────────────────────────────────────────────
step('building…');
if (sh('pnpm', ['build']).status !== 0) die('build failed — see the output above.');
ok('built');

// ── Python (for the spike and the native runtime) ────────────────────────────
const pythonCandidates = isWindows ? ['python', 'py'] : ['python3', 'python'];
let python = process.env.STUDIO_PYTHON;
if (!python) {
  python = pythonCandidates.find((candidate) => {
    const res = quiet(candidate, ['--version']);
    if (res.status !== 0) return false;
    const version = `${res.stdout ?? ''}${res.stderr ?? ''}`;
    const match = version.match(/Python (\d+)\.(\d+)/);
    return match ? Number(match[1]) === 3 && Number(match[2]) >= 9 : false;
  });
}

if (!python) {
  console.log();
  console.log(
    dim(
      '  No Python 3.9+ found. That is fine — Docker does not need it.\n' +
        '  Install Python if you want `--native` mode or `pnpm spike`.',
    ),
  );
} else {
  if (!existsSync(VENV_PY)) {
    step('creating the Python environment…');
    if (sh(python, ['-m', 'venv', VENV]).status !== 0) {
      die(`could not create a virtualenv with ${python}. On Debian/Ubuntu: apt install python3-venv`);
    }
  }
  step('installing the Claritty SDK from PyPI…');
  const pip = sh(VENV_PY, [
    '-m', 'pip', 'install', '--quiet', '--disable-pip-version-check',
    'claritty-sdk>=2.11,<3', 'fastapi', 'uvicorn[standard]',
  ]);
  if (pip.status !== 0) die('pip install failed — see the output above.');
  ok('Python environment ready');
}

// ── Docker (optional) ────────────────────────────────────────────────────────
const docker = quiet('docker', ['version', '--format', '{{.Server.Version}}']);
const dockerOk = docker.status === 0 && !/error|cannot connect/i.test(`${docker.stdout}${docker.stderr}`);
console.log(
  dockerOk
    ? `${green('✓')} Docker ${String(docker.stdout).trim()}`
    : dim('  Docker not running — use --native until you install Docker Desktop.'),
);

// ── done ─────────────────────────────────────────────────────────────────────
console.log();
console.log(bold('Ready. Try:'));
console.log();
if (python) {
  console.log(`  pnpm spike                    ${dim('# prove an automation runs against the local control plane')}`);
}
console.log(`  node apps/cli/dist/index.js doctor`);
console.log(`  node apps/cli/dist/index.js new my-automation`);
console.log(`  cd my-automation && node ../apps/cli/dist/index.js run ${python ? '--native ' : ''}--simulate`);
console.log();
console.log(dim('  No account, no login, no telemetry. Everything stays on this machine.'));
console.log();
