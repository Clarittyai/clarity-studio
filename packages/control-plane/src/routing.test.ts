/**
 * The desktop app refuses to start a run when no model key is configured, so
 * that pressing Run now does not build a venv for a minute before failing. That
 * shortcut is only safe while it agrees with the plane about which models need
 * a key — and it did not: choosing `ollama/llama3.1:8b`, which needs no key at
 * all, was refused up front with "add a provider key".
 *
 * A pre-check stricter than the thing it stands in for turns a working setup
 * into an error naming a fix that is not the problem, so the rule lives in one
 * place now and is asserted here.
 */
import { describe, expect, it } from 'vitest';

import { builtInProviders, modelNeedsKey, providerIdForModel } from './routing.js';

describe('providerIdForModel', () => {
  it.each([
    ['claude-haiku-4-5', 'anthropic'],
    ['claude-opus-5', 'anthropic'],
    ['anthropic/claude-sonnet-5', 'anthropic'],
    ['gpt-4o-mini', 'openai'],
    ['openai/llama3.1:8b', 'openai'],
    ['o3', 'openai'],
    ['gemini-2.5-flash', 'google'],
    ['ollama/llama3.1:8b', 'ollama'],
    ['openrouter/meta-llama/llama-3.1-8b', 'openrouter'],
    ['simulator', 'simulator'],
  ])('routes %s to %s', (model, provider) => {
    expect(providerIdForModel(model)).toBe(provider);
  });

  it('claims nothing for an id no provider recognises', () => {
    // The prefix is what routes a local model. Without it there is no way to
    // tell "llama3.1:8b on my Ollama" from "…on my LM Studio behind OpenAI".
    expect(providerIdForModel('llama3.1:8b')).toBeUndefined();
  });
});

describe('modelNeedsKey', () => {
  it('is false for the providers that answer without a credential', () => {
    expect(modelNeedsKey('ollama/llama3.1:8b')).toBe(false);
    expect(modelNeedsKey('simulator')).toBe(false);
  });

  it('is true for the hosted providers', () => {
    expect(modelNeedsKey('claude-haiku-4-5')).toBe(true);
    expect(modelNeedsKey('gpt-4o-mini')).toBe(true);
    expect(modelNeedsKey('gemini-2.5-flash')).toBe(true);
  });

  it('is false for an unroutable id, so the plane gives the truer error', () => {
    // Not runnable either — but "no provider handles this model" says what is
    // actually wrong, where "you have no key" sends someone to add one that
    // would change nothing.
    expect(modelNeedsKey('llama3.1:8b')).toBe(false);
  });
});

describe('builtInProviders', () => {
  it('matches the simulator before anything else can claim it', () => {
    // Order matters: the plane takes the first provider whose handles() passes.
    expect(builtInProviders()[0]?.id).toBe('simulator');
  });

  it('gives every provider a distinct id', () => {
    const ids = builtInProviders().map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
