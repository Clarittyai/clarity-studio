/**
 * Local cost accounting.
 *
 * Studio shows real spend even on your own key, because "this automation costs
 * $0.14 a day" is the number that decides whether you keep it running.
 *
 * Prices are USD per million tokens and go stale — they are data, not logic,
 * and are overridable from settings. An unknown model costs 0 and is reported
 * as unpriced rather than guessed: a wrong number is worse than no number.
 */

export interface ModelPrice {
  /** USD per million input tokens. */
  input: number;
  /** USD per million output tokens. */
  output: number;
}

export const PRICES: Record<string, ModelPrice> = {
  // Anthropic. Rows are per family and resolve by LONGEST prefix, so a newer
  // family needs its own row wherever an older, shorter key would swallow it.
  // Two ways that went wrong, both of them the silent-wrong-number this file's
  // header warns about: `claude-opus-4` caught 4.6/4.7/4.8 and priced them at
  // Opus 4.0's $15/$75 — three times their real cost — while the 5 series
  // matched nothing and reported $0.00.
  'claude-fable-5': { input: 10, output: 50 },
  'claude-mythos-5': { input: 10, output: 50 },
  'claude-opus-5': { input: 5, output: 25 },
  'claude-opus-4-8': { input: 5, output: 25 },
  'claude-opus-4-7': { input: 5, output: 25 },
  'claude-opus-4-6': { input: 5, output: 25 },
  'claude-opus-4': { input: 15, output: 75 },
  'claude-sonnet-5': { input: 3, output: 15 },
  'claude-sonnet-4': { input: 3, output: 15 },
  'claude-haiku-4': { input: 1, output: 5 },
  'claude-3-5-haiku': { input: 0.8, output: 4 },
  // OpenAI
  'gpt-4o': { input: 2.5, output: 10 },
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  'gpt-4.1': { input: 2, output: 8 },
  'gpt-4.1-mini': { input: 0.4, output: 1.6 },
  o3: { input: 2, output: 8 },
  'o4-mini': { input: 1.1, output: 4.4 },
  // Google
  'gemini-2.5-pro': { input: 1.25, output: 10 },
  'gemini-2.5-flash': { input: 0.3, output: 2.5 },
  // Anything you run yourself
  simulator: { input: 0, output: 0 },
  ollama: { input: 0, output: 0 },
};

/**
 * Longest-prefix match, so a dated id (`claude-sonnet-4-20260101`) resolves to
 * its family without needing a row per release.
 */
export function priceFor(model: string): ModelPrice | undefined {
  const normalised = model.replace(/^(anthropic|openai|google|ollama|openrouter)\//, '');
  if (normalised.startsWith('ollama')) return PRICES.ollama;

  let best: ModelPrice | undefined;
  let bestLen = -1;
  for (const [key, price] of Object.entries(PRICES)) {
    if (normalised.startsWith(key) && key.length > bestLen) {
      best = price;
      bestLen = key.length;
    }
  }
  return best;
}

/** Cost in micro-dollars (1e-6 USD). Integers — floating-point money in a
 *  ledger you sum thousands of times is how totals drift. */
export function costMicros(model: string, promptTokens: number, completionTokens: number): number {
  const price = priceFor(model);
  if (!price) return 0;
  const usd = (promptTokens / 1e6) * price.input + (completionTokens / 1e6) * price.output;
  return Math.round(usd * 1e6);
}

export function isPriced(model: string): boolean {
  return priceFor(model) !== undefined;
}

export function formatUsd(micros: number): string {
  const usd = micros / 1e6;
  if (usd === 0) return '$0.00';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}
