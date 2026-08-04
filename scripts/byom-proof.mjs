/**
 * "Bring your own model" is a promise, so it is a test.
 *
 * A configured base URL must actually route a run's model call to the user's
 * own endpoint. It did not, for a while: the providers accepted `ctx.baseUrl`
 * and nothing ever supplied one, so an endpoint was stored and then silently
 * ignored — the run went to the vendor API and the user paid for it there.
 *
 * This stands up a fake OpenAI-compatible server, points a provider at it, and
 * asserts the call arrives. No network, no key, no cost.
 */
import { createServer } from 'node:http';

import { ControlPlane } from '../packages/control-plane/dist/index.js';

let received;
const fake = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    received = { url: req.url, body: JSON.parse(body || '{}'), auth: req.headers.authorization };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'x', model: 'gpt-4o-mini', choices: [{ message: { role: 'assistant', content: 'from my own model' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 3 },
    }));
  });
});
await new Promise((r) => fake.listen(0, '127.0.0.1', r));
const mine = `http://127.0.0.1:${fake.address().port}/v1`;
console.log('my endpoint      :', mine);

const plane = new ControlPlane({
  port: 0,
  secrets: {
    async providerKey(id) { return id === 'openai' ? 'sk-local' : undefined; },
    async providerBaseUrl(id) { return id === 'openai' ? mine : undefined; },
    async integrationCredentials() { return undefined; },
    async allSecretValues() { return []; },
  },
  store: {
    checkpointStep() {}, completeRun() {}, recordLlmCall() {},
    getRun: () => undefined, getSteps: () => [], getLlmCalls: () => [],
  },
});
const { url } = await plane.listen();
const id = plane.register('proof');
const env = plane.environmentFor('proof', { platformUrl: url });

const res = await fetch(`${url}/api/v1/chat/completions`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    Authorization: `Bearer ${id.authToken}`,
    'X-Claritty-App-Id': 'proof',
  },
  body: JSON.stringify({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] }),
});
const out = await res.json().catch(() => ({}));
console.log('status           :', res.status);
console.log('MY SERVER GOT IT :', Boolean(received), received ? received.url : '(never called)');
const content = out?.choices?.[0]?.message?.content;
console.log('reply content    :', content ?? JSON.stringify(out).slice(0, 200));

await plane.close();
fake.close();

if (!received || res.status !== 200 || content !== 'from my own model') {
  console.error('\nFAILED — the run did not reach the configured endpoint.');
  process.exit(1);
}
console.log('\nBYOM PROOF PASSED — the run went to the endpoint the user configured.');
