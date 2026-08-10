/**
 * Which provider serves a model id, and whether that needs a key.
 *
 * This exists because the answer was worked out in two places. The plane routes
 * on `handles()` and refuses only when the chosen provider actually needs a key
 * — the simulator and a local Ollama do not. The desktop app ran its own
 * cheaper check before starting anything ("is there an Anthropic or OpenAI key
 * anywhere?"), which was true enough while a key was the only way to run.
 *
 * The moment a model override could name `ollama/…`, the two disagreed: the
 * plane would have served the run happily, and the app refused it up front with
 * "add a provider key" for a model that needs none. A pre-check that is stricter
 * than the thing it is checking for is worse than no pre-check, because the
 * error names a fix that is not the problem.
 */
import { anthropic } from './providers/anthropic.js';
import { google } from './providers/google.js';
import { ollama, openai, openrouter } from './providers/openai.js';
import { createSimulator } from './providers/simulator.js';
import type { Provider } from './types.js';

/** Providers that answer without any stored credential: the simulator is local
 *  by definition, and Ollama rejects nothing. */
const KEYLESS = new Set(['simulator', 'ollama']);

/** Every provider a plane has by default, in match order. */
export function builtInProviders(): Provider[] {
  return [createSimulator(), anthropic, openai, google, ollama, openrouter];
}

/** Who would serve this model, or undefined if nothing claims it. */
export function providerIdForModel(model: string): string | undefined {
  return builtInProviders().find((p) => p.handles(model))?.id;
}

/**
 * Whether running this model needs a key to be configured.
 *
 * An unroutable id answers `false` on purpose. It is not runnable either, but
 * "no provider handles this model" is a different and more accurate error than
 * "you have no key", and it is the plane's job to say it.
 */
export function modelNeedsKey(model: string): boolean {
  const id = providerIdForModel(model);
  return id !== undefined && !KEYLESS.has(id);
}
