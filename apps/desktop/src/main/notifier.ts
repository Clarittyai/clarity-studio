/**
 * Telling you a run finished.
 *
 * Until now the preference existed and nothing read it: the toggle stored a
 * value, and the only thing that ever produced a notification was the "send a
 * test" button. A run could fail overnight and say nothing.
 *
 * Every channel here goes through the same connector engine an automation's own
 * steps use, with the same machine-wide credentials set in Settings. There is no
 * separate notification service and nothing is sent anywhere but the provider
 * you connected.
 *
 * The rule this file exists to keep: **a channel that fails says so.** A
 * notification is the thing you rely on to find out something went wrong, so a
 * notification that silently fails to send is the worst possible failure — you
 * conclude nothing happened. Every send returns its outcome, the caller stores
 * the last one, and the panel shows it next to the toggle.
 */

import { executeTool, findIntegration } from '@clarity-studio/connectors';

import { verdictDetail, verdictHeadline, type RunVerdict } from '../shared/run-verdict.js';

export interface NotifyPrefs {
  desktop?: boolean;
  slack?: boolean;
  /** Where to post. Slack needs one; the bot must be in it. */
  slackChannel?: string;
  telegram?: boolean;
  whatsapp?: boolean;
  email?: boolean;
  emailTo?: string;
  /** Resend refuses a from-address on an unverified domain, so this is asked
   *  for rather than guessed. */
  emailFrom?: string;
}

/** What one channel did, kept so the UI can show a failure rather than imply
 *  everything is fine. */
export interface DeliveryResult {
  channel: 'slack' | 'telegram' | 'whatsapp' | 'email';
  ok: boolean;
  /** The provider's own words when it refused. */
  error?: string;
  at: number;
}

export interface RunSummary {
  automation: string;
  status: string;
  error?: string | null;
  /**
   * What the run actually achieved, which `status` does not say. The engine
   * calls a run successful when ANY step succeeded, so an automation whose only
   * real step could not run still arrives here as `success` with no error — and
   * this file then said "finished — The run completed."
   *
   * That is the same failure the docstring above warns about for a channel that
   * silently drops a message. The point of the notification is not having to
   * look; being told it worked is worse than being told nothing, because you
   * stop looking. Optional so a caller with no steps to hand still works.
   */
  verdict?: RunVerdict;
}

/** One line, because that is what a phone shows. */
export function headline(run: RunSummary): string {
  if (run.verdict) return verdictHeadline(run.automation, run.verdict);
  const ok = run.status === 'success';
  return `${run.automation} ${ok ? 'finished' : run.status === 'failed' ? 'failed' : run.status}`;
}

export function detail(run: RunSummary): string {
  if (run.verdict) return verdictDetail(run.verdict);
  if (run.error) return run.error.slice(0, 500);
  return run.status === 'success' ? 'The run completed.' : `The run ended as ${run.status}.`;
}

/**
 * Send to every enabled channel that has what it needs.
 *
 * `credentials` is looked up per integration by the caller, which owns the
 * vault. Channels run independently: one provider being down must not stop the
 * others, so this never rejects and reports each outcome separately.
 */
export async function deliver(
  prefs: NotifyPrefs,
  run: RunSummary,
  credentialsFor: (integrationId: string) => Record<string, string> | undefined,
  now: number,
  fetchImpl?: typeof fetch,
): Promise<DeliveryResult[]> {
  const text = `${headline(run)}\n${detail(run)}`;
  const jobs: Array<Promise<DeliveryResult>> = [];

  const send = async (
    channel: DeliveryResult['channel'],
    integrationId: string,
    toolId: string,
    args: Record<string, unknown>,
  ): Promise<DeliveryResult> => {
    try {
      const spec = findIntegration(integrationId);
      const tool = spec?.tools.find((t) => t.id === toolId);
      if (!tool) throw new Error(`no ${toolId} connector`);
      const credentials = credentialsFor(integrationId);
      if (!credentials) throw new Error(`${spec?.name ?? integrationId} is not connected`);
      await executeTool({ spec: tool, args, credentials, fetchImpl });
      return { channel, ok: true, at: now };
    } catch (cause) {
      return {
        channel,
        ok: false,
        error: cause instanceof Error ? cause.message : String(cause),
        at: now,
      };
    }
  };

  if (prefs.slack && prefs.slackChannel?.trim()) {
    jobs.push(
      send('slack', 'slack', 'slack.post_message', {
        channel: prefs.slackChannel.trim(),
        text,
      }),
    );
  }

  if (prefs.telegram) {
    // chat_id is a connector field, not a notification setting — it is part of
    // knowing which Telegram account this is, the same as the bot token.
    const chatId = credentialsFor('telegram')?.chat_id;
    jobs.push(
      chatId
        ? send('telegram', 'telegram', 'telegram.send_message', { chat_id: chatId, text })
        : Promise.resolve({
            channel: 'telegram' as const,
            ok: false,
            error: 'Telegram has no chat id — add one in Settings › Connections.',
            at: now,
          }),
    );
  }

  if (prefs.whatsapp) {
    // Both the destination number and the id are part of which WhatsApp account
    // this is, so they live with the connection rather than in preferences.
    const to = credentialsFor('whatsapp')?.to;
    jobs.push(
      to
        ? send('whatsapp', 'whatsapp', 'whatsapp.send_message', { to, text })
        : Promise.resolve({
            channel: 'whatsapp' as const,
            ok: false,
            error: 'WhatsApp has no number to message — add one in Settings › Connections.',
            at: now,
          }),
    );
  }

  if (prefs.email && prefs.emailTo?.trim() && prefs.emailFrom?.trim()) {
    jobs.push(
      send('email', 'resend', 'resend.send', {
        from: prefs.emailFrom.trim(),
        to: prefs.emailTo.trim(),
        subject: headline(run),
        text: detail(run),
      }),
    );
  }

  return Promise.all(jobs);
}
