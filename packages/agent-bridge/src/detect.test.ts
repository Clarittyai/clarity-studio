import { describe, expect, it, vi } from 'vitest';

import { AGENTS, composeOpeningPrompt, detectAgents, looksFresh } from './detect.js';

describe('detecting installed agents', () => {
  it('returns only the ones that answer', async () => {
    const probe = vi.fn(async (bin: string) =>
      bin === 'claude'
        ? { code: 0, output: '2.1.4 (Claude Code)' }
        : { code: 127, output: 'command not found' },
    );

    const found = await detectAgents(probe);

    expect(found.map((a) => a.id)).toEqual(['claude']);
    expect(found[0]!.version).toBe('2.1.4');
  });

  it('survives a probe that throws rather than exiting', async () => {
    const probe = vi.fn(async (bin: string) => {
      if (bin === 'codex') throw new Error('spawn ENOENT');
      return { code: 0, output: '1.0.0' };
    });

    const found = await detectAgents(probe);
    // One broken binary must not hide every other agent on the machine.
    expect(found.length).toBe(AGENTS.length - 1);
  });

  it('probes in parallel, because six sequential spawns is a visible pause', async () => {
    let concurrent = 0;
    let peak = 0;
    const probe = vi.fn(async () => {
      peak = Math.max(peak, ++concurrent);
      await new Promise((r) => setTimeout(r, 5));
      concurrent--;
      return { code: 0, output: '1.0.0' };
    });

    await detectAgents(probe);
    expect(peak).toBeGreaterThan(1);
  });

  it('falls back to a readable string when the version is unparseable', async () => {
    const found = await detectAgents(async () => ({ code: 0, output: 'dev build' }));
    expect(found[0]!.version).toBe('dev build');
  });
});

describe('the opening prompt', () => {
  it('sends a non-Clarity repo down the convert path', () => {
    const prompt = composeOpeningPrompt({ hasManifest: false, isFresh: false, request: 'chase invoices' });
    expect(prompt).toMatch(/\/clarity-convert/);
    // The instruction that keeps a conversion from becoming a rewrite.
    expect(prompt).toMatch(/do not rewrite/i);
    expect(prompt).toMatch(/chase invoices/);
  });

  it('leads with what is broken, before what the user asked for', () => {
    const prompt = composeOpeningPrompt({
      hasManifest: true,
      isFresh: false,
      problems: ['Agent "chaser" has no instructions'],
      request: 'add a Slack step',
    });
    // Building on top of a broken manifest wastes a turn and confuses the
    // agent about which failure it caused.
    expect(prompt.indexOf('no instructions')).toBeLessThan(prompt.indexOf('add a Slack step'));
    expect(prompt).toMatch(/claritty-seed-verify/);
  });

  it('tells a fresh project to replace the example rather than add to it', () => {
    const prompt = composeOpeningPrompt({ hasManifest: true, isFresh: true, request: 'watch for churn' });
    expect(prompt).toMatch(/Replace the example/);
    expect(prompt).toMatch(/Delete the example/);
    expect(prompt).toMatch(/watch for churn/);
  });

  it('asks rather than guesses when given no request', () => {
    expect(composeOpeningPrompt({ hasManifest: true, isFresh: true })).toMatch(/Ask me what it should do/);
  });

  it('does not repeat the rules the project already carries', () => {
    const prompt = composeOpeningPrompt({ hasManifest: true, isFresh: true, request: 'x' });
    // CLAUDE.md and AGENTS.md ship with every automation. A second copy here
    // would waste context and drift out of date.
    expect(prompt).not.toMatch(/claritty_finish|promptFile|@tool/);
    expect(prompt.split('\n').length).toBeLessThan(8);
  });
});

describe('recognising an untouched seed', () => {
  it('spots the example by manifest id or by its agent', () => {
    expect(looksFresh('my-automation', [])).toBe(true);
    expect(looksFresh('invoice-chaser', ['digest-writer'])).toBe(true);
    expect(looksFresh('invoice-chaser', ['chaser'])).toBe(false);
  });
});
