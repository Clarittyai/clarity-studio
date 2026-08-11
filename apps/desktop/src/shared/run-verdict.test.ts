import { describe, expect, it } from 'vitest';

import {
  reasonHint,
  runVerdict,
  tidyReason,
  verdictDetail,
  verdictHeadline,
} from './run-verdict.js';

/**
 * These cases are the four `client-summary` runs that prompted this file.
 *
 * Each was stored `status: success, error: null`, each spent 1–2k tokens, and
 * each read no mail and sent no email. Every surface repeated the engine's
 * verdict; only the executions row disagreed, in a note nothing else could see.
 */
describe('run verdict', () => {
  const plan = { stepId: 'plan', status: 'success', error: null };
  const summariseBlocked = {
    stepId: 'summarise',
    status: 'skipped',
    error:
      "agent 'client-summarizer' raised: model returned non-JSON text without calling the __finish tool — refusing to guess output shape.",
  };

  it('refuses to call a run successful when the step that matters could not run', () => {
    const v = runVerdict({ status: 'success', error: null }, [plan, summariseBlocked]);
    expect(v.didItsJob).toBe(false);
    expect(v.status).toBe('skipped');
    expect(v.note).toBe('summarise could not run');
  });

  it('carries the recorded reason, which is the only actionable part', () => {
    // It was one join away from every screen and none of them showed it. A
    // person reading "1 step skipped" beside "Gmail not connected" concludes
    // they should connect Gmail; the actual reason is a model that would not
    // call the finish tool, and connecting Gmail would not have helped.
    const v = runVerdict({ status: 'success', error: null }, [plan, summariseBlocked]);
    expect(v.reason).toMatch(/without calling the __finish tool/);
  });

  it('leaves an ordinary conditional skip alone', () => {
    // A gate that correctly did not fire is skipped WITH NO ERROR. Counting it
    // meant a working automation showed an amber dot and "1 step skipped" on
    // every run it ever made.
    const gate = { stepId: 'only-on-weekdays', status: 'skipped', error: null };
    const v = runVerdict({ status: 'success', error: null }, [plan, gate]);
    expect(v).toEqual({ status: 'success', didItsJob: true });
  });

  it('says nothing ran when nothing did', () => {
    const v = runVerdict({ status: 'success', error: null }, [summariseBlocked]);
    expect(v.note).toBe('nothing ran');
  });

  it('counts several blocked steps rather than naming one of them', () => {
    const v = runVerdict({ status: 'success', error: null }, [
      plan,
      summariseBlocked,
      { stepId: 'notify', status: 'skipped', error: 'gmail is not connected' },
    ]);
    expect(v.note).toBe('2 steps could not run');
  });

  it('keeps a real success a success', () => {
    const v = runVerdict({ status: 'success', error: null }, [
      plan,
      { stepId: 'summarise', status: 'success', error: null },
    ]);
    expect(v).toEqual({ status: 'success', didItsJob: true });
  });

  it('falls back to a step reason when a failed run recorded none', () => {
    const v = runVerdict({ status: 'failed', error: null }, [
      { stepId: 'summarise', status: 'failed', error: 'the model timed out' },
    ]);
    expect(v.status).toBe('failed');
    expect(v.reason).toBe('the model timed out');
  });

  it('drops the agent name the SDK stamps on twice', () => {
    // The real string is "agent 'client-summarizer' raised: agent
    // 'client-summarizer': model returned non-JSON text…" — sixty characters of
    // the same name before the sentence starts, on a line that has to fit in a
    // row that already names the step.
    const v = runVerdict({ status: 'success', error: null }, [plan, summariseBlocked]);
    expect(v.reason).toBe(
      'model returned non-JSON text without calling the __finish tool — refusing to guess output shape.',
    );
  });

  it('does not judge a run still in flight', () => {
    expect(runVerdict({ status: 'running' }, []).status).toBe('running');
  });
});

describe('the hint', () => {
  const noToolCall = 'agent raised: empty response and no tool call.';

  it('names the model as the weak link, because nothing else on screen does', () => {
    // "empty response and no tool call" is accurate and useless: the obvious
    // reading is that the automation is broken, and it usually is not.
    const h = reasonHint(noToolCall, { provider: 'ollama', model: 'qwen2.5:32b' });
    expect(h).toMatch(/qwen2\.5:32b did it here/);
    expect(h).toMatch(/Vault/);
    // No success rate: 2-in-8 was measured for one model on one machine, and
    // quoting it for a model it was never measured on invents precision.
    expect(h).not.toMatch(/half the time|\d+%/);
  });

  it('does not blame local models for a hosted one', () => {
    const h = reasonHint(noToolCall, { provider: 'anthropic', model: 'claude-sonnet-4-6' });
    expect(h).toMatch(/without calling a tool/);
    expect(h).not.toMatch(/Local models/);
  });

  it('stays quiet about failures it has nothing to add to', () => {
    // A hint that fires on everything is noise, and noise gets skipped past.
    expect(reasonHint('gmail is not connected', { provider: 'ollama', model: 'qwen2.5:32b' })).toBeUndefined();
    expect(reasonHint(undefined, { provider: 'ollama', model: 'qwen2.5:32b' })).toBeUndefined();
  });

  it('rides along in the notification body', () => {
    const v = runVerdict({ status: 'success', error: null }, [
      { stepId: 'plan', status: 'success', error: null },
      { stepId: 'write', status: 'skipped', error: noToolCall },
    ]);
    expect(verdictDetail(v, { provider: 'ollama', model: 'qwen2.5:32b' })).toMatch(
      /qwen2\.5:32b did it here/,
    );
  });
});

describe('what a notification says', () => {
  it('does not tell you a run that did nothing finished', () => {
    // The notifier's own rule is that a channel which fails must say so, because
    // the whole point of the channel is not having to look. Content that claims
    // success is the same failure: you are told it worked and you stop looking.
    const v = runVerdict({ status: 'success', error: null }, [
      { stepId: 'plan', status: 'success', error: null },
      { stepId: 'summarise', status: 'skipped', error: 'gmail is not connected' },
    ]);
    expect(verdictHeadline('client-summary', v)).toBe('client-summary did nothing');
    expect(verdictDetail(v)).toBe('gmail is not connected');
  });

  it('still says finished when it did finish', () => {
    const v = runVerdict({ status: 'success', error: null }, []);
    expect(verdictHeadline('client-summary', v)).toBe('client-summary finished');
    expect(verdictDetail(v)).toBe('The run completed.');
  });
});

/**
 * The doubled prefix, as it actually reaches the screen.
 *
 * `tidyReason` existed and was applied to the row's summary line — while the
 * expanded timeline printed the raw field. So the sixty characters of repeated
 * agent name its docstring describes were still on screen, in monospace, one
 * sentence wrapped into three red lines. Same string, two elements, one tidied.
 */
describe('tidyReason on the string the SDK really produces', () => {
  const DOUBLED =
    "agent 'client-summarizer' raised: agent 'client-summarizer': model returned " +
    'non-JSON text without calling the __finish tool — refusing to guess output shape.';

  it('strips BOTH levels of the prefix, not just the outer one', () => {
    const out = tidyReason(DOUBLED);
    expect(out).toBe(
      'model returned non-JSON text without calling the __finish tool — refusing to guess output shape.',
    );
    expect(out).not.toContain('client-summarizer');
    expect(out).not.toContain('raised');
  });

  it('leaves a reason that never had the prefix alone', () => {
    const plain = 'Gmail is not connected.';
    expect(tidyReason(plain)).toBe(plain);
  });

  it('is idempotent, so applying it in two places cannot double-strip meaning', () => {
    // The row and the timeline both call it now. Tidying a tidied string must
    // not start eating the sentence.
    expect(tidyReason(tidyReason(DOUBLED))).toBe(tidyReason(DOUBLED));
  });

  it('lets a caller tell "the run said it too" from "the run said something new"', () => {
    // What the timeline uses to suppress a run-level error that merely repeats
    // the step's. Equality has to hold AFTER tidying, because the two fields
    // carry different numbers of prefixes.
    const stepSaid = DOUBLED;
    const runSaid = "agent 'client-summarizer': " + tidyReason(DOUBLED);
    expect(tidyReason(runSaid)).toBe(tidyReason(stepSaid));

    const different = 'The workflow timed out.';
    expect(tidyReason(different)).not.toBe(tidyReason(stepSaid));
  });
});
