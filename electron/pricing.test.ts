import { describe, expect, it } from 'vitest';
import { addUsage, calculateCost, emptyUsage, priceFor, pricingTable, usageFromApi } from './pricing';

const close = (a: number | null, b: number) => {
  expect(a).not.toBeNull();
  expect(a as number).toBeCloseTo(b, 10);
};

describe('calculateCost', () => {
  // The reviewer's cases (scratchpad e101-review-ai/t1.js), with correct prices.
  it('prices a cached Opus 4.6 turn without subtracting cache tokens', () => {
    const u = { inputTokens: 1200, outputTokens: 800, cacheReadTokens: 6000, cacheWriteTokens: 0 };
    close(calculateCost('claude-opus-4-6', u), (1200 * 5 + 800 * 25 + 6000 * 0.5) / 1e6);
  });

  it('prices the first cache write at 1.25x input', () => {
    const u = { inputTokens: 300, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 5000 };
    close(calculateCost('claude-opus-4-6', u), (300 * 5 + 100 * 25 + 5000 * 6.25) / 1e6);
  });

  it('prices Haiku 4.5 at $1 per million input tokens', () => {
    close(calculateCost('claude-haiku-4-5', { inputTokens: 1e6, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }), 1);
  });

  it('prices Opus 5.5 at $4 per million input (no Sonnet 4.6 fallback)', () => {
    close(calculateCost('claude-opus-5-5', { inputTokens: 1e6, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }), 4);
  });

  it('uses the 5.5 table', () => {
    const u = { inputTokens: 1e6, outputTokens: 1e6, cacheReadTokens: 1e6, cacheWriteTokens: 1e6 };
    close(calculateCost('claude-opus-5-5', u), 4 + 20 + 0.2 + 5);
    close(calculateCost('claude-sonnet-5-5', u), 2 + 10 + 0.2 + 2.5);
    close(calculateCost('claude-sonnet-4-6', u), 3 + 15 + 0.3 + 3.75);
  });

  it('applies Haiku 5.5 long-context rates above 100K prompt tokens', () => {
    close(calculateCost('claude-haiku-5-5', { inputTokens: 50_000, outputTokens: 1000, cacheReadTokens: 0, cacheWriteTokens: 0 }), (50_000 * 0.1 + 1000 * 0.5) / 1e6);
    close(calculateCost('claude-haiku-5-5', { inputTokens: 150_000, outputTokens: 1000, cacheReadTokens: 0, cacheWriteTokens: 0 }), (150_000 * 0.5 + 1000 * 2.5) / 1e6);
  });

  it('returns null for an unknown model instead of guessing', () => {
    expect(calculateCost('claude-mystery-9', { inputTokens: 1000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 })).toBeNull();
    expect(priceFor('gpt-4')).toBeNull();
  });

  it('accepts a dated snapshot ID', () => {
    expect(priceFor('claude-haiku-4-5-20251001')?.input).toBe(1);
  });

  it('ignores negative and NaN counts', () => {
    close(calculateCost('claude-sonnet-5-5', { inputTokens: NaN, outputTokens: -5, cacheReadTokens: 0, cacheWriteTokens: 0 }), 0);
  });
});

describe('usage helpers', () => {
  it('sums usage over rounds', () => {
    const r1 = { inputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 40 };
    const total = [r1, r1, r1].reduce(addUsage, emptyUsage());
    expect(total).toEqual({ inputTokens: 30, outputTokens: 60, cacheReadTokens: 90, cacheWriteTokens: 120 });
  });

  it('maps SDK usage with nulls', () => {
    expect(usageFromApi({ input_tokens: 5, output_tokens: 6, cache_read_input_tokens: null, cache_creation_input_tokens: undefined })).toEqual({
      inputTokens: 5, outputTokens: 6, cacheReadTokens: 0, cacheWriteTokens: 0,
    });
  });

  it('lists the price table with notes for unverified rates', () => {
    const table = pricingTable();
    expect(table.map((r) => r.model)).toContain('claude-sonnet-5-5');
    expect(table.find((r) => r.model === 'claude-haiku-5-5')?.note).toMatch(/100K/);
  });
});
