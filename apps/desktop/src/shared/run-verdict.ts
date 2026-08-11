/**
 * Did this run actually do its job?
 *
 * The engine's own answer is not that question. `workflow_engine.py` declares a
 * run `success` when ANY step succeeded — deliberately, so one broken step does
 * not throw away the work of the others. But `client-summary` has two steps: a
 * deterministic `plan` that builds a Gmail query, and the `summarise` agent that
 * does everything the automation exists for. `plan` succeeds whatever happens.
 * So four consecutive runs that read no mail, wrote no digest and sent no email
 * were each stored as `status: success, error: null`, having spent 8.3k tokens
 * between them.
 *
 * Every surface then repeated that verdict: the notification said "finished —
 * The run completed", Home counted the automation healthy, and only the
 * executions row disagreed, in a note computed at render time that nothing else
 * could see. The disagreement is the bug. There is one question here and it
 * needs one answer, in one place, that every surface reads.
 *
 * Deliberately NOT a re-judgement of the engine: `run.status` is kept as the
 * engine's word for what the workflow did. This answers the different question a
 * person is actually asking when they look at a list of runs.
 */

/** The subset of a stored run this needs. */
export interface VerdictRun {
  status: string;
  error?: string | null;
}

/** The subset of a stored step this needs. */
export interface VerdictStep {
  stepId: string;
  status: string;
  error?: string | null;
}

export interface RunVerdict {
  /** What to draw. `skipped` is the amber "it ran and achieved nothing" case. */
  status: 'success' | 'failed' | 'running' | 'skipped';
  /**
   * True when the run did what it exists to do. False for a failure AND for the
   * case this file exists for: a green run that produced nothing.
   */
  didItsJob: boolean;
  /** A short phrase for a row, naming what happened rather than counting units. */
  note?: string;
  /**
   * The recorded reason, already written for a person by whatever refused. This
   * is the field that tells someone what to fix, and it was one join away from
   * every screen while none of them showed it.
   */
  reason?: string;
}

/**
 * A step that was skipped WITH an error tried and could not. A step skipped with
 * no error is a conditional gate that correctly did not fire — an ordinary part
 * of a working workflow, and nothing to warn about.
 *
 * Conflating them was its own bug: the previous check counted every skip, so an
 * automation with a perfectly good `if` branch would have shown an amber dot and
 * "1 step skipped" on every run it ever made, for as long as it worked properly.
 */
function blockedSteps(steps: VerdictStep[]): VerdictStep[] {
  return steps.filter((s) => s.status === 'skipped' && !!s.error);
}

export function runVerdict(run: VerdictRun, steps: VerdictStep[]): RunVerdict {
  if (run.status === 'running' || run.status === 'starting') {
    return { status: 'running', didItsJob: false };
  }
  if (run.status === 'failed') {
    return {
      status: 'failed',
      didItsJob: false,
      reason: run.error ? tidyReason(run.error) : firstReason(steps),
    };
  }

  const blocked = blockedSteps(steps);
  if (blocked.length === 0) {
    return { status: 'success', didItsJob: true };
  }

  // Everything that tried, failed. The engine only calls this a failure when
  // there was no successful step at all, which a deterministic prep step is
  // enough to prevent.
  const ran = steps.filter((s) => s.status === 'success').length;
  const note =
    ran === 0
      ? 'nothing ran'
      : blocked.length === 1
        ? `${blocked[0]!.stepId} could not run`
        : `${blocked.length} steps could not run`;

  return {
    status: 'skipped',
    didItsJob: false,
    note,
    reason: blocked[0]?.error ? tidyReason(blocked[0].error) : undefined,
  };
}

function firstReason(steps: VerdictStep[]): string | undefined {
  const found = steps.find((s) => s.error)?.error;
  return found ? tidyReason(found) : undefined;
}

/**
 * Drop the agent prefix the SDK stamps on — twice.
 *
 * A real recorded reason reads "agent 'client-summarizer' raised: agent
 * 'client-summarizer': model returned non-JSON text…". Sixty characters of the
 * same name before the sentence starts, on a line that has to fit in a row, and
 * the row already says which step this was. What survives is the part that
 * tells someone what went wrong.
 */
export function tidyReason(raw: string): string {
  let out = raw.trim();
  // Repeat, because the SDK applies it at two levels.
  for (let i = 0; i < 2; i++) {
    out = out.replace(/^agent\s+'[^']*'\s*(?:raised)?\s*:\s*/i, '');
  }
  return out;
}

/**
 * The part the recorded reason cannot say: what to do about it.
 *
 * "empty response and no tool call" is the SDK naming a state. It is accurate
 * and it is useless — it does not say the model is the weak link, and nothing
 * else on screen does either, so the obvious reading is that the automation is
 * broken. It usually is not.
 *
 * Measured: `qwen2.5:32b` behind Ollama's OpenAI shim, sent the SAME well-formed
 * request eight times, emitted a tool call twice. `command-r` intermittently
 * answers with Cohere's native "Action: ```json```" prose instead. The adapter
 * already retries one empty local reply, which takes this to roughly even odds
 * — so the remaining failures need a sentence, not another retry.
 *
 * The sentence names no success rate. Two in eight was measured for one model on
 * one machine, and quoting it back for a model it was never measured on would be
 * inventing a number to sound precise.
 *
 * Returns undefined when there is nothing useful to add, which is most of the
 * time. A hint that fires on everything is noise, and noise is what people learn
 * to skip past.
 */
export function reasonHint(
  reason?: string,
  /**
   * `provider` decides whether the model is local, NOT the model name. The store
   * records what was sent to the endpoint, which has the `ollama/` prefix
   * stripped — so `llama3.1:8b` arrives here looking like any other name and a
   * prefix test silently took the generic branch for the exact case this hint
   * exists to explain.
   */
  who?: { provider?: string; model?: string },
): string | undefined {
  if (!reason) return undefined;
  const model = who?.model;
  const localModel = who?.provider === 'ollama';
  const noToolCall =
    /empty response and no tool call|without calling the .*finish tool|non-JSON text/i.test(
      reason,
    );
  if (!noToolCall) return undefined;

  return localModel
    ? `The model answered without calling a tool, which local models do often — ` +
        `${model ?? 'this one'} did it here. Studio's agent loop is only proven ` +
        `against Anthropic: add a key in Settings → Vault, or try running it ` +
        `again or on a larger local model.`
    : 'The model answered without calling a tool, so the step could not finish. ' +
        'Running it again often works; a more capable model works more often.';
}

/**
 * One line for a notification.
 *
 * "finished" for a run that did nothing is the same failure the notifier's own
 * docstring warns about for a channel that silently drops a message: you are
 * told the thing you rely on worked, so you stop looking.
 */
export function verdictHeadline(automation: string, v: RunVerdict): string {
  if (v.status === 'failed') return `${automation} failed`;
  if (v.status === 'skipped') return `${automation} did nothing`;
  if (v.status === 'running') return `${automation} is running`;
  return `${automation} finished`;
}

/** The body. Says the reason when there is one, because that is the actionable half. */
export function verdictDetail(
  v: RunVerdict,
  who?: { provider?: string; model?: string },
): string {
  if (v.reason) {
    const hint = reasonHint(v.reason, who);
    const body = hint ? `${v.reason} ${hint}` : v.reason;
    return body.slice(0, 500);
  }
  if (v.status === 'skipped') {
    return 'It ran, but the step that does the work could not, so nothing came of it.';
  }
  if (v.status === 'failed') return 'The run failed.';
  return 'The run completed.';
}
