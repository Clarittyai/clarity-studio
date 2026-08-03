/**
 * Webhook ingress, and the reason to keep Studio installed: **replay**.
 *
 * Every delivery is stored whole — headers and body — before it is forwarded.
 * That single decision is what turns webhook debugging from "please ask Stripe
 * to send that again" into pressing a button. The hosted platform does not
 * offer it; a local tool can, because the payload never has to leave the
 * machine.
 *
 * Signature verification is deliberately *not* done here. The automation
 * declares a `webhook_secret` config field and checks the signature itself,
 * because only it knows which provider's scheme applies. Studio's job is to
 * deliver the bytes faithfully and remember them.
 */

import type { Store } from '@clarity-studio/db';

import type { DispatchTarget } from './dispatcher.js';

export interface WebhookIngressOptions {
  store: Store;
  resolveTarget: (projectId: string) => DispatchTarget | undefined;
}

export interface IngressResult {
  status: number;
  body: unknown;
  deliveryId: string;
  runId?: string;
}

/** Headers worth keeping. Forwarding hop-by-hop headers or an inbound
 *  `authorization` to the automation would be leaking, not delivering. */
const DROP_HEADERS = new Set([
  'host', 'connection', 'content-length', 'authorization', 'cookie',
  'transfer-encoding', 'keep-alive', 'upgrade', 'proxy-authorization',
]);

export class WebhookIngress {
  constructor(private readonly opts: WebhookIngressOptions) {}

  /**
   * Accept a delivery for a trigger instance and forward it.
   *
   * The delivery is recorded before anything can go wrong, so a payload that
   * crashes the automation is still on disk to inspect and replay.
   */
  async deliver(
    instanceId: string,
    payload: unknown,
    headers: Record<string, string> = {},
    opts: { replayOf?: string } = {},
  ): Promise<IngressResult> {
    const { store } = this.opts;
    const instance = store.triggers.get(instanceId);

    if (!instance) {
      return { status: 404, body: { error: `no trigger instance ${instanceId}` }, deliveryId: '' };
    }

    const forwardable = filterHeaders(headers);
    const deliveryId = store.triggers.startDelivery({
      instanceId,
      requestHeaders: forwardable,
      requestBody: payload,
    });

    if (!instance.enabled) {
      // 202, not an error: the sender did nothing wrong, and a 4xx would make
      // most providers start retrying or disable the endpoint on their side.
      store.triggers.finishDelivery(deliveryId, { success: false, error: 'trigger is disabled' });
      return { status: 202, body: { accepted: false, reason: 'trigger is disabled' }, deliveryId };
    }

    const target = this.opts.resolveTarget(instance.projectId);
    if (!target) {
      store.triggers.finishDelivery(deliveryId, { success: false, error: 'automation is not running' });
      return {
        status: 503,
        body: { accepted: false, reason: 'the automation is not running — start it and replay this delivery' },
        deliveryId,
      };
    }

    // Keyed on the delivery, not the payload: two identical payloads sent
    // deliberately are two events, and a replay is meant to run again.
    const idempotencyKey = `webhook:${deliveryId}`;
    const runId = `wfr_${deliveryId.replace(/-/g, '').slice(0, 24)}`;

    store.openRun({
      id: runId,
      projectId: instance.projectId,
      workflowId: instance.workflowId ?? undefined,
      triggeredBy: opts.replayOf ? 'webhook-replay' : 'webhook',
      idempotencyKey,
    });

    try {
      const res = await fetch(`${target.baseUrl}/internal/trigger-webhook`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'X-Claritty-Internal': target.internalSecret },
        body: JSON.stringify({
          instanceId,
          recipeTriggerId: instance.recipeTriggerId,
          workflowId: instance.workflowId,
          config: instance.config ?? {},
          payload,
          headers: forwardable,
          workflowRunId: runId,
          idempotencyKey,
        }),
        signal: AbortSignal.timeout(10 * 60_000),
      });

      const body = (await res.json().catch(() => ({}))) as { success?: boolean; error?: string };
      const success = res.ok && body.success === true;

      store.triggers.finishDelivery(deliveryId, {
        success,
        httpStatus: res.status,
        error: success ? null : body.error ?? `HTTP ${res.status}`,
        runId,
      });
      store.triggers.recordRun(instanceId, Date.now(), success ? 'success' : 'failed', body.error ?? null);

      return { status: success ? 200 : 502, body: { accepted: true, success, runId }, deliveryId, runId };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      store.triggers.finishDelivery(deliveryId, { success: false, error: message, runId });
      store.triggers.recordRun(instanceId, Date.now(), 'failed', message);
      store.completeRun({ runId, status: 'failed', error: message });
      return { status: 502, body: { accepted: true, success: false, error: message }, deliveryId, runId };
    }
  }

  /**
   * Send a past delivery through again, byte for byte.
   *
   * The new attempt is recorded as its own delivery rather than overwriting the
   * original — you want to see that you replayed it, and how many times.
   */
  async replay(deliveryId: string): Promise<IngressResult> {
    const original = this.opts.store.triggers.delivery(deliveryId);
    if (!original) {
      return { status: 404, body: { error: `no delivery ${deliveryId}` }, deliveryId: '' };
    }
    return this.deliver(original.instanceId, original.requestBody, original.requestHeaders ?? {}, {
      replayOf: deliveryId,
    });
  }
}

function filterHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (DROP_HEADERS.has(key.toLowerCase())) continue;
    out[key.toLowerCase()] = value;
  }
  return out;
}
