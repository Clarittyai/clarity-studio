/**
 * The local control plane — the thing that makes an unmodified Claritty
 * automation run on your laptop.
 *
 * A deployed automation expects a platform behind `CLARITTY_PLATFORM_URL` that
 * gives it a model to call, credentials to use, and somewhere to report each
 * step. This server is that platform, running on 127.0.0.1, with your keys and
 * your machine. The automation cannot tell the difference, which is the whole
 * point: what runs here runs anywhere.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';

import { ConnectorError, executeTool, resolveTool } from '@claritty-studio/connectors';

import { EnvSecretSource } from './env-secrets.js';
import { MemoryRunStore } from './memory-store.js';
import { anthropic, ProviderHttpError } from './providers/anthropic.js';
import { google } from './providers/google.js';
import { ollama, openai, openrouter } from './providers/openai.js';
import { createSimulator } from './providers/simulator.js';
import { costMicros, isPriced } from './pricing.js';
import { Redactor } from './redact.js';
import type {
  ChatCompletionRequest,
  ProjectIdentity,
  Provider,
  RunStore,
  SecretSource,
} from './types.js';

export interface ControlPlaneOptions {
  host?: string;
  port?: number;
  /** Model used when a request carries none. Rarely hit in practice: the SDK's
   *  `AgentDecl.model` defaults to `claude-sonnet-4-6`, so an agent that
   *  declares nothing still sends a concrete id. See {@link forceModel}. */
  defaultModel?: string;
  /**
   * Override every requested model with this one.
   *
   * Needed because a manifest names a model but the person running it may not
   * have that provider's key — an automation written against Claude has to be
   * runnable by someone holding only an OpenAI key, and a dry run has to reach
   * the simulator no matter what the manifest says. Studio sets this from the
   * user's choice; it is never inferred, because silently rerouting someone's
   * automation to a different model is exactly the kind of surprise that makes
   * a run trace untrustworthy.
   */
  forceModel?: string;
  /** Narrower form of the above: rewrite specific model ids. Useful for
   *  pinning a family alias to a dated release. */
  modelAliases?: Record<string, string>;
  secrets?: SecretSource;
  store?: RunStore;
  /** Extra providers, or replacements. Matched before the built-ins. */
  providers?: Provider[];
  /** Master key for per-project app secrets. Generated if absent. */
  masterKey?: string;
  logger?: boolean;
  /** Block a model call whose payload contains a known secret. On by default:
   *  there is no fleet to break here, and the alternative is watching a
   *  credential leave for a third party. */
  blockSecretEgress?: boolean;
  /** Let connectors reach private and loopback addresses. Off by default.
   *  Turn it on only to automate something you self-host on your own network. */
  allowPrivateHosts?: boolean;
}

export class ControlPlane {
  readonly app: FastifyInstance;
  readonly store: RunStore;
  readonly redactor = new Redactor();

  private readonly projects = new Map<string, ProjectIdentity>();
  private readonly secrets: SecretSource;
  private readonly providers: Provider[];
  private readonly defaultModel: string;
  private readonly masterKey: string;
  private readonly blockSecretEgress: boolean;
  private readonly spend = new Map<string, number>();
  /** Webhook sinks, registered by the scheduler: instanceId → forwarder. */
  private readonly webhookSinks = new Map<
    string,
    (payload: unknown, headers: Record<string, string>) => Promise<unknown>
  >();
  private anyWebhook?: (
    instanceId: string,
    payload: unknown,
    headers: Record<string, string>,
  ) => Promise<{ status: number; body: unknown }>;

  private address?: { host: string; port: number };

  constructor(private readonly opts: ControlPlaneOptions = {}) {
    this.secrets = opts.secrets ?? new EnvSecretSource();
    this.store = opts.store ?? new MemoryRunStore();
    this.defaultModel = opts.defaultModel ?? 'claude-sonnet-4';
    this.masterKey = opts.masterKey ?? randomBytes(32).toString('hex');
    this.blockSecretEgress = opts.blockSecretEgress ?? true;
    this.providers = [
      ...(opts.providers ?? []),
      createSimulator(),
      anthropic,
      openai,
      google,
      ollama,
      openrouter,
    ];
    this.app = Fastify({ logger: opts.logger ?? false });
    this.routes();
  }

  // ── project identity ───────────────────────────────────────────────────────

  /** Mint the credentials a project's container will be given. */
  register(projectId: string): ProjectIdentity {
    const identity: ProjectIdentity = {
      id: projectId,
      authToken: `stk_${randomBytes(24).toString('hex')}`,
      internalSecret: randomBytes(32).toString('hex'),
      appSecret: createHmac('sha256', this.masterKey).update(projectId).digest('hex'),
    };
    this.projects.set(projectId, identity);
    return identity;
  }

  /** The environment to inject into a project's container.
   *
   *  Note what is absent: any provider API key. The container gets a local,
   *  revocable token and nothing else, so compromising the image yields no
   *  credential. This mirrors how the hosted platform works, which is why an
   *  automation that runs here runs there unchanged. */
  environmentFor(projectId: string, opts: { platformUrl: string; userId?: string } ): Record<string, string> {
    const id = this.projects.get(projectId) ?? this.register(projectId);
    const base = opts.platformUrl.replace(/\/+$/, '');
    return {
      CLARITTY_PLATFORM_URL: base,
      CLARITY_PLATFORM_URL: base,
      CLARITTY_LLM_PROXY_URL: `${base}/api/v1`,
      CLARITTY_OTEL_ENDPOINT: base,
      CLARITTY_AUTH_TOKEN: id.authToken,
      CLARITY_INTERNAL_SECRET: id.internalSecret,
      CLARITY_APP_INTEGRATION_SECRET: id.appSecret,
      CLARITY_APP_ID: projectId,
      CLARITTY_APP_ID: projectId,
      CLARITTY_USER_ID: opts.userId ?? 'local',
      CLARITTY_TENANT_ID: 'local',
      CLARITTY_ENV: 'local',
      // The SDK refuses to boot with debug on outside development, because
      // debug handlers log request bodies — which for an integration call
      // includes the credential it just decrypted.
      ENABLE_DEBUG: 'false',
      CLARITTY_PARALLEL_TOOLS: 'true',
    };
  }

  onWebhook(
    instanceId: string,
    sink: (payload: unknown, headers: Record<string, string>) => Promise<unknown>,
  ): void {
    this.webhookSinks.set(instanceId, sink);
  }

  /**
   * Handle every webhook, whatever the instance id.
   *
   * Preferred over per-instance registration because it removes a race: the
   * control plane starts listening as soon as Studio does, but an automation
   * takes seconds to boot. A delivery landing in that window would otherwise
   * hit no sink and be answered with a 404 — telling a sender that a perfectly
   * valid endpoint does not exist, and losing the payload. With one handler
   * installed up front, the delivery is recorded and can be replayed.
   */
  onAnyWebhook(
    handler: (
      instanceId: string,
      payload: unknown,
      headers: Record<string, string>,
    ) => Promise<{ status: number; body: unknown }>,
  ): void {
    this.anyWebhook = handler;
  }

  // ── lifecycle ──────────────────────────────────────────────────────────────

  async listen(): Promise<{ host: string; port: number; url: string }> {
    await this.refreshRedactor();
    const host = this.opts.host ?? '127.0.0.1';
    const port = this.opts.port ?? 4319;
    await this.app.listen({ host, port });
    const actual = this.app.server.address();
    const boundPort = typeof actual === 'object' && actual ? actual.port : port;
    this.address = { host, port: boundPort };
    return { host, port: boundPort, url: `http://${host}:${boundPort}` };
  }

  async close(): Promise<void> {
    await this.app.close();
  }

  get url(): string {
    if (!this.address) throw new Error('control plane is not listening yet');
    return `http://${this.address.host}:${this.address.port}`;
  }

  private async refreshRedactor(): Promise<void> {
    this.redactor.setSecrets(await this.secrets.allSecretValues());
  }

  /** Provider ids that currently have a usable key. */
  async configuredProviders(): Promise<string[]> {
    const ids = [...new Set(this.providers.map((p) => p.id))].filter(
      (id) => id !== 'simulator' && id !== 'ollama',
    );
    const present = await Promise.all(
      ids.map(async (id) => ((await this.secrets.providerKey(id)) ? id : undefined)),
    );
    return present.filter((v): v is string => Boolean(v));
  }

  // ── auth ───────────────────────────────────────────────────────────────────

  /** Resolve the calling project from `/internal/*` headers.
   *
   *  Both credentials are accepted because the SDK always sends both. The
   *  per-project app secret is what stops one project reading another's vault
   *  — a shared secret alone proves only "some container of ours". */
  private authenticateInternal(req: FastifyRequest): ProjectIdentity {
    const headers = req.headers as Record<string, string | undefined>;
    const internal = headers['x-claritty-internal'];
    const appId = headers['x-claritty-app-id'] ?? headers['x-claritty-appid'];
    const appSecret = headers['x-claritty-app-secret'];

    if (appId && appSecret) {
      const known = this.projects.get(appId);
      if (known && constantTimeEqual(appSecret, known.appSecret)) return known;
    }
    if (internal) {
      for (const p of this.projects.values()) {
        if (constantTimeEqual(internal, p.internalSecret)) return p;
      }
    }
    throw new HttpError(401, 'unauthenticated: bad or missing Claritty internal headers');
  }

  private authenticateBearer(req: FastifyRequest): ProjectIdentity {
    const auth = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    if (auth) {
      for (const p of this.projects.values()) {
        if (constantTimeEqual(auth, p.authToken)) return p;
      }
    }
    throw new HttpError(401, 'unauthenticated: bad or missing bearer token');
  }

  // ── routes ─────────────────────────────────────────────────────────────────

  private routes(): void {
    const app = this.app;

    app.setErrorHandler((err, _req, reply) => {
      if (err instanceof HttpError) {
        return reply.status(err.status).send({ error: err.message, ...(err.extra ?? {}) });
      }
      if (err instanceof ProviderHttpError) {
        return reply
          .status(err.status >= 400 && err.status < 600 ? err.status : 502)
          .send({ error: this.redactor.text(err.message), provider: err.provider });
      }
      const message = err instanceof Error ? err.message : String(err);
      return reply.status(500).send({ error: this.redactor.text(message || 'internal error') });
    });

    app.get('/health', async () => ({
      status: 'healthy',
      service: 'claritty-studio-control-plane',
      projects: this.projects.size,
    }));

    // ── the model call ───────────────────────────────────────────────────────
    app.post('/api/v1/chat/completions', async (req, reply) => {
      const project = this.authenticateBearer(req);
      const body = req.body as ChatCompletionRequest;
      const headers = req.headers as Record<string, string | undefined>;
      const runId = headers['x-claritty-workflow-run-id'];
      const agentId = headers['x-claritty-agent-id'];
      const budgetCents = numberOrUndefined(headers['x-claritty-budget-cents']);

      if (body?.stream) {
        // The agent loop never streams; only chat helpers do. Rather than ship
        // a half-working SSE path, say so plainly.
        throw new HttpError(400, 'streaming is not implemented by the local control plane yet');
      }

      const requested = body.model || this.defaultModel;
      const model = this.opts.forceModel ?? this.opts.modelAliases?.[requested] ?? requested;
      const provider = this.providers.find((p) => p.handles(model));
      if (!provider) {
        throw new HttpError(
          400,
          `no provider handles model "${model}". Add a key in Studio → Vault, ` +
            `or prefix the model (ollama/…, openrouter/…).`,
          { reason: 'NO_PROVIDER_FOR_MODEL', model },
        );
      }

      // Spend is tracked per project AND run: two projects can legitimately
      // reuse a run id, and one must never eat the other's budget.
      const spendKey = `${project.id}:${runId ?? ''}`;

      // Budget ceiling, enforced before the call rather than after, because
      // after is too late to prevent the spend.
      if (runId && budgetCents !== undefined) {
        const spentMicros = this.spend.get(spendKey) ?? 0;
        if (spentMicros >= budgetCents * 10_000) {
          throw new HttpError(402, 'workflow budget exceeded', {
            reason: 'WORKFLOW_BUDGET_EXCEEDED',
            spentUsd: spentMicros / 1e6,
            budgetUsd: budgetCents / 100,
          });
        }
      }

      // Last checkpoint before the automation's content leaves for a third
      // party. Studio knows the literal secrets, so this is exact, not a guess.
      const leaked = this.redactor.findEgress(body.messages);
      if (leaked.length > 0 && this.blockSecretEgress) {
        throw new HttpError(400, 'refusing to send a stored secret to a model provider', {
          reason: 'SECRET_EGRESS_BLOCKED',
          matches: leaked.length,
        });
      }

      const apiKey = (await this.secrets.providerKey(provider.id)) ?? '';
      if (!apiKey && provider.id !== 'simulator' && provider.id !== 'ollama') {
        // Say which keys ARE present, so the fix is obvious rather than a
        // guessing game — this is the error a new user hits first.
        const available = await this.configuredProviders();
        throw new HttpError(
          412,
          `This automation asks for "${requested}", which needs a ${provider.id} key, ` +
            `and none is configured. ` +
            (available.length
              ? `You do have: ${available.join(', ')} — pick one of those to run with, `
              : `No provider keys are configured yet — add one in Studio → Vault, `) +
            `or use the simulator to exercise the wiring without spending anything.`,
          { reason: 'PROVIDER_KEY_MISSING', provider: provider.id, model, available },
        );
      }

      const startedAt = Date.now();
      const result = await provider.complete({ ...body, model }, { apiKey });
      const latencyMs = Date.now() - startedAt;

      const micros = costMicros(
        result.model || model,
        result.usage.prompt_tokens,
        result.usage.completion_tokens,
      );
      if (runId) this.spend.set(spendKey, (this.spend.get(spendKey) ?? 0) + micros);

      this.store.recordLlmCall({
        runId,
        agentId,
        provider: provider.id,
        model: result.model || model,
        promptTokens: result.usage.prompt_tokens,
        completionTokens: result.usage.completion_tokens,
        costMicros: micros,
        latencyMs,
        at: startedAt,
      });

      return reply.send(result);
    });

    // ── credentials ──────────────────────────────────────────────────────────
    app.post('/internal/integrations/credentials/fetch', async (req, reply) => {
      const project = this.authenticateInternal(req);
      const body = (req.body ?? {}) as {
        userId?: string;
        integrationCatalogId?: string;
        integrationId?: string;
      };
      const integrationId = body.integrationCatalogId ?? body.integrationId;
      if (!integrationId) throw new HttpError(400, 'integrationCatalogId is required');

      const creds = await this.secrets.integrationCredentials(
        project.id,
        integrationId,
        body.userId ?? 'local',
      );
      if (!creds) {
        // The SDK maps 404 to CredentialsNotAvailable, which optional
        // integrations degrade on gracefully. Anything else would crash a tool.
        return reply.status(404).send({ reason: 'NOT_CONNECTED', integrationId });
      }
      await this.refreshRedactor();
      return reply.send({ credentials: creds, integrationId, userId: body.userId ?? 'local' });
    });

    // ── running a connector tool ─────────────────────────────────────────────
    // This is the endpoint that turns "34 connectors" from a claim into a
    // capability. The SDK's catalog wires every integration tool to POST here;
    // without it an automation can think but cannot touch anything.
    app.post('/internal/integrations/tools/:integrationId/:toolId/execute', async (req, reply) => {
      const project = this.authenticateInternal(req);
      const { integrationId, toolId } = req.params as { integrationId: string; toolId: string };
      const body = (req.body ?? {}) as { userId?: string; arguments?: Record<string, unknown>; args?: Record<string, unknown> };
      const args = body.arguments ?? body.args ?? {};

      const credentials = (await this.secrets.integrationCredentials(
        project.id,
        integrationId,
        body.userId ?? 'local',
      )) as Record<string, string> | undefined;

      const resolved = resolveTool(integrationId, toolId, credentials ?? {});
      if (!resolved) {
        // Naming what IS available beats a bare 404 — the usual cause is a
        // manifest written against the hosted catalog, which is larger.
        throw new HttpError(404, `Studio has no local connector for "${integrationId}.${toolId}".`, {
          reason: 'NO_LOCAL_CONNECTOR',
          integrationId,
          toolId,
        });
      }

      if (!credentials && resolved.integration.fields.length > 0) {
        // 409 rather than 500: the SDK maps this to "not connected", which a
        // tool handler degrades on instead of crashing the run.
        return reply.status(409).send({
          reason: 'NOT_CONNECTED',
          integrationId,
          message: `${resolved.integration.name} is not connected. ${resolved.integration.howToConnect}`,
        });
      }

      try {
        const result = await executeTool({
          spec: resolved.tool,
          args,
          credentials: credentials ?? {},
          allowPrivateHosts: this.opts.allowPrivateHosts ?? false,
        });
        return reply.send({ result });
      } catch (err) {
        if (err instanceof ConnectorError) {
          const status = err.reason === 'credentials' ? 409 : err.reason === 'ssrf' ? 400 : (err.status ?? 502);
          // Redacted: a provider's error body can echo the request, and the
          // request carried the credential.
          throw new HttpError(status, this.redactor.text(err.message), { reason: err.reason.toUpperCase() });
        }
        throw err;
      }
    });

    app.post('/internal/integrations/state', async (req) => {
      const project = this.authenticateInternal(req);
      const body = (req.body ?? {}) as { userId?: string; integrationCatalogId?: string };
      const id = body.integrationCatalogId;
      if (!id) throw new HttpError(400, 'integrationCatalogId is required');
      const creds = await this.secrets.integrationCredentials(project.id, id, body.userId ?? 'local');
      return { connected: Boolean(creds), integrationId: id };
    });

    // ── run checkpoints: where the timeline comes from ───────────────────────
    app.post('/internal/workflow-runs/:runId/checkpoint', async (req) => {
      this.authenticateInternal(req);
      const { runId } = req.params as { runId: string };
      const b = (req.body ?? {}) as {
        stepId: string;
        status: string;
        output?: unknown;
        error?: string | null;
        startedAt: number;
        endedAt?: number | null;
      };
      this.store.checkpointStep({
        runId,
        stepId: b.stepId,
        status: b.status,
        output: this.redactor.value(b.output),
        error: b.error ? this.redactor.text(b.error) : null,
        startedAt: b.startedAt,
        endedAt: b.endedAt ?? null,
      });
      return { ok: true };
    });

    app.post('/internal/workflow-runs/:runId/complete', async (req) => {
      this.authenticateInternal(req);
      const { runId } = req.params as { runId: string };
      const b = (req.body ?? {}) as { status: string; outputs?: unknown; error?: string | null };
      this.store.completeRun({
        runId,
        status: b.status,
        outputs: this.redactor.value(b.outputs),
        error: b.error ? this.redactor.text(b.error) : null,
      });
      return { ok: true };
    });

    // ── traces ───────────────────────────────────────────────────────────────
    app.post('/v1/traces', async () => ({ partialSuccess: {} }));

    // ── webhooks ─────────────────────────────────────────────────────────────
    app.post('/webhooks/:instanceId', async (req, reply) => {
      const { instanceId } = req.params as { instanceId: string };
      const headers = Object.fromEntries(
        Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(',') : String(v ?? '')]),
      );

      const sink = this.webhookSinks.get(instanceId);
      if (sink) return reply.send(await sink(req.body, headers));

      if (this.anyWebhook) {
        const result = await this.anyWebhook(instanceId, req.body, headers);
        return reply.status(result.status).send(result.body);
      }

      // Nothing is listening at all — Studio is up but no automation is being
      // served. Say so rather than claiming the endpoint does not exist.
      return reply.status(503).send({
        error: 'Studio is not serving any automation right now',
        hint: 'run `claritty-studio serve` in the automation directory',
        instanceId,
      });
    });
  }
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly extra?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function numberOrUndefined(v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

export { isPriced };
