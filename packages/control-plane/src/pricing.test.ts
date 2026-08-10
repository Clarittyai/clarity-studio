/**
 * Pricing is resolved by longest-prefix match, which is what keeps the table
 * short — and what silently mis-prices a whole model family the moment a newer
 * one shares an older one's prefix. Both failure modes had shipped:
 *
 *   - `claude-opus-4` swallowed 4.6/4.7/4.8 and charged them Opus 4.0's
 *     $15/$75, three times the real price;
 *   - the 5 series matched nothing and reported $0.00.
 *
 * Neither raises anything. The run completes, the timeline renders, and the
 * only symptom is a cost number nobody can check — in the feature the README
 * leads with. So the families Studio actually runs get asserted by name.
 */
import { describe, expect, it } from 'vitest';

import { costMicros, isPriced, priceFor } from './pricing.js';

describe('priceFor', () => {
  it.each([
    ['claude-fable-5', 10, 50],
    ['claude-mythos-5', 10, 50],
    ['claude-opus-5', 5, 25],
    ['claude-opus-4-8', 5, 25],
    ['claude-opus-4-7', 5, 25],
    ['claude-opus-4-6', 5, 25],
    ['claude-sonnet-5', 3, 15],
    ['claude-sonnet-4-6', 3, 15],
    ['claude-haiku-4-5', 1, 5],
  ])('prices %s at $%d/$%d per million', (model, input, output) => {
    expect(priceFor(model)).toEqual({ input, output });
  });

  it('still resolves a dated id to its family', () => {
    expect(priceFor('claude-haiku-4-5-20251001')).toEqual({ input: 1, output: 5 });
  });

  it('does not let an older family swallow a newer one', () => {
    // The specific regression: both start with `claude-opus-4`.
    expect(priceFor('claude-opus-4-8')).not.toEqual(priceFor('claude-opus-4'));
  });

  it('reports an unknown model as unpriced rather than guessing', () => {
    expect(priceFor('claude-opus-99')).toBeUndefined();
    expect(isPriced('claude-opus-99')).toBe(false);
    expect(costMicros('claude-opus-99', 1_000_000, 1_000_000)).toBe(0);
  });

  it('costs a real run in whole micro-dollars', () => {
    // 1M in + 1M out on Haiku 4.5 = $1 + $5.
    expect(costMicros('claude-haiku-4-5', 1_000_000, 1_000_000)).toBe(6_000_000);
    expect(Number.isInteger(costMicros('claude-sonnet-5', 1234, 567))).toBe(true);
  });
});
