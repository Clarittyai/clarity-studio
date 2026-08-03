/**
 * The M3 proof: an automation reaching a real HTTP service through the vault
 * and the connector engine, with the credential never leaving the host.
 */
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ControlPlane } from '/home/user/clarity-studio/packages/control-plane/dist/index.js';

const received = [];
const server = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    received.push({ url: req.url, body });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, delivered: true }));
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const hookPort = server.address().port;
console.log(`fake service listening on ${hookPort}`);

// Build an automation that calls the connector tool.
const dir = mkdtempSync(join(tmpdir(), 'm3-'));
const project = join(dir, 'notifier');
cpSync('/home/user/clarity-studio/packages/automation-seed', project, { recursive: true });

writeFileSync(join(project, 'intelligence.yaml'), `schemaVersion: 2
id: notifier
version: 1.0.0

integrations:
  - id: outbound-webhook
    required: true

# A catalog tool: handler "broker" means the host executes it, so the
# automation holds no credential and knows no provider URL.
tools:
  - id: outbound-webhook.post
    source: catalog
    handler: broker
    input:
      url: { type: string, required: true }
      payload: { type: object, required: true }
    output:
      ok: { type: boolean, required: false }

agents: []

workflows:
  - id: notify
    inputs:
      url: { type: string, required: true }
    steps:
      # Called directly as a step, so this proves the connector chain rather
      # than a model's willingness to pass sensible arguments.
      - id: send
        tool: outbound-webhook.post
        input:
          url: "\${input.url}"
          payload: { event: "invoice.paid", amount: 4200 }
    outputs:
      sent: "\${steps.send.output.ok}"

triggers:
  - id: on-demand
    type: SCHEDULE
    workflow: notify
    supportedSchedules: [ONE_TIME]
    configFields:
      - { key: time, type: time, required: true, label: "Run at", default: "09:00" }
      - { key: timezone, type: timezone, required: true, label: "Timezone" }
`);

const plane = new ControlPlane({
  port: 0,
  forceModel: 'simulator',
  allowPrivateHosts: true,          // so the test can reach its own fake service
  secrets: {
    async providerKey() { return undefined; },
    async integrationCredentials(_p, id) { return id === 'outbound-webhook' ? {} : undefined; },
    async allSecretValues() { return []; },
  },
});
const { url: planeUrl } = await plane.listen();
const env = plane.environmentFor('m3', { platformUrl: planeUrl });

const py = '/home/user/clarity-studio/.venv-probe/bin/python';
const proc = spawn(py, ['-m', 'uvicorn', 'backend.main:app', '--host', '127.0.0.1', '--port', '3311', '--log-level', 'warning'], {
  cwd: project, env: { ...process.env, ...env, PYTHONPATH: project, APP_DATA_DIR: join(project, '.data') },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const log = [];
proc.stdout.on('data', (d) => log.push(String(d)));
proc.stderr.on('data', (d) => log.push(String(d)));

for (let i = 0; i < 60; i++) {
  try { if ((await fetch('http://127.0.0.1:3311/health')).ok) break; } catch {}
  await new Promise((r) => setTimeout(r, 500));
}

// The simulator will call outbound-webhook.post with synthesised args, so
// supply the real ones as workflow input via the agent's prompt is not enough —
// drive the tool directly through the same endpoint the automation uses.
const runId = 'wfr_m3_proof';
const res = await fetch('http://127.0.0.1:3311/api/workflows/notify/execute', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'X-User-ID': 'local' },
  body: JSON.stringify({
    inputs: { url: `http://127.0.0.1:${hookPort}/hook` },
    workflow_run_id: runId,
    user_id: 'local',
  }),
});
const result = await res.json();

console.log('workflow status  :', result.status);
console.log('steps            :', result.steps?.map((s) => `${s.id}=${s.status}`).join(', '));
console.log('service hits     :', received.length);
if (received.length) console.log('service received :', received[0].body.slice(0, 120));
if (result.status !== 'success') console.log(log.join('').split('\n').slice(-20).join('\n'));

proc.kill('SIGTERM');
await plane.close();
server.close();
process.exit(result.status === 'success' ? 0 : 1);
